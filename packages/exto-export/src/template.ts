/**
 * EXTO template mode: write the register on the site's own sheet.
 *
 * `columns.ts` holds Matchline's generic Rev21 map — a good default and a
 * truthful one, but it is *a* layout, not *the* layout. A site that already
 * maintains its registry by hand has a sheet of its own: a particular width, a
 * particular header row, particular wording, and columns Matchline knows nothing
 * about and has no business filling. The deliverable that site wants is its own
 * sheet with the compiled facts in it — not Matchline's sheet with its facts in
 * it.
 *
 * So the site supplies that workbook once. {@link analyzeExtoTemplate} captures
 * its header row exactly as it stands, works out which of those headers name
 * something this package can fill, and returns a small JSON value. The desktop
 * stores that value in the project file. Every later EXTO export is written on
 * it.
 *
 * ## Two steps, deliberately separate
 *
 * - {@link analyzeExtoTemplate} reads bytes and reports. It writes nothing.
 * - `writeExtoWorkbook(rows, { template })` writes from the captured value and
 *   takes no template bytes at all. The captured headers *are* the column list,
 *   so a template file that has moved or changed on disk since capture cannot
 *   silently change an export, and what the user reviewed is what ships.
 *
 * This is the same split `@matchline/mel-export`'s site-template flow makes, for
 * the same reason.
 *
 * ## What matching will and will not do
 *
 * A header is bound to a field when it matches one of the generic Rev21 headers
 * in `EXTO_REV21_COLUMNS` exactly, or matches it ignoring surrounding space and
 * case. That is the whole rule. There is no synonym table and no fuzzy match,
 * because a column filled from a guess is indistinguishable, in the delivered
 * file, from a column filled from a fact.
 *
 * Everything unmatched stays blank — Matchline writes the template's header text
 * back and puts nothing under it. That is not a limitation to be worked around
 * later: a registry sheet routinely carries columns that are somebody else's to
 * fill, including personal contact details, and the only safe thing to write
 * into a column this package does not understand is nothing at all.
 *
 * ## The captured value carries no site data
 *
 * {@link ExtoTemplate} holds header text, a row index and a field-to-column
 * list. It never holds a data row. A template is a layout, and a layout is all
 * that is captured.
 */

import { SpreadsheetReadError, readWorkbook, sheetAoa } from '@matchline/spreadsheet-import';

import type { ExtoField } from './columns.js';
import { EXTO_REV21_COLUMNS, isExtoField } from './columns.js';
import { ExtoExportError } from './errors.js';

/** How a template header was recognised. */
export type ExtoHeaderMatch = 'exact' | 'trimmed-case-insensitive';

/** One template column this package can fill, and what fills it. */
export interface ExtoTemplateBinding {
  readonly field: ExtoField;
  /** Zero-based position in the template's header row. */
  readonly columnIndex: number;
  readonly match: ExtoHeaderMatch;
}

/**
 * A captured layout: the sheet's headers, where they sit, and what they mean.
 *
 * A plain JSON value by construction — no Maps, no Sets, no `undefined` fields —
 * because it persists in a project file beside the learned tables.
 */
export interface ExtoTemplate {
  readonly version: 1;
  /** The sheet the headers were read from. */
  readonly sheetName: string;
  /**
   * The header row, verbatim and in full, including blanks. Written back exactly
   * as captured: the site's spelling is the site's, and re-spelling it would
   * produce a file its own tooling no longer recognises.
   */
  readonly headers: ReadonlyArray<string>;
  /**
   * Zero-based worksheet row the headers sat on. `0` for a sheet that starts
   * with its headers; `1` for one with a spacer or title row above them. The
   * export reproduces this exactly, blank rows and all.
   */
  readonly headerRowIndex: number;
  /** The columns this package fills, in ascending position. */
  readonly matched: ReadonlyArray<ExtoTemplateBinding>;
  /** Free text naming where the layout came from, for the review UI. */
  readonly capturedFrom: { readonly label: string };
}

