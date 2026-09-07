/**
 * The `globalThis.XLSX` the vendored files expect a browser page to have set.
 *
 * SSM-Audit is a single HTML page that loads SheetJS as a script tag, so its
 * `vendor/audit/model.js` reads a bare `XLSX` global in `auditColumnName` --
 * the one function of the rulebook that is UI-only. Matchline has no such
 * global, and a `ReferenceError` from a helper nothing on the audit path calls
 * would be a crash with no cause on screen.
 *
 * So this defines the one utility that helper needs, and only if nothing else
 * already claimed the name: a spreadsheet column letter from a zero-based
 * index. It is a definition, not a stub -- `auditColumnName(27)` answers `AB`
 * here exactly as it does in the browser -- because a shim that returned
 * something plausible and wrong is worse than one that throws.
 *
 * Importing this module for its side effect is what `src/index.ts` does before
 * it touches the rulebook. It is deliberately not a dependency on the vendored
 * SheetJS bundle: one function is not worth loading a spreadsheet library the
 * audit path never otherwise reaches.
 */

/** `XLSX.utils.encode_col`: 0 -> `A`, 25 -> `Z`, 26 -> `AA`. */
function encodeCol(index) {
  let column = '', value = Math.trunc(Number(index));
  if (!Number.isFinite(value) || value < 0) return 'A';
  for (value += 1; value > 0; value = Math.floor((value - 1) / 26)) {
    column = String.fromCharCode(65 + ((value - 1) % 26)) + column;
  }
  return column;
}

const existing = globalThis.XLSX;
if (existing === undefined) {
  globalThis.XLSX = { utils: { encode_col: encodeCol } };
} else if (existing.utils !== undefined && existing.utils.encode_col === undefined) {
  existing.utils.encode_col = encodeCol;
}

export { encodeCol };
