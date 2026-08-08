/**
 * Things the compiler refused to decide on its own.
 *
 * Claims-not-writes means a disagreement is an output, not an exception: the
 * compile finishes, every claim survives, and the ambiguity arrives here for a
 * person to settle (PRODUCT.md §5.6, §5.7).
 */
import type { AttributeClaim } from './claims.js';
import type { LadderSourceKind } from './hierarchy-config.js';
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

/**
 * One ladder rung offered several equally good parents (PRODUCT.md §11.1).
 *
 * The ladder stops here rather than falling through to a weaker rung: dropping
 * to weaker evidence to break a tie the strong evidence could not break is
 * guessing, and it is the same rule identity follows at §9.2.
 */
export interface AmbiguousParentReviewItem {
  readonly kind: 'ambiguous-parent';
  readonly assetId: string;
  /** The rung that tied. Rungs below it were never consulted. */
  readonly ladderSource: LadderSourceKind;
  /** Every candidate the rung produced, ordered for stable display. */
  readonly candidateParentIds: ReadonlyArray<string>;
}

/**
 * A set of assets that ended up parenting each other.
 *
 * A cycle is broken into a review item rather than snapped at an arbitrary
 * edge, because which edge is wrong is a judgement about the site, not about
 * the graph.
 */
export interface StructuralCycleReviewItem {
  readonly kind: 'structural-cycle';
  /** The cycle members, ordered for stable display. */
  readonly assetIds: ReadonlyArray<string>;
}

/**
 * A required boundary level had no value, so no structural decision was safe
 * (PRODUCT.md §11.3).
 *
 * Explicit attributes only: a profile fallback value never feeds a boundary
 * comparison, so "missing" here really means no source stated it.
 */
export interface MissingBoundaryReviewItem {
  readonly kind: 'missing-boundary';
  readonly assetId: string;
  readonly levelId: string;
}

/**
 * A learned rule that has not earned claim grade (ENGINE.md E3, DECISIONS.md #3).
 *
 * Proposal-grade description rules never write hierarchy and never become
 * claims -- they arrive here, with the rule and its measured confidence, for a
 * person to accept or reject.
 */
export interface NestingProposalReviewItem {
  readonly kind: 'nesting-proposal';
  readonly assetId: string;
  readonly proposedParentId: string;
  /** The rule in reviewable words, e.g. `VFD parents TIT (7/8)`. */
  readonly ruleDetail: string;
  /** Measured precision of the rule, 0..1. Never a threshold, always the number. */
  readonly confidence: number;
}

/**
 * A profile-stated claim rule that produced nothing because a tag it names has
 * no identity in this compile (relationship-claims' skipped list, surfaced).
 *
 * Skipping is loud by design: a mistyped tag in a profile lookup would
 * otherwise vanish silently and the site would never learn its rule is dead.
 */
export interface DeadClaimRuleReviewItem {
  readonly kind: 'dead-claim-rule';
  readonly ladderSource: string;
  readonly reason: string;
  readonly childRef: string;
  readonly parentRef: string;
}

/**
 * A profile alias whose target names a canonical tag no asset carries.
 *
 * Terminal by the same rule as ambiguity: the site said "this spelling is a
 * different asset" -- falling through to a weaker tier would attach the tag to
 * exactly the asset the alias was overriding.
 */
export interface UnresolvableAliasReviewItem {
  readonly kind: 'unresolvable-alias';
  readonly evidenceTag: string;
  readonly aliasTarget: string;
}

/**
 * Component collapse absorbed an object that carries its own tag.
 *
 * The tag no longer names an asset; evidence spelled with it will attach to
 * the absorbing asset. A person should confirm that is what the site means
 * (or list the class as separately commissionable).
 */
export interface AbsorbedTaggedComponentReviewItem {
  readonly kind: 'absorbed-tagged-component';
  readonly absorbedTag: string;
  readonly absorbingAssetId: string;
  readonly objectId: number;
}

export type ReviewItem =
  | SystemConflictReviewItem
  | DuplicateModelTagReviewItem
  | SystemCatalogConflictReviewItem
  | FuzzyIdentityReviewItem
  | AmbiguousSuffixReviewItem
  | AmbiguousParentReviewItem
  | StructuralCycleReviewItem
  | MissingBoundaryReviewItem
  | NestingProposalReviewItem
  | DeadClaimRuleReviewItem
  | UnresolvableAliasReviewItem
  | AbsorbedTaggedComponentReviewItem;

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
    case 'ambiguous-parent':
      return `asset ${item.assetId}: ${item.candidateParentIds.length} parents tied at tier ${item.ladderSource}`;
    case 'structural-cycle':
      return `structural cycle across ${item.assetIds.length} assets`;
    case 'missing-boundary':
      return `asset ${item.assetId}: boundary level ${item.levelId} has no value`;
    case 'nesting-proposal':
      return `asset ${item.assetId}: proposed parent ${item.proposedParentId} (${item.ruleDetail})`;
    case 'dead-claim-rule':
      return `${item.ladderSource} rule ${item.childRef} -> ${item.parentRef} produced nothing (${item.reason})`;
    case 'unresolvable-alias':
      return `alias ${item.evidenceTag} -> ${item.aliasTarget}: no asset carries that tag`;
    case 'absorbed-tagged-component':
      return `tag ${item.absorbedTag} was absorbed into ${item.absorbingAssetId} (object ${item.objectId})`;
  }
  return assertNever(item, 'unhandled ReviewItem');
}
