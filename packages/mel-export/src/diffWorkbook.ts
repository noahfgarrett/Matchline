/**
 * A §12.4 revision diff → one .xlsx, one sheet per category.
 *
 * Same split as the canonical export: `diff.ts` computes, this writes. Every
 * cell is text and the bytes are stable across runs, for the reasons spelled
 * out in `workbook.ts` — a revision report that hashed differently on every
 * run could not itself be diffed.
 *
 * ## Which sheets appear
 *
 * A category with no entries gets no sheet: eight empty tabs is how a reviewer
 * stops reading a report. **Summary always appears**, listing every §12.4
 * category with its count including the zeros, so "this category is empty" and
 * "this build forgot the category" never look the same. It is also the first
 * sheet, which is the one Excel opens on.
 */

import { writeWorkbook } from '@matchline/spreadsheet-import';
import type { SheetInput } from '@matchline/spreadsheet-import';

import { CANONICAL_MEL_HEADERS, canonicalMelCells } from './columns.js';
import type {
  MelAssetChange,
  MelDependencyChange,
  MelFieldChange,
  MelHierarchyLevelChange,
  MelRevisionDiff,
} from './diff.js';

/** The sheet that is always written, whatever the diff holds. */
export const DIFF_SUMMARY_SHEET_NAME = 'Summary';

/** Header row of the Summary sheet. */
const SUMMARY_HEADERS: ReadonlyArray<string> = ['Category', 'Count'];

/** Header row of every per-asset change sheet. */
const CHANGE_HEADERS: ReadonlyArray<string> = ['Equipment Tag', 'Before', 'After'];

/**
 * Write the revision diff as a workbook.
 *
 * Sheets come out in §12.4's own order, behind Summary. An empty diff writes a
 * Summary-only workbook of zeros — a truthful report of a model revision that
 * changed nothing, and still a file Excel opens.
 */
export function writeDiffWorkbook(diff: MelRevisionDiff): Uint8Array {
  const categories = diffCategories(diff);
  const summary: SheetInput = {
    name: DIFF_SUMMARY_SHEET_NAME,
    aoa: [
      [...SUMMARY_HEADERS],
      ...categories.map((category) => [category.name, String(category.aoa.length - 1)]),
    ],
  };
  const populated = categories.filter((category) => category.aoa.length > 1);
  return writeWorkbook([summary, ...populated]);
}

/** One sheet per §12.4 category, header row included, in §12.4 order. */
function diffCategories(diff: MelRevisionDiff): ReadonlyArray<SheetInput> {
  return [
    { name: 'Added Assets', aoa: assetSheet(diff.added) },
    { name: 'Removed Assets', aoa: assetSheet(diff.removed) },
    { name: 'Changed Tags', aoa: changeSheet(diff.changedTags) },
    { name: 'Changed Descriptions', aoa: changeSheet(diff.changedDescriptions) },
    { name: 'Changed System Keys', aoa: changeSheet(diff.changedSystemKeys) },
    { name: 'Changed Hierarchy Levels', aoa: hierarchySheet(diff.changedHierarchyLevels) },
    { name: 'Moved Parents', aoa: changeSheet(diff.movedParents) },
    { name: 'Added Dependencies', aoa: dependencySheet(diff.dependencyChanges.added) },
    { name: 'Removed Dependencies', aoa: dependencySheet(diff.dependencyChanges.removed) },
    { name: 'New Conflicts', aoa: changeSheet(diff.newConflicts) },
  ];
}

/**
 * Added and removed assets print the whole §12.1 row.
 *
 * "Asset MAH001-10-01 appeared" is not reviewable on its own; what it is, which
 * system it landed in and which model file it came from are the facts a
 * reviewer needs, and they are already exactly one row wide.
 */
function assetSheet(changes: ReadonlyArray<MelAssetChange>): ReadonlyArray<ReadonlyArray<string>> {
  return [
    [...CANONICAL_MEL_HEADERS],
    ...changes.map((change) => [...canonicalMelCells(change.row)]),
  ];
}

function changeSheet(changes: ReadonlyArray<MelFieldChange>): ReadonlyArray<ReadonlyArray<string>> {
  return [
    [...CHANGE_HEADERS],
    ...changes.map((change) => [change.canonicalTag, change.before, change.after]),
  ];
}

function hierarchySheet(
  changes: ReadonlyArray<MelHierarchyLevelChange>,
): ReadonlyArray<ReadonlyArray<string>> {
  return [
    ['Equipment Tag', 'Level', 'Before', 'After'],
    ...changes.map((change) => [change.canonicalTag, change.level, change.before, change.after]),
  ];
}

function dependencySheet(
  changes: ReadonlyArray<MelDependencyChange>,
): ReadonlyArray<ReadonlyArray<string>> {
  return [
    ['Equipment Tag', 'Dependency Tag', 'Dependencies Before', 'Dependencies After'],
    ...changes.map((change) => [
      change.canonicalTag,
      change.dependencyTag,
      change.before,
      change.after,
    ]),
  ];
}
