/**
 * Detect every sheet in a workbook, then import the ones that carry
 * connectivity.
 *
 * This is the convenience layer for PRODUCT.md §7 Screen 1: a user drops
 * EasyPower, a Cable Schedule, and a PMD, and Matchline says what each file is
 * and what it read out of it. The rule that shapes the whole function is that
 * unrecognized sheets are *listed*, never guessed at — a sheet that detection
 * could not place, or placed by name without finding a usable header row, comes
 * back as `not-imported` with the reason, so Screen 1 can ask the user rather
 * than inventing a mapping.
 */

import { detectSheetKind } from './detect.js';
import { importCableSheet } from './cable.js';
import { importEasyPowerSheet } from './easypower.js';
import { importPmdSheet } from './pmd.js';
import { ConnectivityImportError } from './errors.js';
import type {
  CableMapping,
  ConnectivityObservation,
  EasyPowerMapping,
  ObservationSource,
  PmdMapping,
  SheetDetection,
  SheetImportResult,
  SheetKind,
} from './types.js';

import { readWorkbook, sheetAoa } from '@matchline/spreadsheet-import';

/**
 * A caller-supplied replacement for what detection concluded about one sheet.
 *
 * All three fields are required: a half-override would put this package back in
 * the business of filling in the rest by guess.
 */
export interface SheetOverride {
  readonly kind: SheetKind;
  readonly headerRow: number;
  readonly mappedColumns: Readonly<Record<string, number>>;
}

/** Overrides by sheet name. */
export type ConnectivityOverrides = Readonly<Record<string, SheetOverride>>;

/** Why a recognized-or-not sheet produced no observations. */
export type NotImportedReason =
  /** Detection placed the sheet in no family. */
  | 'unknown-kind'
  /** The kind is known but no header row was found, so there is no layout to read. */
  | 'no-header-row'
  /** The kind is known and carries no connectivity — a MEL. */
  | 'not-connectivity';

/** The kind, header row, and columns actually used for a sheet. */
export interface AppliedMapping {
  readonly kind: SheetKind;
  readonly headerRow: number;
  readonly mappedColumns: Readonly<Record<string, number>>;
}

/** What happened to one sheet. */
export type SheetReport =
  | {
      readonly status: 'imported';
      readonly sheet: string;
      readonly detection: SheetDetection;
      readonly applied: AppliedMapping;
      readonly overridden: boolean;
      readonly result: SheetImportResult;
    }
  | {
      readonly status: 'not-imported';
      readonly sheet: string;
      readonly detection: SheetDetection;
      readonly applied: AppliedMapping;
      readonly overridden: boolean;
      readonly reason: NotImportedReason;
    };

/** Everything one workbook yielded. */
export interface ConnectivityWorkbookReport {
  readonly sourceFile: string;
  /** One entry per sheet, in workbook order. */
  readonly sheets: ReadonlyArray<SheetReport>;
  /** Every observation from every imported sheet, in sheet order then row order. */
  readonly observations: ReadonlyArray<ConnectivityObservation>;
  /** Names of the sheets no family claimed. */
  readonly unknownSheets: readonly string[];
}

/**
 * Read a whole workbook's connectivity.
 *
 * @param bytes The workbook.
 * @param sourceFile The file name to record in every observation's provenance.
 * @param overrides Per-sheet replacements for what detection concluded.
 * @throws {SpreadsheetReadError} when the bytes do not parse as a workbook.
 * @throws {ConnectivityImportError} when an override names a kind without the
 * columns that kind needs, or points outside the sheet.
 */
export function importConnectivityWorkbook(
  bytes: Uint8Array,
  sourceFile: string,
  overrides: ConnectivityOverrides = {},
): ConnectivityWorkbookReport {
  const workbook = readWorkbook(bytes);
  const sheets: SheetReport[] = [];
  const observations: ConnectivityObservation[] = [];
  const unknownSheets: string[] = [];

  for (const sheet of workbook.sheetNames) {
    const scan = sheetAoa(workbook.getSheet(sheet));
    const detection = detectSheetKind(sheet, scan.aoa);
    const override = overrides[sheet];
    const overridden = override !== undefined;
    const applied: AppliedMapping = override ?? {
      kind: detection.kind,
      headerRow: detection.headerRow,
      mappedColumns: detection.mappedColumns,
    };
    const base = { sheet, detection, applied, overridden } as const;

    if (applied.kind === 'unknown') {
      unknownSheets.push(sheet);
      sheets.push({ ...base, status: 'not-imported', reason: 'unknown-kind' });
      continue;
    }
    if (applied.kind === 'mel') {
      sheets.push({ ...base, status: 'not-imported', reason: 'not-connectivity' });
      continue;
    }
    if (applied.headerRow < 0) {
      sheets.push({ ...base, status: 'not-imported', reason: 'no-header-row' });
      continue;
    }

    const source: ObservationSource = { sourceFile, sheet, rowNums: scan.rowNums };
    const result = importSheet(applied.kind, scan.aoa, applied, source);
    observations.push(...result.observations);
    sheets.push({ ...base, status: 'imported', result });
  }

  return { sourceFile, sheets, observations, unknownSheets };
}

/** Dispatch to the importer for a connectivity kind. */
function importSheet(
  kind: 'easypower' | 'cable-schedule' | 'pmd',
  aoa: ReadonlyArray<ReadonlyArray<string>>,
  applied: AppliedMapping,
  source: ObservationSource,
): SheetImportResult {
  switch (kind) {
    case 'easypower':
      return importEasyPowerSheet(aoa, easyPowerMapping(applied, source.sheet), applied.headerRow, source);
    case 'cable-schedule':
      return importCableSheet(aoa, cableMapping(applied, source.sheet), applied.headerRow, source);
    case 'pmd':
      return importPmdSheet(aoa, pmdMapping(applied, source.sheet), applied.headerRow, source);
    default: {
      const exhaustive: never = kind;
      throw new Error(`unhandled connectivity kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/* ---- generic columns → typed mappings ---- */

export function easyPowerMapping(applied: AppliedMapping, sheet: string): EasyPowerMapping {
  return {
    source: requireColumn(applied, sheet, 'source'),
    load: requireColumn(applied, sheet, 'load'),
  };
}

export function cableMapping(applied: AppliedMapping, sheet: string): CableMapping {
  const cableTag = applied.mappedColumns['cableTag'];
  return {
    from: requireColumn(applied, sheet, 'from'),
    to: requireColumn(applied, sheet, 'to'),
    ...(cableTag === undefined ? {} : { cableTag }),
  };
}

export function pmdMapping(applied: AppliedMapping, sheet: string): PmdMapping {
  return {
    panel: requireColumn(applied, sheet, 'panel'),
    instrument: requireColumn(applied, sheet, 'instrument'),
  };
}

function requireColumn(applied: AppliedMapping, sheet: string, role: string): number {
  const columnIndex = applied.mappedColumns[role];
  if (columnIndex === undefined) {
    throw new ConnectivityImportError({
      kind: 'missing-mapped-column',
      sheet,
      sheetKind: applied.kind,
      role,
    });
  }
  return columnIndex;
}
