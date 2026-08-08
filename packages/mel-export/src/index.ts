/**
 * `@matchline/mel-export` — the canonical generated MEL.
 *
 * Matchline's canonical model can describe a site more completely than the MEL
 * the project started with, and that generated MEL is a product deliverable in
 * its own right (PRODUCT.md §2.7). This package is the last step of it: the
 * §12.1 column contract, compiled assets rendered onto it as typed rows, and
 * those rows written out as .xlsx.
 *
 * Two layers, either usable alone:
 *
 * - {@link buildCanonicalMelRows} — assets → ordered typed rows. Pure, no
 *   workbook involved; this is what a preview grid or a diff should read.
 * - {@link writeCanonicalMelWorkbook} — the same rows as .xlsx bytes, written
 *   through `@matchline/spreadsheet-import`'s vendored SheetJS. Every cell is
 *   text, and the bytes are stable across runs.
 *
 * The input, {@link GeneratedMelAsset}, is this package's own flattened shape
 * rather than another package's output type, so the exporter stays independent
 * of how the catalog and the resolver evolve.
 */

export {
  CANONICAL_MEL_COLUMNS,
  CANONICAL_MEL_HEADERS,
  canonicalMelCells,
} from './columns.js';
export type { CanonicalMelColumn, CanonicalMelField, CanonicalMelRow } from './columns.js';

export { buildCanonicalMelRows } from './rows.js';
export type { GeneratedMelAsset } from './rows.js';

export { DEFAULT_MEL_SHEET_NAME, writeCanonicalMelWorkbook } from './workbook.js';
export type { WriteCanonicalMelOptions } from './workbook.js';
