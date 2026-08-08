/** Helpers shared by the scheduling tests. */

import { readWorkbook, sheetAoa, writeWorkbook } from '@matchline/spreadsheet-import';

/**
 * An AoA through real .xlsx bytes and back.
 *
 * The sheet readers take a `SheetAoa`, and building one by hand would skip the
 * part most likely to break: what the vendored writer and scan actually do to
 * blank rows and to text that looks numeric.
 */
export function sheetFrom(aoa, sheetName = 'Activities') {
  const bytes = writeWorkbook([{ name: sheetName, aoa }]);
  const workbook = readWorkbook(bytes);
  return sheetAoa(workbook.getSheet(sheetName));
}

/** Read a written workbook's first sheet back as an AoA. */
export function readSheet(bytes, sheetName) {
  const workbook = readWorkbook(bytes);
  return sheetAoa(workbook.getSheet(sheetName)).aoa;
}

/**
 * A fixed reordering of a list.
 *
 * Deterministic on purpose: a randomized shuffle would make a determinism
 * failure unreproducible, which is the opposite of the point.
 */
export function reorder(items) {
  const odd = items.filter((_, index) => index % 2 === 1);
  const even = items.filter((_, index) => index % 2 === 0);
  return [...odd.reverse(), ...even.reverse()];
}
