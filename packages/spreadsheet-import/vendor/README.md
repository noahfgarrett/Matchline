# Vendored SheetJS

`sheetjs.js` is **xlsx-js-style 1.2.0-beta** (SheetJS `0.18.5`), copied here **byte-identically**
from the frozen donor.

| | |
|---|---|
| Donor path | `packages/legacy-parity/src/vendor/sheetjs.js` |
| SHA-256 | `f32ff938c11a1beae2fb3774b7a00e02d3f78c9f9f01c2e501f80bdfaaa60db7` |
| Size | 425,022 bytes |
| Verified with | `cmp` (identical) and `shasum -a 256` |

The donor copy was **copied, never moved** — `packages/legacy-parity/` stays untouched, and its
own build and 656-test suite continue to run against its own copy.

`test/vendor-integrity.test.mjs` re-hashes both files on every run and fails if either drifts
from the constant above, so the two copies cannot silently diverge and this package cannot
silently acquire a different SheetJS.

## Why a copy instead of an npm dependency

Zero npm dependencies is a standing rule for the engine packages (supply-chain surface). The
donor already froze this exact build, and the AoA scan ported into `src/aoa.ts` must stay
byte-parity with the donor's — which means the same parser, not merely a compatible one.

## Why `package.json` sits next to it

`{ "type": "commonjs" }` marks this directory as non-ESM so the `.js` bundle is not treated as
an ES module by the `"type": "module"` package around it. It is a marker file only.

> Note: the loader in `src/xlsx.ts` does **not** in fact `require()` the bundle — under the
> CommonJS path the bundle's header calls `require('./cpexcel.js')`, a codepage table the
> browser build does not ship, and would throw. It is evaluated the way the donor evaluates
> it (browser globals path) instead. The marker stays because it keeps Node from ever
> attempting to parse a 425 KB sloppy-mode script as ESM.

## Macros

The bundle is a parser: it contains no formula evaluator and no macro interpreter. On top of
that, `src/xlsx.ts` pins `bookVBA: false`, so a workbook's `vbaProject.bin` — where VBA macros
live — is discarded during parsing rather than merely left unexecuted, and `bookFiles: false`,
so raw archive entries are not retained either.

## Updating

Don't, in E1. If a future stage needs a newer SheetJS, it is a deliberate deviation: record it
in `docs/ORIGIN.md`'s deviation log, re-run the donor's `tests/aoa-dense.test.mjs` equivalent,
and update the hash above and in `test/vendor-integrity.test.mjs` in the same commit.
