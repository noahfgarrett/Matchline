# How the SSM Compiler Builds the SSM

This is the complete decision logic, as implemented today (v1.3.1). Every rule
here is traceable to code; file references point at the module that owns it.

---

## 1. The inputs, and what each one is trusted to say

| Input | Required? | What it contributes |
|---|---|---|
| **MEL** (Master Equipment List) | Yes — the only required input | The *universe*: every tag that exists, plus Building, Discipline, UPN, System Description, Equipment Description, System Parent assertions, Project Phase |
| **Easy Power export** | Optional | The electrical spine: who feeds whom, from source breakers down through the downstream columns |
| **Cable schedule** | Optional | Explicit power edges: Load Name (To) ← Panel (From) |
| **PMD** (Point Master Database) | Optional | Instrument → panel wiring: which panel each instrument's points land on |
| **Prior registry export** (finished SSM) | Optional, once | Training data: description→classification, nesting roles/affinities, item-master patterns. Learned once, saved into the profile, applied forever after |
| **Item Master template** | Optional | The universal (VF) item-master vocabulary, used to normalize legacy CA_* names |
| **P6 schedule** (XER or XLSX) | Optional | L2 milestones per equipment/UPN |
| **P&ID line list** | Optional | Piping/duct roll-ups per UPN |

The guiding principle for incomplete inputs: **every derived fact resolves down
a fallback ladder to a defensible default**. A missing source never blocks the
build — it just lands records on a lower rung, and a recompile with more mature
documents promotes them.

## 2. Reading the files (`src/io/detect.js`)

Sheets are identified by *name first, headers second*:

- A tab named "Equipment List", "Master Equipment List", "MEL", etc. is a MEL by name.
- Otherwise headers are scanned across the first rows (headers may start in row 1, 2, 3 — the scan goes deeper) looking for an Equipment Tag column. Exact forms ("Equipment Tag") are trusted alone; loose forms ("Equipment Tag Number", "Tag No.", "Asset Tag") are only trusted when a UPN or System Parent column plus a second MEL column corroborate — so a cable schedule's "Cable Tag" or a registry's "Equipment ID" can never masquerade as a MEL.
- Anything unrecognized can be mapped by hand in Site profile → Data Mapping.
- If a build produces nothing, the failure is diagnosed and named (unrecognized MEL header row, seeding disabled in the profile, or a MEL-looking tab in the wrong selection group) — never a generic "no rows" shrug.

## 3. The seed universe: MEL first (`src/hierarchy/projection.js`)

Every MEL row becomes a canonical record. From its columns:

- **System Name** = `{UPN}` + one space + `{System Description}`. (Deliberately one space — the two-space variant seen in some Cx exports is their quirk, not ours.)
- **Building** and **Discipline** come straight from the MEL, never guessed.
- **Project Phase** gates register inclusion: excluded phases (default: `Future`) still create records — so edges can attach to them — but stay out of the exported register.
- A filled **System Parent Equipment Tag(s)** cell becomes a parent claim (see §5).

The structure that falls out with a MEL alone: **Building → only the
disciplines that exist there → only the systems that exist under each → the
equipment in each system**, with System Parent assertions nesting parents and
children inside each system.

## 4. One asset, many spellings (`src/hierarchy/build.js` — melTagLookup)

The MEL is the naming authority. Evidence documents spell tags differently
("DDC-7301" in a cable schedule vs "B14-DDC-7301" in the MEL), so every
evidence tag resolves through identity tiers:

1. **Exact** match against the MEL
2. **Suffix** match — the back end of the tag (only when unambiguous: exactly one MEL candidate)
3. **Normalized** match — separators/case collapsed

On a match, the evidence is *rekeyed to the MEL spelling* — one record, MEL
spelling wins, all the variant spellings' claims attach to it. An ambiguous
suffix match (two possible MEL tags) attaches nothing: no guessing.

