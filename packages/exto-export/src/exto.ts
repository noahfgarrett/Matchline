/**
 * Compiled assets → EXTO Rev21 upload rows → .xlsx bytes.
 *
 * Ported from the donor's `packages/legacy-parity/src/export/xlsx.js`,
 * `addExtoSheet`. The column positions live in `columns.ts`; what is here is the
 * two Rev21 rendering conventions the donor spells out, and the row order.
 *
 * ## Rev21 conventions carried over
 *
 * 1. **A root attaches to its own System Name.** The donor:
 *    `row[P] = parentValue ? registerDisplayValue(parentValue) :
 *    (rootsAttachToSystem && recordAttribute(record,'system')) ||
 *    registerDisplayValue(parentValue)`. A root with no System Name to stand in
 *    for a parent still falls through to `'N/A'`. The frozen legacy (Eagle)
 *    profile turns this off and keeps `'N/A'` for every root — that is
 *    {@link BuildExtoRowsOptions.rootsAttachToSystem}.
 * 2. **A blank register value is spelled `'N/A'`.** The donor's
 *    `registerDisplayValue`. It applies to Closest Parent and Dependencies only;
 *    Milestone, Item Master and Equipment Classification are left genuinely
 *    blank, which is how the donor writes them.
 *
 * ## Row order
 *
 * The donor emitted register order, which is a UI ordering. Matchline needs a
 * byte-stable export (docs/ENGINE.md rule 3), so rows sort the way
 * `@matchline/mel-export` sorts a generated MEL: UPN first, then Equipment ID,
 * both by UTF-16 code unit, with a blank UPN last so an unresolved system reads
 * as a block at the bottom rather than hiding at the top under a blank. Ties keep
 * input order — `Array.prototype.sort` is stable — which is what makes a
 * duplicated tag emit its two rows the same way every run.
 *
 * ## Values are otherwise verbatim
 *
 * Nothing here trims to a new spelling, pads, or upper-cases. The only
 * transforms are the ones the column list itself calls for: the dependency
 * join, the two `'N/A'` renderings, and the CA_*→VF_* item-master normalization
 * the caller opts into by supplying a vocabulary.
 */

import { writeWorkbook } from '@matchline/spreadsheet-import';

import type { ExtoAsset } from './asset.js';
import type { ExtoCells } from './columns.js';
import { extoCellRow, extoHeaderRow, extoSpacerRow } from './columns.js';
import type { ItemMasterNormalization } from './itemmasters.js';
import { describeItemMasterNormalization } from './itemmasters.js';
import { clean, compareCodeUnits } from './text.js';

/** The donor's rendering of a blank register value. */
export const EXTO_BLANK_REGISTER_VALUE = 'N/A';

/** Separator for the Dependencies cell — the donor's `join('; ')`. */
const DEPENDENCY_SEPARATOR = '; ';

/** The sheet name used when the caller does not choose one (donor: 'Exto SSM'). */
export const DEFAULT_EXTO_SHEET_NAME = 'Exto SSM';

/**
 * One upload row: the seven Rev21 cells, plus why the Item Master cell reads the
 * way it does.
 *
 * The provenance member is not a column and cannot become one — `extoCellRow`
 * is driven by `EXTO_REV21_COLUMNS`, which is typed over {@link ExtoCells}, and
 * this type only extends it.
 */
export interface ExtoRow extends ExtoCells {
  /**
   * The normalization decision behind {@link ExtoCells.itemMaster}, so a review
   * grid can say *why* `CA_NB_EL_MV_GEAR` became `VF_EL_MV_GEAR` — or why it
   * did not.
   */
  readonly itemMasterNormalization: ItemMasterNormalization;
}

/** Options for {@link buildExtoRows}. */
export interface BuildExtoRowsOptions {
  /**
   * Rev21 root convention: a root's Closest Parent is its own System Name.
   * Defaults to `true`, matching the shipped profile. The frozen legacy Eagle
   * profile sets it `false` and keeps `'N/A'`.
   */
  readonly rootsAttachToSystem?: boolean;
  /**
   * The legal VF item-master vocabulary — normally
   * {@link ItemMasterTable.vocabulary}. Supplied, a legacy `CA_<site>_<name>`
   * master is rewritten onto its VF equivalent before it is printed. Omitted,
   * every master is printed as stated: an empty vocabulary means no guessing.
   */
  readonly itemMasterVocabulary?: ReadonlyArray<string>;
}

/**
 * Build the ordered Rev21 upload rows for a set of assets.
 *
 * Pure and total: no input is rejected, and the same input always yields the
 * same rows in the same order. An empty input yields no rows — the caller still
 * gets a spacer and a header row from {@link writeExtoWorkbook}.
 */
