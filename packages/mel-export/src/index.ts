/**
 * `@matchline/mel-export` — the canonical generated MEL.
 *
 * Matchline's canonical model can describe a site more completely than the MEL
 * the project started with, and that generated MEL is a product deliverable in
 * its own right (PRODUCT.md §2.7). This package is the last step of it: the
 * §12.1 column contract, compiled assets rendered onto it as typed rows, and
 * those rows written out as .xlsx.
 *
 * Two layers, either usable alone:
 *
 * - {@link buildCanonicalMelRows} — assets → ordered typed rows. Pure, no
 *   workbook involved; this is what a preview grid or a diff should read.
 * - {@link writeCanonicalMelWorkbook} — the same rows as .xlsx bytes, written
 *   through `@matchline/spreadsheet-import`'s vendored SheetJS. Every cell is
 *   text, and the bytes are stable across runs.
 *
 * The input, {@link GeneratedMelAsset}, is this package's own flattened shape
 * rather than another package's output type, so the exporter stays independent
 * of how the catalog and the resolver evolve.
 *
 * Three further outputs read the same asset shape:
 *
 * - {@link analyzeTemplate} / {@link writeTemplateMel} — the site's own MEL
 *   layout, filled (§12.2).
 * - {@link compareWithExistingMel} — where Matchline and a supplied MEL
 *   disagree, as plain data. No review items are created here (§12.3).
 * - {@link diffMelRevisions} / {@link writeDiffWorkbook} — what a new model
 *   revision changed (§12.4).
 */

export {
  CANONICAL_MEL_COLUMNS,
  CANONICAL_MEL_HEADERS,
  canonicalMelCells,
} from './columns.js';
export type { CanonicalMelColumn, CanonicalMelField, CanonicalMelRow } from './columns.js';

export { buildCanonicalMelRows } from './rows.js';
export type { GeneratedMelAsset } from './rows.js';

export { DEFAULT_MEL_SHEET_NAME, writeCanonicalMelWorkbook } from './workbook.js';
export type { WriteCanonicalMelOptions } from './workbook.js';

export {
  CANONICAL_MEL_FIELDS,
  MelExportError,
  describeMelExportReason,
  isCanonicalMelField,
} from './errors.js';
export type { MelExportReason } from './errors.js';

export { TEMPLATE_HEADER_SYNONYMS, analyzeTemplate, writeTemplateMel } from './template.js';
export type {
  AnalyzeTemplateOptions,
  TemplateAnalysis,
  TemplateColumn,
  TemplateColumnMapping,
  TemplateColumnSuggestion,
  TemplateColumnSource,
  TemplateHeaderMatch,
  TemplateMelMapping,
  WriteTemplateMelOptions,
} from './template.js';

export { compareWithExistingMel } from './compare.js';
export type {
  CompareWithExistingMelOptions,
  ExistingMelColumn,
  ExistingMelMapping,
  MelComparison,
  MelComparisonSummary,
  MelFieldComparison,
  MelTagComparison,
} from './compare.js';

export { diffMelRevisions } from './diff.js';
export type {
  DiffMelRevisionsOptions,
  MelAssetChange,
  MelDependencyChange,
  MelDependencyChanges,
  MelFieldChange,
  MelHierarchyLevel,
  MelHierarchyLevelChange,
  MelRevisionDiff,
  MelRevisionDiffSummary,
} from './diff.js';

export { DIFF_SUMMARY_SHEET_NAME, writeDiffWorkbook } from './diffWorkbook.js';
