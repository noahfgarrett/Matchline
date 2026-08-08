/**
 * The canonical MEL column contract (PRODUCT.md §12.1).
 *
 * The field list and its order are the published shape of Matchline's
 * first-class output (§2.7), so they live in one place, spelled once. A column
 * added, renamed or reordered here changes every generated workbook, which is
 * exactly why nothing else in the package is allowed to hold a header string.
 *
 * Every value is text. A System Key is a string — `'001'` is not the number 1
 * (§5.5, "leading zeros!") — and the sheet must say so, so the row type has no
 * numeric members at all: anything numeric is rendered before it becomes a cell.
 */

/**
 * One row of the canonical MEL, one field per §12.1 column.
 *
 * All members are required and all are strings: a value no source stated is the
 * empty string, never `undefined`. The alternative — an absent member — would
 * reach a cell as the text `'undefined'`, which is how a gap gets mistaken for
 * a fact.
 */
export interface CanonicalMelRow {
  readonly equipmentTag: string;
  readonly equipmentDescription: string;
  readonly equipmentType: string;
  readonly building: string;
  readonly nativeDiscipline: string;
  readonly ssmDiscipline: string;
  readonly systemKey: string;
  readonly systemDescription: string;
  readonly systemLabel: string;
  readonly systemParentEquipmentTag: string;
  readonly dependencies: string;
  readonly sourceModel: string;
  readonly modelObjectId: string;
  readonly inclusionStatus: string;
  readonly parentEvidence: string;
  readonly reviewStatus: string;
  readonly modelRevisionHash: string;
}

/** A field of {@link CanonicalMelRow}, usable as a column key. */
export type CanonicalMelField = keyof CanonicalMelRow;

/** A column: the row field it reads and the header text written above it. */
export interface CanonicalMelColumn {
  readonly field: CanonicalMelField;
  readonly header: string;
}

/**
 * The §12.1 columns, in output order.
 *
 * `satisfies` keeps every `field` a real member of {@link CanonicalMelRow}, so a
 * renamed field breaks the build here rather than emitting a column of empty
 * cells. Coverage — every field present exactly once — is asserted in the tests.
 */
export const CANONICAL_MEL_COLUMNS = [
  { field: 'equipmentTag', header: 'Equipment Tag' },
  { field: 'equipmentDescription', header: 'Equipment Description' },
  { field: 'equipmentType', header: 'Equipment Type' },
  { field: 'building', header: 'Building' },
  { field: 'nativeDiscipline', header: 'Native Discipline' },
  { field: 'ssmDiscipline', header: 'SSM Discipline' },
  { field: 'systemKey', header: 'System Key' },
  { field: 'systemDescription', header: 'System Description' },
  { field: 'systemLabel', header: 'System Label' },
  { field: 'systemParentEquipmentTag', header: 'System Parent Equipment Tag' },
  { field: 'dependencies', header: 'Dependencies' },
  { field: 'sourceModel', header: 'Source Model' },
  { field: 'modelObjectId', header: 'Model Object ID' },
  { field: 'inclusionStatus', header: 'Inclusion Status' },
  { field: 'parentEvidence', header: 'Parent Evidence' },
  { field: 'reviewStatus', header: 'Review Status' },
  { field: 'modelRevisionHash', header: 'Model Revision Hash' },
] as const satisfies ReadonlyArray<CanonicalMelColumn>;

/** The header row of a generated MEL, in output order. */
export const CANONICAL_MEL_HEADERS: ReadonlyArray<string> = CANONICAL_MEL_COLUMNS.map(
  (column) => column.header,
);

/** One row as its cells, in column order. Text only, by construction. */
export function canonicalMelCells(row: CanonicalMelRow): ReadonlyArray<string> {
  return CANONICAL_MEL_COLUMNS.map((column) => row[column.field]);
}
