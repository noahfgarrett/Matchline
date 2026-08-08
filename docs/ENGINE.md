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
  `model-field | tag-segment | mel-lookup | direct-column | composite | manual`. Each
  component yields an AttributeClaim for systemKey/systemDescription with provenance; the
  chain takes the first success for the *resolved* value but KEEPS all claims. Disagreement
  between components = System Conflict review item unless profile precedence explicitly
  covers it. Normalization transforms (`trim`, `uppercase`, `stripPrefix`, `padStart`,
  `alias`) are explicit profile steps — never silent (leading zeros!). System identifiers
  are strings, always. Also builds the System Catalog from a supplied MEL (systemKey →
  description, aliases, multi-description conflicts as review items).
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
     relationship → profile lookup → flow-anchored family → family+role → accepted learned
     model → prior SSM example → model-tree suggestion → root of grouping. First tier with
     exactly one candidate wins; a tier with >1 equal candidates = ambiguous-parent review
     item and the ladder STOPS (no fall-through guessing — same rule as identity).
  2. **Boundary fold** (§11.3, DECISIONS.md #1 — hard boundaries, NO feed-chain exception):
     for the selected parent, all enabled boundary keys known and equal → structural parent;
     any enabled boundary differs → parent removed, demoted to dependency of the child,
     child re-resolves in its own grouping or roots; any REQUIRED boundary value missing →
     no structural decision — review or provisional-root per profile policy. Explicit
     attributes only: a profile fallback value never feeds a boundary comparison.
  3. **Projection**: configured hierarchy levels (any raw/derived field, per-level
     boundary toggle) → level tree → system grouping → one structural parent + additive
     dependencies per asset. nativeDiscipline and ssmDiscipline are separate fields; ssm
     discipline comes from profile projection rules / top-parent inheritance / manual, and
     only acts as a boundary if enabled.
  4. **Snapshot**: immutable ResolvedSnapshot — deterministic (same inputs + profile →
     identical snapshot), cycle detection (structural cycles broken to review items, never
     silently), every decision provenance'd, losing claims retained.
- **`@matchline/compiler`** — the orchestrator that owns the E1 property-bag seam:
  extraction cache + spreadsheets + SiteProfile → asset catalog → subjects (property bags)
  → system resolution → identity → observations → claims → snapshot → outputs. The only
  package that knows the whole pipeline order.

## Binding semantics (all stages)

1. Model-first: the asset universe comes ONLY from the extraction cache. MEL rows never
   create assets in E1 (MEL_ONLY discrepancy records arrive with identity work in E2).
2. Every resolved value carries provenance (source, property/column, rule/component,
   fallback rung). Losing claims are retained.
3. Determinism: same cache + same profile → identical outputs, byte-stable exports.
4. No profile fallback value may drive a structural decision (donor invariant 2 carries over).
