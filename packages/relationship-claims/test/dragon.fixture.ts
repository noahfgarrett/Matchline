/**
 * Dragon-site relationship fixtures (DECISIONS.md #6: all invented data is
 * Dragon).
 *
 * The family is PRODUCT.md §11.2 verbatim -- MAH → PLC → VFD → TIT sharing the
 * family key `001-10-01` -- plus one air handler from a second family, which is
 * what makes the "flow without family support is connectivity, not structure"
 * case testable.
 *
 * Typed here rather than written inline in the .mjs tests so a subject list or
 * a flow edge the tests lean on cannot drift out of what the types allow.
 */
import type { ManualRelationshipOverride, Provenance, RoleGraphConfig } from '@matchline/domain';

import type {
  AssembleOptions,
  ClaimSubject,
  FlowEdgeInput,
  LearnedClaimInput,
  PriorSsmExample,
  ProfileLookupEntry,
  ResolveTag,
} from '../dist/index.js';

const CABLE_FILE = 'Dragon-CableSchedule.xlsx';
const MODEL_FILE = 'Dragon-Mechanical.nwc';

/** One cable schedule row, as an address. */
export function cableRow(row: number): Provenance {
  return {
    sourceFile: CABLE_FILE,
    sourceRef: { kind: 'sheet-row', sheet: 'Cables', row },
    propertyOrColumn: 'From',
  };
}

/** The §11.2 family, plus an air handler that belongs to another one. */
export const DRAGON_SUBJECTS: ReadonlyArray<ClaimSubject> = [
  { assetId: 'asset-0001', canonicalTag: 'MAH001-10-01', role: 'MAH', familyKey: '001-10-01' },
  { assetId: 'asset-0002', canonicalTag: 'PLC001-10-01', role: 'PLC', familyKey: '001-10-01' },
  { assetId: 'asset-0003', canonicalTag: 'VFD001-10-01', role: 'VFD', familyKey: '001-10-01' },
  { assetId: 'asset-0004', canonicalTag: 'TIT001-10-01', role: 'TIT', familyKey: '001-10-01' },
  { assetId: 'asset-0005', canonicalTag: 'MAH002-20-01', role: 'MAH', familyKey: '002-20-01' },
];

/** MAH → PLC → VFD → TIT. */
export const DRAGON_ROLE_GRAPH: RoleGraphConfig = {
  rules: [
    { parentRole: 'MAH', childRole: 'PLC' },
    { parentRole: 'PLC', childRole: 'VFD' },
    { parentRole: 'VFD', childRole: 'TIT' },
  ],
};

/**
 * Two in-family feeds and one cross-family feed.
 *
 * The cross-family feed is the DECISIONS.md #1 shape: real connectivity that
 * must never become structure.
 */
export const DRAGON_FLOW_EDGES: ReadonlyArray<FlowEdgeInput> = [
  {
    fromAssetId: 'asset-0001',
    toAssetId: 'asset-0002',
    relationshipType: 'POWERS',
    provenance: cableRow(18),
  },
  {
    fromAssetId: 'asset-0002',
    toAssetId: 'asset-0003',
    relationshipType: 'POWERS',
    provenance: cableRow(19),
  },
  {
    fromAssetId: 'asset-0005',
    toAssetId: 'asset-0002',
    relationshipType: 'POWERS',
    provenance: cableRow(42),
  },
];

/** The instrument's feed, for the case where flow anchors the whole ladder. */
export const VFD_TO_TIT_EDGE: FlowEdgeInput = {
  fromAssetId: 'asset-0003',
  toAssetId: 'asset-0004',
  relationshipType: 'POWERS',
  provenance: cableRow(20),
};

/** A second cable between one pair: parallel feeders are real (§E2). */
export const PARALLEL_FEED_EDGE: FlowEdgeInput = {
  fromAssetId: 'asset-0001',
  toAssetId: 'asset-0002',
  relationshipType: 'POWERS',
  provenance: cableRow(77),
};

/** A second VFD in the family, so one TIT has two role-compatible parents. */
export const AMBIGUOUS_FAMILY_SUBJECTS: ReadonlyArray<ClaimSubject> = [
  ...DRAGON_SUBJECTS,
  { assetId: 'asset-0006', canonicalTag: 'VFD002-10-01', role: 'VFD', familyKey: '001-10-01' },
];

const TAG_TO_ASSET: ReadonlyMap<string, string> = new Map(
  DRAGON_SUBJECTS.map((subject) => [subject.canonicalTag, subject.assetId]),
);

/** The identity bridge: exact canonical spellings only, `null` for anything else. */
export const resolveDragonTag: ResolveTag = (tag) => TAG_TO_ASSET.get(tag) ?? null;

/** The full Dragon compile: role graph plus flow, nothing else configured. */
export const DRAGON_OPTIONS: AssembleOptions = {
  roleGraph: DRAGON_ROLE_GRAPH,
  flowEdges: DRAGON_FLOW_EDGES,
  resolveTag: resolveDragonTag,
};

/** A subject whose model property names its parent, and one whose tag is a typo. */
export const EXPLICIT_PARENT_SUBJECTS: ReadonlyArray<ClaimSubject> = [
  ...DRAGON_SUBJECTS.slice(0, 3),
  {
    assetId: 'asset-0004',
    canonicalTag: 'TIT001-10-01',
    role: 'TIT',
    familyKey: '001-10-01',
    explicitParentTag: 'VFD001-10-01',
    explicitParentProvenance: {
      sourceFile: MODEL_FILE,
      sourceRef: { kind: 'model-object', objectId: '00000000-0000-4000-8000-000000000044' },
      propertyOrColumn: 'Dragon Data > Parent Tag',
    },
  },
  {
    assetId: 'asset-0005',
    canonicalTag: 'MAH002-20-01',
    role: 'MAH',
    familyKey: '002-20-01',
    explicitParentTag: 'PLC009-99-99',
  },
];

export const DRAGON_MANUAL_OVERRIDES: ReadonlyArray<ManualRelationshipOverride> = [
  { childAssetId: 'asset-0004', parentAssetId: 'asset-0002', note: 'walked down 2026-08-05' },
  { childAssetId: 'asset-0005', parentAssetId: null, note: 'stands alone, no feeder' },
];

export const DRAGON_PROFILE_LOOKUP: ReadonlyArray<ProfileLookupEntry> = [
  { childTag: 'TIT001-10-01', parentTag: 'VFD001-10-01' },
  { childTag: 'TIT001-10-01', parentTag: 'VFD001-10-01' },
  { childTag: 'TIT404-40-04', parentTag: 'VFD001-10-01' },
];

export const DRAGON_PRIOR_SSM: ReadonlyArray<PriorSsmExample> = [
  { childTag: 'VFD001-10-01', parentTag: 'MAH001-10-01' },
];

/** One graded rule of each grade, over the same pair. */
export const DRAGON_LEARNED: ReadonlyArray<LearnedClaimInput> = [
  {
    childAssetId: 'asset-0003',
    parentAssetId: 'asset-0001',
    ruleDetail: 'MAH parents VFD (12/13 sightings)',
    confidence: 0.923,
    grade: 'claim',
  },
  {
    childAssetId: 'asset-0004',
    parentAssetId: 'asset-0002',
    ruleDetail: 'PLC parents TIT (4/9 sightings)',
    confidence: 0.444,
    grade: 'proposal',
  },
];
