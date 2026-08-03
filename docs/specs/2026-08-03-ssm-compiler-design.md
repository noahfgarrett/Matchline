# SSM Compiler — Design Spec

**Date:** 2026-08-03 (rev 2 — incomplete-inputs model, full-fork decision, P6 equipment IDs)
**Status:** Approved direction; Phase 1 in progress
**Deliverable:** A standalone single-file app (this repo, `SSMCompiler.html`) that ingests the five contract-standard project documents and emits a complete SSM, a backfilled MEL, a UPN predecessor matrix, and a QA scorecard — one drop zone, one build button.

---

## 1. Purpose

Building a Start-Up System Matrix today takes a team of engineers months of manual Smartsheet work. Every relationship the SSM encodes is already latent in documents that exist on every project: the MEL, the cable schedule, the Easy Power export, the PMD, and the P6 schedule. The client SOP defines the assembly rules formally. The Compiler mechanically applies those rules to those documents.

The core insight: **parent-vs-dependency is not a property of a relationship — it is the relationship crossed with a partition.** The MEL partitions equipment into buckets (Building / Discipline / UPN-System). A feed edge inside a bucket makes a structural parent; a feed edge crossing a bucket boundary makes a dependency and roots the equipment in its own bucket. This is the SOP's own rule (child UPN must match parent UPN; a dependency gates commissioning but belongs to a different UPN or discipline), so the Compiler is an implementation of policy, not a heuristic.

## 2. Goals

1. Generate an SOP-conformant SSM from the five inputs with zero manual hierarchy work.
2. Backfill the MEL's `System Parent Equipment Tag(s)` column (plus a dependency column), every cell carrying provenance, so the MEL converges toward being the single source of truth.
3. Derive the UPN-level predecessor matrix (the contract "one pager") instead of hand-drawing it.
4. Compute the acceptance-criteria KPIs locally (tag-vs-MEL validation, structure lint, milestone coverage) so uploads arrive pre-green.
5. **Produce a complete, valid SSM from incomplete inputs**, with incompleteness made visible and priced rather than blocking (see §6).
6. Stay one-size-fits-all in logic: all site variation lives in profile data (mappings, tag anatomy, rule packs), never in code.

### Non-goals

- Replacing SSManagement. It remains the per-site exploration/curation app and is not modified by this project; the Compiler lives in its own repo on a one-time fork.
- Writing into EXTO or P6 directly. Outputs are files a human uploads/reviews.
- Modeling construction sequencing/testing for piping spools (pressure test, passivation, flushing) — the SOP tracks those outside the SSM.

## 3. Inputs

All spreadsheet inputs go through the header-shape detection contract (forked `src/io/detect.js`), extended with two new detectors (P6, line list). Auto-detection is overridable per profile.

| # | Document | Role | Detection anchor columns |
|---|---|---|---|
| 1 | **MEL** | Universe + partition + override evidence | Equipment Tag, Equipment Description, Bldg, Discipline, **UPN**, System Description, System Parent Equipment Tag(s), Project Phase |
| 2 | **Cable schedule** | Power edges (highest-fidelity) | Load Name (To), Panel (From) |
| 3 | **Easy Power export** | Power edges / electrical spine | Starting Source, Downstream 1..n, ID Name |
| 4 | **PMD** | Control/signal edges (instrument → panel) | PANEL, INSTRUMENT TAG |
| 5 | **P6 export** (XER or XLSX activity export) | L1/L2 milestones, tag→milestone association, schedule cross-check | XER: TASK/TASKPRED/ACTVCODE tables. XLSX: Activity ID, Activity Name, predecessors. Activities carry equipment IDs, milestones, and UPNs **when mature** — early revisions may have any of these sparsely populated (see §6) |
| 6 | *(optional)* **P&ID line list** | Piping/duct roll-up rows | Line ID, UPN (column map configurable) |
| 7 | *(optional)* **Prior SSM / working copy** | Diff & change-control reporting | Equipment ID, Closest Parent, Dependencies |

