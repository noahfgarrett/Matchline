/**
 * Reading a sheet as records, driven by an explicit column mapping.
 *
 * E1 does no auto-detection: the caller says which header text carries which
 * field and which row the headers are on. Heuristic detection is E2's job
 * (docs/ENGINE.md). A mapping that does not fit the sheet is an error, never a
 * guess — silently reading the wrong column is how wrong tags reach an
 * engineer's screen.
 *
 * ## Header matching
 *
 * Each mapped header is looked for twice, and which pass matched is reported on
 * every column so the caller can surface "we matched 'System Description' to
 * 'system  description'" rather than pretending it was exact:
 *
 * 1. `exact` — the header cell equals the requested text, byte for byte.
 * 2. `trimmed-case-insensitive` — both sides trimmed and lowercased.
 *
 * The exact pass runs across the whole header row before the loose pass does,
 * so an exact match always beats a loose one no matter which column it sits in.
 * Within a pass the leftmost column wins, which makes the result deterministic
 * on sheets that repeat a header.
 *
 * ## Values
 *
 * Cells arrive from {@link sheetAoa} already stringified — display text Excel
 * cached, or `format_cell` output — so nothing here re-parses or re-formats
 * anything. The only transform is `.trim()`, matching the donor's `clean()`
 * (`packages/legacy-parity/src/core/text.js`). A text cell holding `'001'`
 * stays `'001'`; a numeric cell holding `1` reads as `'1'`. Those two are
 * genuinely different facts about the workbook, and telling them apart is the
 * system-resolver's normalization problem, not this reader's.
 */

import { SpreadsheetReadError } from './errors.js';
import type { MissingColumn } from './errors.js';

/** Which pass matched a header. */
export type HeaderMatch = 'exact' | 'trimmed-case-insensitive';

/** How one mapped field was bound to a column. */
export interface MappedColumn<Field extends string> {
  readonly field: Field;
  /** The header text the caller asked for. */
  readonly header: string;
  /** The header text actually found on the sheet. */
  readonly matchedHeader: string;
  /** Zero-based column index within the AoA. */
  readonly columnIndex: number;
  readonly match: HeaderMatch;
}

/** The result of {@link readMappedTable}. */
export interface MappedTable<Field extends string> {
  /** One entry per mapped field, in the mapping's own key order. */
  readonly columns: ReadonlyArray<MappedColumn<Field>>;
  /** One record per non-blank data row, in sheet order. */
  readonly rows: ReadonlyArray<Readonly<Record<Field, string>>>;
  /** The header row index that was used. */
  readonly headerRow: number;
  /** Data rows examined, blank ones included. */
  readonly scannedRowCount: number;
  /** Data rows dropped because every mapped column was empty. */
  readonly blankRowCount: number;
}

/** Options for {@link readMappedTable}. */
export interface ReadMappedTableOptions {
  /** Zero-based AoA row index holding the headers. Data starts below it. */
  readonly headerRow: number;
}

/**
 * Read an AoA as records under an explicit `{ field: columnHeader }` mapping.
 *
 * @throws {SpreadsheetReadError} `empty-mapping` when the mapping names no
 * fields, `header-row-out-of-range` when the header row is not in the sheet,
 * and `missing-columns` — listing every available header — when a mapped
 * header is not on the header row.
 */
export function readMappedTable<Field extends string>(
  aoa: ReadonlyArray<ReadonlyArray<string>>,
  mapping: Readonly<Record<Field, string>>,
  options: ReadMappedTableOptions,
): MappedTable<Field> {
  const fields = Object.keys(mapping) as Field[];
  if (fields.length === 0) throw new SpreadsheetReadError({ kind: 'empty-mapping' });

  const { headerRow } = options;
  const headerCells = aoa[headerRow];
  if (!Number.isInteger(headerRow) || headerRow < 0 || headerCells === undefined) {
    throw new SpreadsheetReadError({
      kind: 'header-row-out-of-range',
      headerRow,
      rowCount: aoa.length,
    });
  }

  const columns: MappedColumn<Field>[] = [];
  const missing: MissingColumn[] = [];
  for (const field of fields) {
    const header = mapping[field];
    const found = locateHeader(headerCells, header);
    if (found === undefined) missing.push({ field, header });
    else columns.push({ field, header, ...found });
  }
  if (missing.length > 0) {
    throw new SpreadsheetReadError({
      kind: 'missing-columns',
      missing,
      availableHeaders: headerCells.map((cell) => cell.trim()).filter((cell) => cell !== ''),
    });
  }

  const rows: Array<Readonly<Record<Field, string>>> = [];
  let blankRowCount = 0;
  for (let r = headerRow + 1; r < aoa.length; r++) {
    const cells = aoa[r];
    if (cells === undefined) continue;
    const record = {} as Record<Field, string>;
    let anyValue = false;
    for (const column of columns) {
      const raw = cells[column.columnIndex];
      const value = raw === undefined ? '' : raw.trim();
      if (value !== '') anyValue = true;
      record[column.field] = value;
    }
    if (anyValue) rows.push(record);
    else blankRowCount++;
  }

  return {
    columns,
    rows,
    headerRow,
    scannedRowCount: Math.max(0, aoa.length - headerRow - 1),
    blankRowCount,
  };
}

/** Where a header sits and how it matched, or `undefined` if it is absent. */
function locateHeader(
  headerCells: ReadonlyArray<string>,
  header: string,
): { readonly matchedHeader: string; readonly columnIndex: number; readonly match: HeaderMatch } | undefined {
  const exact = headerCells.indexOf(header);
  if (exact !== -1) {
    return { matchedHeader: header, columnIndex: exact, match: 'exact' };
  }
  const wanted = fold(header);
  for (let c = 0; c < headerCells.length; c++) {
    const cell = headerCells[c];
    if (cell === undefined) continue;
    if (fold(cell) === wanted) {
      return { matchedHeader: cell, columnIndex: c, match: 'trimmed-case-insensitive' };
    }
  }
  return undefined;
}

/**
 * The loose-comparison form of a header. `toLowerCase()` without a locale
 * argument is deliberate: locale-aware casing would make the same workbook read
 * differently on different machines.
 */
function fold(value: string): string {
  return value.trim().toLowerCase();
}
