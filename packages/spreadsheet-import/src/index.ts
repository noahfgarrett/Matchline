/**
 * `@matchline/spreadsheet-import` — workbook reads for the engine.
 *
 * Three layers, each usable on its own:
 *
 * - {@link readWorkbook} / {@link writeWorkbook} — the typed boundary around
 *   the vendored SheetJS bundle. Macros are never executed; see `src/xlsx.ts`.
 * - {@link sheetAoa} — the donor's dense/sparse worksheet scan, ported with its
 *   byte-parity invariant intact.
 * - {@link readMappedTable} / {@link readMelTable} — records under an explicit
 *   caller-supplied column mapping. No detection heuristics in E1.
 */

export { sheetAoa } from './aoa.js';
export type { SheetAoa } from './aoa.js';

export { SpreadsheetReadError, describeSpreadsheetReadReason } from './errors.js';
export type { MissingColumn, SpreadsheetReadReason } from './errors.js';

export { MEL_FIELDS, readMelTable } from './mel.js';
export type { MelField, MelMapping, MelReadStats, MelTable, OptionalMelField } from './mel.js';

export { readMappedTable } from './table.js';
export type {
  HeaderMatch,
  MappedColumn,
  MappedTable,
  ReadMappedTableOptions,
} from './table.js';

export {
  isDenseWorksheet,
  readWorkbook,
  worksheetRef,
  writeWorkbook,
  VENDOR_SHEETJS_PATH,
} from './xlsx.js';
export type {
  CellInput,
  DenseWorksheet,
  DenseWorksheetRow,
  ReadWorkbookOptions,
  SheetInput,
  SparseWorksheet,
  WorkbookHandle,
  Worksheet,
  WorksheetCell,
} from './xlsx.js';
