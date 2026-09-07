/**
 * A shim, not a vendored file.
 *
 * `vendor/audit/model.js` imports `sheetAoaAsync` from here because SSM-Audit
 * reads its rows out of a workbook a person picked. Matchline never does: the
 * rows are built from the compiled project (`src/rows.ts`), so nothing on the
 * audit path calls this. It exists so the vendored module graph resolves with
 * its own relative import paths unchanged, and it is implemented rather than
 * left throwing so that a future caller gets a worksheet scan, not a surprise.
 *
 * `@matchline/spreadsheet-import` exports `sheetAoa` -- the same dense/sparse
 * scan, with the same `{aoa, rowNums}` shape and the same byte-parity
 * invariant -- so this is an async wrapper over it rather than a second
 * implementation of it. `onChunk` is called once, at the end: the underlying
 * reader is synchronous, so there is no midpoint to report from, and inventing
 * progress nobody measured would be a number that means nothing.
 */
import { sheetAoa } from '@matchline/spreadsheet-import';

export async function sheetAoaAsync(sheet, onChunk) {
  const parsed = sheetAoa(sheet);
  if (onChunk) await onChunk(parsed.aoa.length, parsed.aoa.length);
  return parsed;
}
