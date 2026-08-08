/**
 * Site-template MEL (PRODUCT.md §12.2).
 *
 * The canonical MEL (§12.1) is Matchline's own sheet. A site that already runs
 * on its own MEL layout wants the same facts in *its* columns, so the user
 * uploads that workbook as a **template** and Matchline fills it: same headers,
 * same order, one row per asset.
 *
 * Two steps, deliberately separate:
 *
 * - {@link analyzeTemplate} reads the uploaded workbook and reports what
 *   columns it has, plus a suggested mapping. It never writes anything.
 * - {@link writeTemplateMel} writes the filled workbook from a mapping the user
 *   has confirmed. It takes no template bytes at all — the mapping *is* the
 *   column list, in template order — so the reviewed mapping is the only thing
 *   that can shape the output, and a template file that has moved on disk
 *   between analysis and export cannot silently change the export.
 *
 * ## Suggestions are suggestions
 *
 * §12.2 is a mapping UI, not an inference engine. A suggestion is offered when
 * a template header matches a §12.1 header exactly, matches it ignoring case
 * and surrounding space, or matches one of the handful of synonyms in
 * {@link TEMPLATE_HEADER_SYNONYMS}. Anything else is left unmapped for the user
 * to bind, because a column filled from a guess is indistinguishable, in the
 * delivered file, from a column filled from a fact.
 */

import {
  SpreadsheetReadError,
  readWorkbook,
  sheetAoa,
  writeWorkbook,
} from '@matchline/spreadsheet-import';

import { CANONICAL_MEL_COLUMNS } from './columns.js';
import type { CanonicalMelField, CanonicalMelRow } from './columns.js';
import { CANONICAL_MEL_FIELDS, MelExportError, isCanonicalMelField } from './errors.js';
import type { GeneratedMelAsset } from './rows.js';
import { buildCanonicalMelRows } from './rows.js';
import { DEFAULT_MEL_SHEET_NAME } from './workbook.js';

/* ---- mapping ---- */

/**
 * What a template column is filled from: a §12.1 field, a fixed value the site
 * wants in every row (a project number, a contract code), or nothing.
 *
 * `'blank'` is a real choice rather than an omission: the mapping lists every
 * template column so column order survives, and a column the user has looked at
 * and left empty has to be expressible.
 */
export type TemplateColumnSource =
  | CanonicalMelField
  | { readonly kind: 'literal'; readonly value: string }
  | { readonly kind: 'blank' };

/** One template column and the thing that fills it. */
export interface TemplateColumnMapping {
  /** The header text, written back verbatim. */
  readonly templateColumn: string;
  readonly field: TemplateColumnSource;
}

/** The template's columns in template order — the shape {@link writeTemplateMel} takes. */
export type TemplateMelMapping = ReadonlyArray<TemplateColumnMapping>;

/* ---- synonyms ---- */

/**
 * The small, visible synonym table.
 *
 * Deliberately short. Every entry is a spelling seen on real commissioning
 * MELs whose meaning is unambiguous; anything arguable belongs in the user's
 * hands, not here. Matched after trimming and case folding, so `'upn'` and
 * `' UPN '` both hit the first row.
 *
 * `System Description` needs no entry — it is already a §12.1 header and
 * matches exactly. `System` is the "single System column" of §12.2, which
 * carries the human-facing label rather than the key.
 */
export const TEMPLATE_HEADER_SYNONYMS: ReadonlyArray<{
  readonly header: string;
  readonly field: CanonicalMelField;
}> = [
  { header: 'UPN', field: 'systemKey' },
  { header: 'System', field: 'systemLabel' },
  { header: 'Tag', field: 'equipmentTag' },
  { header: 'Equipment No.', field: 'equipmentTag' },
  { header: 'Equipment No', field: 'equipmentTag' },
  { header: 'Description', field: 'equipmentDescription' },
];

/* ---- analysis ---- */

/** How a template header was recognised. */
export type TemplateHeaderMatch = 'exact' | 'trimmed-case-insensitive' | 'synonym';

/** A suggested binding for one template column. */
export interface TemplateColumnSuggestion {
  readonly field: CanonicalMelField;
  readonly match: TemplateHeaderMatch;
}

/** One column of the uploaded template. */
export interface TemplateColumn {
  /** Zero-based position in the template, which the export preserves. */
  readonly index: number;
  /** The header text exactly as the template spells it. */
  readonly header: string;
  /** Absent when nothing in the table recognised the header. */
  readonly suggestion?: TemplateColumnSuggestion;
}

