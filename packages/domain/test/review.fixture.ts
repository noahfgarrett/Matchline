import {
  EVIDENCE_TIER,
  type AttributeClaim,
  type DuplicateModelTagReviewItem,
  type ReviewItem,
} from '@matchline/domain';

/**
 * One review item of every kind.
 *
 * Type-checked so that a new `ReviewItem` member cannot be added without a
 * constructible example, and consumed by the runtime test that walks the union.
 */

const MODEL_UPN_CLAIM: AttributeClaim = {
  subjectAssetId: 'asset-0001',
  attribute: 'systemKey',
  proposedValue: '002',
  source: 'MODEL',
  rule: 'system.fromModelUpn',
  evidenceTier: EVIDENCE_TIER.MODEL,
  provenance: {
    sourceFile: 'Dragon-Mechanical.nwc',
    sourceRef: { kind: 'model-object', objectId: '00000000-0000-4000-8000-000000000004' },
    propertyOrColumn: 'Dragon Data > UPN',
    rule: 'system.fromModelUpn',
  },
};

const TAG_SEGMENT_CLAIM: AttributeClaim = {
  subjectAssetId: 'asset-0001',
  attribute: 'systemKey',
  proposedValue: '001',
  source: 'MODEL',
  rule: 'system.fromTagSegment',
  evidenceTier: EVIDENCE_TIER.INFERRED,
  provenance: {
    sourceFile: 'Dragon-Mechanical.nwc',
    sourceRef: { kind: 'model-object', objectId: '00000000-0000-4000-8000-000000000004' },
    propertyOrColumn: 'Dragon Data > Tag',
    rule: 'system.fromTagSegment',
  },
};

/** Every item kind, in union declaration order. */
export const DRAGON_REVIEW_ITEMS = [
  {
    kind: 'system-conflict',
    assetId: 'asset-0001',
    claims: [MODEL_UPN_CLAIM, TAG_SEGMENT_CLAIM],
  },
  {
    kind: 'duplicate-model-tag',
    canonicalTag: 'MAH001-10-01',
    objectIds: [4, 57],
  },
  {
    kind: 'system-catalog-conflict',
    systemKey: '001',
    descriptions: ['Mechanical Dry Air Handling', 'Dry Air Handling'],
  },
  {
    kind: 'fuzzy-identity',
    evidenceTag: 'MAH001-10-1',
    candidates: [
      { assetId: 'asset-0001', distance: 1 },
      { assetId: 'asset-0002', distance: 2 },
    ],
  },
  {
    kind: 'ambiguous-suffix',
    evidenceTag: '10-01',
    candidateAssetIds: ['asset-0001', 'asset-0009'],
  },
  {
    kind: 'ambiguous-parent',
    assetId: 'asset-0004',
    ladderSource: 'family-role',
    candidateParentIds: ['asset-0002', 'asset-0003'],
  },
  {
    kind: 'structural-cycle',
    assetIds: ['asset-0002', 'asset-0003', 'asset-0004'],
  },
  {
    kind: 'missing-boundary',
    assetId: 'asset-0009',
    levelId: 'building',
  },
  {
    // PRODUCT.md §2.5 in review form (P0-4): somebody parented the RIO in
    // System 650 under the panel in System 603, and the System boundary refused
    // it. The relationship is not lost — the panel is a dependency — so what a
    // person settles here is which of the two was wrong.
    kind: 'manual-boundary-demotion',
    assetId: 'asset-0650',
    parentAssetId: 'asset-0603',
    boundaryLevelId: 'system',
  },
  {
    kind: 'nesting-proposal',
    assetId: 'asset-0004',
    proposedParentId: 'asset-0003',
    ruleDetail: 'VFD parents TIT (7/8 sightings)',
    confidence: 0.875,
  },
  {
    kind: 'dead-claim-rule',
    ladderSource: 'profile-lookup',
    reason: 'unresolvable-parent-tag',
    childRef: 'TIT603-10-01',
    parentRef: 'MAH001-10-99',
  },
  {
    kind: 'unresolvable-alias',
    evidenceTag: 'MAH-1',
    aliasTarget: 'MAH001-10-99',
  },
  {
    kind: 'absorbed-tagged-component',
    absorbedTag: 'VFD001-10-01',
    absorbingAssetId: 'asset-0001',
    objectId: 57,
  },
  {
    // A parent decision recorded while the register still listed a unit that
    // this revision of the model does not contain (P0-9). The note is the part
    // that would be lost if the decision were dropped instead of reported.
    kind: 'orphaned-decision',
    decision: 'manual-parent',
    childRef: 'tag:MAH009-10-01',
    parentRef: 'tag:MAH001-10-01',
    reason: 'unknown-child',
    note: 'Commissioned with the D1 train.',
  },
  // The three aggregates land at the END of the array on purpose: the tests
  // above index it positionally, and an item inserted in the middle would
  // renumber every assertion that has nothing to do with this change.
  {
    // The audit's blocker B3, as one row: a site whose Building property nobody
    // mapped stops every nesting, and one item per asset per level would be a
    // queue nobody can work.
    kind: 'missing-boundary-level',
    levelId: 'building',
    assetCount: 34,
    exampleAssetIds: ['asset-0001', 'asset-0002', 'asset-0009'],
  },
  {
    kind: 'boundary-demotion',
    levelId: 'system',
    ladderSource: 'flow-family',
    pairCount: 12,
    exampleAssetIds: ['asset-0004', 'asset-0650'],
  },
  {
    kind: 'unresolved-system',
    skipReasons: ['keyChain[0] model-field no-value'],
    assetCount: 8,
    exampleAssetIds: ['asset-0009'],
  },
] as const satisfies ReadonlyArray<ReviewItem>;

/**
 * The same tag registered by two sources (P0-1).
 *
 * Kept out of `DRAGON_REVIEW_ITEMS` because that array holds one item per kind;
 * this is the second shape the one kind can take, and the flat `objectIds`
 * repeat `4` on purpose -- two sources really do both number an object 4, which
 * is why `sources` exists.
 */
export const DUPLICATE_ACROSS_SOURCES: DuplicateModelTagReviewItem = {
  kind: 'duplicate-model-tag',
  canonicalTag: 'MAH001-10-01',
  objectIds: [4, 4],
  sources: [
    { sourceId: 'dragon-mech-a', objectIds: [4] },
    { sourceId: 'dragon-mech-b', objectIds: [4] },
  ],
};

/** One source claiming a tag twice: a duplicate, but not a cross-source one. */
export const DUPLICATE_WITHIN_ONE_SOURCE: DuplicateModelTagReviewItem = {
  kind: 'duplicate-model-tag',
  canonicalTag: 'MAH001-10-01',
  objectIds: [4, 57],
  sources: [{ sourceId: 'dragon-mech-a', objectIds: [4, 57] }],
};

/**
 * The invariant this fixture exists for: every `ReviewItem` member has a
 * constructible example above.
 *
 * A type, not a runtime check, so adding a member to the union without adding
 * an example here stops this file compiling rather than failing a test run.
 */
type UnexampledKind = Exclude<
  ReviewItem['kind'],
  (typeof DRAGON_REVIEW_ITEMS)[number]['kind']
>;
export type EveryReviewKindHasAnExample = UnexampledKind extends never ? true : never;
const _EVERY_KIND_HAS_AN_EXAMPLE: EveryReviewKindHasAnExample = true;
void _EVERY_KIND_HAS_AN_EXAMPLE;
