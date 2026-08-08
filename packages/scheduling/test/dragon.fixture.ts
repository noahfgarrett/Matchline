/**
 * Dragon-site scheduling fixtures (DECISIONS.md #6: all invented data is Dragon).
 *
 * Typed here rather than written inline in the .mjs tests so a snapshot, an
 * asset row or a P6 activity the tests lean on cannot drift out of what the
 * types actually allow.
 *
 * The site, in one picture:
 *
 * ```
 * Dragon Utilities / Electrical / 603      GIS603-00-01
 *                                            └ XFM603-10-01
 *                                                └ PNL603-10-01
 *                                                    └ VFD603-10-01
 * Dragon Utilities / Mechanical / 2201     MAH2201-20-01   (depends on PNL603-10-01)
 *                                            └ VFD2201-20-02
 *                                                └ TIT2201-20-03
 * Dragon Utilities / I&C / 650             RIO650-30-01    (PNL603-10-01 demoted, §2.5)
 *                                            └ FMS650-30-02
 * Dragon Screening / I&C / 777             PIT777-40-01
 * Dragon Screening / I&C / 900             DDC900-50-01
 * ```
 */

import type {
  ParentDecision,
  Provenance,
  ResolvedAssetNode,
  ResolvedDependency,
  ResolvedSnapshot,
} from '@matchline/domain';

import type { MilestoneAsset, PredecessorAsset, SequenceAsset } from '../dist/index.js';

/* ---- assets ---- */

/** One row satisfying every asset shape this package takes. */
export interface DragonAsset extends MilestoneAsset, SequenceAsset, PredecessorAsset {
  readonly assetId: string;
  readonly canonicalTag: string;
  readonly discipline: string;
  readonly building: string;
  readonly systemKey: string;
}

const UTILITIES = 'Dragon Utilities';
const SCREENING = 'Dragon Screening';

export const DRAGON_ASSETS: ReadonlyArray<DragonAsset> = [
  { assetId: 'asset-0001', canonicalTag: 'GIS603-00-01', building: UTILITIES, discipline: 'Electrical', systemKey: '603' },
  { assetId: 'asset-0002', canonicalTag: 'XFM603-10-01', building: UTILITIES, discipline: 'Electrical', systemKey: '603' },
  { assetId: 'asset-0003', canonicalTag: 'PNL603-10-01', building: UTILITIES, discipline: 'Electrical', systemKey: '603' },
  { assetId: 'asset-0004', canonicalTag: 'VFD603-10-01', building: UTILITIES, discipline: 'Electrical', systemKey: '603' },
  { assetId: 'asset-0010', canonicalTag: 'MAH2201-20-01', building: UTILITIES, discipline: 'Mechanical', systemKey: '2201' },
  { assetId: 'asset-0011', canonicalTag: 'VFD2201-20-02', building: UTILITIES, discipline: 'Mechanical', systemKey: '2201' },
  { assetId: 'asset-0012', canonicalTag: 'TIT2201-20-03', building: UTILITIES, discipline: 'Mechanical', systemKey: '2201' },
  { assetId: 'asset-0020', canonicalTag: 'RIO650-30-01', building: UTILITIES, discipline: 'I&C', systemKey: '650' },
  { assetId: 'asset-0021', canonicalTag: 'FMS650-30-02', building: UTILITIES, discipline: 'I&C', systemKey: '650' },
  { assetId: 'asset-0030', canonicalTag: 'PIT777-40-01', building: SCREENING, discipline: 'I&C', systemKey: '777' },
  { assetId: 'asset-0040', canonicalTag: 'DDC900-50-01', building: SCREENING, discipline: 'I&C', systemKey: '900' },
];

/* ---- snapshot ---- */

const MODEL_FILE = 'Dragon-Electrical.nwd';

function modelProvenance(objectId: string): Provenance {
  return { sourceFile: MODEL_FILE, sourceRef: { kind: 'model-object', objectId } };
}

function dependency(parentAssetId: string): ResolvedDependency {
  return {
    parentAssetId,
    relationshipType: 'DEPENDENCY',
    provenance: modelProvenance(parentAssetId),
  };
}

const ROOT: ParentDecision = { parentAssetId: null, ladderSource: null, status: 'root' };

function childOf(parentAssetId: string): ParentDecision {
  return { parentAssetId, ladderSource: 'explicit-model', status: 'resolved' };
}

/** The boundary fold's own outcome: parent removed, kept as a dependency. */
function demotedRoot(parentAssetId: string): ParentDecision {
  return {
    parentAssetId: null,
    ladderSource: 'explicit-model',
    status: 'root',
    demotedFrom: { parentAssetId, boundaryLevelId: 'system' },
  };
}

function node(
  assetId: string,
  parent: ParentDecision,
  dependencies: ReadonlyArray<ResolvedDependency> = [],
): ResolvedAssetNode {
  return { assetId, parent, dependencies, levelPath: [], losingClaims: [] };
}

/** Assemble a snapshot from nodes, with stats that match them. */
export function snapshotOf(nodes: ReadonlyArray<ResolvedAssetNode>): ResolvedSnapshot {
  return {
    nodes: new Map(nodes.map((entry) => [entry.assetId, entry])),
    reviewItems: [],
    stats: {
      nodeCount: nodes.length,
      rootCount: nodes.filter((entry) => entry.parent.status !== 'resolved').length,
      demotedToDependencyCount: nodes.filter((entry) => entry.parent.demotedFrom !== undefined)
        .length,
      unresolvedCount: 0,
      cycleCount: 0,
      ambiguousCount: 0,
    },
  };
}