/** What {@link analyzeTemplate} found. */
export interface TemplateAnalysis {
  /** The sheet that was read. */
  readonly sheetName: string;
  /** Every sheet in the uploaded workbook, so a caller can offer a choice. */
  readonly sheetNames: ReadonlyArray<string>;
  /** Zero-based index, within the scanned rows, of the header row used. */
  readonly headerRow: number;
  readonly columns: ReadonlyArray<TemplateColumn>;
  /**
   * The suggestions as a ready mapping: one entry per template column, in
   * template order, with unsuggested columns bound to `'blank'`. Hand it to
   * {@link writeTemplateMel} unchanged for a preview, or after the user edits
   * it for the real export.
   */
  readonly suggestedMapping: TemplateMelMapping;
}

/** Options for {@link analyzeTemplate}. */
export interface AnalyzeTemplateOptions {
  /** Which sheet to read. Defaults to the workbook's first sheet. */
  readonly sheetName?: string;
  /**
   * Which scanned row holds the headers, overriding the rule below. Indexes the
   * *scanned* rows — blank worksheet rows are not scanned — so it is the index
   * {@link TemplateAnalysis.headerRow} reports back.
   */
  readonly headerRow?: number;
}

/**
 * Read an uploaded MEL workbook and describe its columns.
 *
 * The header row is the first scanned row holding **two or more** non-empty
 * cells. MEL templates routinely carry a title above the headers, and a title
 * is one cell wide while a header row is not — a rule that took the first
 * non-empty row would name every column of every such template `undefined`. A
 * sheet where no row has two non-empty cells falls back to its first non-empty
 * row, and {@link AnalyzeTemplateOptions.headerRow} settles the rest.
 *
 * Trailing columns with no header are dropped (a column with no name is not a
 * template column); an empty header *between* named ones is kept, because
 * dropping it would shift every column after it.
 *
 * @throws {SpreadsheetReadError} `not-a-workbook` for bytes that do not parse,
 * `sheet-not-found` when the named sheet is not in the workbook,
 * `header-row-out-of-range` for an explicit `headerRow` the sheet does not have.
 * @throws {MelExportError} `template-has-no-header-row` for a sheet with no
 * non-empty row.
 */
export function analyzeTemplate(
  bytes: Uint8Array,
  options: AnalyzeTemplateOptions = {},
): TemplateAnalysis {
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
  const headerRow = locateHeaderRow(aoa, options.headerRow, sheetName);

  const headers = trimTrailingBlanks(aoa[headerRow] ?? []);
  const columns = suggestColumns(headers);
  return {
    sheetName,
    sheetNames,
    headerRow,
    columns,
    suggestedMapping: columns.map((column) => ({
      templateColumn: column.header,
      field: column.suggestion?.field ?? BLANK,
    })),
  };
}

const BLANK = { kind: 'blank' } as const;

/**
 * The header row: the caller's, or the first row that looks like a header list.
 *
 * "Looks like" is one rule and it is stated in the doc comment above: two or
 * more non-empty cells. A one-cell row is a title.
 */
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
  for (let r = 0; r < aoa.length; r++) {
    const filled = (aoa[r] ?? []).filter((cell) => cell.trim() !== '').length;
    if (filled >= 2) return r;
    if (filled === 1 && firstNonEmpty === -1) firstNonEmpty = r;
  }
  if (firstNonEmpty === -1) {
    throw new MelExportError({ kind: 'template-has-no-header-row', sheetName });
  }
  return firstNonEmpty;
}

/** Drop empty cells off the right-hand end; keep gaps in the middle. */
function trimTrailingBlanks(headers: ReadonlyArray<string>): ReadonlyArray<string> {
  let end = headers.length;
  while (end > 0 && (headers[end - 1] ?? '').trim() === '') end--;
  return headers.slice(0, end);
}

/**
 * Bind each header to at most one field, and each field to at most one header.
 *
 * First column wins a contested field: a template with both `Tag` and
 * `Equipment No.` means one of them is a secondary spelling, and suggesting the
 * same field twice would silently write the tag into two columns.
 */
function suggestColumns(headers: ReadonlyArray<string>): ReadonlyArray<TemplateColumn> {
  const claimed = new Set<CanonicalMelField>();
  return headers.map((header, index) => {
    const suggestion = recogniseHeader(header);
    if (suggestion === undefined || claimed.has(suggestion.field)) return { index, header };
    claimed.add(suggestion.field);
    return { index, header, suggestion };
  });
}

