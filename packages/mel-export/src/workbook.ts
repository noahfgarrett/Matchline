/**
 * Canonical MEL rows → .xlsx bytes.
 *
 * The workbook is written through `@matchline/spreadsheet-import`'s vendored
 * SheetJS, which is the only copy of that library anywhere in the engine.
 *
 * ## Every cell is text
 *
 * The sheet is built from a `string[][]`, so `aoa_to_sheet` produces `t: 's'`
 * cells throughout and a System Key of `'001'` reaches Excel as `'001'` rather
 * than collapsing to the number 1. This is not a formatting preference: system
 * identifiers are strings (PRODUCT.md §5.5), and a key that loses its leading
 * zeros no longer joins to the System Catalog. Numbers are rendered to text in
 * `rows.ts`, before a value can become a cell, and {@link CanonicalMelRow} has
 * no numeric members for one to slip through.
 *
 * ## Byte stability (docs/ENGINE.md rule 3)
 *
 * Two runs over the same assets produce identical bytes — the same file hash,
 * in different processes, on different days. The vendored bundle writes no
 * document timestamps unless a workbook carries `Props` (this one does not, so
 * `docProps/core.xml` has no `dcterms:created`), and it stamps every zip entry
 * with the fixed 1980 DOS epoch rather than the wall clock. No write option
 * needs pinning, and the tests hold that: one writes a workbook in a child
 * process whose `Date` is faked to 2099 and asserts the bytes are unchanged, so
 * a vendor bump that started embedding a clock would fail rather than quietly
 * ending byte stability.
 */

import { writeWorkbook } from '@matchline/spreadsheet-import';

import type { CanonicalMelRow } from './columns.js';
import { CANONICAL_MEL_HEADERS, canonicalMelCells } from './columns.js';
import type { GeneratedMelAsset } from './rows.js';
import { buildCanonicalMelRows } from './rows.js';

/** The sheet name used when the caller does not choose one. */
export const DEFAULT_MEL_SHEET_NAME = 'MEL';

/** Options for {@link writeCanonicalMelWorkbook}. */
export interface WriteCanonicalMelOptions {
  /**
   * Sheet name. Defaults to {@link DEFAULT_MEL_SHEET_NAME}. Excel's own rules
   * apply — 31 characters, and no character it forbids — and a name that breaks
   * them raises `SpreadsheetReadError` (`invalid-sheet-name`) from the writer
   * rather than producing a file that will not open.
   */
  readonly sheetName?: string;
}

/**
 * Write the canonical generated MEL: header row, then one row per asset in
 * {@link buildCanonicalMelRows} order.
 *
 * An empty asset list is not an error — it yields a header-only sheet, which is
 * a truthful export of a project whose filters admitted nothing, and still a
 * workbook Excel opens.
 */
export function writeCanonicalMelWorkbook(
  assets: ReadonlyArray<GeneratedMelAsset>,
  options: WriteCanonicalMelOptions = {},
): Uint8Array {
  const aoa: ReadonlyArray<ReadonlyArray<string>> = canonicalMelAoa(
    buildCanonicalMelRows(assets),
  );
  return writeWorkbook([{ name: options.sheetName ?? DEFAULT_MEL_SHEET_NAME, aoa }]);
}

/** Header row followed by the data rows, all cells text. */
function canonicalMelAoa(
  rows: ReadonlyArray<CanonicalMelRow>,
): ReadonlyArray<ReadonlyArray<string>> {
  return [[...CANONICAL_MEL_HEADERS], ...rows.map(canonicalMelCells)];
}