## 5. Everything is a claim, not a decision

No source writes the hierarchy directly. Each contributes **claims** which are
resolved together:

- **STRUCTURAL_PARENT** claims compete for the single parent slot.
- **DEPENDENCY** claims are additive — a record can have many.

Priority order for the parent slot (highest wins; `projection.js`):

| Priority | Source |
|---|---|
| ~2000 | Relate rules from the site profile (rule order breaks ties) |
| 1000 | Cable schedule |
| 900 | MEL System Parent column |
| 800 | Easy Power |
| 700 | PMD |
| 500 | Previously-resolved register rows (re-imported working copy) |
| 450 | Previously-resolved flow placements |
| 150 | Inferred nesting (see §7) — **any real evidence beats an inference** |

For **top-down disciplines** (Electrical, LSS, Security — the ones that
commission source-to-load), the Easy Power and MEL priorities swap for that
gear: the feed sources decide nesting, and a filled-in MEL System Parent
cannot sever the chain (it stays recorded as a runner-up claim).

**Manual overrides sit above the whole table.** A drag-and-drop reparent (or
explicit "make root") is stored in the profile and outranks every claim from
every document, permanently, until undone.

Contradictions aren't silently swallowed: when the MEL asserts one parent and
the cable schedule another, the higher priority wins the slot and the loser is
kept as provenance, flagged for review.

## 6. The partition fold — parent vs dependency (`src/compiler/fold.js`)

This is the core rule of the whole compiler:

> **A feed relationship is only a structural parent when both ends live in the
> same partition. A feed that crosses partitions is a dependency.**

- A **partition** is the tuple **(Building, Discipline, System)** — all three explicit, from the MEL or a rule or an override. A record with an unknown partition is never demoted (no guessing in either direction).
- Same partition → the feeder is the **parent** (nesting).
- Different partition → the feeder becomes a **dependency**, and the fed equipment stands as a root (or nests under something in its *own* system).

**The feed-chain exception.** Within one top-down discipline (Electrical,
LSS, Security) and one building, a feed claim from Easy Power or the Cable
Schedule survives a *system* crossing: the chain IS the hierarchy. GIS sits at
the top under its own system (602 Medium Voltage) and everything it feeds
nests beneath it — even a transformer whose own MEL UPN names another system.
That transformer's register row still carries its own MEL building and UPN;
only the tree nesting follows the feed. The exception requires explicit
(MEL-derived) disciplines on both ends — a fallback-derived "Electrical" is
not proof — and it never crosses a building or a discipline: a B14 feeder
serving B31 gear, or an electrical panel serving an I&C device, demotes to a
dependency exactly as before.

The canonical example: an I&C RIO panel in UPN 650 powered from an electrical
panel in UPN 603. The power feed is real — so it's recorded — but the RIO does
not *nest* under the electrical panel: it roots in its own 650 system block
with the 603 panel as a dependency. Validated against real data: ~97% of
parent links in a finished, accepted SSM are same-UPN.

The same fold implements the panel conventions: a panel is a **dependency** of
the instruments it feeds *and* of the equipment those instruments serve —
never their structural parent — because panels live in their own electrical
system block.

## 7. Description-driven nesting (`src/compiler/nesting.js`, `itemmasters.js`)

When no document asserts a parent, the compiler infers one — carefully.

**Step 1 — classify from the Equipment Description.** A digit-masked
description table learned from a finished SSM maps descriptions to equipment
classes (~94% accurate on real data). Assignments only stick at ≥0.9
confidence.

**Step 2 — role gates.** From the finished SSM, each class learns whether it
ever parents anything. A class that appears as a parent in <5% of its rows
(seen ≥10 times) is *child-only* — it will never be guessed as anyone's
parent. That kills the classic failure where two siblings look more alike than
parent and child.

**Step 3 — pair the instance by tag numbers.** Two nesting rules:

