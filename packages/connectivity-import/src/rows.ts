/**
 * The row loop the three importers share.
 *
 * All three read the same shape — an upstream cell, a downstream cell, and
 * optionally a conductor — and differ only in which columns those are and what
 * the resulting relationship is called. Written once here after the third
 * importer wanted it; the per-family semantics stay in `easypower.ts`,
 * `cable.ts`, and `pmd.ts`.
 *
 * ## Semantics, fixed here so a future edit cannot drift
 *
 * - Tags are trimmed and otherwise untouched. `'001'` stays `'001'`, case is
 *   preserved, and no tag normalization happens — that is the identity
 *   package's job, and folding here would destroy what the document said.
 * - A row missing either endpoint is skipped with a reason, never guessed at.
 *   A row whose two endpoints are the same tag is a `self-loop`: a real
 *   spreadsheet artifact (a panel listed as its own feed) that would otherwise
 *   become a one-node cycle downstream.
 * - Duplicate rows are KEPT. Two cables between the same pair of tags are two
 *   real cables, and an EasyPower row repeated per circuit is real too.
 *   Deduplication needs identity resolution and conflict rules, which are
 *   downstream concerns (PRODUCT.md §8.3).
 * - `rowCount === observationCount + skipped.length` always holds.
 */

import { ConnectivityImportError } from './errors.js';
import type {
  ConnectivityKind,
  ConnectivityObservation,
  ConnectivitySourceKind,
  ImportStats,
  ObservationSource,
  SheetImportResult,
  SkippedRow,
  SkipReason,
} from './types.js';

import type { RelationshipType } from '@matchline/domain';

/** Which columns carry the relationship on this sheet. */
export interface RelationColumns {
  readonly fromColumn: number;
  readonly toColumn: number;
  readonly viaColumn?: number;
}

/** What the relationship is called once read. Constant per document family. */
export interface RelationShape {
  readonly kind: ConnectivityKind;
  readonly sourceKind: ConnectivitySourceKind;
  readonly relationshipType: RelationshipType;
}

/**
 * Read every data row below `headerRow` as one relationship each.
 *
 * @throws {ConnectivityImportError} `header-row-out-of-range` when the header
 * row is not in the sheet, `mapped-column-out-of-range` when a mapped column
 * index lands past the end of the header row.
 */
export function readRelationRows(
  aoa: ReadonlyArray<ReadonlyArray<string>>,
  headerRow: number,
  columns: RelationColumns,
  shape: RelationShape,
  source: ObservationSource,
): SheetImportResult {
  const headerCells = aoa[headerRow];
  if (!Number.isInteger(headerRow) || headerRow < 0 || headerCells === undefined) {
    throw new ConnectivityImportError({
      kind: 'header-row-out-of-range',
      headerRow,
      rowCount: aoa.length,
    });
  }
  const headerWidth = headerCells.length;
  requireInRange('from', columns.fromColumn, headerWidth);
  requireInRange('to', columns.toColumn, headerWidth);
  if (columns.viaColumn !== undefined) requireInRange('via', columns.viaColumn, headerWidth);

  const observations: ConnectivityObservation[] = [];
  const skipped: SkippedRow[] = [];
  const skippedCount: Record<SkipReason, number> = {
    'missing-from': 0,
    'missing-to': 0,
    'self-loop': 0,
  };
  const fromTags = new Set<string>();
  const toTags = new Set<string>();

  for (let index = headerRow + 1; index < aoa.length; index++) {
    const cells = aoa[index] ?? [];
    const row = rowNumberAt(source, index);
    const fromTag = (cells[columns.fromColumn] ?? '').trim();
    const toTag = (cells[columns.toColumn] ?? '').trim();

    const reason = skipReasonFor(fromTag, toTag);
    if (reason !== null) {
      skipped.push({ row, reason, fromTag, toTag });
      skippedCount[reason] += 1;
      continue;
    }

    const via =
      columns.viaColumn === undefined ? '' : (cells[columns.viaColumn] ?? '').trim();
    fromTags.add(fromTag);
    toTags.add(toTag);
    observations.push({
      kind: shape.kind,
      fromTag,
      toTag,
      ...(via === '' ? {} : { via }),
      sourceKind: shape.sourceKind,
      relationshipType: shape.relationshipType,
      provenance: {
        sourceFile: source.sourceFile,
        sourceRef: { kind: 'sheet-row', sheet: source.sheet, row },
        fromColumn: columns.fromColumn,
        toColumn: columns.toColumn,
        ...(via === '' || columns.viaColumn === undefined ? {} : { viaColumn: columns.viaColumn }),
      },
    });
  }

  const stats: ImportStats = {
    rowCount: Math.max(0, aoa.length - headerRow - 1),
    observationCount: observations.length,
    skippedCount,
    distinctFromTags: fromTags.size,
    distinctToTags: toTags.size,
  };
  return { observations, stats, skipped };
}

/**
 * Endpoints are checked upstream-first, so a row missing both reports
 * `missing-from`. One reason per row keeps the skip list countable.
 */
function skipReasonFor(fromTag: string, toTag: string): SkipReason | null {
  if (fromTag === '') return 'missing-from';
  if (toTag === '') return 'missing-to';
  if (fromTag === toTag) return 'self-loop';
  return null;
}

/**
 * The row number this AoA index addresses. Worksheet row when the caller passed
 * `rowNums`, AoA position otherwise; either way one-based, matching how a
 * spreadsheet numbers its own rows.
 */
function rowNumberAt(source: ObservationSource, index: number): number {
  const worksheetRow = source.rowNums?.[index];
  return worksheetRow === undefined ? index + 1 : worksheetRow + 1;
}

function requireInRange(role: string, columnIndex: number, headerWidth: number): void {
  if (Number.isInteger(columnIndex) && columnIndex >= 0 && columnIndex < headerWidth) return;
  throw new ConnectivityImportError({
    kind: 'mapped-column-out-of-range',
    role,
    columnIndex,
    headerWidth,
  });
}
