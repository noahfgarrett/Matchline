/**
 * The EXTO Rev21 column contract.
 *
 * Ported from the donor's `packages/legacy-parity/src/export/xlsx.js`,
 * `addExtoSheet` — the `cfg.<field> ?? <index>` defaults it falls back to when a
 * profile carries no `hierarchy.extoColumns` override:
 *
 * ```js
 * const G=cfg.upn??6, K=cfg.equipmentId??10, P=cfg.closestParent??15,
 *       AN=cfg.dependencies??39, MS=cfg.milestone??24, IM=cfg.itemMaster??26,
 *       CL=cfg.classification??35;
 * ```
 *
 * ## This is a positional map, not a header list
 *
 * The Standardized Upload File Template Rev21 is a wide sheet whose columns are
 * fixed by position. The donor writes exactly the seven it knows and leaves
 * every other column of the 40 blank, because a template column it cannot fill
 * honestly is better left empty than invented. This port does the same: seven
 * columns, at these indices, and nothing else.
 *
 * The donor's own header comment above `addExtoSheet` says "Dependencies → AM".
 * The code says 39, which is column **AN**. The code is the contract — the
 * default is pinned to 39 here, matching the shipped profile's
 * `extoColumns.dependencies` (`tests/eagle-profile.acceptance.test.mjs` asserts
 * `extoDependencies: 39`) — and the stale comment is not carried over. The
 * frozen legacy Eagle profile is the one that uses 38.
 *
 * ## Layout
 *
 * Row 0 is a blank spacer, row 1 is the header, data starts at row 2 (donor:
 * "header row 2, data row 3", one-based). The donor freezes those two rows;
 * freezing is presentation, needs a post-hoc zip rewrite, and is deliberately
 * not ported — the bytes have to be stable (docs/ENGINE.md rule 3).
 *
 * Every value is text. A UPN is a string — `'001'` is not the number 1
 * (PRODUCT.md §5.5, "leading zeros!") — so {@link ExtoCells} has no numeric
 * members for one to slip through.
 */

/**
 * One row of the EXTO upload sheet: the seven cells the Rev21 map positions.
 *
 * All members are required and all are strings; a value no source stated is the
 * empty string (or `'N/A'`, for the two columns whose Rev21 convention is to
 * spell a blank out loud), never `undefined`.
 */
export interface ExtoCells {
  /** Rev21 "UPN" — Matchline's System Key (PRODUCT.md §2.3). */
  readonly upn: string;
  readonly equipmentId: string;
  /** `'N/A'` when the asset is a root and no System Name stands in for one. */
  readonly closestParent: string;
  readonly milestone: string;
  readonly itemMaster: string;
  readonly equipmentClassification: string;
  /** `'N/A'` when the asset has no dependencies. */
  readonly dependencies: string;
}

/** A field of {@link ExtoCells}, usable as a column key. */
export type ExtoField = keyof ExtoCells;

/** A column: the row field it reads, its header text, and its fixed position. */
export interface ExtoColumn {
  readonly field: ExtoField;
  readonly header: string;
  /** Zero-based sheet column. `6` is spreadsheet column G. */
  readonly columnIndex: number;
}

/**
 * The Rev21 columns, in ascending position.
 *
 * `satisfies` keeps every `field` a real member of {@link ExtoCells}, so a
 * renamed field breaks the build here rather than emitting a column of empty
 * cells. Coverage — every field present exactly once — is asserted in the tests,
 * as is the exact index and header of each column: a template revision that
 * moves a column has to move it here, visibly, in a diff.
 */
export const EXTO_REV21_COLUMNS = [
  { field: 'upn', header: 'UPN', columnIndex: 6 },
  { field: 'equipmentId', header: 'Equipment ID', columnIndex: 10 },
  { field: 'closestParent', header: 'Closest Parent', columnIndex: 15 },
  { field: 'milestone', header: 'Milestone', columnIndex: 24 },
  { field: 'itemMaster', header: 'Item Master Unique Identifier', columnIndex: 26 },
  { field: 'equipmentClassification', header: 'Equipment Classification', columnIndex: 35 },
  { field: 'dependencies', header: 'Dependencies', columnIndex: 39 },
] as const satisfies ReadonlyArray<ExtoColumn>;

/** Sheet width: the donor's `W = Math.max(...indices) + 1`. */
export const EXTO_REV21_WIDTH: number =
  Math.max(...EXTO_REV21_COLUMNS.map((column) => column.columnIndex)) + 1;

/** Zero-based row holding the headers. Row 0 above it is a blank spacer. */
export const EXTO_HEADER_ROW_INDEX = 1;

/** Zero-based row the first data row lands on. */
export const EXTO_FIRST_DATA_ROW_INDEX = EXTO_HEADER_ROW_INDEX + 1;

/**
 * A full-width row with each column's value placed at its Rev21 index and every
 * unmapped column blank.
 */
export function extoSheetRow(
  valueOf: (column: (typeof EXTO_REV21_COLUMNS)[number]) => string,
): ReadonlyArray<string> {
  const cells: string[] = new Array<string>(EXTO_REV21_WIDTH).fill('');
  for (const column of EXTO_REV21_COLUMNS) cells[column.columnIndex] = valueOf(column);
  return cells;
}

/** The blank spacer row above the headers. */
export function extoSpacerRow(): ReadonlyArray<string> {
  return new Array<string>(EXTO_REV21_WIDTH).fill('');
}

/** The header row, headers at their Rev21 positions. */
export function extoHeaderRow(): ReadonlyArray<string> {
  return extoSheetRow((column) => column.header);
}

/** One row's cells, at their Rev21 positions. */
export function extoCellRow(row: ExtoCells): ReadonlyArray<string> {
  return extoSheetRow((column) => row[column.field]);
}
