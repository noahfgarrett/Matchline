/**
 * `@matchline/identity` -- PRODUCT.md §9.
 *
 * Ties foreign tag spellings to the model-first canonical universe through an
 * ordered ladder of tiers, refusing to decide when more than one asset could
 * claim a spelling and never merging on edit distance alone. Pure,
 * deterministic, zero dependencies outside the workspace.
 */
export { buildIdentityIndex, DEFAULT_FUZZY_MAX_DISTANCE } from './build.js';

export { FUZZY_CANDIDATE_LIMIT, resolveTag, resolveTags } from './resolve.js';
export type { ResolveTagOptions } from './resolve.js';

export { boundaryCuts, DEFAULT_TAG_SEPARATORS } from './boundary.js';
export type { BoundaryCut } from './boundary.js';

export { normalizeTag } from './normalize.js';

export { boundedDistance } from './distance.js';

export { anatomyCanIdentify, anatomyIdentityKey } from './anatomy-key.js';

export type {
  BoundaryPrefixEntry,
  IdentityAsset,
  IdentityConfig,
  IdentityIndex,
  ResolveTagsResult,
} from './types.js';
