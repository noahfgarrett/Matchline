/**
 * The property-bag seam (STATUS.md, "Property-bag seam (E3 owes this)").
 *
 * `@matchline/asset-catalog` publishes the handful of fields a site *mapped*;
 * it deliberately does not carry the raw `category > name` bag, because the
 * catalog is a model-first reading and not a property dump. But
 * `@matchline/system-resolver`'s `model-field` and `direct-column` rungs address
 * arbitrary properties, and a `parentTagProperty` does too. Somebody has to
 * re-read the cache for the assets the catalog kept, and that somebody is the
 * orchestrator -- the E1 and E2 integration tests bridged it by hand, and this
 * file is that bridge made into an API.
 *
 * ## First object owning a `(category, name)` pair wins
 *
 * An asset can own several cache objects: the representative object first, then
 * every component `collapseComponents` absorbed into it, in ascending cache
 * ordinal. Reading them in that order and keeping the first non-blank value for
 * each pair matches `asset-catalog`'s own rule for its mapped fields
 * (`packages/asset-catalog/src/catalog.ts`), so a value read through this seam
 * and the same value read off `ModelAsset` can never disagree.
 *
 * A blank value is not a value. An extractor writes an empty string where a
 * property exists and says nothing, and a later object that *does* state the
 * property should win over an earlier one that did not. Trimming is the only
 * transform here; normalization is an explicit, provenanced resolver step
 * (PRODUCT.md §5.5).
 */
import type { PropertyRef } from '@matchline/domain';
import type { ModelAsset } from '@matchline/asset-catalog';
import type { ExtractionCache, SourceModelNode } from '@matchline/model-schema';
import type { ResolverSubject } from '@matchline/system-resolver';

/** The nested `category -> name -> value` shape `ResolverSubject` wants. */
export type SubjectProperties = ReadonlyMap<string, ReadonlyMap<string, string>>;

/**
 * One asset's raw properties, plus which object supplied each of them.
 *
 * The owner ids are what lets a claim built from the bag address the object it
 * was actually read off, rather than the asset's representative object. With
 * component collapse on, those are routinely different objects.
 */
export interface AssetPropertyBag {
  readonly properties: SubjectProperties;
  /** `propertyKey(ref)` -> the cache object that supplied the value. */
  readonly ownerObjectIds: ReadonlyMap<string, number>;
}

/**
 * NUL separator: no Navisworks category or property name contains one, so two
 * distinct `(category, name)` pairs can never collide onto one key. The same
 * device `asset-catalog` uses, for the same reason.
 */
const KEY_SEPARATOR = '\u0000';

function propertyKey(ref: PropertyRef): string {
  return `${ref.category}${KEY_SEPARATOR}${ref.name}`;
}

/** Trimmed, or `null` when the property says nothing. */
function meaningful(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Reads every property of an asset's objects, with the owner of each.
 *
 * One pass over `cache.propertiesOf` per owned object, in `asset.objectIds`
 * order. Pure with respect to the cache: nothing is written, and the same cache
 * and asset always produce the same bag.
 */
export function readAssetProperties(cache: ExtractionCache, asset: ModelAsset): AssetPropertyBag {
  const properties = new Map<string, Map<string, string>>();
  const ownerObjectIds = new Map<string, number>();

  for (const objectId of asset.objectIds) {
    for (const property of cache.propertiesOf(objectId)) {
      const value = meaningful(property.valueText);
      if (value === null) {
        continue;
      }
      let byName = properties.get(property.category);
      if (byName === undefined) {
        byName = new Map<string, string>();
        properties.set(property.category, byName);
      }
      if (byName.has(property.name)) {
        continue;
      }
      byName.set(property.name, value);
      ownerObjectIds.set(propertyKey({ category: property.category, name: property.name }), objectId);
    }
  }

  return { properties, ownerObjectIds };
}

/**
 * One asset's raw `category -> name -> value` bag.
 *
 * The narrow half of {@link readAssetProperties}, published because the UI needs
 * exactly this and nothing more: a property inspector for a selected asset, and
 * the input a Site Profile Studio preview feeds to `resolveSubject` when a user
 * is trying a resolver rung out.
 */
export function subjectPropertiesFor(cache: ExtractionCache, asset: ModelAsset): SubjectProperties {
  return readAssetProperties(cache, asset).properties;
}

/** One property as the bag holds it, with the object that supplied it. */
export interface ReadProperty {
  readonly value: string;
  readonly objectId: number;
}

/** Look one property up in a bag, or `null` when no owned object stated it. */
export function propertyFrom(bag: AssetPropertyBag, ref: PropertyRef): ReadProperty | null {
  const value = bag.properties.get(ref.category)?.get(ref.name);
  if (value === undefined) {
    return null;
  }
  const objectId = bag.ownerObjectIds.get(propertyKey(ref));
  if (objectId === undefined) {
    return null;
  }
  return { value, objectId };
}

/**
 * Source model file names by id, flattened across appended models.
 *
 * An asset's provenance names the file it came out of, and a coordination model
 * is a forest: `Dragon-Controls-PLC.nwc` is appended inside
 * `Dragon-Controls.nwc`, and a claim read off a PLC module must say so.
 */
export function sourceModelFileNames(cache: ExtractionCache): ReadonlyMap<number, string> {
  const names = new Map<number, string>();
  const visit = (node: SourceModelNode): void => {
    if (node.fileName !== null) {
      names.set(node.id, node.fileName);
    }
    for (const child of node.children) {
      visit(child);
    }
  };
  for (const root of cache.sourceModels()) {
    visit(root);
  }
  return names;
}

/**
 * The document one asset was read from.
 *
 * The asset's own source model when the cache names one, and the coordination
 * file the cache was extracted from otherwise -- never an empty string, because
 * provenance that names no document cannot be navigated back to.
 */
export function sourceFileOf(
  asset: ModelAsset,
  fileNames: ReadonlyMap<number, string>,
  inputFileName: string,
): string {
  if (asset.sourceModelId === null) {
    return inputFileName;
  }
  return fileNames.get(asset.sourceModelId) ?? inputFileName;
}

/**
 * One catalog asset as a `ResolverSubject`.
 *
 * `objectId` is the representative object -- `objectIds[0]`, which
 * `asset-catalog` guarantees is the object the asset was matched on -- so a
 * model-field claim's `sourceRef` addresses the thing a reviewer would select in
 * Navisworks.
 */
export function resolverSubjectOf(
  asset: ModelAsset,
  bag: AssetPropertyBag,
  sourceFile: string,
): ResolverSubject {
  const representative = asset.objectIds[0];
  return {
    assetId: asset.assetId,
    canonicalTag: asset.canonicalTag,
    properties: bag.properties,
    sourceFile,
    ...(representative === undefined ? {} : { objectId: String(representative) }),
  };
}
