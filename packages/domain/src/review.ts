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

/** One source's share of a duplicated tag, addressable within that source. */
export interface DuplicateModelTagSource {
  readonly sourceId: string;
  /** That source's objects carrying the tag, ascending. */
  readonly objectIds: ReadonlyArray<number>;
}

/**
 * One tag on more than one model object. Both objects are kept, never merged.
 *
 * P0-1 detects duplicates across the whole universe -- within one cache, across
 * caches, across source models -- so the objects listed here may belong to
 * different sources, and an object id alone is then not an address. `sources`
 * is the addressable form; `objectIds` is the flat list, ordered by source then
 * by id, and stays the thing a count is taken of.
 */
export interface DuplicateModelTagReviewItem {
  readonly kind: 'duplicate-model-tag';
  readonly canonicalTag: string;
  readonly objectIds: ReadonlyArray<number>;
  /**
   * Which sources claim the tag. Optional because records written before the
   * universe existed do not carry it; absent is not "one source".
   */
  readonly sources?: ReadonlyArray<DuplicateModelTagSource>;
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
 * A person's parent decision that an enabled boundary refused (P0-4).
 *
 * Manual is still the strongest rung: it wins the ladder competition outright.
 * What it no longer does is skip the fold — "cross-boundary manual → dependency
 * + provenance records manual origin + boundary demotion + visible review item".
 * This is that visible item, and it is the only demotion that raises one,
 * because it is the only one where the compiler is contradicting a person
 * rather than a rule.
 *
 * Nothing is discarded to produce it: the refused claim stays on the node's
 * losing claims, and the parent stays on the node as a `DEPENDENCY` carrying
 * the person's own words.
 */
export interface ManualBoundaryDemotionReviewItem {
  readonly kind: 'manual-boundary-demotion';
  /** The asset somebody re-parented. */
  readonly assetId: string;
  /** The parent they chose, now a dependency. */
  readonly parentAssetId: string;
  /** The enabled level whose value differs between the two. */
  readonly boundaryLevelId: string;
}

/**
 * One boundary level that stopped nesting, counted rather than repeated
 * (PRODUCT.md §11.3).
 *
 * A per-asset `missing-boundary` item is the right record when a person is owed
 * an explanation about one asset. It is the wrong record for the case the
 * audit found: a site whose Building property nobody mapped raises one item per
 * asset per level, so 40,000 assets produce 40,000 rows describing one thing to
 * fix -- and a queue nobody can work is the same as no queue at all.
 *
 * So the rule-driven half of it aggregates. One item per level, carrying how
 * many assets it stopped and a handful of them by name; the fix is a mapping,
 * not 40,000 decisions. Nothing is discarded to produce it: every asset is
 * still counted, and the assets whose own decision was refused keep their own
 * item (see {@link MissingBoundaryReviewItem}).
 */
export interface MissingBoundaryLevelReviewItem {
  readonly kind: 'missing-boundary-level';
  readonly levelId: string;
  /**
   * Assets this level left without a structural decision.
   *
   * Counted per asset whose own walk stopped here, not per unstated cell: the
   * value may be missing on the child, on the parent the ladder selected, or on
   * both, and what a person is being told is how much equipment went unplaced.
   */
  readonly assetCount: number;
  /** Up to ten of them, in asset-id order, so the item names real equipment. */
  readonly exampleAssetIds: ReadonlyArray<string>;
}

/**
 * Parents one boundary level took away from one ladder rung, counted.
 *
 * The manual rung keeps its per-pair {@link ManualBoundaryDemotionReviewItem}:
 * refusing a person is owed a named explanation. A rule-driven demotion is the
 * fold doing its job, and one per pair would bury the queue -- but silence is
 * what the audit actually found, and "every cross-file parent was demoted and
 * nothing anywhere says so" is not an acceptable answer either. So the rung
 * reports the count.
 */
export interface BoundaryDemotionReviewItem {
  readonly kind: 'boundary-demotion';
  readonly levelId: string;
  /** The rung whose parents were refused. Never `manual`, which has its own item. */
  readonly ladderSource: LadderSourceKind;
  /** How many (child, parent) pairs this level demoted at that rung. */
  readonly pairCount: number;
  /** Up to ten of the children, in asset-id order. */
  readonly exampleAssetIds: ReadonlyArray<string>;
}

/**
 * Assets the System Resolver could not place, grouped by why (PRODUCT.md §5).
 *
 * An unresolved system used to be a number on the compile summary and nothing
 * in the queue, so a site whose resolver reads a property half its model does
 * not carry saw "34 assets" and no reason. The skip reasons ARE the reason --
 * they name the rung and what it lacked -- so assets that failed the same way
 * are one row, and a site fixes one thing per row rather than one per asset.
 */
export interface UnresolvedSystemReviewItem {
  readonly kind: 'unresolved-system';
  /** Every rung reason these assets share, sorted, e.g. `keyChain[0] no-value`. */
  readonly skipReasons: ReadonlyArray<string>;
  readonly assetCount: number;
  /** Up to ten of the assets, in asset-id order. */
  readonly exampleAssetIds: ReadonlyArray<string>;
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

/**
 * Which stored decision could not be re-addressed to an asset.
 *
 * A person's decision is recorded against an asset id, and P0-9's identity
 * ledger is what carries those ids across a re-compile. When it cannot -- the
 * equipment left the model, a source was not registered this time, a tag now
 * names two assets -- the decision is not applied and it is NOT dropped: it
 * arrives here, verbatim, for a person to re-aim or retire.
 */
export type OrphanedDecisionKind = 'manual-parent' | 'manual-system' | 'derived-attribute';

/** Why a stored decision could not be re-addressed. */
export type OrphanedDecisionReason =
  | 'unknown-child'
  | 'unknown-parent'
  | 'ambiguous-child'
  | 'ambiguous-parent';

/**
 * A stored decision the identity ledger could not re-address (P0-9).
 *
 * "Migrate tag-keyed overrides via latest snapshot; unmappable overrides become
 * orphaned-decision review items, never dropped." Both references are carried
 * exactly as the project recorded them, because the spelling is the evidence: a
 * reviewer needs to see the id or tag that no longer resolves in order to know
 * what the decision was ever about.
 */
export interface OrphanedDecisionReviewItem {
  readonly kind: 'orphaned-decision';
  readonly decision: OrphanedDecisionKind;
  /** The asset the decision was about, as recorded. */
  readonly childRef: string;
  /**
   * The other end, as recorded. `''` when the decision names none -- a manual
   * make-root, or a system assignment, which is about one asset only.
   */
  readonly parentRef: string;
  readonly reason: OrphanedDecisionReason;
  /**
   * Which field the decision was about, when the decision names one.
   *
   * A derived attribute's `manual` rung is a table per attribute, so two
   * attributes can hold an unmappable assignment for the same asset -- two rows
   * to re-aim, not one. Absent on every decision kind that is about the asset
   * itself, which keeps their review keys exactly what they always were.
   */
  readonly field?: string;
  /** The person's own words, kept so the decision itself survives its address. */
  readonly note?: string;
}

/**
 * Why a tag-only re-match is worth a person's eye rather than only an event.
 *
 * - `reappeared` — the entry's last recorded state was `disappeared`. The asset
 *   was not in the previous compile at all, and the only thing tying this one
 *   to it is a string somebody types.
 * - `different-source` — the entry was last read from one set of registered
 *   sources and this compile read it from another. Equipment does move between
 *   documents; so does a tag that was reused for something else.
 */
export type PossibleRematchReason = 'reappeared' | 'different-source';

/**
 * The identity ledger tied this asset to a previous entry by TAG ALONE, and the
 * circumstances make that worth checking (P0-9).
 *
 * The `tag` tier is the weakest rung of the evidence order and the only one
 * that is not scoped to a model file: it exists so that a re-extraction with no
 * stable model evidence still carries an id forward. The cost is that a tag
 * reused for new equipment inherits the retired equipment's id — and with it
 * every manual system, every manual parent and every review decision recorded
 * against it. That is exactly right when the site re-tagged a unit, and exactly
 * wrong when it retired one and reused the number.
 *
 * A tag re-match on its own is ordinary and is reported as a ledger event.
 * This item is the subset where nothing else agrees the two are the same thing:
 * the entry had vanished, or it lived in different documents. The re-match
 * still HAPPENS — refusing it would mint a new id and orphan the decisions,
 * which is the failure the ledger exists to prevent — and this says so, so a
 * person can split them if it was wrong.
 */
export interface PossibleRematchReviewItem {
  readonly kind: 'possible-rematch';
  /** The ledger id the asset inherited. */
  readonly assetId: string;
  /** The tag both compiles carry, which is the whole of the evidence. */
  readonly canonicalTag: string;
  readonly reason: PossibleRematchReason;
  /** The sources the ledger last saw this asset in. Empty for a new project. */
  readonly previousSourceIds: ReadonlyArray<string>;
  /** The sources this compile read it from. */
  readonly sourceIds: ReadonlyArray<string>;
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
  | MissingBoundaryLevelReviewItem
  | ManualBoundaryDemotionReviewItem
  | BoundaryDemotionReviewItem
  | UnresolvedSystemReviewItem
  | NestingProposalReviewItem
  | DeadClaimRuleReviewItem
  | UnresolvableAliasReviewItem
  | AbsorbedTaggedComponentReviewItem
  | OrphanedDecisionReviewItem
  | PossibleRematchReviewItem;

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
    case 'duplicate-model-tag': {
      // Named only when there is more than one: "across sources dragon-mech"
      // would tell a reviewer nothing they did not already know, and every
      // single-source item would grow a clause for no reason.
      const sourceIds = [...new Set((item.sources ?? []).map((source) => source.sourceId))].sort();
      const across = sourceIds.length > 1 ? ` across sources ${sourceIds.join(', ')}` : '';
      return `tag ${item.canonicalTag}: ${item.objectIds.length} model objects share it${across}`;
    }
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
    case 'manual-boundary-demotion':
      return (
        `asset ${item.assetId}: the manual parent ${item.parentAssetId} crosses boundary level ` +
        `${item.boundaryLevelId}, so it is a dependency rather than a parent`
      );
    case 'missing-boundary-level':
      return (
        `boundary level ${item.levelId}: ${String(item.assetCount)} assets could not be ` +
        'placed, because the level states no value on one side or the other'
      );
    case 'boundary-demotion':
      return (
        `boundary level ${item.levelId}: ${String(item.pairCount)} parents from the ` +
        `${item.ladderSource} rung became dependencies`
      );
    case 'unresolved-system':
      return (
        `${String(item.assetCount)} assets resolved no system ` +
        `(${item.skipReasons.join('; ')})`
      );
    case 'nesting-proposal':
      return `asset ${item.assetId}: proposed parent ${item.proposedParentId} (${item.ruleDetail})`;
    case 'dead-claim-rule':
      return `${item.ladderSource} rule ${item.childRef} -> ${item.parentRef} produced nothing (${item.reason})`;
    case 'unresolvable-alias':
      return `alias ${item.evidenceTag} -> ${item.aliasTarget}: no asset carries that tag`;
    case 'absorbed-tagged-component':
      return `tag ${item.absorbedTag} was absorbed into ${item.absorbingAssetId} (object ${item.objectId})`;
    case 'possible-rematch':
      return (
        `asset ${item.assetId} (${item.canonicalTag}) kept its id on the tag alone ` +
        `(${item.reason})`
      );
    case 'orphaned-decision': {
      // The other end is named only when the decision has one, so a make-root
      // or a system assignment does not read as a decision about nothing.
      const target = item.parentRef === '' ? '' : ` -> ${item.parentRef}`;
      const field = item.field === undefined ? '' : ` for ${item.field}`;
      return (
        `stored ${item.decision} decision ${item.childRef}${target}${field} ` +
        `no longer resolves (${item.reason})`
      );
    }
  }
  return assertNever(item, 'unhandled ReviewItem');
}