- **Containment**: a tag that *extends* another tag by a substantive suffix (≥3 extra characters at a separator boundary) nests under it — `B14-AHU-01` → `B14-AHU-01-TT-02`. The substantive-extension guard exists because "-A"/"-B" endings are usually siblings, not children.
- **Role + affinity**: if class A parents class B in the training data ≥3 times, a B instance nests under the A instance in the *same partition* whose tag shares the longest number run — the "number nomenclature" pairing.

**Step 4 — self-grading.** Every class's predictions are scored against the
training SSM's actual parents. A class only earns **claim grade** (auto-nest,
at priority 150) with ≥85% precision over ≥10 predictions. Everything else is
a **proposal**: written to the review queue and the Completed MEL's proposal
column, never into the hierarchy silently. Benchmarked end-to-end against a
held-out finished SSM: 87% claim precision, 100% agreement on which equipment
are roots.

**Instruments end up at the bottom** (they mount on pipes and skids), nested
under the equipment they serve, with `controls →` reference nodes in the flow
view; their feeding panels attach as dependencies per §6.

All learned tables (classification, roles, affinities, grades) persist into
the site profile the first time a registry is processed — later sessions apply
them with no registry upload.

## 8. Milestones and sequencing (`src/compiler/ladders.js`, `sequence.js`)

Each record's L2 milestone resolves down a ladder:

1. A P6 activity carries this equipment ID explicitly
2. A P6 milestone carries the record's UPN in an explicit column
3. The UPN is extracted from a milestone name by pattern
4. No match → the building-ready bucket (the SOP's own default)

Sequencing within a system follows **discipline polarity**: Electrical (and
LSS/Security) commission top-down (source → load); Mechanical and I&C
commission bottom-up (children before parent). Cross-UPN ordering is emitted
as the predecessor matrix.

## 9. The two views

- **SSM Hierarchy** (the deliverable): Building → Discipline → System → equipment tree. The same System Name appears under *both* Mechanical and I&C when both disciplines have equipment in it — the discipline split is deliberate.
- **Electrical Flow**: exists only when Easy Power is present; MEL-only records never appear here. In this view the instrument relationship is flipped: instrument first, then what it controls beneath it.

## 10. Massaging — the human finishes it (`build.js`, `result.js`)

- **Drag and drop** any equipment onto a new parent (or onto a system folder to make it a root). Validated live: no cross-building/discipline/system moves (those belong as dependencies), no cycles.
- **Drag-to-teach**: one drop offers every same-class sibling, each paired to its *own* parent instance by tag numbers, as a reviewable checklist — select/deselect, search to add missed tags. The batch applies as one undo step.
- **Undo/redo** (⌘Z / ⇧⌘Z) walk the full massage history; a pin badge marks manually placed rows.
- Every manual move persists as a profile relationship override — top of the priority table, survives rebuilds.

## 11. What comes out (`src/export/xlsx.js`)

- **SSM register** — the full hierarchy with partition columns, milestone, sequence
- **Completed MEL** — the original MEL with System Parent backfilled (claims) and proposals in their own column, every cell with provenance
- **EXTO upload sheet** (optional layer, off for sites on other Cx software) — Rev21 column map, roots attached to their own System Name, item masters auto-assigned via the learned (discipline, class, UPN) table at a 0.9 gate, CA_*→VF_* normalized
- **UPN predecessor matrix**
- **QA scorecard + exceptions** — KPIs, contradictions, orphans, review queue, item-master audit
- **Change control** — broken-dependency callouts against a prior working copy

## 12. The invariants

1. The MEL is the universe and the naming authority.
2. Partitions come from explicit data only — never from a fallback, in either direction.
3. Every parent decision is a claim with provenance; nothing is silently rewritten.
4. Evidence outranks inference; humans outrank everything.
5. Inference must earn claim grade against real data, or it stays a proposal.
6. Missing inputs degrade to defensible defaults, never to failure.
