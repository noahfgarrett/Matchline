/**
 * The model tree's ancestry suggestion (PRODUCT.md §11.1 tier 8).
 *
 * The weakest rung on the parent candidate ladder, and the only one no engine
 * package can assemble: `@matchline/relationship-claims` lists `model-tree` in
 * `UNASSEMBLED_LADDER_SOURCES` precisely because the tree lives in the
 * extraction cache, which only the orchestrator reads.
 *
 * ## The walk
 *
 * From an asset's REPRESENTATIVE object (`objectIds[0]`, which `asset-catalog`
 * guarantees is the object the asset was matched on), climb `ModelObject.parentId`
 * one step at a time. The first ancestor object that belongs to ANOTHER asset
 * yields that asset's id. Nothing else does: an ancestor no asset owns is a
 * layer, a file node or a collapsed component's shell, and the climb continues
 * past it.
 *
 * Three consequences worth stating, because each one is a decision:
 *
 * 1. **Nearest wins.** An asset with two asset-bearing ancestors at different
 *    depths gets the nearer one. The model tree's own statement about an asset
 *    is "what it sits inside", and the outer ancestor is what the inner one
 *    sits inside -- claiming it here would skip a level the model drew.
 * 2. **A root representative has no suggestion.** The climb ends at
 *    `parentId === null` with nothing found, and the asset simply carries no
 *    `modelTreeParentId`. Absent, never `''`: the SSM compiler treats an empty
 *    string as no suggestion anyway, and an absent key says so honestly.
 * 3. **Component collapse needs no special case.** An absorbed component is one
 *    of the absorbing asset's `objectIds`, so an ancestor that was absorbed
 *    resolves to the asset that absorbed it -- the same answer the climb would
 *    reach by walking past it to the representative. The `!== asset.assetId`
 *    test is what keeps the rule literally "another asset" rather than
 *    accidentally so.
 *
 * ## One walk per source, never across (P0-1)
 *
 * A model tree is a fact about one file. Two sources have their own object
 * ordinals and their own roots, so the climb runs once per source over that
 * source's assets alone, and object 3 of one source can never be found as an
 * ancestor of object 4 of another. A family that spans two files still nests --
 * but through the tag-based claim rungs, which are about the site, rather than
 * through a tree that only one of the two files drew.
 *
 * Deterministic: the caches are read in `sourceId` order, the assets are walked
 * in catalog order, and the result depends on nothing else.
 */
import type { ModelAsset } from '@matchline/asset-catalog';
import type { ExtractionCache } from '@matchline/model-schema';

/** The part of a model source this rung reads. */
export interface ModelTreeSource {
  readonly sourceId: string;
  readonly cache: ExtractionCache;
}

/**
 * `assetId` -> the asset its representative object sits inside, for every asset
 * the model tree places inside another.
 *
 * Assets with no asset-bearing ancestor are absent from the map rather than
 * mapped to anything. `sources` is expected in `sourceId` order; an asset whose
 * source is not in the list contributes nothing, which is the same answer as a
 * source whose tree places it at a root.
 */
export function modelTreeParents(
  sources: ReadonlyArray<ModelTreeSource>,
  assets: ReadonlyArray<ModelAsset>,
): ReadonlyMap<string, string> {
  const assetsBySource = new Map<string, ModelAsset[]>();
  for (const asset of assets) {
    const bucket = assetsBySource.get(asset.sourceId);
    if (bucket === undefined) {
      assetsBySource.set(asset.sourceId, [asset]);
    } else {
      bucket.push(asset);
    }
  }

  const parents = new Map<string, string>();
  for (const source of sources) {
    for (const [assetId, parentAssetId] of parentsWithinSource(
      source.cache,
      assetsBySource.get(source.sourceId) ?? [],
    )) {
      parents.set(assetId, parentAssetId);
    }
  }
  return parents;
}

/** The climb over one source's cache, for that source's assets alone. */
function parentsWithinSource(
  cache: ExtractionCache,
  assets: ReadonlyArray<ModelAsset>,
): ReadonlyMap<string, string> {
  const assetIdByObjectId = new Map<number, string>();
  for (const asset of assets) {
    for (const objectId of asset.objectIds) {
      if (!assetIdByObjectId.has(objectId)) {
        assetIdByObjectId.set(objectId, asset.assetId);
      }
    }
  }

  // Every asset under one building layer climbs the same chain above it, so the
  // parent of an object is asked for once per object rather than once per
  // descendant asset. Read-only within a compile, so memoizing cannot go stale.
  const parentIds = new Map<number, number | null>();
  const parentIdOf = (objectId: number): number | null => {
    const memo = parentIds.get(objectId);
    if (memo !== undefined) {
      return memo;
    }
    const parentId = cache.object(objectId)?.parentId ?? null;
    parentIds.set(objectId, parentId);
    return parentId;
  };

  const parents = new Map<string, string>();
  for (const asset of assets) {
    const representative = asset.objectIds[0];
    if (representative === undefined) {
      continue;
    }
    const ancestor = nearestAssetAncestor(
      representative,
      asset.assetId,
      assetIdByObjectId,
      parentIdOf,
    );
    if (ancestor !== null) {
      parents.set(asset.assetId, ancestor);
    }
  }
  return parents;
}

/**
 * Climb from one object to the first ancestor owned by an asset other than
 * `assetId`, or `null` when the climb reaches a root without finding one.
 *
 * Iterative, and it refuses to revisit an object: extraction ordinals rule
 * parent cycles out, but a corrupt cache must not hang a compile. The same
 * guard `asset-catalog`'s own ancestor walk carries, for the same reason.
 *
 * `parentIdOf` returns `null` both for a root object and for a parent id
 * pointing at a row that is not there. Both end the chain, and neither is a
 * suggestion.
 */
function nearestAssetAncestor(
  objectId: number,
  assetId: string,
  assetIdByObjectId: ReadonlyMap<number, string>,
  parentIdOf: (objectId: number) => number | null,
): string | null {
  const seen = new Set<number>([objectId]);
  let parentId = parentIdOf(objectId);

  while (parentId !== null) {
    if (seen.has(parentId)) {
      return null;
    }
    seen.add(parentId);

    const owner = assetIdByObjectId.get(parentId);
    if (owner !== undefined && owner !== assetId) {
      return owner;
    }

    parentId = parentIdOf(parentId);
  }
  return null;
}
