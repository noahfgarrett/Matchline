# ORIGIN — fork provenance

Matchline is forked from **SSManagement 4.2.2**.

- **Origin repo:** `noahfgarrett/SSManagement` (private); local checkout `~/Codebase/SSManagement`
- **Origin commit:** `cb07f40` ("merge: fix PMD canonical claim collisions"), tagged here as **`ssmanagement-origin-4.2.2`**
- **Fork date:** 2026-08-07
- **Method:** full history-preserving clone. The entire donor tree was relocated unchanged into
  `packages/legacy-parity/` — its git tree hash is bit-identical to the origin tag's root tree
  (`0c6f5d4a4063660d7ce2d828ff65336e2253fb68`), covering the golden fixtures and the literal
  U+0001 KEYSEP bytes in donor sources.
- **SSManagement remains unchanged** and continues its own life; its retired predecessor
  (SSManagement-Legacy) is untouched and out of scope.

## What legacy-parity is

`packages/legacy-parity/` is the frozen, runnable donor: its own `package.json`, build
(`npm run build` → single-file `SSManagement.html`), and full test suite (656 tests via the
node --test VM harness). It exists so donor behavior stays reproducible while Matchline's
TypeScript packages are built alongside it.

Parity policy (locked decision, see DECISIONS.md): the donor suite is kept green as an
archive; only a **targeted subset** of behaviors Matchline actually inherits (partition fold,
claims resolution, tag identity) gets ported as executable parity tests in the new packages.
Donor goldens (`packages/legacy-parity/tests/golden/*.json`) are never regenerated.

## Deviation log

Every deliberate behavioral deviation from the donor is recorded here as it happens.

| # | Date | Deviation | Rationale |
|---|------|-----------|-----------|
| 1 | 2026-08-07 | Single-file HTML build constraint dropped; normal monorepo workspace (Electron/React/TS planned). | Desktop app with native extraction worker cannot be a single HTML file. |
| 2 | 2026-08-07 | Authority inverted: Navisworks model is the asset universe and naming authority; MEL demoted to enrichment/validation/lookup. | Core Matchline product thesis (docs/PRODUCT.md §2.1). |
| 3 | 2026-08-07 | Feed-chain exception dropped from the SSM projection: building/discipline/system are hard boundaries; cross-boundary feeds always demote to dependencies. Feed chains remain intact only in the Electrical Flow view. | Noah's decision, 2026-08-07 (DECISIONS.md #1). |
