/**
 * Cable Schedule — the conductors that realize the power paths.
 *
 * Also a primary connectivity source (PRODUCT.md §2.2). Where EasyPower says a
 * bus feeds a load, the cable schedule says which cable does it, so the
 * relationship is `WIRED_TO` and the cable tag rides along as `via`.
 *
 * The donor's column order is preserved by detection: `Panel (From)` is the
 * upstream end and `Load Name (To)` the downstream one, even though the sheet
 * conventionally prints the load first.
 *
 * Two rows naming the same pair are two cables, and both are kept. A parallel
 * run is not a duplicate — treating it as one would understate the installation.
 */

import { readRelationRows } from './rows.js';
import type { RelationColumns, RelationShape } from './rows.js';
import type { CableMapping, ObservationSource, SheetImportResult } from './types.js';

const CABLE_FEED: RelationShape = {
  kind: 'feed',
  sourceKind: 'cable-schedule',
  relationshipType: 'WIRED_TO',
};

/**
 * Read a Cable Schedule as `WIRED_TO` feeds.
 *
 * A row whose cable-tag cell is blank, or a mapping with no cable-tag column at
 * all, yields an observation with no `via` — the relationship is still real,
 * the conductor is simply unnamed.
 *
 * @throws {ConnectivityImportError} on an unusable header row or column index.
 */
export function importCableSheet(
  aoa: ReadonlyArray<ReadonlyArray<string>>,
  mapping: CableMapping,
  headerRow: number,
  source: ObservationSource,
): SheetImportResult {
  const columns: RelationColumns = {
    fromColumn: mapping.from,
    toColumn: mapping.to,
    ...(mapping.cableTag === undefined ? {} : { viaColumn: mapping.cableTag }),
  };
  return readRelationRows(aoa, headerRow, columns, CABLE_FEED, source);
}