/** Options for {@link analyzeExtoTemplate}. */
export interface AnalyzeExtoTemplateOptions {
  /** Which sheet to read. Defaults to the workbook's first sheet. */
  readonly sheetName?: string;
  /**
   * Which worksheet row holds the headers, overriding the rule below. Zero-based
   * and absolute, so it is the number {@link ExtoTemplate.headerRowIndex}
   * reports back and the number the export writes to.
   */
  readonly headerRowIndex?: number;
  /** Free text naming the source, normally the file name. */
  readonly label?: string;
}

/**
 * How far down the sheet the header row is looked for.
 *
 * A registry sheet puts its headers on row 0 or, if it carries a spacer or a
 * title, a row or two below. Scanning further would let a sheet whose real
 * header row is blank bind itself to the first data row it happened to reach,
 * which is a worse outcome than refusing.
 */
export const EXTO_TEMPLATE_HEADER_SCAN_ROWS = 10;

/**
 * Read a registry or EXTO workbook and capture its layout.
 *
 * The header row is the first row within {@link EXTO_TEMPLATE_HEADER_SCAN_ROWS}
 * holding **two or more** non-empty cells. Registry sheets routinely carry a
 * one-cell title or a blank spacer above the headers, and a rule that took the
 * first non-empty row would capture that title as a one-column layout. A sheet
 * with no such row falls back to its first non-empty row, and
 * {@link AnalyzeExtoTemplateOptions.headerRowIndex} settles the rest.
 *
 * Trailing blank headers are dropped — a column with no name is not a template
 * column — while a blank header *between* named ones is kept, because dropping
 * it would shift every column after it and silently move the site's data.
 *
 * @throws {SpreadsheetReadError} `not-a-workbook` for bytes that do not parse,
 * `sheet-not-found` when the named sheet is not in the workbook, and
 * `header-row-out-of-range` for an explicit `headerRowIndex` the sheet does not
 * have.
 * @throws {ExtoExportError} `template-has-no-header-row` for a sheet whose
 * scanned rows carry no headers at all.
 */
export function analyzeExtoTemplate(
  bytes: Uint8Array,
  options: AnalyzeExtoTemplateOptions = {},
): ExtoTemplate {
  const workbook = readWorkbook(bytes);
  const sheetNames = workbook.sheetNames;
  const sheetName = options.sheetName ?? sheetNames[0] ?? '';
  const sheet = sheetName === '' ? undefined : workbook.getSheet(sheetName);
  if (sheet === undefined) {
    throw new SpreadsheetReadError({
      kind: 'sheet-not-found',
      sheetName,
      availableSheets: sheetNames,
    });
  }

  const { aoa } = sheetAoa(sheet);
  const headerRowIndex = locateHeaderRow(aoa, options.headerRowIndex, sheetName);
  const headers = trimTrailingBlanks(aoa[headerRowIndex] ?? []);

  return {
    version: 1,
    sheetName,
    headers,
    headerRowIndex,
    matched: bindHeaders(headers),
    capturedFrom: { label: options.label ?? '' },
  };
}

function locateHeaderRow(
  aoa: ReadonlyArray<ReadonlyArray<string>>,
  requested: number | undefined,
  sheetName: string,
): number {
  if (requested !== undefined) {
    if (!Number.isInteger(requested) || requested < 0 || aoa[requested] === undefined) {
      throw new SpreadsheetReadError({
        kind: 'header-row-out-of-range',
        headerRow: requested,
        rowCount: aoa.length,
      });
    }
    return requested;
  }
  let firstNonEmpty = -1;
  const limit = Math.min(aoa.length, EXTO_TEMPLATE_HEADER_SCAN_ROWS);
  for (let row = 0; row < limit; row += 1) {
    const filled = (aoa[row] ?? []).filter((cell) => cell.trim() !== '').length;
    if (filled >= 2) return row;
    if (filled === 1 && firstNonEmpty === -1) firstNonEmpty = row;
  }
  if (firstNonEmpty === -1) {
    throw new ExtoExportError({
      kind: 'template-has-no-header-row',
      sheetName,
      scannedRows: limit,
    });
  }
  return firstNonEmpty;
}

