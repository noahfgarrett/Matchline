/**
 * `@matchline/connectivity-import` — EasyPower, Cable Schedule, and PMD
 * workbooks as typed connectivity observations.
 *
 * EasyPower, the Cable Schedule, and the PMD are the primary sources for
 * connectivity (PRODUCT.md §2.2) and the inputs the Electrical Flow projection
 * is built from (§10). This package turns them into facts, and stops there: it
 * resolves no identity, merges no duplicates, and settles no disagreement.
 * Every observation is addressed back to the file, sheet, row, and columns it
 * came from, which is what makes a later conflict reviewable instead of silent
 * (§8.4).
 *
 * Three layers, each usable on its own:
 *
 * - {@link detectSheetKind} / {@link detectWorkbook} — which document family a
 *   sheet belongs to, where its headers are, and which columns carry what. The
 *   donor's detection logic in Matchline's neutral vocabulary; see `headers.ts`
 *   for exactly which of its lists were ported.
 * - {@link importEasyPowerSheet} / {@link importCableSheet} /
 *   {@link importPmdSheet} — one sheet, under a detected or explicit column
 *   mapping, as observations plus the rows that were skipped and why.
 * - {@link importConnectivityWorkbook} — detect, then import every recognized
 *   sheet, with unrecognized ones listed rather than guessed at.
 */

export { detectSheetKind, detectWorkbook, HEADER_SCAN_ROWS } from './detect.js';

export { ConnectivityImportError, describeConnectivityImportReason } from './errors.js';
export type { ConnectivityImportReason } from './errors.js';

export {
  detectCableColumns,
  detectEasyPowerColumns,
  detectMelColumns,
  detectPmdColumns,
  foldHeader,
  normalizeHeader,
} from './headers.js';
export type { DetectedColumns } from './headers.js';

export { importEasyPowerSheet } from './easypower.js';
export { importCableSheet } from './cable.js';
export { importPmdSheet } from './pmd.js';

export {
  cableMapping,
  easyPowerMapping,
  importConnectivityWorkbook,
  pmdMapping,
} from './workbook.js';
export type {
  AppliedMapping,
  ConnectivityOverrides,
  ConnectivityWorkbookReport,
  NotImportedReason,
  SheetOverride,
  SheetReport,
} from './workbook.js';

export type {
  CableMapping,
  ConnectivityKind,
  ConnectivityObservation,
  ConnectivityProvenance,
  ConnectivitySourceKind,
  DetectionConfidence,
  EasyPowerMapping,
  ImportStats,
  ObservationSource,
  PmdMapping,
  SheetDetection,
  SheetDetectionResult,
  SheetImportResult,
  SheetKind,
  SkippedRow,
  SkipReason,
} from './types.js';