const EXACT_HEADERS: ReadonlyMap<string, CanonicalMelField> = new Map(
  CANONICAL_MEL_COLUMNS.map((column) => [column.header, column.field]),
);

const FOLDED_HEADERS: ReadonlyMap<string, CanonicalMelField> = new Map(
  CANONICAL_MEL_COLUMNS.map((column) => [fold(column.header), column.field]),
);

const FOLDED_SYNONYMS: ReadonlyMap<string, CanonicalMelField> = new Map(
  TEMPLATE_HEADER_SYNONYMS.map((synonym) => [fold(synonym.header), synonym.field]),
);

/** Locale-independent by construction: `toLowerCase`, never `toLocaleLowerCase`. */
function fold(header: string): string {
  return header.trim().toLowerCase();
}

function recogniseHeader(header: string): TemplateColumnSuggestion | undefined {
  const exact = EXACT_HEADERS.get(header);
  if (exact !== undefined) return { field: exact, match: 'exact' };
  const folded = fold(header);
  if (folded === '') return undefined;
  const insensitive = FOLDED_HEADERS.get(folded);
  if (insensitive !== undefined) return { field: insensitive, match: 'trimmed-case-insensitive' };
  const synonym = FOLDED_SYNONYMS.get(folded);
  if (synonym !== undefined) return { field: synonym, match: 'synonym' };
  return undefined;
}

/* ---- writing ---- */

/** Options for {@link writeTemplateMel}. */
export interface WriteTemplateMelOptions {
  /**
   * Sheet name. Defaults to {@link DEFAULT_MEL_SHEET_NAME}. Excel's own rules
   * apply, and a name that breaks them raises `SpreadsheetReadError`
   * (`invalid-sheet-name`) from the writer.
   */
  readonly sheetName?: string;
}

/**
 * Write the assets onto the site's own MEL layout.
 *
 * The template's columns come out in the mapping's order with the mapping's
 * header text, unmapped columns come out empty, and the rows are the same
 * assets in the same {@link buildCanonicalMelRows} order the canonical export
 * uses. Every cell is text, and two runs over the same input produce the same
 * bytes — see `workbook.ts` for why.
 *
 * @throws {MelExportError} `empty-template-mapping` for a mapping with no
 * columns, `unknown-canonical-field` — listing every offender at once — when a
 * mapping names something that is not a §12.1 field.
 * @throws {SpreadsheetReadError} `invalid-sheet-name` for a sheet name Excel
 * will not accept.
 */
export function writeTemplateMel(
  assets: ReadonlyArray<GeneratedMelAsset>,
  mapping: TemplateMelMapping,
  options: WriteTemplateMelOptions = {},
): Uint8Array {
  assertMappingFits(mapping);
  const rows = buildCanonicalMelRows(assets);
  const header = mapping.map((column) => column.templateColumn);
  const aoa: ReadonlyArray<ReadonlyArray<string>> = [
    header,
    ...rows.map((row) => mapping.map((column) => cellFor(column.field, row))),
  ];
  return writeWorkbook([{ name: options.sheetName ?? DEFAULT_MEL_SHEET_NAME, aoa }]);
}

/**
 * Every unknown field name in one error, not the first one found.
 *
 * A mapping built by a UI against a stale field list is wrong in several places
 * at once, and fixing it one refusal at a time is how a user gives up.
 */
function assertMappingFits(mapping: TemplateMelMapping): void {
  if (mapping.length === 0) throw new MelExportError({ kind: 'empty-template-mapping' });
  const unknown: string[] = [];
  for (const column of mapping) {
    const field: TemplateColumnSource = column.field;
    if (typeof field === 'string' && !isCanonicalMelField(field)) unknown.push(field);
  }
  if (unknown.length > 0) {
    throw new MelExportError({
      kind: 'unknown-canonical-field',
      fields: unknown,
      knownFields: CANONICAL_MEL_FIELDS,
    });
  }
}

function cellFor(source: TemplateColumnSource, row: CanonicalMelRow): string {
  if (typeof source === 'string') return row[source];
  switch (source.kind) {
    case 'literal':
      return source.value;
    case 'blank':
      return '';
    default: {
      const exhaustive: never = source;
      throw new Error(`unhandled TemplateColumnSource: ${JSON.stringify(exhaustive)}`);
    }
  }
}
