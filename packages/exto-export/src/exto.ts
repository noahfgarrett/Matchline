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
 *    for a parent falls through to the blank rendering. The frozen legacy
 *    (Eagle) profile turns this off and leaves every root's Closest Parent
 *    blank — that is {@link BuildExtoRowsOptions.rootsAttachToSystem}.
 *
 *    Held against a real hand-built registry, this is the convention: every
 *    row's Closest Parent was filled, nine rows in ten naming another row's
 *    Equipment ID and the remaining roots naming, exactly, their own System
 *    Name. Nothing had to be invented to match that — it is what the default
 *    already did.
 * 2. **A stated-nothing register value is blank.** The donor's
 *    `registerDisplayValue` spelled it `'N/A'`; a real registry spells it by
 *    leaving the cell empty, in every one of the ~9,000 rows that has no
 *    dependency and every root that has no parent, with the literal text `N/A`
 *    appearing nowhere in either column. So blank is the default here, and
 *    `'N/A'` is available behind {@link BuildExtoRowsOptions.registerBlanks}
 *    for the frozen legacy profile that wants the donor's rendering back.
 *
 *    Either way this applies to Closest Parent and Dependencies only. Every
 *    other column has always been left genuinely blank.
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
 * Nothing here trims to a new spelling, pads, or upper-cases on its own. The
 * transforms are the ones the column list itself calls for: the dependency
 * join, the two `'N/A'` renderings, the CA_*→VF_* item-master normalization the
 * caller opts into by supplying a vocabulary, and — also opt-in — the approved
 * spelling of a dropdown-backed cell (see {@link ExtoCanonicalize}). Every one
 * of them is a decision the caller made out loud; the default is verbatim.
 */

import { writeWorkbook } from '@matchline/spreadsheet-import';

import type { ExtoAsset } from './asset.js';
import type { ExtoCells, ExtoField } from './columns.js';
import { extoCellRow, extoHeaderRow, extoSpacerRow } from './columns.js';
import type { ItemMasterNormalization } from './itemmasters.js';
import { describeItemMasterNormalization } from './itemmasters.js';
import type { ExtoTemplate } from './template.js';
import { clean, compareCodeUnits } from './text.js';

/**
 * The donor's rendering of a stated-nothing register value.
 *
 * Retained as the `'n-a'` choice of {@link BuildExtoRowsOptions.registerBlanks},
 * not as a default — see convention 2 in the module note.
 */
export const EXTO_BLANK_REGISTER_VALUE = 'N/A';

/**
 * How a register column renders "nothing was stated".
 *
 * `'blank'` leaves the cell empty, which is what a real registry carries and
 * what this package does unless told otherwise. `'n-a'` writes
 * {@link EXTO_BLANK_REGISTER_VALUE}, the donor's rendering, for a site whose
 * downstream tooling reads an empty cell as "not yet filled in" rather than as
 * "nothing to fill in".
 */
export type ExtoRegisterBlanks = 'blank' | 'n-a';

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
  /**
   * Which dropdown-backed cells this row prints in the approved spelling rather
   * than the one the source used.
   *
   * Always present, empty when no canonicaliser was supplied or nothing
   * matched. Sorted in {@link EXTO_DROPDOWN_FIELDS} order, so two runs over the
   * same register produce the same list — the row is part of a byte-stable
   * export and a set iterated in insertion order would not be.
   */
  readonly canonicalizedFields: ReadonlyArray<ExtoDropdownField>;
}

/**
 * The five Rev21 columns Exto validates against a fixed dropdown.
 *
 * Item Master is deliberately not one: it has its own normalization layer
 * (`itemmasters.ts`), which reports what it did and why, and a second one
 * rewriting the same cell would leave two answers for one column.
 */
export const EXTO_DROPDOWN_FIELDS = [
  'upn',
  'discipline',
  'wbs',
  'systemName',
  'equipmentClassification',
] as const satisfies ReadonlyArray<ExtoField>;

/** One of {@link EXTO_DROPDOWN_FIELDS}. */
export type ExtoDropdownField = (typeof EXTO_DROPDOWN_FIELDS)[number];

