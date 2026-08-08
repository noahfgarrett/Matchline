/**
 * Relationship claims carrying the ladder rung that produced them.
 *
 * A plain `RelationshipClaim` says who proposed what. The SSM projection also
 * needs to know *which rung of the §11.1 ladder* the proposal arrived on,
 * because the ladder -- not the evidence tier -- is what decides precedence: a
 * manual override beats a model property beats a flow-anchored family rule,
 * regardless of how strong the underlying document is.
 */
import type { RelationshipClaim } from './claims.js';
import type { LadderSourceKind } from './hierarchy-config.js';

/**
 * One parent or dependency proposal, tagged with its ladder rung.
 *
 * Orientation is fixed and load-bearing: `subjectAssetId` is the *child* (the
 * asset being placed) and `targetAssetId` is the proposed *parent* or the
 * upstream asset depended on. Every producer and consumer reads it that way.
 */
export interface SsmRelationshipClaim extends RelationshipClaim {
  readonly ladderSource: LadderSourceKind;
}
