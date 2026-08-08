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

export type ReviewItem =
  | SystemConflictReviewItem
  | DuplicateModelTagReviewItem
  | SystemCatalogConflictReviewItem;

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
  }
  return assertNever(item, 'unhandled ReviewItem');
}
