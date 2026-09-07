# ENGINE — compiler package architecture

Grows per execution stage (see STATUS.md). Types live in `@matchline/domain`; every engine
package is pure TypeScript, zero npm dependencies, deterministic, tested with node --test.
Provenance on every produced fact; claims-not-writes throughout (conflicts surface, nothing
silently resolved). All examples use the invented Dragon site.

## E1 — model-first engine core (PRODUCT.md Phase 2)

```
extraction cache ─▶ asset-catalog ─▶ canonical assets (model-first universe)
        │                 │
        │           tag-anatomy (role/system/family segments)
        │                 │
MEL workbook ─▶ spreadsheet-import ─▶ system-resolver ─▶ SystemResolution + System Catalog
                                            │
                                       mel-export ─▶ canonical generated MEL (.xlsx)
```

### Packages

- **`@matchline/spreadsheet-import`** — vendored SheetJS (copied from the frozen donor;
  donor unchanged), AoA workbook scan preserving the donor's dense/sparse byte-parity
  behavior, and explicit-mapping MEL table reads. Auto-detection heuristics arrive in E2;
  E1 reads via a caller-supplied column mapping. Never executes workbook macros.
- **`@matchline/tag-anatomy`** — profile-taught tag segmentation. Model: tokenize on
  configured separators; segment extractors (`alphaPrefix`, `digitSuffix`, `token`,
  `tokenRange`, `charRange`) assign named segments (role, system, unit, instance); composite
  templates build `familyKey`/`localFamily`; `ignoredSuffixes` strip before tokenizing.
  `MAH001-10-01` → role `MAH`, system `001`, familyKey `001-10-01`. Pure: `(anatomy, tag) →
  segments | no-match`, plus a whole-set preview (coverage, per-rule hit counts, examples).
- **`@matchline/asset-catalog`** — extraction cache + profile filters → the canonical asset
  universe. Filters (PRODUCT.md §6.6): included/excluded classes, required tag property
  (profile property mapping), accepted tag patterns, selection-set membership, source-model
  includes, component collapse (a candidate absorbs its candidate descendants unless a
  descendant's class is listed separately commissionable; an absorbed component that carried
  a tag of its own raises a review item). Duplicate model tags
  → both objects kept, status `DUPLICATE_MODEL_TAG`, never merged. Output includes an
  inclusion-impact report (counts in/out per filter) for the wizard.
- **`@matchline/system-resolver`** — ordered chain of components per PRODUCT.md §5:
  `model-field | tag-segment | mel-lookup | direct-column | composite | upn-from-tag |
  exto-system-name | manual`. Each
  component yields an AttributeClaim for systemKey/systemDescription with provenance; the
  chain takes the first success for the *resolved* value but KEEPS all claims. Disagreement
  between components = System Conflict review item unless profile precedence explicitly
  covers it. Normalization transforms (`trim`, `uppercase`, `stripPrefix`, `padStart`,
  `alias`, `unicodeFold`) are explicit profile steps — never silent (leading zeros!).
  `unicodeFold` is the one shared implementation (`@matchline/domain`): NFKC, zero-width
  strip, dash-family fold, NBSP, whitespace around hyphens, run identically by identity and
  by the resolver, because a tag that folds one way in one stage and another way in the
  other joins in one and not the other. System identifiers
  are strings, always. Also builds the System Catalog from a supplied MEL (systemKey →
  description, aliases, multi-description conflicts as review items).

  Two rungs read the approved VF Exto vocabulary, which `@matchline/ssm-audit` vendors
  byte-for-byte from SSM-Audit and publishes on its `/exto` subpath. Nothing about the
  vocabulary is decided here.

  - **`upn-from-tag`** — the UPN is carried INSIDE the equipment tag: the first approved
    three-digit run after a nomenclature boundary, so `MAH101-01` and `VFD101-01` are both
    on system 101, and `RIO6500` is 650 rather than also 500. Needs no tag anatomy, so it
    is the rung for a Revit-shaped mark. Exactly one candidate answers; zero skips with
    `no-upn-candidate`, several with `ambiguous-upn` and the candidates listed — two
    approved UPNs in one tag are two real systems, and the rung will not choose. It
    coexists with `tag-segment`; the profile's chain order decides which speaks first.
  - **`exto-system-name`** — a description-chain rung. Takes the settled System Key and a
    description (from an earlier description rung, or from its own `descriptionProperty`)
    and yields the one System Name the Upload Template accepts. `exact` when
    `<UPN> <description>` IS an approved name; `unique-upn` when the UPN owns exactly one
    name and `allowUniqueUpn` is on — the claim's provenance rule says which, spelled
    `exto-approved-list:exact` / `:unique-upn`. `description-mismatch` and `unknown-system`
    skip with every approved name for that UPN as `candidates`, so the aggregate
    `unresolved-system` item can print what to write instead of only that it was wrong.
    When this rung wins the description chain its value is the whole `systemLabel` — the
    approved spelling already opens with the UPN, and `buildLabel` would print it twice.
    Put it ABOVE a MEL lookup: chain order is chain order, and everything it cannot name
    approvingly falls through to the site's own words.

  One more rule is the compiler's, not the resolver's, because it needs the discipline:
  `systemResolver.applyIcDisciplineRule`. On, a native discipline the SOP reads as
  instrumentation (`I&C`, `Instrumentation & Controls`) projects to
  `FACILITIES MONITORING SYSTEM` — there is no I&C in the approved Discipline list — and
  the asset's System Key becomes the approved UPN in its own tag, recorded as one more
  `Provenance` entry with rule `ssm-audit:ic-discipline`. A site projection somebody wrote
  down still outranks it. Default: on for a new draft, OFF for a profile lifted from a
  stored revision, because a rule that moves assets between systems must not switch itself
  on under a site that has already published.
