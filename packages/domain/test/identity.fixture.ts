import type { IdentityMatch, IdentityMiss, IdentityOutcome } from '@matchline/domain';

/**
 * One outcome of every shape, type-checked.
 *
 * A match must be constructible at every tier and a miss must be constructible
 * with and without candidates; if `IdentityOutcome` stops discriminating on
 * `status`, the narrowing in the runtime test stops compiling here first.
 */

export const DRAGON_EXACT_MATCH: IdentityMatch = {
  status: 'matched',
  evidenceTag: 'MAH001-10-01',
  assetId: 'asset-0001',
  tier: 'exact',
  detail: 'evidence tag equals canonical tag "MAH001-10-01"',
  sharingAssets: 1,
};

export const DRAGON_SUFFIX_MATCH: IdentityMatch = {
  status: 'matched',
  evidenceTag: 'MAH001-10-01-SPARE',
  assetId: 'asset-0001',
  tier: 'suffix-unambiguous',
  detail: 'evidence tag extends canonical tag "MAH001-10-01" at separator "-"',
  sharingAssets: 1,
};

export const DRAGON_FUZZY_MISS: IdentityMiss = {
  status: 'unmatched',
  evidenceTag: 'MAH001-10-1',
  candidates: [{ assetId: 'asset-0001', tier: 'fuzzy-proposal', distance: 1 }],
};

export const DRAGON_HOPELESS_MISS: IdentityMiss = {
  status: 'unmatched',
  evidenceTag: 'WIDGET',
  candidates: [],
};

export const DRAGON_IDENTITY_OUTCOMES: ReadonlyArray<IdentityOutcome> = [
  DRAGON_EXACT_MATCH,
  DRAGON_SUFFIX_MATCH,
  DRAGON_FUZZY_MISS,
  DRAGON_HOPELESS_MISS,
];
