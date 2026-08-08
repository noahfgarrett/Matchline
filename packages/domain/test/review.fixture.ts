import {
  EVIDENCE_TIER,
  type AttributeClaim,
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
export const DRAGON_REVIEW_ITEMS: ReadonlyArray<ReviewItem> = [
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
    kind: 'nesting-proposal',
    assetId: 'asset-0004',
    proposedParentId: 'asset-0003',
    ruleDetail: 'VFD parents TIT (7/8 sightings)',
    confidence: 0.875,
  },
];