/** Drop empty cells off the right-hand end; keep gaps in the middle. */
function trimTrailingBlanks(headers: ReadonlyArray<string>): ReadonlyArray<string> {
  let end = headers.length;
  while (end > 0 && (headers[end - 1] ?? '').trim() === '') end -= 1;
  return headers.slice(0, end);
}

const EXACT_HEADERS: ReadonlyMap<string, ExtoField> = new Map(
  EXTO_REV21_COLUMNS.map((column) => [column.header, column.field]),
);

const FOLDED_HEADERS: ReadonlyMap<string, ExtoField> = new Map(
  EXTO_REV21_COLUMNS.map((column) => [fold(column.header), column.field]),
);

/** Locale-independent by construction: `toLowerCase`, never `toLocaleLowerCase`. */
function fold(header: string): string {
  return header.trim().toLowerCase();
}

/**
 * Bind each header to at most one field, and each field to at most one column.
 *
 * The first column wins a contested field. A sheet with two columns that both
 * fold to the same generic header means one of them is a second spelling, and
 * writing the same value into both would put a fact somewhere the site did not
 * ask for it.
 */
function bindHeaders(headers: ReadonlyArray<string>): ReadonlyArray<ExtoTemplateBinding> {
  const claimed = new Set<ExtoField>();
  const bindings: ExtoTemplateBinding[] = [];
  headers.forEach((header, columnIndex) => {
    const exact = EXACT_HEADERS.get(header);
    if (exact !== undefined) {
      if (!claimed.has(exact)) {
        claimed.add(exact);
        bindings.push({ field: exact, columnIndex, match: 'exact' });
      }
      return;
    }
    const folded = fold(header);
    if (folded === '') return;
    const insensitive = FOLDED_HEADERS.get(folded);
    if (insensitive === undefined || claimed.has(insensitive)) return;
    claimed.add(insensitive);
    bindings.push({ field: insensitive, columnIndex, match: 'trimmed-case-insensitive' });
  });
  return bindings;
}

/**
 * Structural validation for a template arriving from outside the process.
 *
 * A stored template decides what a delivered workbook looks like, so a
 * hand-edited or half-written one has to be caught here rather than produce a
 * file with a value under the wrong header. Bindings are checked against the
 * captured header list too: a `columnIndex` past the end of `headers` would
 * write a cell into a column that has no name.
 */
export function validateExtoTemplate(value: unknown): value is ExtoTemplate {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record['version'] !== 1) return false;
  if (typeof record['sheetName'] !== 'string') return false;

  const headers = record['headers'];
  if (!Array.isArray(headers) || !headers.every((h: unknown) => typeof h === 'string')) {
    return false;
  }

  const headerRowIndex = record['headerRowIndex'];
  if (
    typeof headerRowIndex !== 'number' ||
    !Number.isInteger(headerRowIndex) ||
    headerRowIndex < 0
  ) {
    return false;
  }

  const capturedFrom = record['capturedFrom'];
  if (typeof capturedFrom !== 'object' || capturedFrom === null || Array.isArray(capturedFrom)) {
    return false;
  }
  if (typeof (capturedFrom as Record<string, unknown>)['label'] !== 'string') return false;

  const matched = record['matched'];
  if (!Array.isArray(matched)) return false;
  const seen = new Set<string>();
  return matched.every((binding: unknown): boolean => {
    if (typeof binding !== 'object' || binding === null || Array.isArray(binding)) return false;
    const row = binding as Record<string, unknown>;
    const field = row['field'];
    const columnIndex = row['columnIndex'];
    const match = row['match'];
    if (typeof field !== 'string' || !isExtoField(field)) return false;
    if (seen.has(field)) return false;
    seen.add(field);
    if (typeof columnIndex !== 'number' || !Number.isInteger(columnIndex)) return false;
    if (columnIndex < 0 || columnIndex >= headers.length) return false;
    return match === 'exact' || match === 'trimmed-case-insensitive';
  });
}
