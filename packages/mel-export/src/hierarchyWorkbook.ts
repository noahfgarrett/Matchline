/**
 * The SSM hierarchy, flattened onto one sheet → .xlsx bytes.
 *
 * A hierarchy is a tree, and a tree does not survive being emailed. What the
 * SSM reviewer actually needs is the tree *widened*: one column per configured
 * level, one row per asset, so that sorting by Building or filtering to one
 * discipline is the reviewer's own spreadsheet skill rather than a feature this
 * package has to grow.
 *
 * Every cell is text and the bytes are stable across runs, for the reasons
 * `workbook.ts` spells out — the level values, the system keys and the tags are
 * all identifiers, and an identifier that Excel re-reads as a number (`001` as
 * 1, `D1-10` as a date) has stopped joining to anything.
 *
 * ## The writer never re-sorts
 *
 * Rows come out in the order handed in. Stack order, tag order and grouping
 * order are all defensible, they disagree, and the caller is the only layer
 * that knows which one this export is for; a writer that quietly imposed its
 * own would make the choice unavailable.
 *
 * ## The Levels sheet is always written
 *
 * Same reasoning as `diffWorkbook.ts` gives for Summary: "no levels are
 * configured" and "this build forgot to write the levels" must not look the
 * same to someone holding the file. With no levels the hierarchy sheet is just
 * the fixed columns, and the header-only Levels sheet is what says that was
 * intended.
 */

import { writeWorkbook } from '@matchline/spreadsheet-import';

/** One configured hierarchy level, as the level sheet lists it. */
export interface SsmHierarchyLevelConfig {
  readonly displayName: string;
  readonly attributeKey: string;
  readonly boundary: boolean;
}

/** One asset, flattened onto the hierarchy sheet. */
export interface SsmHierarchyRow {
  /** One value per configured level, in stack order. `''` where the asset has none. */
  readonly levelValues: ReadonlyArray<string>;
  readonly canonicalTag: string;
  readonly description: string;
  readonly equipmentType: string;
  readonly nativeDiscipline: string;
  readonly ssmDiscipline: string;
  readonly systemKey: string;
  readonly systemLabel: string;
  /** `''` when this asset has no structural parent. */
  readonly structuralParentTag: string;
  readonly dependencyTags: ReadonlyArray<string>;
  /** True when the asset is a top-of-grouping asset (no structural parent). */
  readonly root: boolean;
  /** The level values joined for reading, e.g. `D1 › 001`. */
  readonly levelPath: string;
}

/** The sheet the flattened assets are written to. */
export const SSM_HIERARCHY_SHEET_NAME = 'SSM Hierarchy';

/** The sheet that always states which levels the export was configured with. */
export const SSM_LEVELS_SHEET_NAME = 'Levels';

/**
 * The headers that follow the level columns.
 *
 * Fixed and in this order whatever the level stack is, so that a saved filter
 * or a downstream reader can be written against the right-hand end of the sheet
 * even though the left-hand end changes with the configuration.
 */
const FIXED_HIERARCHY_HEADERS: ReadonlyArray<string> = [
  'Tag',
  'Description',
  'Type',
  'Native Discipline',
  'SSM Discipline',
  'System Key',
  'System Label',
  'Structural Parent Tag',
  'Dependencies',
  'Root',
  'Level Path',
];

/** Header row of the Levels sheet. */
const LEVELS_HEADERS: ReadonlyArray<string> = ['Level', 'Attribute Key', 'Structural Boundary'];

/** How a boolean column reads to someone filtering the sheet by eye. */
function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

/**
 * Write the flattened SSM hierarchy: the hierarchy sheet, then the Levels sheet
 * that says what its level columns mean.
 *
 * An empty row list is not an error — it yields a header-only hierarchy sheet,
 * which is a truthful export of a grouping that admitted nothing, and still a
 * workbook Excel opens.
 */
export function writeSsmHierarchyWorkbook(
  rows: ReadonlyArray<SsmHierarchyRow>,
  levels: ReadonlyArray<SsmHierarchyLevelConfig>,
): Uint8Array {
  return writeWorkbook([
    { name: SSM_HIERARCHY_SHEET_NAME, aoa: hierarchyAoa(rows, levels) },
    { name: SSM_LEVELS_SHEET_NAME, aoa: levelsAoa(levels) },
  ]);
}

/** Header row followed by one row per asset, all cells text. */
function hierarchyAoa(
  rows: ReadonlyArray<SsmHierarchyRow>,
  levels: ReadonlyArray<SsmHierarchyLevelConfig>,
): ReadonlyArray<ReadonlyArray<string>> {
  return [
    [...levels.map((level) => level.displayName), ...FIXED_HIERARCHY_HEADERS],
    ...rows.map((row) => hierarchyCells(row, levels.length)),
  ];
}

/**
 * One asset's cells, level columns first.
 *
 * The level cells are taken by position and forced to exactly `levelCount`
 * wide. A row that carries fewer values than there are levels is padded and one
 * that carries more is truncated, because the alternative — emitting the row's
 * own width — would slide Tag, System Key and every other fixed column one
 * place along for that row only, and a sheet that is misaligned on a single
 * line is worse than one that is visibly missing a value.
 */
function hierarchyCells(row: SsmHierarchyRow, levelCount: number): ReadonlyArray<string> {
  const levelCells: string[] = [];
  for (let index = 0; index < levelCount; index++) {
    levelCells.push(row.levelValues[index] ?? '');
  }
  return [
    ...levelCells,
    row.canonicalTag,
    row.description,
    row.equipmentType,
    row.nativeDiscipline,
    row.ssmDiscipline,
    row.systemKey,
    row.systemLabel,
    row.structuralParentTag,
    row.dependencyTags.join('; '),
    yesNo(row.root),
    row.levelPath,
  ];
}

/** The configured stack, in stack order, header row included. */
function levelsAoa(
  levels: ReadonlyArray<SsmHierarchyLevelConfig>,
): ReadonlyArray<ReadonlyArray<string>> {
  return [
    [...LEVELS_HEADERS],
    ...levels.map((level) => [level.displayName, level.attributeKey, yesNo(level.boundary)]),
  ];
}
