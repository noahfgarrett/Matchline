/**
 * Reading a MEL workbook: the one convenience wrapper E1 needs.
 *
 * A MEL (Master Equipment List) is the client's spreadsheet of equipment. In
 * Matchline the model — not the MEL — is the asset universe (docs/ORIGIN.md
 * deviation 2), so this reader exists to supply enrichment, validation, and
 * system lookups, and it deliberately does nothing clever: no sheet guessing,
 * no header-row detection, no field inference. The caller names the sheet, the
 * header row, and the header text behind every field. Detection is E2.
 *
 * `equipmentTag` is the one required field, because a MEL row that names no
 * equipment cannot be joined to anything.
 */

import { SpreadsheetReadError } from './errors.js';
import { sheetAoa } from './aoa.js';
import { readMappedTable } from './table.js';
import type { MappedColumn } from './table.js';
import { readWorkbook } from './xlsx.js';

/** Every MEL field E1 knows how to read. */
export const MEL_FIELDS = [
  'equipmentTag',
  'upn',
  'systemDescription',
  'systemParent',
  'building',
  'discipline',
  'description',
  'projectPhase',
] as const;

/** One of {@link MEL_FIELDS}. */
export type MelField = (typeof MEL_FIELDS)[number];

/** {@link MEL_FIELDS} widened for membership tests against arbitrary keys. */
const KNOWN_FIELDS: readonly string[] = MEL_FIELDS;

/** Every MEL field except the required one. */
export type OptionalMelField = Exclude<MelField, 'equipmentTag'>;

/**
 * `{ field: columnHeader }` for a MEL sheet. `equipmentTag` is required;
 * every other field is read only if the caller maps it.
 */
export type MelMapping = {
  readonly equipmentTag: string;
} & {
  readonly [Field in OptionalMelField]?: string;
};

/** What a MEL read saw, for the wizard's "does this look right?" moment. */
export interface MelReadStats {
  /** Data rows below the header row, blank ones included. */
  readonly rowCount: number;
  /** Rows kept whose `equipmentTag` was empty — unjoinable, but not blank. */
  readonly blankTagCount: number;
  /** Rows dropped because every mapped column was empty. */
  readonly blankRowCount: number;
}

/** The result of {@link readMelTable}, typed to exactly the mapped fields. */
export interface MelTable<Field extends MelField> {
  readonly columns: ReadonlyArray<MappedColumn<Field>>;
  readonly rows: ReadonlyArray<Readonly<Record<Field, string>>>;
  readonly stats: MelReadStats;
}

/**
 * Read a MEL sheet out of workbook bytes under an explicit mapping.
 *
 * The returned row type carries exactly the fields the mapping named, so a
 * caller that did not map `upn` cannot read `row.upn`.
 *
 * @throws {SpreadsheetReadError} `sheet-not-found` (listing the sheets that do
 * exist), plus everything {@link readMappedTable} throws.
 */
export function readMelTable<Mapping extends MelMapping>(
  workbookBytes: Uint8Array,
  sheetName: string,
  mapping: Mapping,
  headerRow: number,
): MelTable<Extract<keyof Mapping, MelField>> {
  /* `Mapping extends MelMapping` does not stop a caller passing an extra key:
     TypeScript performs no excess-property check against a type parameter's
     constraint. Left alone, that key would be read as a real column and land
     in every row under a name the row type does not admit. Refuse instead. */
  const unknownFields = Object.keys(mapping).filter((field) => !KNOWN_FIELDS.includes(field));
  if (unknownFields.length > 0) {
    throw new SpreadsheetReadError({
      kind: 'unknown-mel-fields',
      fields: unknownFields,
      knownFields: [...MEL_FIELDS],
    });
  }

  const workbook = readWorkbook(workbookBytes);
  const worksheet = workbook.getSheet(sheetName);
  if (worksheet === undefined) {
    throw new SpreadsheetReadError({
      kind: 'sheet-not-found',
      sheetName,
      availableSheets: workbook.sheetNames,
    });
  }

  type Field = Extract<keyof Mapping, MelField>;
  const { aoa } = sheetAoa(worksheet);
  const table = readMappedTable<Field>(aoa, mapping as Readonly<Record<Field, string>>, {
    headerRow,
  });

  return {
    columns: table.columns,
    rows: table.rows,
    stats: {
      rowCount: table.scannedRowCount,
      blankTagCount: countBlankTags(table.rows),
      blankRowCount: table.blankRowCount,
    },
  };
}

/**
 * Rows whose equipment tag is empty. `MelMapping` requires `equipmentTag`, so
 * the key is always present; the parameter is widened to plain string keys
 * because the generic row type cannot express that to the compiler.
 */
function countBlankTags(rows: ReadonlyArray<Readonly<Record<string, string>>>): number {
  let count = 0;
  for (const row of rows) {
    if (row['equipmentTag'] === '') count++;
  }
  return count;
}