export function buildExtoRows(
  assets: ReadonlyArray<ExtoAsset>,
  options: BuildExtoRowsOptions = {},
): ReadonlyArray<ExtoRow> {
  const rootsAttachToSystem = options.rootsAttachToSystem ?? true;
  const vocabulary = options.itemMasterVocabulary ?? [];
  return assets
    .map((asset) => toRow(asset, rootsAttachToSystem, vocabulary))
    .sort(compareRows);
}

function toRow(
  asset: ExtoAsset,
  rootsAttachToSystem: boolean,
  vocabulary: ReadonlyArray<string>,
): ExtoRow {
  const normalization = describeItemMasterNormalization(asset.itemMaster, vocabulary);
  return {
    upn: clean(asset.systemKey),
    equipmentId: clean(asset.canonicalTag),
    closestParent: closestParentOf(asset, rootsAttachToSystem),
    milestone: clean(asset.milestoneLabel),
    itemMaster: normalization.output,
    equipmentClassification: clean(asset.equipmentClass),
    dependencies: registerDisplayValue(joinDependencies(asset.dependencyTags)),
    itemMasterNormalization: normalization,
  };
}

/** Donor `registerDisplayValue`: a blank register value is spelled out loud. */
function registerDisplayValue(value: string): string {
  const cleaned = clean(value);
  return cleaned === '' ? EXTO_BLANK_REGISTER_VALUE : cleaned;
}

/** Rev21 convention 1. See the module note. */
function closestParentOf(asset: ExtoAsset, rootsAttachToSystem: boolean): string {
  const parent = clean(asset.structuralParentTag);
  if (parent !== '') return registerDisplayValue(parent);
  const systemLabel = clean(asset.systemLabel);
  if (rootsAttachToSystem && systemLabel !== '') return systemLabel;
  return EXTO_BLANK_REGISTER_VALUE;
}

/** Dependency tags, code-unit sorted so the cell does not depend on input order. */
function joinDependencies(tags: ReadonlyArray<string> | undefined): string {
  if (tags === undefined || tags.length === 0) return '';
  const cleaned = tags.map(clean).filter((tag) => tag !== '');
  if (cleaned.length === 0) return '';
  return [...cleaned].sort(compareCodeUnits).join(DEPENDENCY_SEPARATOR);
}

function compareRows(a: ExtoRow, b: ExtoRow): number {
  return compareUpns(a.upn, b.upn) || compareCodeUnits(a.equipmentId, b.equipmentId);
}

/** Code-unit order, except that a blank UPN sorts after every real one. */
function compareUpns(a: string, b: string): number {
  if (a === b) return 0;
  if (a === '') return 1;
  if (b === '') return -1;
  return compareCodeUnits(a, b);
}

/* -------------------------------------------------------------------------- */
/* Workbook                                                                   */
/* -------------------------------------------------------------------------- */

/** Options for {@link writeExtoWorkbook}. */
export interface WriteExtoWorkbookOptions {
  /**
   * Sheet name. Defaults to {@link DEFAULT_EXTO_SHEET_NAME}. Excel's own rules
   * apply — 31 characters, and no character it forbids — and a name that breaks
   * them raises `SpreadsheetReadError` (`invalid-sheet-name`) from the writer
   * rather than producing a file that will not open.
   */
  readonly sheetName?: string;
}

/**
 * Write the EXTO upload sheet: blank spacer row, Rev21 header row, then one row
 * per asset in {@link buildExtoRows} order.
 *
 * Every cell is text, written through `@matchline/spreadsheet-import`'s vendored
 * SheetJS — the only copy of that library anywhere in the engine — so a UPN of
 * `'001'` reaches Excel as `'001'` rather than collapsing to the number 1. The
 * bytes are stable across runs, processes and clocks, for the reasons
 * `@matchline/mel-export/src/workbook.ts` sets out at length: the vendored
 * bundle writes no document timestamps unless a workbook carries `Props` (this
 * one does not) and stamps every zip entry with the fixed 1980 DOS epoch.
 *
 * An empty row list is not an error — it yields a header-only sheet, which is a
 * truthful export of a register that admitted nothing, and still a workbook
 * Excel opens.
 */
export function writeExtoWorkbook(
  rows: ReadonlyArray<ExtoRow>,
  options: WriteExtoWorkbookOptions = {},
): Uint8Array {
  return writeWorkbook([
    { name: options.sheetName ?? DEFAULT_EXTO_SHEET_NAME, aoa: extoAoa(rows) },
  ]);
}

/** Spacer row, header row, then the data rows — all cells text. */
export function extoAoa(rows: ReadonlyArray<ExtoRow>): ReadonlyArray<ReadonlyArray<string>> {
  return [extoSpacerRow(), extoHeaderRow(), ...rows.map(extoCellRow)];
}
