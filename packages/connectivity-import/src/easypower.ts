/**
 * EasyPower — a power study's source-to-load rows.
 *
 * EasyPower is a primary connectivity source (PRODUCT.md §2.2, §10): what it
 * says about which bus energizes which load is engineered evidence, and it
 * outranks a tracking document. Each row states one such path, so each row
 * becomes one `POWERS` feed from the study's source column to its load column.
 *
 * The donor threaded the intermediate `Downstream<n>` columns into a chain of
 * edges (`packages/legacy-parity/src/hierarchy/build.js`). That chain is a
 * hierarchy concern and is not built here — detection still reports the
 * downstream columns it found (`mappedColumns.downstream1`, …) so the stage that
 * wants them has them.
 */

import { readRelationRows } from './rows.js';
import type { RelationShape } from './rows.js';
import type { EasyPowerMapping, ObservationSource, SheetImportResult } from './types.js';

const EASYPOWER_FEED: RelationShape = {
  kind: 'feed',
  sourceKind: 'easypower',
  relationshipType: 'POWERS',
};

/**
 * Read an EasyPower sheet as `POWERS` feeds.
 *
 * @param aoa Sheet contents, headers included.
 * @param mapping Detected or explicit source/load columns.
 * @param headerRow Zero-based row the headers sit on; data starts below it.
 * @param source The file and sheet this AoA came from, for provenance.
 * @throws {ConnectivityImportError} on an unusable header row or column index.
 */
export function importEasyPowerSheet(
  aoa: ReadonlyArray<ReadonlyArray<string>>,
  mapping: EasyPowerMapping,
  headerRow: number,
  source: ObservationSource,
): SheetImportResult {
  return readRelationRows(
    aoa,
    headerRow,
    { fromColumn: mapping.source, toColumn: mapping.load },
    EASYPOWER_FEED,
    source,
  );
}
