/**
 * The donor's worksheet → array-of-arrays scan, ported unchanged in behavior.
 *
 * Source: `packages/legacy-parity/src/io/workbook.js` (`scanCells`,
 * `scanDenseRows`, `assembleAoa`, `sheetAoa`).
 *
 * ## Donor invariant carried over
 *
 * A workbook may be handed to us dense (`XLSX.read(..., { dense: true })`, an
 * array of row arrays) or sparse (address-keyed). The two paths must produce
 * byte-identical output — every stage downstream of this one consumes the AoA,
 * so a divergence between them would be a silent, shape-dependent difference in
 * what the engine thinks the workbook says. `test/aoa-dense.test.mjs` proves it
 * the way the donor's `tests/aoa-dense.test.mjs` does: read the same bytes both
 * ways and compare the serialized results.
 *
 * ## Semantics, restated so a future edit cannot drift
 *
 * - A sheet with no `!ref` yields `{ aoa: [], rowNums: [] }`.
 * - A cell counts as present when any of `v`, `f`, `w` is non-null; a cell
 *   holding only formatting is skipped.
 * - A cell's value is its cached display text `w` when present, otherwise
 *   `XLSX.utils.format_cell(cell)`. Values are never re-formatted by locale and
 *   never re-parsed as numbers — text `'001'` stays `'001'`.
 * - Rows that ended up with no cells at all are dropped, so AoA row `i` is not
 *   worksheet row `i`; `rowNums[i]` is the zero-based worksheet row it came
 *   from.
 * - Every emitted row is padded with `''` to a common width of `maxCol + 1`,
 *   where `maxCol` starts at 0 — so even an empty-ish sheet is one column wide.
 *
 * The donor's chunked `sheetAoaAsync` is deliberately not ported: it exists to
 * yield to a browser progress ring, and this package has no UI.
 */

import { decodeCell, formatCell, isDenseWorksheet, worksheetRef } from './xlsx.js';
import type { DenseWorksheet, SparseWorksheet, Worksheet } from './xlsx.js';

/** A scanned worksheet: the padded value grid and its source row numbers. */
export interface SheetAoa {
  /** Rows of display text, all the same width. Never holds `undefined`. */
  readonly aoa: ReadonlyArray<ReadonlyArray<string>>;
  /** `rowNums[i]` is the zero-based worksheet row that produced `aoa[i]`. */
  readonly rowNums: readonly number[];
}

/** Mutable accumulator shared by both scan paths, as in the donor. */
interface ScanState {
  readonly rows: Map<number, Map<number, string>>;
  maxCol: number;
}

/** Donor's address filter: at most three column letters and a row number. */
const CELL_ADDRESS = /^[A-Z]{1,3}\d+$/;

/** Scan a worksheet into a padded array of arrays. */
export function sheetAoa(worksheet: Worksheet | undefined): SheetAoa {
  if (!worksheet || !worksheetRef(worksheet)) return { aoa: [], rowNums: [] };
  const state: ScanState = { rows: new Map(), maxCol: 0 };
  if (isDenseWorksheet(worksheet)) scanDenseRows(worksheet, state);
  else scanCells(worksheet, state);
  return assembleAoa(state);
}

/** Sparse path: walk every own key, keep the ones that look like addresses. */
function scanCells(worksheet: SparseWorksheet, state: ScanState): void {
  for (const address of Object.keys(worksheet)) {
    if (address[0] === '!' || !CELL_ADDRESS.test(address)) continue;
    const cell = worksheet[address];
    if (!cell || typeof cell === 'string') continue;
    if (cell.v == null && cell.f == null && cell.w == null) continue;
    const position = decodeCell(address);
    const value = cell.w != null ? cell.w : formatCell(cell);
    let row = state.rows.get(position.r);
    if (!row) {
      row = new Map();
      state.rows.set(position.r, row);
    }
    row.set(position.c, value);
    if (position.c > state.maxCol) state.maxCol = position.c;
  }
}

/**
 * Dense path: row and column indices are already known, so the address regex,
 * `decode_cell`, and the whole-object key walk all disappear.
 */
function scanDenseRows(worksheet: DenseWorksheet, state: ScanState): void {
  for (let r = 0; r < worksheet.length; r++) {
    const cells = worksheet[r];
    if (!cells) continue;
    let row: Map<number, string> | null = null;
    for (let c = 0; c < cells.length; c++) {
      const cell = cells[c];
      if (!cell || (cell.v == null && cell.f == null && cell.w == null)) continue;
      if (row === null) {
        row = state.rows.get(r) ?? new Map();
        state.rows.set(r, row);
      }
      row.set(c, cell.w != null ? cell.w : formatCell(cell));
      if (c > state.maxCol) state.maxCol = c;
    }
  }
}

/** Rows in worksheet order, padded to a common width with `''`. */
function assembleAoa(state: ScanState): SheetAoa {
  const entries = [...state.rows.entries()].sort(([a], [b]) => a - b);
  const width = state.maxCol + 1;
  const rowNums = entries.map(([rowNum]) => rowNum);
  const aoa = entries.map(([, cells]) => {
    const row = new Array<string>(width);
    for (let c = 0; c < width; c++) {
      const value = cells.get(c);
      row[c] = value === undefined ? '' : value;
    }
    return row;
  });
  return { aoa, rowNums };
}