Notes:

- UPN is confirmed present and complete in the MEL. `System = "{UPN} {System Description}"` composes the system key; no external join required.
- XER is plain tab-delimited text (`%T`/`%F`/`%R` records) and is parsed with no new dependencies, honoring the zero-dependency constraint.
- MEL rows with `Project Phase` in an excluded set (default: `Future`) are carried but flagged out of the register by default (profile-configurable).

## 4. Domain model

Reuses SSManagement's canonical model and claims vocabulary unchanged where possible:

- **Record** — one commissionable line item, seeded **from the MEL** (this is new relative to SSManagement: its `buildCanonicalModel()` seeds from the Easy Power tree; the Compiler seeds from MEL rows and lets other sources attach evidence). MEL rows that are functional splits of one physical asset (`..._CNTRL_PWR`, `..._PWR`, `..._PWR_CB9`) are distinct records tied by the anatomy identity/matching split. Dual tags (`...-581/582`) are one record with an alias, expanded on export.
- **Edge** — directed "A needs B" evidence: `POWERS` (cable, Easy Power), `CONTROLS` (PMD, RIO/PLC topology), `ASSERTED` (MEL System Parent column), `RULE` (rule-pack derived). Every edge carries source + row provenance.
- **Claim** — `STRUCTURAL_PARENT` (singular) / `DEPENDENCY` (additive) from the forked claims module, resolved with its existing precedence/ambiguity/cycle machinery.
- **Partition key** — the grouping tuple of the SSM mode: `(Building, Discipline, System)` where `System = "{UPN} {System Description}"`. Nesting requires the full tuple to match (the forked projection's `sameGroup` behavior), which matches the SOP: a dependency is anything cross-UPN **or cross-discipline**.
- **Milestone** — L2 milestone activities parsed from P6, associated to tags via the milestone ladder (§6).

## 5. The fold algorithm

For each record, after all edges are attached:

1. **Candidate feeds** = incoming `POWERS` edges, then `CONTROLS` for signal-only devices, plus `ASSERTED` and `RULE` claims, ranked by the profile's `parentSourcePriority`.
2. **Pass-through hop:** if a feeder is not a MEL member (bus, junction node from Easy Power), walk up that chain until the nearest MEL member; record the hop path in provenance.
3. **Same-partition preference:** among candidate feeds, a same-partition candidate wins the `STRUCTURAL_PARENT` claim even over a higher-priority cross-partition candidate.
4. **Demotion:** every cross-partition candidate becomes a `DEPENDENCY` claim with provenance `demoted: crosses {UPN-A}→{UPN-B} via {edge}`. Dual/alternate feeds demote the same way (alternate source = dependency).
5. **Roots:** a record with no same-partition feed is a root of its system block, carrying its cross-partition feeds as dependencies. (Canonical test: RIO in UPN 650 fed from a panel in UPN 603 → RIO roots under 650 with the panel as dependency.)
6. **MEL assertion handling:** a filled `System Parent Equipment Tag(s)` cell is high-priority evidence, but if it contradicts the physical edges or the partition rule it is *flagged*, not silently obeyed. Trailing tags in the cell beyond the first are additive dependencies.
7. **Rule-pack resolution:** class-level rule dependencies ("PLC", "Elec Panel", "DB Panel") resolve to tags via PMD/cable/topology. Unresolvable ones emit an explicit `UNRESOLVED: <class>` placeholder row in the QA report — never dropped silently.
8. **Cycle handling:** quarantine (`findCycles`) at record level; new detection at UPN level after collapsing cross-partition edges. UPN-level cycles are always review items.
9. **Synthetic nodes:** discipline headers, system rows, organizational headers (e.g. `<tag> - I&C` grouping row when a major equipment has ≥ N I&C children; default N=4), and piping roll-up rows per UPN from the line list. All synthetic nodes are marked as such and excluded from tag-vs-MEL validation.

**Pairing mechanics** (how "what goes with what" is decided, in confidence order):

- *Explicit edges are read, not inferred* — a cable row is an edge; an Easy Power path is a chain of edges; a PMD row pairs instrument to panel.
- *Identity resolution* links the same asset across documents via tiered matching: exact → normalized → anatomy-aware (identity segments only) → corroborated fuzzy (context must agree; always lands in the review queue). Every match records its tier.
- *Tag-family inference* pairs mech/I&C children to parents by shared unit/loop segment + compatible equipment-type roles (MAH101 ← VFD101, SC101, ZSO101...), per-site tunable through anatomy.
- *Rule-pack shape rules* decide child-vs-dependency structure once a family or edge match exists.
- *Disagreement resolution:* source precedence + corroboration + partition preference; top-rank ties become ambiguity review items, never coin flips.

**Sequencing.** Within a system: topological order of the structural tree, direction set by discipline polarity — Mechanical/I&C bottom-up (children → parent), Electrical/LSS/Security top-down (parent → children). Polarity is profile data (`discipline → polarity` map with SOP defaults). Across systems: topological sort of the UPN dependency DAG per building/discipline. The polarity also drives the EXTO parent-gating flag on upload rows.

## 6. Incomplete inputs: fallback ladders and recompilation

Project documents mature at different rates (early P6 especially). The Compiler's contract is: **complete, valid output at every input maturity level — with incompleteness graded, attributed, and recoverable.** Three mechanisms:

**6a. Fallback ladders.** Every derived fact resolves down an ordered ladder from strongest evidence to weakest-but-valid default. Provenance records which rung fired; nothing is ever blank because a source was immature.

- *Tag → L2 milestone:* (1) P6 activity carries this equipment ID → direct association; (2) P6 milestone/activity carries a UPN → UPN-level assignment for every tag in that UPN; (3) UPN extracted from milestone name by pattern; (4) no L2 found → building-ready bucket (the SOP's own default). An immature P6 simply lands more tags on rungs 2–4.
- *Structural parent:* (1) same-partition explicit edge; (2) MEL assertion; (3) tag-family + rule pack; (4) root-of-system — flat but SOP-valid.
- *Dependency:* (1) explicit cross-partition edge; (2) rule-pack class dependency resolved to a tag; (3) unresolved class placeholder (visible, counted).
- *Partition:* (1) MEL UPN + System Description; (2) feeder-chain majority proposal (flagged, never auto-applied); (3) Unassigned bucket.

**6b. Coverage scorecard.** At ingest, each source gets a coverage profile (rows parsed, % tags matched to MEL, field fill rates — e.g. "P6: milestones for 14/23 UPNs, equipment IDs on 8% of activities"). The QA output reports the rung distribution per ladder, which converts "the inputs aren't complete" into a precise punch list: *this* missing data unlocks *these* rows, owned by *that* document's author.

**6c. Deterministic recompilation.** Outputs are a pure function of (inputs, profile). When a document revision arrives, recompile and diff: the report shows rung promotions ("P6 rev 12 promoted 240 tags from building-ready to direct L2 association"), new/moved parents, and broken dependencies (flagged for approval per SOP change control). The SSM stops being a hand-maintained artifact and becomes a build product that tracks document maturity automatically — which dissolves the put-incomplete-pieces-together problem: pieces are *allowed* to be incomplete because assembling them costs one click, every time.

## 7. Profiles and the SOP baseline

The Compiler uses the same profile schema, rules engine, and anatomy system as SSManagement (forked). Profiles remain schema-compatible where practical so a site profile authored in SSManagement's Studio can be imported. The Compiler ships with an **"SOP Baseline" starter profile** encoding the Guidelines-Smartsheet conventions as Relate/Classify rules, including at minimum:

- I&C devices of major equipment → children of that equipment (MAH → ZSO/TIT/TCV/TSL...).
- VFD → child of its major equipment; dependencies: its electrical panel + PLC.
- FMS hardwired I/O → children of the VFD; dependency: PLC.
- Main breaker panel → child of its major equipment; dependency: DB panel.
- Standalone LCPs → system root (child of the milestone); their instruments → children of the LCP.
- Control valves → child of parent equipment.
- Instruments not tied to equipment → child of distribution piping roll-up *iff same UPN*.
- Room sensors → children of the equipment they control.
- FAP → dependency of its VESDA system.

Sites customize by editing the profile, never by code. New profile fields introduced: `polarity` map, milestone-name pattern, phase-exclusion set, EXTO upload column map, I&C-header threshold.

## 8. Outputs

All exports read one immutable resolved snapshot. Every generated cell is traceable to provenance viewable in-app and exported on a Provenance sheet.

1. **SSM workbook**
   - *Register sheet:* Equipment ID · Closest Parent · Dependencies · UPN · System · Building · Discipline · L2 Milestone · sequence index — hierarchy-ordered per polarity.
   - *EXTO upload sheet:* column layout driven by the profile's upload column map (default seeded from SSManagement's Exto export layout; exact template columns are a profile setting so template drift never requires code).
   - *Visual tree* (hierarchy/outline exports, grouped Building → Discipline → System).
2. **Completed MEL** — the user's original workbook, structurally untouched, with `System Parent Equipment Tag(s)` and a `Dependencies` column backfilled. Proposed values are styled distinctly from pre-existing values; a companion Provenance sheet lists tag → proposal → evidence. Contradictions between asserted and derived values are listed, not overwritten.
3. **UPN predecessor matrix** — matrix sheet (UPN × UPN) plus an edge-list sheet (`predecessor UPN, successor UPN, via edges…`), per building/discipline.
4. **QA scorecard** — KPIs, exceptions, and the §6 coverage report:
   - KPIs mirroring the client's PBI health indicators: tag-vs-MEL validation %, tag→milestone association %, records with parent, records with dependencies, anatomy match rate, P6 linkage coverage.
   - Structure lint: every child's UPN equals its parent's UPN; every dependency crosses a partition boundary; orphans; UPN cycles; unresolved class dependencies; MEL assertions contradicting physics; cross-building power edges; cables referencing tags absent from the MEL (and vice versa).
   - Ladder rung distribution per derived fact + per-source coverage profile.
   - Schedule cross-check: derived UPN precedence vs P6 predecessor logic, disagreements listed.
5. **Diff report** (when a prior SSM/working copy or prior compile is supplied) — adds, removals, moved parents, rung promotions, and **broken dependencies called out separately** (SOP requires approval to break a dependency).

## 9. Architecture

**Standalone repo** (`~/Codebase/SSMCompiler`), same philosophy as SSManagement: zero runtime dependencies, plain ES modules concatenated by a build script into one committed artifact, `SSMCompiler.html`, in a single top-level scope (no duplicate top-level names, no surviving import/export).

**Full fork, then trim.** The repo starts as a full copy of SSManagement's `src/`, `build/`, `tests/`, and `package.json` at commit `6d51935` (recorded in `docs/FORK.md`), because the 56 modules share one bundle scope and are interwoven — cherry-picking a subset risks silent missing-name failures. The transform then proceeds in place: rebrand the artifact (`SSMCompiler.html`), retarget or disable the update channel, add compiler modules, and progressively remove SSManagement-only surfaces that the Compiler does not use. The fork is one-time: improvements flow between repos by deliberate cherry-pick; no runtime or build coupling; SSManagement is never modified.

**Kept from the fork (core):** `src/io/` (workbook, detect + new P6/line-list detectors), `src/core/`, `src/rules/` (engine, anatomy, normalize, classify, expression — wired to MEL lookups as a production path — lookup, provider, schema), `src/hierarchy/claims.js` + modes/grouping projection, `src/profile/` (schema, durable storage), comparison machinery, `src/export/xlsx.js` plumbing, vendored SheetJS/fflate/PDF.js (PDF.js may be trimmed once legend surfaces are removed).

**New modules (Compiler-specific):** `src/compiler/seed.js` (MEL-first universe), `src/compiler/edges.js` (edge assembly + pass-through hops), `src/compiler/fold.js` (partition fold, §5), `src/compiler/ladders.js` (§6 fallback ladders + coverage), `src/compiler/sequence.js` (polarity-aware topo sort, UPN DAG), `src/io/p6.js` (XER/XLSX parse, milestone extraction), `src/compiler/exports.js` (deliverables), compiler screens in `src/ui/` (drop zone → build → results/review).

**UI flow:** upload (multi-file drop, per-file detected-type chips + coverage summary) → build (progress + issue count) → results (four deliverable cards + QA summary + review queues: ambiguities, cycles, unresolved deps, MEL contradictions). Review actions record manual overrides into the profile.

## 10. Testing

- Golden fixtures: one small synthetic project (MEL ~60 rows across 2 buildings / 3 disciplines / 4 UPNs, cable, Easy Power, PMD, XER) exercising every rule class, **shipped in three maturity variants** (sparse / partial / complete) to test every ladder rung and rung-promotion diffs. Fixture data is invented, not client data.
- Canonical fold tests: the RIO example (cross-UPN feed → root + dependency); same-partition preference over higher-priority cross-partition feed; pass-through hop; dual feed; MEL assertion contradiction; LSS device listed under panel and VFD (duplicate occurrence, single structural parent).
- Output invariants (property-style over the fixtures): child UPN == parent UPN for every nested row; every dependency crosses partition; register contains every non-excluded MEL row exactly once; every derived fact carries a ladder rung; exports blocked while rebuild pending.
- P6: XER parse round-trip; milestone ladder table-driven tests (each rung).
- The forked test suite ships with the fork; the repo has its own `node --test` suite and a bundle-staleness check for `SSMCompiler.html`.

## 11. Delivery phases

1. **Phase 1 — fork-to-green + the fold + the two core deliverables.** Full fork, rebrand, build/tests green; MEL seeding, edge assembly, fold + parent/dependency ladders, SSM register + completed MEL with provenance.
2. **Phase 2 — schedule + QA.** P6 ingestion, milestone ladder, sequencing/polarity, UPN predecessor matrix, QA scorecard incl. coverage report, EXTO upload sheet.
3. **Phase 3 — round-trip.** Diff/change-control + rung-promotion report, line-list piping roll-ups + manual-add surface, rule-pack authoring polish, review-queue UX, trim unused fork surfaces.

## 12. Decisions and defaults (revisit if wrong)

- **Standalone repo over a second build target in SSManagement:** SSManagement stays frozen and stable for site use; the Compiler iterates fast without risking it.
- **Full fork over selective module copy:** the single-scope bundle makes partial forks failure-prone; copying everything and trimming later is safer and matches the one-time-fork policy. Trim happens in Phase 3, not opportunistically.
- **Demotion policy:** direct-feeder classification (root + dependency), no nearest-same-system-ancestor walk — matches the SOP example. A walk mode is not built until a real site needs it.
- **Partition key:** full grouping tuple (Building, Discipline, System). Cross-building same-UPN edges therefore demote; they also appear in lint as probable data errors.
- **Incompleteness is graded, never fatal:** every ladder ends in an SOP-valid default (building-ready, root-of-system, placeholder). No input maturity level produces an invalid or empty SSM.
- **Piping roll-ups:** Phase 3, via optional line list; manual-add as fallback.
- **EXTO template columns:** profile-configurable map, defaulted from SSManagement's Exto export layout, because the exact current template revision is not yet in hand.
- **Confidentiality:** SOP conventions are encoded as rule data in the baseline profile; no SOP text is reproduced in code, comments, or fixtures.
