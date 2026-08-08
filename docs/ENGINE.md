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
  includes, component collapse (a matched asset absorbs its descendants unless a descendant
  independently matches — "separately commissionable subcomponents"). Duplicate model tags
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

### Semantics rules (binding)

1. Model-first: the asset universe comes ONLY from the extraction cache. MEL rows never
   create assets in E1 (MEL_ONLY discrepancy records arrive with identity work in E2).
2. Every resolved value carries provenance (source, property/column, rule/component,
   fallback rung). Losing claims are retained.
3. Determinism: same cache + same profile → identical outputs, byte-stable exports.
4. No profile fallback value may drive a structural decision (donor invariant 2 carries over).