/**
 * The approved spelling of one dropdown value, or `''` when there is none.
 *
 * Supplied by the caller rather than imported, and not because it is
 * configurable — the approved list is a published standard and this package
 * would use it directly if it could. It cannot: `@matchline/ssm-audit` vendors
 * that list and already depends on this package, so importing it back would
 * close a cycle. The callers hand over `extoRev21Canonical` from
 * `@matchline/ssm-audit/exto`, and the SSM Audit's OWN row builder deliberately
 * does not — it must judge the register as written, not as this package could
 * have written it.
 */
export type ExtoCanonicalize = (field: ExtoDropdownField, value: string) => string;

/** Options for {@link buildExtoRows}. */
export interface BuildExtoRowsOptions {
  /**
   * Rev21 root convention: a root's Closest Parent is its own System Name.
   * Defaults to `true`, matching the shipped profile and what a real registry
   * does. The frozen legacy Eagle profile sets it `false`.
   */
  readonly rootsAttachToSystem?: boolean;
  /**
   * How Closest Parent and Dependencies render when nothing was stated.
   * Defaults to `'blank'`. See convention 2 in the module note.
   */
  readonly registerBlanks?: ExtoRegisterBlanks;
  /**
   * The legal VF item-master vocabulary — normally
   * {@link ItemMasterTable.vocabulary}. Supplied, a legacy `CA_<site>_<name>`
   * master is rewritten onto its VF equivalent before it is printed. Omitted,
   * every master is printed as stated: an empty vocabulary means no guessing.
   */
  readonly itemMasterVocabulary?: ReadonlyArray<string>;
  /**
   * The approved spelling for a dropdown-backed cell.
   *
   * Supplied, a value that matches an approved one case- and
   * whitespace-insensitively is printed the way the template spells it, so
   * `medium voltage` reaches Exto as `Medium Voltage`. A value that matches
   * nothing is printed exactly as it arrived — this rewrites spellings, it does
   * not correct data, and a site's own word for something is a fact about the
   * site rather than a typo to fix. Omitted, no cell is touched.
   */
  readonly canonicalize?: ExtoCanonicalize;
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
  const registerBlanks = options.registerBlanks ?? 'blank';
  const vocabulary = options.itemMasterVocabulary ?? [];
  return assets
    .map((asset) =>
      toRow(asset, rootsAttachToSystem, registerBlanks, vocabulary, options.canonicalize),
    )
    .sort(compareRows);
}

/**
 * How many cells across a set of rows print an approved spelling.
 *
 * The export's own accounting: "6 cells now spell what the template spells" is
 * something a person can check, and a rewrite nobody counted is a rewrite
 * nobody can audit.
 */
export function countCanonicalizedCells(rows: ReadonlyArray<ExtoRow>): number {
  let total = 0;
  for (const row of rows) total += row.canonicalizedFields.length;
  return total;
}

function toRow(
  asset: ExtoAsset,
  rootsAttachToSystem: boolean,
  registerBlanks: ExtoRegisterBlanks,
  vocabulary: ReadonlyArray<string>,
  canonicalize: ExtoCanonicalize | undefined,
): ExtoRow {
  const normalization = describeItemMasterNormalization(asset.itemMaster, vocabulary);
  const dropdown: Record<ExtoDropdownField, string> = {
    upn: clean(asset.systemKey),
    discipline: clean(asset.ssmDiscipline),
    wbs: clean(asset.wbs),
    systemName: clean(asset.systemLabel),
    equipmentClassification: clean(asset.equipmentClass),
  };
  const canonicalizedFields: ExtoDropdownField[] = [];
  if (canonicalize !== undefined) {
    for (const field of EXTO_DROPDOWN_FIELDS) {
      const stated = dropdown[field];
      if (stated === '') continue;
      const approved = canonicalize(field, stated);
      // `''` is "no approved value matches"; an approved value identical to
      // what the source already wrote is not a rewrite and is not counted.
      if (approved === '' || approved === stated) continue;
      dropdown[field] = approved;
      canonicalizedFields.push(field);
    }
  }

  return {
    upn: dropdown.upn,
    equipmentId: clean(asset.canonicalTag),
    closestParent: closestParentOf(asset, rootsAttachToSystem, registerBlanks),
    milestone: clean(asset.milestoneLabel),
    itemMaster: normalization.output,
    equipmentClassification: dropdown.equipmentClassification,
    dependencies: registerDisplayValue(joinDependencies(asset.dependencyTags), registerBlanks),
    building: clean(asset.building),
    level: clean(asset.level),
    grid: clean(asset.grid),
    discipline: dropdown.discipline,
    wbs: dropdown.wbs,
    systemName: dropdown.systemName,
    manufacturer: clean(asset.manufacturer),
    modelNumber: clean(asset.modelNumber),
    itemMasterNormalization: normalization,
    canonicalizedFields,
  };
}

