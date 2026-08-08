/**
 * Dragon-site compiler fixtures (DECISIONS.md #6: all invented data is Dragon).
 *
 * Two scenarios carry most of the suite, both lifted from PRODUCT.md rather than
 * imagined:
 *
 * - **§2.5 verbatim** -- an electrical panel in System 603 feeding a RIO in
 *   System 650. The flow evidence is real, the nesting is not: the RIO belongs
 *   in 650 with the panel listed as a dependency.
 * - **§11.2 verbatim** -- MAH → PLC → VFD → TIT sharing family key `001-10-01`,
 *   every member in one building, one discipline and one system, so the whole
 *   chain survives the fold intact.
 *
 * Typed here rather than written inline in the .mjs tests so a subject list or a
 * claim the tests lean on cannot drift out of what the types allow.
 */
import type { HierarchyConfig, LadderSourceKind, RelationshipType, SsmRelationshipClaim } from '@matchline/domain';
import {
  DEPENDENCY_RULE,
  LADDER_SOURCE_EVIDENCE_TIER,
  LADDER_SOURCE_KIND,
  LADDER_SOURCE_RELATIONSHIP_TYPE,
  LADDER_SOURCE_RULE,
  ladderRung,
} from '@matchline/relationship-claims';

import type { CompileClaims, CompileInput, CompileSubject } from '../dist/index.js';

/** The three attribute keys every fixture level addresses. */
export const BUILDING = 'building';
export const DISCIPLINE = 'ssmDiscipline';
export const SYSTEM = 'systemKey';

const CABLE_FILE = 'Dragon-CableSchedule.xlsx';

/** One subject. Absent keys are absent on purpose -- never defaulted (§11.3). */
export function subject(
  assetId: string,
  attributes: Readonly<Record<string, string>>,
  modelTreeParentId?: string,
): CompileSubject {
  return {
    assetId,
    attributes: new Map(Object.entries(attributes)),
    ...(modelTreeParentId === undefined ? {} : { modelTreeParentId }),
  };
}

/**
 * One structural claim, stamped exactly as `@matchline/relationship-claims`
 * would stamp it, so a fixture claim and an assembled one are the same thing.
 */
export function claim(
  ladderSource: LadderSourceKind,
  childAssetId: string,
  parentAssetId: string,
  row = 1,
): SsmRelationshipClaim {
  return {
    subjectAssetId: childAssetId,
    targetAssetId: parentAssetId,
    kind: 'structural-parent',
    relationshipType: LADDER_SOURCE_RELATIONSHIP_TYPE[ladderSource],
    source: LADDER_SOURCE_KIND[ladderSource],
    rule: LADDER_SOURCE_RULE[ladderSource],
    evidenceTier: LADDER_SOURCE_EVIDENCE_TIER[ladderSource],
    ladderSource,
    provenance: {
      sourceFile: CABLE_FILE,
      sourceRef: { kind: 'sheet-row', sheet: 'Cables', row },
      rule: LADDER_SOURCE_RULE[ladderSource],
      fallbackRung: ladderRung(ladderSource),
    },
  };
}

/** One additive relation, read from the dependent asset's side. */
export function dependency(
  dependentAssetId: string,
  upstreamAssetId: string,
  relationshipType: RelationshipType = 'POWERS',
  row = 1,
): SsmRelationshipClaim {
  return {
    subjectAssetId: dependentAssetId,
    targetAssetId: upstreamAssetId,
    kind: 'dependency',
    relationshipType,
    source: LADDER_SOURCE_KIND['flow-family'],
    rule: DEPENDENCY_RULE,
    evidenceTier: LADDER_SOURCE_EVIDENCE_TIER['flow-family'],
    ladderSource: 'flow-family',
    provenance: {
      sourceFile: CABLE_FILE,
      sourceRef: { kind: 'sheet-row', sheet: 'Cables', row },
      rule: DEPENDENCY_RULE,
    },
  };
}

/** Shorthand for a claims bundle with the parts a test does not use left empty. */
export function claims(parts: Partial<CompileClaims>): CompileClaims {
  return {
    structural: parts.structural ?? [],
    dependencies: parts.dependencies ?? [],
    makeRoot: parts.makeRoot ?? [],
  };
}

/**
 * Building and system are hard boundaries; discipline is display-only.
 *
 * This is the §11.4 default: a PLC keeps its native discipline and still nests
 * under a Mechanical Dry parent, because discipline only blocks a structural
 * relationship when the site enables it as a boundary.
 */
export const DRAGON_HIERARCHY: HierarchyConfig = {
  levels: [
    {
      levelId: 'building',
      displayName: 'Building',
      attributeKey: BUILDING,
      boundary: true,
      missingValuePolicy: 'review',
      sort: 'label',
    },
    {
      levelId: 'discipline',
      displayName: 'SSM Discipline',
      attributeKey: DISCIPLINE,
      boundary: false,
      missingValuePolicy: 'unassigned-group',
      sort: 'label',
    },
    {
      levelId: 'system',
      displayName: 'System',
      attributeKey: SYSTEM,
      boundary: true,
      missingValuePolicy: 'review',
      sort: 'key',
    },
  ],
};

