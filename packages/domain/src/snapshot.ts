/**
 * The immutable resolved snapshot (PRODUCT.md §8.3, ENGINE.md E3 step 4).
 *
 * Every output -- the SSM tree, the generated MEL, the commissioning exports --
 * is derived from one snapshot, so the snapshot is where determinism is owned:
 * the same inputs and the same profile must produce an identical value here.
 *
 * Types only; `@matchline/ssm-compiler` produces it.
 */
import type { LadderSourceKind } from './hierarchy-config.js';
import type { Provenance } from './provenance.js';
import type { RelationshipType } from './relationship.js';
import type { ReviewItem } from './review.js';
import type { SsmRelationshipClaim } from './ssm-claims.js';

/**
 * Where the boundary fold took a parent away (PRODUCT.md §11.3).
 *
 * Kept on the decision rather than thrown away, because "this asset would have
 * nested under panel 603 but the building boundary stopped it" is the single
 * most asked question about a compiled tree (DECISIONS.md #1).
 */
export interface ParentDemotion {
  /** The parent the ladder selected, before the fold removed it. */
  readonly parentAssetId: string;
  /** The configured level whose value differed. */
  readonly boundaryLevelId: string;
}

/**
 * What the compiler concluded about one asset's structural parent.
 *
 * `status` is the discriminator a reader should trust:
 * - `resolved` -- a parent survived the fold; `parentAssetId` is non-null.
 * - `root` -- the asset is a root of its grouping, decided, not defaulted.
 * - `provisional-root` -- a required boundary value was missing and the profile
 *   policy said root anyway; the decision is flagged, not final.
 * - `unresolved` -- no decision could be made; a review item says why.
 *
 * Every status except `resolved` carries `parentAssetId: null`.
 */
export interface ParentDecision {
  readonly parentAssetId: string | null;
  /** Which ladder rung won, or `null` when no claim did. */
  readonly ladderSource: LadderSourceKind | null;
  /** The claim that won the slot. Absent when nothing won. */
  readonly winningClaim?: SsmRelationshipClaim;
  /** Present only when the fold demoted the selected parent to a dependency. */
  readonly demotedFrom?: ParentDemotion;
  readonly status: 'resolved' | 'root' | 'provisional-root' | 'unresolved';
}

/**
 * An additive relation: it orders work, it never nests (PRODUCT.md §11.3).
 *
 * `parentAssetId` names the upstream asset this one depends on -- the same
 * orientation as `SsmRelationshipClaim`, read from the child's side.
 */
export interface ResolvedDependency {
  readonly parentAssetId: string;
  readonly relationshipType: RelationshipType;
  readonly provenance: Provenance;
}

/** One asset's place in the compiled hierarchy. */
export interface ResolvedAssetNode {
  readonly assetId: string;
  readonly parent: ParentDecision;
  /** Everything the asset depends on, including boundary-demoted parents. */
  readonly dependencies: ReadonlyArray<ResolvedDependency>;
  /** The configured level values that placed this asset, outermost first. */
  readonly levelPath: ReadonlyArray<{ readonly levelId: string; readonly value: string }>;
  /** Every claim that lost the parent slot. Retained, never discarded. */
  readonly losingClaims: ReadonlyArray<SsmRelationshipClaim>;
}

/** Counts a reviewer checks before trusting a compile. */
export interface SnapshotStats {
  readonly nodeCount: number;
  readonly rootCount: number;
  /** Parents the boundary fold turned into dependencies. */
  readonly demotedToDependencyCount: number;
  readonly unresolvedCount: number;
  /** Structural cycles broken into review items, never silently. */
  readonly cycleCount: number;
  /** Ladder tiers that offered more than one candidate and stopped. */
  readonly ambiguousCount: number;
}

/**
 * The compiled hierarchy: one node per asset, plus everything the compiler
 * refused to decide.
 *
 * `nodes` is a Map whose iteration order is part of the contract, so a snapshot
 * serializes to the same bytes every time.
 */
export interface ResolvedSnapshot {
  readonly nodes: ReadonlyMap<string, ResolvedAssetNode>;
  readonly reviewItems: ReadonlyArray<ReviewItem>;
  readonly stats: SnapshotStats;
}