/** Donor `registerDisplayValue`, with the blank rendering made a choice. */
function registerDisplayValue(value: string, registerBlanks: ExtoRegisterBlanks): string {
  const cleaned = clean(value);
  if (cleaned !== '') return cleaned;
  return registerBlanks === 'n-a' ? EXTO_BLANK_REGISTER_VALUE : '';
}

/** Rev21 convention 1. See the module note. */
function closestParentOf(
  asset: ExtoAsset,
  rootsAttachToSystem: boolean,
  registerBlanks: ExtoRegisterBlanks,
): string {
  const parent = clean(asset.structuralParentTag);
  if (parent !== '') return registerDisplayValue(parent, registerBlanks);
  const systemLabel = clean(asset.systemLabel);
  if (rootsAttachToSystem && systemLabel !== '') return systemLabel;
  return registerDisplayValue('', registerBlanks);
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
   * Sheet name. Defaults to {@link DEFAULT_EXTO_SHEET_NAME}, or to the
   * template's own sheet name when a template is supplied. Excel's own rules
   * apply — 31 characters, and no character it forbids — and a name that breaks
   * them raises `SpreadsheetReadError` (`invalid-sheet-name`) from the writer
   * rather than producing a file that will not open.
   */
  readonly sheetName?: string;
  /**
   * A layout captured by `analyzeExtoTemplate`. Supplied, the sheet comes out on
   * the site's own columns — its header text, its width, its header row — with
   * every column this package did not recognise left blank. Omitted, the generic
   * Rev21 map in `columns.ts` is used.
   */
  readonly template?: ExtoTemplate;
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
  const template = options.template;
  const name =
    options.sheetName ?? (template === undefined ? DEFAULT_EXTO_SHEET_NAME : template.sheetName);
  const aoa = template === undefined ? extoAoa(rows) : extoTemplateAoa(rows, template);
  return writeWorkbook([{ name, aoa }]);
}

/** Spacer row, header row, then the data rows — all cells text. */
export function extoAoa(rows: ReadonlyArray<ExtoRow>): ReadonlyArray<ReadonlyArray<string>> {
  return [extoSpacerRow(), extoHeaderRow(), ...rows.map(extoCellRow)];
}

/**
 * The same rows on a captured layout.
 *
 * The template's header row is written back verbatim at the row it was captured
 * from, with blank full-width rows above it — so a sheet whose headers were on
 * row 0 gets no spacer, and one whose headers were on row 1 gets exactly the one
 * it had. Data starts on the row after the headers.
 *
 * Every row is the template's own width, and a column the template's headers did
 * not bind to a field is emitted empty. That is the guarantee that matters most
 * here: a registry sheet carries columns that belong to other people — contact
 * details among them — and this package writes into a column only when the
 * site's own header text said what the column is for.
 */
export function extoTemplateAoa(
  rows: ReadonlyArray<ExtoRow>,
  template: ExtoTemplate,
): ReadonlyArray<ReadonlyArray<string>> {
  const width = template.headers.length;
  const blankRow = (): string[] => new Array<string>(width).fill('');

  const aoa: string[][] = [];
  for (let row = 0; row < template.headerRowIndex; row += 1) aoa.push(blankRow());

  const header = blankRow();
  template.headers.forEach((text, columnIndex) => {
    header[columnIndex] = text;
  });
  aoa.push(header);

  for (const row of rows) {
    const cells = blankRow();
    for (const binding of template.matched) {
      /* A binding past the end cannot happen through `analyzeExtoTemplate` and is
         refused by `validateExtoTemplate`; skipping rather than growing the row
         keeps a hand-edited template from widening the site's sheet. */
      if (binding.columnIndex < width) cells[binding.columnIndex] = row[binding.field];
    }
    aoa.push(cells);
  }
  return aoa;
}
