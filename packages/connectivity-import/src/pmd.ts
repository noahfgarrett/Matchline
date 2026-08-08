/**
 * PMD — panel, instrument, and point relationships.
 *
 * The third primary connectivity source (PRODUCT.md §2.2). A PMD row says a
 * control panel owns an instrument's point, which is a `CONTROLS` relationship:
 * `relationshipKindOf` in `@matchline/domain` classifies that as a dependency,
 * not a structural parent, so an instrument never gets nested under a panel by
 * this evidence alone. That is why the observation kind is `pmd-relation` and
 * not `feed` — a panel does not energize its instruments.
 *
 * A panel with twenty points produces twenty observations. The repetition is
 * the document's meaning, not noise: each row is a distinct point.
 */

import { readRelationRows } from './rows.js';
import type { RelationShape } from './rows.js';
import type { ObservationSource, PmdMapping, SheetImportResult } from './types.js';

const PMD_RELATION: RelationShape = {
  kind: 'pmd-relation',
  sourceKind: 'pmd',
  relationshipType: 'CONTROLS',
};

/**
 * Read a PMD sheet as `CONTROLS` relations from panel to instrument.
 *
 * @throws {ConnectivityImportError} on an unusable header row or column index.
 */
export function importPmdSheet(
  aoa: ReadonlyArray<ReadonlyArray<string>>,
  mapping: PmdMapping,
  headerRow: number,
  source: ObservationSource,
): SheetImportResult {
  return readRelationRows(
    aoa,
    headerRow,
    { fromColumn: mapping.panel, toColumn: mapping.instrument },
    PMD_RELATION,
    source,
  );
}
