import {
  EVIDENCE_TIER,
  LADDER_SOURCE_ORDER,
  type HierarchyConfig,
  type ManualRelationshipOverride,
  type ParentLadderConfig,
  type ResolvedSnapshot,
  type RoleGraphConfig,
  type SsmRelationshipClaim,
} from '@matchline/domain';

/**
 * The Dragon site's SSM configuration and one compiled snapshot.
 *
 * Type-checked so that a hierarchy level, a ladder rung or a parent decision
 * that cannot actually be constructed stops the build. The runtime test then
 * asserts the semantics the types alone cannot state -- that a root carries a
 * null parent by decision, that a demoted parent survives as a dependency, and
 * that losing claims are kept.
 */

/** MAH → PLC → VFD → TIT (PRODUCT.md §11.2). Three rules, not one path. */
export const DRAGON_ROLE_GRAPH: RoleGraphConfig = {
  rules: [
    { parentRole: 'MAH', childRole: 'PLC' },
    { parentRole: 'PLC', childRole: 'VFD' },
    { parentRole: 'VFD', childRole: 'TIT' },
  ],
};

/** The site trusts nothing it did not state itself: no learned rung. */
export const DRAGON_LADDER: ParentLadderConfig = {
  tiers: LADDER_SOURCE_ORDER.filter((tier) => tier !== 'learned-description'),
};

export const DRAGON_HIERARCHY: HierarchyConfig = {
  levels: [
    {
      levelId: 'building',
      displayName: 'Building',
      attributeKey: 'hierarchyAttributes.building',
      boundary: true,
      missingValuePolicy: 'review',
      sort: 'label',
    },
    {
      levelId: 'ssm-discipline',
      displayName: 'SSM Discipline',
      attributeKey: 'ssmDiscipline',
      boundary: true,
      missingValuePolicy: 'unassigned-group',
      sort: 'label',
    },
    {
      levelId: 'system',
      displayName: 'System',
      attributeKey: 'system.systemKey',
      boundary: true,
      missingValuePolicy: 'provisional-root',
      sort: 'key',
    },
  ],
};

export const DRAGON_MANUAL_OVERRIDES: ReadonlyArray<ManualRelationshipOverride> = [
  { childAssetId: 'asset-0004', parentAssetId: 'asset-0003', note: 'walked down 2026-08-05' },
  { childAssetId: 'asset-0009', parentAssetId: null, note: 'stands alone, no feeder' },
];

const FLOW_FAMILY_CLAIM: SsmRelationshipClaim = {
  subjectAssetId: 'asset-0002',
  targetAssetId: 'asset-0001',
  kind: 'structural-parent',
  relationshipType: 'FAMILY_RELATED',
  source: 'FLOW',
  rule: 'relate.flowAnchoredFamily',
  evidenceTier: EVIDENCE_TIER.ENGINEERED_DOCUMENT,
  ladderSource: 'flow-family',
  provenance: {
    sourceFile: 'Dragon-CableSchedule.xlsx',
    sourceRef: { kind: 'sheet-row', sheet: 'Cables', row: 18 },
    propertyOrColumn: 'From',
    rule: 'MAH>PLC',
    fallbackRung: 4,
  },
};

const FAMILY_ROLE_CLAIM: SsmRelationshipClaim = {
  subjectAssetId: 'asset-0002',
  targetAssetId: 'asset-0007',
  kind: 'structural-parent',
  relationshipType: 'FAMILY_RELATED',
  source: 'MODEL',
  rule: 'relate.familyRole',
  evidenceTier: EVIDENCE_TIER.INFERRED,
  ladderSource: 'family-role',
  provenance: {
    sourceFile: 'site-profile',
    sourceRef: { kind: 'sheet-row', sheet: 'roleGraph', row: 1 },
    rule: 'MAH>PLC',
    fallbackRung: 5,
  },
};

/**
 * A compile of four assets: one nested, one root, one boundary-demoted, one the
 * compiler refused to place.
 */
export const DRAGON_SNAPSHOT: ResolvedSnapshot = {
  nodes: new Map([
    [
      'asset-0001',
      {
        assetId: 'asset-0001',
        parent: { parentAssetId: null, ladderSource: null, status: 'root' },
        dependencies: [],
        levelPath: [
          { levelId: 'building', value: 'B-40' },
          { levelId: 'ssm-discipline', value: 'MECH' },
          { levelId: 'system', value: '001' },
        ],
        losingClaims: [],
      },
    ],
    [
      'asset-0002',
      {
        assetId: 'asset-0002',
        parent: {
          parentAssetId: 'asset-0001',
          ladderSource: 'flow-family',
          winningClaim: FLOW_FAMILY_CLAIM,
          status: 'resolved',
        },
        dependencies: [],
        levelPath: [
          { levelId: 'building', value: 'B-40' },
          { levelId: 'ssm-discipline', value: 'MECH' },
          { levelId: 'system', value: '001' },
        ],
        losingClaims: [FAMILY_ROLE_CLAIM],
      },
    ],
    [
      'asset-0650',
      {
        assetId: 'asset-0650',
        parent: {
          parentAssetId: null,
          ladderSource: 'flow-family',
          demotedFrom: { parentAssetId: 'asset-0603', boundaryLevelId: 'system' },
          status: 'root',
        },
        // The panel that fed it stays visible, as a dependency (DECISIONS.md #1).
        dependencies: [
          {
            parentAssetId: 'asset-0603',
            relationshipType: 'POWERS',
            provenance: {
              sourceFile: 'Dragon-EasyPower.xlsx',
              sourceRef: { kind: 'sheet-row', sheet: 'Feeders', row: 91 },
              propertyOrColumn: 'Upstream',
              fallbackRung: 4,
            },
          },
        ],
        levelPath: [
          { levelId: 'building', value: 'B-41' },
          { levelId: 'ssm-discipline', value: 'ELEC' },
          { levelId: 'system', value: '650' },
        ],
        losingClaims: [],
      },
    ],
    [
      'asset-0009',
      {
        assetId: 'asset-0009',
        parent: { parentAssetId: null, ladderSource: null, status: 'unresolved' },
        dependencies: [],
        levelPath: [],
        losingClaims: [],
      },
    ],
  ]),
  reviewItems: [{ kind: 'missing-boundary', assetId: 'asset-0009', levelId: 'building' }],
  stats: {
    nodeCount: 4,
    rootCount: 2,
    demotedToDependencyCount: 1,
    unresolvedCount: 1,
    cycleCount: 0,
    ambiguousCount: 0,
  },
};