- **`@matchline/mel-export`** — canonical generated MEL: the §12.1 field list as typed rows
  from canonical assets + resolutions, then .xlsx via spreadsheet-import's vendored SheetJS.
  Deterministic row order (systemKey, then canonicalTag).

## E2 — connectivity spine (PRODUCT.md Phase 3)

```
EasyPower / Cable / PMD workbooks ─▶ connectivity-import ─▶ ConnectivityObservations
                                              │
model asset universe ─▶ identity (tiered reconciliation) ─▶ IdentityOutcomes
                                              │
                                     electrical-flow ─▶ flow projection
                                     (no SSM boundaries; source-only nodes visible)
```

- **`@matchline/connectivity-import`** — sheet-kind detection ported from the donor
  (name-first, exact headers trusted alone, loose headers need same-family corroboration;
  the donor's blanket EasyPower fallback replaced by an honest `unknown`). Importers emit
  one observation per row with cell-level provenance; duplicates kept (parallel cables are
  real); rows missing endpoints skipped with typed reasons.
- **`@matchline/identity`** — §9.2 tiers: exact → normalized → alias → anatomy →
  suffix-unambiguous → fuzzy-proposal. Ambiguity at any tier is terminal (review item,
  never a guess, no fall-through). The anatomy tier compares the full token sequence, not
  just taught segments, so -A/-B siblings never merge (DECISIONS.md). Fuzzy never matches —
  proposals + review items only.
- **`@matchline/electrical-flow`** — §10 projection: per-observation edges, multi/alternate
  feeds first-class, matched nodes enriched with model metadata, unmatched tags become
  visible flow-only/pmd-only nodes with no assetId (never model-authoritative). Self-loops
  dropped to anomalies; cycles kept (ring feeds are real), one anomaly per SCC. No SSM
  boundary enforcement — cross-system feeds stay visible as feeds.

## E3 — SSM compiler (PRODUCT.md Phase 4)

```
observations + identity + anatomy + role graph + learned rules
        ─▶ relationship-claims (assembly: every source contributes claims)
        ─▶ ssm-compiler (parent ladder → boundary fold → projection → snapshot)
        ─▶ compiler (orchestrator: cache + workbooks + profile → CanonicalModel)
```

- **`@matchline/relationship-claims`** — claims assembly. Sources, each yielding
  RelationshipClaims with provenance and evidence tier: explicit model parent/relationship
  property; profile role rules over tag-anatomy roles (parent ladders, e.g. MAH→PLC→VFD→TIT);
  flow-anchored family rules (flow-connected + same familyKey + compatible roles — strongest
  inference); family+role without flow anchor (weaker); accepted (claim-grade) learned
  description rules; prior-SSM examples. STRUCTURAL_PARENT_CANDIDATE claims compete for one
  slot; DEPENDENCY claims are additive. Nothing writes the hierarchy.
- **`@matchline/learned-rules`** — donor §7 concepts, ported: train from a finished
  SSM/registry export → digit-masked description→classification table; per-class parent
  role gates (a class parenting <5% of ≥10 sightings is child-only); role affinities
  (A parents B ≥3 times → pairing rule); self-grading — a class earns claim grade only at
  ≥85% precision over ≥10 predictions, everything else emits PROPOSALS (review queue), never
  hierarchy writes. Training output is a plain serializable LearnedRuleSet for the profile;
  locked profiles persist nothing (donor invariant 5).
- **`@matchline/ssm-compiler`** — resolution + fold + projection:
  1. **Parent ladder** (§11.1, profile-reorderable): manual override → explicit model
     relationship → MEL System Parent → profile lookup → flow-anchored family → family+role
     → accepted learned model → prior SSM example → model-tree suggestion → root of
     grouping. First tier with exactly one candidate wins; a tier with >1 equal candidates =
     ambiguous-parent review item and the ladder STOPS (no fall-through guessing — same rule
     as identity). The `mel-parent` rung reads the MEL's own "System Parent" column (the
     donor's primary structural source): the first tag a row states is the nesting claim,
     any further tags are dependencies. It is in `LADDER_SOURCE_ORDER` and in a new draft,
     and deliberately NOT inserted into a profile stored before it existed
     (`LADDER_SOURCE_ORDER_BEFORE_MEL_PARENT`) — a rung a site never asked for must not start
     seeding its hierarchy.
  2. **Boundary fold** (§11.3, DECISIONS.md #1 — hard boundaries, NO feed-chain exception;
     RELEASE-1.0-PLAN P0-4 — NO manual exception either):
     for the selected parent, all enabled boundary keys known and equal → structural parent;
     any enabled boundary differs → parent removed, demoted to dependency of the child,
     child re-resolves in its own grouping or roots; any REQUIRED boundary value missing →
     no structural decision — review or provisional-root per profile policy. Explicit
     attributes only: a profile fallback value never feeds a boundary comparison.
     **Manual outranks, and still folds.** A manual override is the top rung and wins the
     competition; it is then folded like any other winner. A cross-boundary manual parent
     becomes a `DEPENDENCY` carrying the person's own words, `ParentDecision.demotedFrom`
     records the parent, the boundary level and `manual: true`, the refused claim stays in
     `losingClaims`, and a `manual-boundary-demotion` review item names child, parent and
     level. A manual parent whose boundary value nobody stated takes the missing-boundary
     path unchanged: manual is the strongest evidence about who the parent is, never
     evidence about where either asset sits. A manual make-root is still final — it is not
     a claim about a pair, so there is nothing to fold.
  3. **Projection**: configured hierarchy levels (any raw/derived field, per-level
     boundary toggle) → level tree → system grouping → one structural parent + additive
     dependencies per asset. A level names its attributes separately (P0-6):
     `keyAttributeKey` is the grouping identity, `displayAttributeKey?` supplies the words
     and `boundaryAttributeKey?` is what the fold compares, both defaulting to the key —
     so re-describing a system re-labels a level node and moves nothing. A level written
     before the split carries one `attributeKey` and is migrated at the entry point
     (`migrateHierarchyConfig`). nativeDiscipline and ssmDiscipline are separate fields;
     ssm discipline comes from profile projection rules / top-parent inheritance / manual,
     and only acts as a boundary if enabled — the default preset leaves it off (P0-5), so a
     startup family that crosses native disciplines stays one branch.
  4. **Completeness** (audit blocker B3): `CompiledProject.completeness` counts how much of
     the site the compile actually described — assets nested vs rooted, assets no rung
     proposed a parent for, assets with no system, per-level `assetsWithoutValue` with a
     flag on the boundary levels that thereby stop every nesting, demotions per (level,
     rung), unresolved systems grouped by the resolver's own skip reasons, MEL rows
     dropped for saying nothing, and `approvedValues` — how much of the register the
     approved VF Exto lists would refuse: `upnNotApproved`, `systemNameNotApproved`
     (per UPN, not against the whole list), `disciplineNotApproved`,
     `classificationNotInList`, `itemMasterNotVf`, each with an asset count, ten
     code-unit-sorted example tags and the SSM Audit rule id that says the same thing in
     the reviewer's words. A blank cell is never counted — that is a different fact with a
     different fix. The overlap with the audit is deliberate and is not duplicated: these
     are the build's own accounting, the audit is the review, and no second review item is
     emitted for them. Read off what the fold and the resolver already decided;
     nothing is recomputed, so it cannot disagree with the snapshot it describes. The
     matching review items are counted rather than repeated: one `missing-boundary-level`
     per level, one `boundary-demotion` per (level, rung), one `unresolved-system` per
     distinct set of skip reasons. A per-asset `missing-boundary` survives only where a
     person's own decision was refused.
  5. **Snapshot**: immutable ResolvedSnapshot — deterministic (same inputs + profile →
     identical snapshot), cycle detection (structural cycles broken to review items, never
     silently), every decision provenance'd, losing claims retained.
- **`@matchline/asset-identity`** — the asset identity ledger (RELEASE-1.0-PLAN P0-9).
  Evidence order, strongest first: profile-mapped stable-id property → source-model
  persistent id + authoring object id, keyed on the pair (kind, id) so a Revit ElementId
  and an AutoCAD handle sharing the same digits never merge → source-model persistent id +
  InstanceGuid → structural (persistent id + root-relative child-index path + class,
  derived from tree shape only) → structural-key (schema v3's `objects.structural_key`, a
  digest of the ancestor chain of class/display-name/sibling-position from the model's
  root — weaker than `structural` because it folds display names in, stronger than `tag`
  because nothing a person edits changes it; absent on a pre-v3 cache) → tag (reconciliation
  only, reported as its own event). Content hash is never identity, so a re-extraction of an
  unchanged model moves nothing. `reconcileLedger` moves a ledger
  `{assetId, currentCanonicalTag, aliases, modelIdentities, status}` forward by one compile:
  a tier that names two previous entries identifies nothing and the walk falls through; one
  entry claimed by two assets SPLITS (both kept, event explains) and is never merged; an
  entry no asset claimed is flagged `disappeared` and never deleted. A `tag`-only match
  additionally raises a `possible-rematch` review item when nothing else agrees the two are
  the same thing (the previous entry last showed `disappeared`, or its sources and the
  current ones do not overlap) — the re-match still happens, but the person who knows the
  site gets a chance to say it was wrong. Plain JSON, because the project persists it.
- **`@matchline/compiler`** — the orchestrator that owns the E1 property-bag seam:
  model universe + spreadsheets + **SiteProfileV2** → asset catalog → **identity ledger** →
  subjects (property bags) → system resolution → identity → observations → claims →
  snapshot → outputs. The only package that knows the whole pipeline order. The ledger is
  spliced immediately after the catalog and before any stage keys on an id, so every stage
  below it reads ledger ids; stored manual decisions are re-addressed through the ledger in
  the same place, and one that cannot be becomes an `orphaned-decision` review item.
  `compileProject` takes the site's whole rule set as ONE value: `SiteProfileV2` carries the
  mappings and their chains, the filters, the anatomy, the resolver, the derived attribute
  registry, the hierarchy levels, the role graph, the ladder, the discipline projection, the
  explicit parent and stable-id properties and identity. What remains a separate input is what
  belongs to the PROJECT rather than the site — its sources, its workbooks, its people's manual
  decisions and its ledger. A profile stored before the consolidation is lifted by
  `migrateSiteProfileV1` (`@matchline/domain`); nothing inside the engine sees a V1.

## SSM Audit gate

The last thing a compile does, and the only stage that changes nothing.

`compileProject` finishes by handing the register it just built to
`@matchline/ssm-audit`, which runs the **SSM-Audit rulebook** over it and publishes
`CompiledProject.ssmAudit`. The question it answers is the one every other stage leaves
open: not "did the engine place this equipment", but "would Exto and the SSM SOP accept
what came out". A register that compiles cleanly and would be rejected on upload is a
failure that used to surface a day later, in somebody else's tool.

### The rulebook is vendored, never edited here

`packages/ssm-audit/vendor/` holds SSM-Audit's own `src/audit/engine.js`,
`src/audit/model.js`, `src/exto/rev21-contract.js`, `src/exto/vf-item-masters.js` and
`src/core/text.js` **byte for byte**, with their relative imports untouched, plus two shims
that complete the module graph — `io/workbook.js` (which the model layer imports and the
audit path never calls) and `xlsx-global.js` (the one SheetJS utility a browser page would
have put on `globalThis`). `packages/ssm-audit/test/parity.test.mjs` compares the five
vendored files against the SSM-Audit checkout whenever one is present and fails on any
difference; SSM-Audit pins the same files against its own integrated source, so the three
copies are held to one rulebook. A rule that needs changing is changed in SSM-Audit and
re-vendored. See DECISIONS.md.

### What the rules read

The audit rows are built through `@matchline/exto-export`'s own flattening, so the rulebook
sees exactly what the upload sheet would carry, cell for cell, rather than a second
flattening that could disagree with it. Three fields the Rev21 column map does not position
are filled from what the compile knows: **Equipment Description**, which the entire
commissioning-logic half of the rulebook reads (a VESDA, an RIO, a heat-trace panel are
recognised by description); **Closest Parent Status**, written `NEW` exactly when Matchline
can see the parent — another row of this upload, or the row's own System Name — and blank
otherwise, because `NEW` asserts that the parent row is created by this upload and blanket
`NEW` would silence the blocker that catches a Closest Parent naming nothing; and the two
**milestone** levels, blank, because no P6 schedule reaches a compile and the rulebook
checks milestones only when a project uses them.

### Findings, and how they reach a person

Each finding carries the rulebook's own words — `why`, `expected`, `recommendation`, the
rule's `statement` — verbatim, plus the two things only Matchline can add: the compiled
`assetId` behind the tag, resolved through the identity index's exact-tag rung, and the same
for the related equipment. A tag naming no asset, or naming two, keeps `assetId: null`; a
duplicated tag is exactly what one of these rules reports, and picking one of the two would
file the finding against equipment nobody chose.

They arrive in the one review queue as the `ssm-audit` kind. `blocker`, `error` and
`warning` are each about one row and stay per asset; `info` is a note about a practice, and a
real register carries thousands, so notes aggregate to one item per rule with a count and ten
examples — the same rule the B-series aggregates follow. The review key is the rule, the
equipment (asset id, or the tag when no asset answers to it), the field and the value found:
not the sentences, so a reworded message never orphans a decision.

### Severities

`blocker` (Exto would refuse the row) · `error` (an SSM SOP rule is broken) · `warning`
(worth a look, often deliberate) · `info` (a note). Screen 8 counts them beside Completeness
and every count opens the queue filtered to it; screen 9 draws the blockers as a warning above
Save — a warning, never a refusal, because a blocker is a fact about the register a compile
produced and not about the profile being published.

### The publish gate, and the export's own spelling

Two of the approved-value counts refuse a publication outright, because Exto refuses the
whole upload over one such cell: a **UPN** outside the dropdown and a **Discipline** outside
it. `publishBlockersFor` reads them off the LAST compile's report and never recomputes them,
so screen 9 cannot disagree with screen 8; a project that has never compiled states nothing
here rather than nothing-is-wrong, and does not block, because "we have not looked" is not a
finding. Each blocker names the count, three example tags and the screen to fix it on. An
unapproved **System Name** is a warning listed beside them — Exto accepts the row, and then
nobody searching for that system finds the equipment on it. Classification and Item Master
are informational counts on screen 8 only.

The refusal is made only to a project whose profile says it delivers to Exto — an
`upn-from-tag` or `exto-system-name` rung, or `applyIcDisciplineRule`. The EXTO layer is
optional in exactly the sense `@matchline/exto-export` sets out, so a plant on its own
numbering is told the same numbers as warnings and is not stopped over somebody else's
dropdown. The compile gate reads the DRAFT blockers only: a compile refused because the
previous compile found something would leave a project unable to look again.

`@matchline/exto-export` prints the approved spelling of a dropdown-backed cell — `upn`,
`discipline`, `wbs`, `systemName`, `equipmentClassification` — when the value matches one
case- and whitespace-insensitively, and prints a non-matching value verbatim. It takes the
canonicaliser as an option rather than importing the vocabulary: `@matchline/ssm-audit`
already depends on the exporter, so the other direction would close a cycle. The desktop
export path supplies `extoRev21Canonical` and counts the rewritten cells in the export note.
The audit's own row builder deliberately does NOT, because auditing a copy the export had
already corrected would report a site as compliant because of what happened on the way out.

### Switching a rule off

`SiteProfileV2.ssmAudit.disabledRuleIds` names rules whose findings this site does not want
to be told about again. The rule still **runs** — `checksRun` counts every check, so the
number stays comparable between compiles — and what is dropped is its findings, its queue
rows and its place in the exported report. A site cannot reword a rule, re-grade it, or add
one: the rulebook is shared, and a local edit would mean two apps disagreeing about one SOP.

## Binding semantics (all stages)

1. Model-first: the asset universe comes ONLY from the extraction cache. MEL rows never
   create assets in E1 (MEL_ONLY discrepancy records arrive with identity work in E2).
2. Every resolved value carries provenance (source, property/column, rule/component,
   fallback rung). Losing claims are retained.
3. Determinism: same cache + same profile → identical outputs, byte-stable exports.
4. No profile fallback value may drive a structural decision (donor invariant 2 carries over).
5. Asset identity is the ledger's, not the model content's: a corrected tag keeps its
   assetId, decisions recorded against it survive, and a revision diff reports a tag change
   rather than a removal and an addition. A decision that cannot be re-addressed is
   reported, never dropped.