/**
 * The compiled Dragon hierarchy.
 *
 * Both cross-system relations are dependencies, which is what the hard-boundary
 * fold produces (DECISIONS.md #1): the panel in 603 feeds the RIO in 650 and
 * serves the air handler in 2201, and neither nests.
 */
export const DRAGON_SNAPSHOT: ResolvedSnapshot = snapshotOf([
  node('asset-0001', ROOT),
  node('asset-0002', childOf('asset-0001')),
  node('asset-0003', childOf('asset-0002')),
  node('asset-0004', childOf('asset-0003')),
  node('asset-0010', ROOT, [dependency('asset-0003')]),
  node('asset-0011', childOf('asset-0010')),
  node('asset-0012', childOf('asset-0011')),
  node('asset-0020', demotedRoot('asset-0003'), [dependency('asset-0003')]),
  node('asset-0021', childOf('asset-0020')),
  node('asset-0030', ROOT),
  node('asset-0040', ROOT),
]);

/**
 * The same site with one impossible edit: the RIO's parent decision is
 * `resolved` onto the panel in system 603, a nesting the fold would never
 * produce. Numbering must still be group-scoped — see the sequencing tests.
 */
export const CROSS_GROUP_SNAPSHOT: ResolvedSnapshot = snapshotOf([
  node('asset-0001', ROOT),
  node('asset-0002', childOf('asset-0001')),
  node('asset-0003', childOf('asset-0002')),
  node('asset-0004', childOf('asset-0003')),
  node('asset-0020', childOf('asset-0003')),
  node('asset-0021', childOf('asset-0020')),
]);

/** Two assets in different systems, each depending on the other. */
export const CYCLE_ASSETS: ReadonlyArray<DragonAsset> = [
  { assetId: 'asset-0101', canonicalTag: 'PNL110-10-01', building: UTILITIES, discipline: 'Electrical', systemKey: '110' },
  { assetId: 'asset-0102', canonicalTag: 'PNL120-10-01', building: UTILITIES, discipline: 'Electrical', systemKey: '120' },
];

export const CYCLE_SNAPSHOT: ResolvedSnapshot = snapshotOf([
  node('asset-0101', ROOT, [dependency('asset-0102')]),
  node('asset-0102', ROOT, [dependency('asset-0101')]),
]);

/** Two assets whose parent links point at each other: no root to start from. */
export const PARENT_CYCLE_SNAPSHOT: ResolvedSnapshot = snapshotOf([
  node('asset-0101', childOf('asset-0102')),
  node('asset-0102', childOf('asset-0101')),
]);

/**
 * Systems `001` and `1`, which are two systems and must stay two (PRODUCT.md
 * §5.5). `001` also has to survive the workbook as text.
 */
export const LEADING_ZERO_ASSETS: ReadonlyArray<DragonAsset> = [
  { assetId: 'asset-0201', canonicalTag: 'GIS001-00-01', building: UTILITIES, discipline: 'Electrical', systemKey: '001' },
  { assetId: 'asset-0202', canonicalTag: 'RIO1-30-01', building: UTILITIES, discipline: 'I&C', systemKey: '1' },
];

export const LEADING_ZERO_SNAPSHOT: ResolvedSnapshot = snapshotOf([
  node('asset-0201', ROOT),
  node('asset-0202', ROOT, [dependency('asset-0201')]),
]);

/* ---- P6 sources ---- */

/**
 * A Dragon XER. Two L2 milestones name their systems in the activity name —
 * the only rung an XER can reach, because the format carries no equipment or
 * UPN column — plus one ordinary task that names nothing.
 */
export const DRAGON_XER: string = [
  'ERMHDR\t19.12\t2026-08-07\tProject\tDragon',
  '%T\tPROJECT',
  '%F\tproj_id\tproj_short_name',
  '%R\t100\tDRAGON',
  '%T\tTASK',
  '%F\ttask_id\ttask_code\ttask_name\ttask_type',
  '%R\t1001\tL2-M1-0603\tL2-M1-0603 - UPN 603 Main Intake Energization\tTT_Mile',
  '%R\t1002\tL2-M1-2201\tL2-M1-2201 - UPN 2201 Screening Systems Enabling\tTT_Mile',
  '%R\t1003\tA1010\tInstall screening supply fan\tTT_Task',
  '%T\tTASKPRED',
  '%F\ttask_pred_id\ttask_id\tpred_task_id\tpred_type',
  '%R\t5001\t1002\t1001\tPR_FS',
  '%E',
  '',
].join('\n');

/** The header row and rows of a Dragon P6 Activities export. */
export const DRAGON_ACTIVITY_SHEET: ReadonlyArray<ReadonlyArray<string>> = [
  ['Activity ID', 'Activity Name', 'Equipment ID', 'UPN', 'Start', 'Finish'],
  ['A2000', 'Commission RIO 650 remote IO', 'RIO650-30-01', '', '01-Mar-27', '05-Mar-27'],
  ['A2010', 'Terminate FMS network trunk', '', '650', '06-Mar-27', '07-Mar-27'],
  ['A2030', 'Preassemble UPN 2201 ductwork', '', '', '', ''],
  ['A2040', 'Loop check UPN 777 instruments', '', '777', '', ''],
  ['', '', '', '', '', ''],
  ['A2050', 'Mobilize commissioning team', '', '', '', ''],
  ['A2060', 'Energize spare feeder', '', '999', '', ''],
];

/** The mapping the wizard would hand the reader for that sheet. */
export const DRAGON_ACTIVITY_MAPPING = {
  activityId: 'Activity ID',
  activityName: 'Activity Name',
  equipmentTag: 'Equipment ID',
  upn: 'UPN',
  startDate: 'Start',
  finishDate: 'Finish',
} as const;
