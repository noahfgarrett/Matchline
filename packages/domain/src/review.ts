/**
 * Things the compiler refused to decide on its own.
 *
 * Claims-not-writes means a disagreement is an output, not an exception: the
 * compile finishes, every claim survives, and the ambiguity arrives here for a
 * person to settle (PRODUCT.md §5.6, §5.7).
 */
import type { AttributeClaim } from './claims.js';
import { assertNever } from './relationship.js';

/** Two or more resolver rungs proposed different systems for one asset. */
export interface SystemConflictReviewItem {
  readonly kind: 'system-conflict';
  readonly assetId: string;
  /** Every competing claim, winners and losers alike. */
  readonly claims: ReadonlyArray<AttributeClaim>;
}

/** One tag on more than one model object. Both objects are kept, never merged. */
export interface DuplicateModelTagReviewItem {
  readonly kind: 'duplicate-model-tag';
  readonly canonicalTag: string;
  readonly objectIds: ReadonlyArray<number>;
}

/** One system key carrying several descriptions in the MEL (PRODUCT.md §5.7). */
export interface SystemCatalogConflictReviewItem {
  readonly kind: 'system-catalog-conflict';
  readonly systemKey: string;
  readonly descriptions: ReadonlyArray<string>;
}

/** One near-miss candidate for a tag no matching tier could tie down. */
export interface FuzzyIdentityCandidate {
  readonly assetId: string;
  /** Levenshtein distance from the evidence tag to that asset's canonical tag. */
  readonly distance: number;
}

/**
 * A foreign tag that only edit distance could relate to anything.
 *
 * Never a merge: §9.2 says fuzzy identity requires review, so the candidates
 * arrive here as proposals and a person picks or rejects them.
 */
export interface FuzzyIdentityReviewItem {
  readonly kind: 'fuzzy-identity';
  readonly evidenceTag: string;
  /** Ranked best-first. Empty is impossible -- no candidates means no item. */
  readonly candidates: ReadonlyArray<FuzzyIdentityCandidate>;
}

/**
 * A foreign tag that several canonical assets could equally claim.
 *
 * Raised by any tier that found more than one answer -- a suffix extending
 * several tags, or a normalization that collapses two distinct canonical tags
 * onto one string. The engine refuses to pick; the ambiguity is the output.
 */
export interface AmbiguousSuffixReviewItem {
  readonly kind: 'ambiguous-suffix';
  readonly evidenceTag: string;
  /** Every asset that could have claimed the tag, ordered for stable display. */
  readonly candidateAssetIds: ReadonlyArray<string>;
}

export type ReviewItem =
  | SystemConflictReviewItem
  | DuplicateModelTagReviewItem
  | SystemCatalogConflictReviewItem
  | FuzzyIdentityReviewItem
  | AmbiguousSuffixReviewItem;

/**
 * A one-line description of what needs deciding.
 *
 * No `default` branch on purpose: adding a member to `ReviewItem` without
 * adding a case here stops this function compiling.
 */
export function reviewItemSummary(item: ReviewItem): string {
  switch (item.kind) {
    case 'system-conflict':
      return `asset ${item.assetId}: ${item.claims.length} competing system claims`;
    case 'duplicate-model-tag':
      return `tag ${item.canonicalTag}: ${item.objectIds.length} model objects share it`;
    case 'system-catalog-conflict':
      return `system ${item.systemKey}: ${item.descriptions.length} conflicting descriptions`;
    case 'fuzzy-identity':
      return `tag ${item.evidenceTag}: ${item.candidates.length} fuzzy candidates need review`;
    case 'ambiguous-suffix':
      return `tag ${item.evidenceTag}: ${item.candidateAssetIds.length} assets could claim it`;
  }
  return assertNever(item, 'unhandled ReviewItem');
}
