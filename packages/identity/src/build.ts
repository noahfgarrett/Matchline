/**
 * Index construction: everything the ladder needs, computed once.
 *
 * Built from the canonical asset universe, which is model-first (PRODUCT.md
 * §9.1): the model's spelling is what foreign spellings resolve *to*, never the
 * other way round.
 */
import { IDENTITY_TIER_ORDER, type IdentityTier } from '@matchline/domain';

import { anatomyCanIdentify, anatomyIdentityKey } from './anatomy-key.js';
import { boundaryCuts, DEFAULT_TAG_SEPARATORS } from './boundary.js';
import { normalizeTag } from './normalize.js';
import type { BoundaryPrefixEntry, IdentityAsset, IdentityConfig, IdentityIndex } from './types.js';

/** Two edits: enough for a transposed pair or a dropped separator, no more. */
export const DEFAULT_FUZZY_MAX_DISTANCE = 2;

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const existing = map.get(key);
  if (existing === undefined) {
    map.set(key, [value]);
    return;
  }
  existing.push(value);
}

function resolveMaxDistance(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return DEFAULT_FUZZY_MAX_DISTANCE;
  }
  return Math.max(0, Math.trunc(requested));
}

/**
 * Builds the reusable lookup structure for one asset universe and one profile.
 *
 * Pure and deterministic: the same assets in the same order with the same
 * config always produce the same index, and every list inside it keeps the
 * supplied order so a duplicated tag presents its assets identically twice.
 */
export function buildIdentityIndex(
  assets: ReadonlyArray<IdentityAsset>,
  config: IdentityConfig = {},
): IdentityIndex {
  const steps = config.tagNormalization ?? [];
  const separators = config.anatomy?.separators ?? DEFAULT_TAG_SEPARATORS;
  const enabledTiers = new Set<IdentityTier>(config.enabledTiers ?? IDENTITY_TIER_ORDER);
  const fuzzyMaxDistance = resolveMaxDistance(config.fuzzyMaxDistance);

  // An asset with no tag has no identity for a foreign spelling to reach.
  const tagged: IdentityAsset[] = [];
  for (const asset of assets) {
    if (asset.canonicalTag.length === 0) {
      continue;
    }
    tagged.push({ assetId: asset.assetId, canonicalTag: asset.canonicalTag });
  }

  const byExactTag = new Map<string, IdentityAsset[]>();
  const byNormalizedTag = new Map<string, IdentityAsset[]>();
  const byAnatomyKey = new Map<string, IdentityAsset[]>();
  const byBoundaryPrefix = new Map<string, BoundaryPrefixEntry[]>();

  const anatomy =
    config.anatomy !== undefined && anatomyCanIdentify(config.anatomy) ? config.anatomy : undefined;

  for (const entry of tagged) {
    push(byExactTag, entry.canonicalTag, entry);
    push(byNormalizedTag, normalizeTag(entry.canonicalTag, steps), entry);

    if (anatomy !== undefined) {
      const key = anatomyIdentityKey(anatomy, entry.canonicalTag);
      if (key !== undefined) {
        push(byAnatomyKey, key, entry);
      }
    }

    for (const cut of boundaryCuts(entry.canonicalTag, separators)) {
      push(byBoundaryPrefix, cut.prefix, { entry, separator: cut.separator });
    }
  }

  return {
    assets: tagged,
    config,
    enabledTiers,
    fuzzyMaxDistance,
    separators,
    byExactTag,
    byNormalizedTag,
    byAnatomyKey,
    byBoundaryPrefix,
  };
}
