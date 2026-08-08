/**
 * Which document family a sheet belongs to.
 *
 * ## Ported arbitration
 *
 * The donor's arbiter is `profileKindForKey`
 * (`packages/legacy-parity/src/profile/schema.js`). Its order is reproduced
 * here:
 *
 * 1. The sheet *name* decides first — MEL names, then the PMD name, then
 *    `/cable\s*schedule/i`.
 * 2. Otherwise scan rows from the top; within each row try PMD, then Cable
 *    Schedule, then MEL. Row-major, so the topmost header row wins across kinds
 *    rather than the first kind winning across rows.
 * 3. The donor then *falls back* to EasyPower for anything unrecognized,
 *    because its universe was exactly those four families.
 *
 * ### The one deliberate divergence
 *
 * Step 3 does not carry over. A blanket "everything else is a power study"
 * would have Matchline guessing at a Notes tab, and PRODUCT.md §7 Screen 1 has
 * to be able to say "we did not recognize this file". So EasyPower is appended
 * as the last *detector* in step 2, and a sheet that satisfies none of them is
 * `'unknown'` — listed for the user, never imported.
 *
 * Row scanning stops after row 4 ({@link HEADER_SCAN_ROWS}). The donor scanned
 * 30/60/200 rows because it had already committed to reading the file; this is
 * the identification pass, and five rows covers the title-and-revision banners
 * real workbooks carry above their headers.
 */

import {
  detectCableColumns,
  detectEasyPowerColumns,
  detectMelColumns,
  detectPmdColumns,
  normalizeHeader,
} from './headers.js';
import type { DetectedColumns } from './headers.js';
import type { SheetDetection, SheetDetectionResult, SheetKind } from './types.js';

import { readWorkbook, sheetAoa } from '@matchline/spreadsheet-import';

/** Rows 0–4 are scanned for a header row. */
export const HEADER_SCAN_ROWS = 5;

/** No kind, no columns, no header row. */
const UNKNOWN: SheetDetection = {
  kind: 'unknown',
  confidence: 'none',
  headerRow: -1,
  mappedColumns: {},
};

/**
 * Donor `MEL_SHEET_NAMES` (`src/io/detect.js`). Compared against
 * {@link normalizeHeader} of the sheet name.
 */
const MEL_SHEET_NAMES: ReadonlySet<string> = new Set([
  'equipmentlist',
  'masterequipmentlist',
  'mel',
  'equipmentmasterlist',
  'melequipmentlist',
]);

/**
 * Donor `PMD_SHEET_NAME` is `'installpmd'`; the other two are Matchline
 * additions for sites that name the tab after the document instead of the step.
 */
const PMD_SHEET_NAMES: ReadonlySet<string> = new Set([
  'installpmd',
  'pmd',
  'pointmasterdatabase',
]);

/** Donor `isCableName`. */
const CABLE_SHEET_NAME = /cable\s*schedule/i;

/**
 * Detector order within a row: the donor's `profileKindForKey` loop (PMD, then
 * Cable, then MEL) with EasyPower appended in place of its blanket fallback.
 */
const DETECTORS: ReadonlyArray<
  readonly [kind: SheetKind, detect: (headers: ReadonlyArray<string>) => DetectedColumns | null]
> = [
  ['pmd', detectPmdColumns],
  ['cable-schedule', detectCableColumns],
  ['mel', detectMelColumns],
  ['easypower', detectEasyPowerColumns],
];

/** The kind a sheet's name claims, if any. Donor order: MEL, PMD, cable. */
function kindFromSheetName(sheetName: string): SheetKind | null {
  const normalized = normalizeHeader(sheetName);
  if (MEL_SHEET_NAMES.has(normalized)) return 'mel';
  if (PMD_SHEET_NAMES.has(normalized)) return 'pmd';
  if (CABLE_SHEET_NAME.test(sheetName.trim())) return 'cable-schedule';
  return null;
}

/** One header row that satisfied one detector. */
interface Candidate {
  readonly kind: SheetKind;
  readonly headerRow: number;
  readonly found: DetectedColumns;
}

/** Every kind any of rows 0–4 satisfies, in row-major then detector order. */
function scanCandidates(aoa: ReadonlyArray<ReadonlyArray<string>>): readonly Candidate[] {
  const candidates: Candidate[] = [];
  const limit = Math.min(aoa.length, HEADER_SCAN_ROWS);
  for (let row = 0; row < limit; row++) {
    const headers = aoa[row];
    if (headers === undefined) continue;
    for (const [kind, detect] of DETECTORS) {
      if (candidates.some((candidate) => candidate.kind === kind)) continue;
      const found = detect(headers);
      if (found !== null) candidates.push({ kind, headerRow: row, found });
    }
  }
  return candidates;
}

/**
 * Identify one sheet.
 *
 * A sheet whose *name* claims a kind keeps that kind even when its headers are
 * unreadable — the result then carries `headerRow: -1` and no columns, which is
 * how the workbook pass reports "recognized, but we will not guess its layout".
 */
export function detectSheetKind(
  sheetName: string,
  aoa: ReadonlyArray<ReadonlyArray<string>>,
): SheetDetection {
  const named = kindFromSheetName(sheetName);
  const candidates = scanCandidates(aoa);

  if (named !== null) {
    const agreeing = candidates.find((candidate) => candidate.kind === named);
    if (agreeing !== undefined) {
      return {
        kind: named,
        confidence: 'name',
        headerRow: agreeing.headerRow,
        mappedColumns: agreeing.found.columns,
      };
    }
    return { kind: named, confidence: 'name', headerRow: -1, mappedColumns: {} };
  }

  const best = pickCandidate(candidates);
  if (best === null) return UNKNOWN;
  return {
    kind: best.kind,
    confidence: best.found.strength,
    headerRow: best.headerRow,
    mappedColumns: best.found.columns,
  };
}

/**
 * An exact-header match outranks a corroborated one no matter which row it sits
 * on; otherwise the candidate found first wins, which is row-major then the
 * donor's detector order. Ranking rather than first-wins matters when a banner
 * row happens to satisfy a loose ladder above the real header row.
 */
function pickCandidate(candidates: readonly Candidate[]): Candidate | null {
  let best: Candidate | null = null;
  for (const candidate of candidates) {
    if (best === null) {
      best = candidate;
      continue;
    }
    if (candidate.found.strength === 'exact-headers' && best.found.strength === 'corroborated') {
      best = candidate;
    }
  }
  return best;
}

/**
 * Identify every sheet in a workbook.
 *
 * @throws {SpreadsheetReadError} when the bytes do not parse as a workbook.
 */
export function detectWorkbook(bytes: Uint8Array): ReadonlyArray<SheetDetectionResult> {
  const workbook = readWorkbook(bytes);
  return workbook.sheetNames.map((sheet) => ({
    sheet,
    detection: detectSheetKind(sheet, sheetAoa(workbook.getSheet(sheet)).aoa),
  }));
}
