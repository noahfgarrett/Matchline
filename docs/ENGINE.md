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
  `alias`, `unicodeFold`) are explicit profile steps — never silent (leading zeros!).
  `unicodeFold` is the one shared implementation (`@matchline/domain`): NFKC, zero-width
  strip, dash-family fold, NBSP, whitespace around hyphens, run identically by identity and
  by the resolver, because a tag that folds one way in one stage and another way in the
  other joins in one and not the other. System identifiers
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
     rung), unresolved systems grouped by the resolver's own skip reasons, and MEL rows
     dropped for saying nothing. Read off what the fold and the resolver already decided;
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
  persistent id + authoring object id → source-model persistent id + InstanceGuid →
  deterministic structural key (persistent id + root-relative child-index path + class) →
  tag (reconciliation only, reported as its own event). Content hash is never identity, so
  a re-extraction of an unchanged model moves nothing. `reconcileLedger` moves a ledger
  `{assetId, currentCanonicalTag, aliases, modelIdentities, status}` forward by one compile:
  a tier that names two previous entries identifies nothing and the walk falls through; one
  entry claimed by two assets SPLITS (both kept, event explains) and is never merged; an
  entry no asset claimed is flagged `disappeared` and never deleted. Plain JSON, because
  the project persists it.
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
