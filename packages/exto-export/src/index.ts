/**
 * `@matchline/exto-export` — the EXTO-style commissioning workbook.
 *
 * EXTO-style workbook exports are one of Matchline's named deliverables
 * (PRODUCT.md §1) and first-production scope (DECISIONS.md). The layer is
 * optional in exactly the donor's sense: a site running some other Cx software
 * never supplies a registry, never gets an item-master table, and still gets
 * every plain SSM and MEL output. Nothing here is on the critical path of the
 * compiler.
 *
 * Five layers, each usable alone:
 *
 * - {@link trainItemMasterTable} / {@link assignItemMaster} — the donor's
 *   learned `(discipline, class, UPN)` and `(discipline, UPN, description word)`
 *   rungs, gated at 0.9 confidence. Above the gate, an assignment with its
 *   rule, confidence and sample count; below it, a review proposal with the
 *   candidates the registry disagreed between; never a guess.
 * - {@link trainWbsTable} / {@link assignWbs} — the same discipline for the
 *   work-breakdown code, on one rung keyed by System Key alone. `wbs.ts` says
 *   why that key and no other, and why a richer one would be overfitting.
 * - {@link analyzeExtoTemplate} — captures a site's own registry layout, so the
 *   export comes out on *its* columns rather than Matchline's. Anything
 *   site-specific about the delivered sheet arrives this way and is stored in
 *   the project file; nothing site-specific is compiled into this package.
 * - {@link buildExtoRows} — assets → ordered typed rows on the Rev21 column map.
 *   Pure, no workbook involved; this is what a preview grid or a diff should
 *   read.
 * - {@link writeExtoWorkbook} — the same rows as .xlsx bytes, written through
 *   `@matchline/spreadsheet-import`'s vendored SheetJS. Every cell is text, the
 *   bytes are stable across runs, and a captured template is honoured exactly:
 *   its headers, its width, its header row, and every column it did not name
 *   left empty.
 *
 * {@link ItemMasterTable}, {@link WbsTable} and {@link ExtoTemplate} are plain
 * JSON values and persist in a project file beside a `LearnedRuleSet`;
 * {@link validateItemMasterTable}, {@link validateWbsTable} and
 * {@link validateExtoTemplate} are the guards on the way back in.
 */

export type { ExtoAsset, ItemMasterAsset } from './asset.js';

export {
  EXTO_FIELDS,
  EXTO_FIRST_DATA_ROW_INDEX,
  EXTO_HEADER_ROW_INDEX,
  EXTO_REV21_COLUMNS,
  EXTO_REV21_WIDTH,
  extoCellRow,
  extoHeaderRow,
  extoSpacerRow,
  isExtoField,
} from './columns.js';
export type { ExtoCells, ExtoColumn, ExtoField } from './columns.js';

export { ExtoExportError, describeExtoExportReason } from './errors.js';
export type { ExtoExportReason } from './errors.js';

export {
  DEFAULT_EXTO_SHEET_NAME,
  EXTO_BLANK_REGISTER_VALUE,
  EXTO_DROPDOWN_FIELDS,
  buildExtoRows,
  countCanonicalizedCells,
  extoAoa,
  extoTemplateAoa,
  writeExtoWorkbook,
} from './exto.js';
export type {
  BuildExtoRowsOptions,
  ExtoCanonicalize,
  ExtoDropdownField,
  ExtoRegisterBlanks,
  ExtoRow,
  WriteExtoWorkbookOptions,
} from './exto.js';

export {
  EXTO_TEMPLATE_HEADER_SCAN_ROWS,
  analyzeExtoTemplate,
  validateExtoTemplate,
} from './template.js';
export type {
  AnalyzeExtoTemplateOptions,
  ExtoHeaderMatch,
  ExtoTemplate,
  ExtoTemplateBinding,
} from './template.js';

export {
  WBS_MIN_CONFIDENCE,
  WBS_PROPOSAL_CANDIDATES,
  assignWbs,
  trainWbsTable,
  validateWbsTable,
} from './wbs.js';
export type {
  TrainWbsOptions,
  WbsAssignment,
  WbsEntry,
  WbsTable,
  WbsTrainingRow,
} from './wbs.js';

export {
  ITEM_MASTER_MIN_CONFIDENCE,
  ITEM_MASTER_PROPOSAL_CANDIDATES,
  assignItemMaster,
  assignItemMasters,
  describeItemMasterNormalization,
  normalizeItemMasterName,
  suspectRowReason,
  trainItemMasterTable,
} from './itemmasters.js';
export type {
  ItemMasterAssignment,
  ItemMasterEntry,
  ItemMasterNormalization,
  ItemMasterRung,
  ItemMasterTable,
  NormalizationRule,
  SuspectRow,
  SuspectRowReason,
  ItemMasterTrainingRow,
  TrainItemMasterOptions,
} from './itemmasters.js';

export { validateItemMasterTable } from './validate.js';