/** The same stack with discipline promoted to a hard boundary (§11.4, other way). */
export const DISCIPLINE_BOUNDARY_HIERARCHY: HierarchyConfig = {
  levels: DRAGON_HIERARCHY.levels.map((level) =>
    level.levelId === 'discipline' ? { ...level, boundary: true } : level,
  ),
};

/** A hierarchy whose only level is building, under a chosen missing-value policy. */
export function buildingOnlyHierarchy(
  missingValuePolicy: 'unassigned-group' | 'review' | 'provisional-root',
): HierarchyConfig {
  return {
    levels: [
      {
        levelId: 'building',
        displayName: 'Building',
        attributeKey: BUILDING,
        boundary: true,
        missingValuePolicy,
        sort: 'label',
      },
    ],
  };
}

// --- PRODUCT.md §2.5, verbatim ---------------------------------------------

export const PANEL = 'asset-panel-603';
export const RIO = 'asset-rio-650';

/** Panel in System 603, RIO in System 650, both in building D1, both electrical. */
export const RIO_SUBJECTS: ReadonlyArray<CompileSubject> = [
  subject(PANEL, { [BUILDING]: 'D1', [DISCIPLINE]: 'Electrical', [SYSTEM]: '603' }),
  subject(RIO, { [BUILDING]: 'D1', [DISCIPLINE]: 'Electrical', [SYSTEM]: '650' }),
];

/** The cable schedule says the panel feeds the RIO. Both halves of that survive. */
export const RIO_CLAIMS: CompileClaims = claims({
  structural: [claim('flow-family', RIO, PANEL, 12)],
  dependencies: [dependency(RIO, PANEL, 'POWERS', 12)],
});

export const RIO_INPUT: CompileInput = {
  subjects: RIO_SUBJECTS,
  claims: RIO_CLAIMS,
  hierarchy: DRAGON_HIERARCHY,
};

// --- PRODUCT.md §11.2, verbatim --------------------------------------------

export const MAH = 'asset-0001-mah';
export const PLC = 'asset-0002-plc';
export const VFD = 'asset-0003-vfd';
export const TIT = 'asset-0004-tit';

const MECHANICAL_DRY = 'Mechanical Dry';

/** One family, one building, one discipline, one system. */
export const FAMILY_SUBJECTS: ReadonlyArray<CompileSubject> = [
  subject(MAH, { [BUILDING]: 'D1', [DISCIPLINE]: MECHANICAL_DRY, [SYSTEM]: '001' }),
  subject(PLC, { [BUILDING]: 'D1', [DISCIPLINE]: MECHANICAL_DRY, [SYSTEM]: '001' }),
  subject(VFD, { [BUILDING]: 'D1', [DISCIPLINE]: MECHANICAL_DRY, [SYSTEM]: '001' }),
  subject(TIT, { [BUILDING]: 'D1', [DISCIPLINE]: MECHANICAL_DRY, [SYSTEM]: '001' }),
];

/** MAH → PLC → VFD anchored by flow; VFD → TIT by family and role alone. */
export const FAMILY_CLAIMS: CompileClaims = claims({
  structural: [
    claim('flow-family', PLC, MAH, 1),
    claim('flow-family', VFD, PLC, 2),
    claim('family-role', TIT, VFD, 3),
  ],
  dependencies: [dependency(PLC, MAH, 'POWERS', 1), dependency(VFD, PLC, 'POWERS', 2)],
});

export const FAMILY_INPUT: CompileInput = {
  subjects: FAMILY_SUBJECTS,
  claims: FAMILY_CLAIMS,
  hierarchy: DRAGON_HIERARCHY,
};

/**
 * Both scenarios in one compile, plus the model-tree rung and a demoted parent.
 *
 * This is what the determinism test shuffles: every code path that emits a list
 * -- decisions, dependencies, losing claims, level buckets -- is exercised at
 * once, so a stray iteration-order dependency has somewhere to show up.
 */
export const DRAGON_INPUT: CompileInput = {
  subjects: [
    ...FAMILY_SUBJECTS,
    ...RIO_SUBJECTS,
    subject('asset-0005-tit', { [BUILDING]: 'D1', [DISCIPLINE]: MECHANICAL_DRY, [SYSTEM]: '001' }, VFD),
    subject('asset-0006-xfmr', { [BUILDING]: 'D2', [DISCIPLINE]: 'Electrical', [SYSTEM]: '603' }),
  ],
  claims: claims({
    structural: [
      ...FAMILY_CLAIMS.structural,
      ...RIO_CLAIMS.structural,
      // Cross-building: D2 transformer proposed as the D1 panel's parent.
      claim('flow-family', PANEL, 'asset-0006-xfmr', 20),
    ],
    dependencies: [
      ...FAMILY_CLAIMS.dependencies,
      ...RIO_CLAIMS.dependencies,
      dependency(PANEL, 'asset-0006-xfmr', 'POWERS', 20),
    ],
  }),
  hierarchy: DRAGON_HIERARCHY,
};
