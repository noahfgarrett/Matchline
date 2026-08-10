/**
 * The model universe as this package takes it (RELEASE-1.0-PLAN P0-1).
 *
 * Separate from `catalog.ts` because the asset catalog and the property
 * catalog both read the same universe and must agree, to the letter, on what a
 * valid one is and on what order its sources are read in.
 */
import type { SourceAssignments } from '@matchline/domain';
import type { ExtractionCache } from '@matchline/model-schema';

import { AssetCatalogConfigError } from './errors.js';

/** One registered model source, as the catalog reads it. */
export interface CatalogSource {
  /** Project-assigned and unique within the universe. Never a file name. */
  readonly sourceId: string;
  readonly cache: ExtractionCache;
  /** What the project asserts about this whole source (P0-8). */
  readonly assignments?: SourceAssignments;
}

/**
 * The sources in `sourceId` order, refusing a universe that cannot be
 * addressed.
 *
 * Sorting here rather than trusting the caller is what makes every output
 * independent of the order sources were registered, dropped, or re-added in.
 *
 * Generic in the source type so a caller that carries more than this package
 * needs -- `@matchline/compiler`'s `ModelSourceInput` carries the display name
 * and the raw file name too -- gets its own type back and can share this one
 * definition of "a valid universe, in the order it is read" rather than
 * restating it and drifting from it.
 *
 * @throws AssetCatalogConfigError when an id is blank or repeated.
 */
export function orderCatalogSources<TSource extends CatalogSource>(
  sources: ReadonlyArray<TSource>,
): ReadonlyArray<TSource> {
  const seen = new Set<string>();
  for (const source of sources) {
    if (source.sourceId.length === 0) {
      throw new AssetCatalogConfigError({ kind: 'blank-source-id' });
    }
    if (seen.has(source.sourceId)) {
      // Two sources under one id would silently merge: same key, same object
      // ordinals, and no way to tell whose object 4 an asset came from.
      throw new AssetCatalogConfigError({
        kind: 'duplicate-source-id',
        sourceId: source.sourceId,
      });
    }
    seen.add(source.sourceId);
  }
  return [...sources].sort((left, right) =>
    left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0,
  );
}
