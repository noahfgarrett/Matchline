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
 * Three layers, each usable alone:
 *
 * - {@link trainItemMasterTable} / {@link assignItemMaster} — the donor's
 *   learned `(discipline, class, UPN)` and `(discipline, UPN, description word)`
 *   rungs, gated at 0.9 confidence. Above the gate, an assignment with its
 *   rule, confidence and sample count; below it, a review proposal with the
 *   candidates the registry disagreed between; never a guess.
 * - {@link buildExtoRows} — assets → ordered typed rows on the Rev21 column map.
 *   Pure, no workbook involved; this is what a preview grid or a diff should
 *   read.
 * - {@link writeExtoWorkbook} — the same rows as .xlsx bytes, written through
 *   `@matchline/spreadsheet-import`'s vendored SheetJS. Every cell is text, and
 *   the bytes are stable across runs.
 *
 * {@link ItemMasterTable} is a plain JSON value and persists in a Site Profile
 * beside a `LearnedRuleSet`; {@link validateItemMasterTable} is the guard on the
 * way back in.
 */

export type { ExtoAsset, ItemMasterAsset } from './asset.js';

export {
  EXTO_FIRST_DATA_ROW_INDEX,
  EXTO_HEADER_ROW_INDEX,
  EXTO_REV21_COLUMNS,
  EXTO_REV21_WIDTH,
  extoCellRow,
  extoHeaderRow,
  extoSpacerRow,
} from './columns.js';
export type { ExtoCells, ExtoColumn, ExtoField } from './columns.js';

export {
  DEFAULT_EXTO_SHEET_NAME,
  EXTO_BLANK_REGISTER_VALUE,
  buildExtoRows,
  extoAoa,
  writeExtoWorkbook,
} from './exto.js';
export type { BuildExtoRowsOptions, ExtoRow, WriteExtoWorkbookOptions } from './exto.js';

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
