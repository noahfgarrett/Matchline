/**
 * Ways a profile can address something the cache does not have.
 *
 * A filter naming a selection set that is not in the model is a mistake in the
 * profile, not an empty result: silently returning zero assets would look like
 * "this model has no equipment" instead of "you spelled the set name wrong".
 * The error carries the available names so a caller can show them.
 */
export type AssetCatalogConfigReason = {
  readonly kind: 'unknown-selection-set';
  readonly name: string;
  /** Every set and folder name in the cache, deduped, in traversal order. */
  readonly available: ReadonlyArray<string>;
};

/** Thrown by `buildAssetCatalog` when the filters do not fit the cache. */
export class AssetCatalogConfigError extends Error {
  readonly reason: AssetCatalogConfigReason;

  constructor(reason: AssetCatalogConfigReason) {
    super(describeAssetCatalogConfigReason(reason));
    this.name = 'AssetCatalogConfigError';
    this.reason = reason;
  }
}

/** The message shown for a reason. Exhaustive: a new reason will not compile. */
export function describeAssetCatalogConfigReason(reason: AssetCatalogConfigReason): string {
  switch (reason.kind) {
    case 'unknown-selection-set': {
      const available =
        reason.available.length === 0
          ? 'the cache has no selection sets'
          : `available: ${reason.available.join(', ')}`;
      return `selection set '${reason.name}' is not in this model (${available})`;
    }
    default: {
      const exhaustive: never = reason.kind;
      throw new Error(`unhandled AssetCatalogConfigReason: ${JSON.stringify(exhaustive)}`);
    }
  }
}
