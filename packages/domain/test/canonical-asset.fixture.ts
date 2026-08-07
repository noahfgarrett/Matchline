import {
  EVIDENCE_TIER,
  type AttributeClaim,
  type CanonicalAsset,
  type RelationshipClaim,
  type SourceObservation,
} from '@matchline/domain';

/**
 * A fully populated asset from the Dragon fixture site.
 *
 * This file exists to be type-checked: if `CanonicalAsset` ever grows a field
 * that cannot actually be supplied, or an optional field stops behaving like
 * one under exactOptionalPropertyTypes, this stops compiling. The runtime test
 * then asserts the shape survived the round trip through the barrel.
 */
export const DRAGON_PUMP: CanonicalAsset = {
  assetId: 'asset-0001',
  canonicalTag: 'DRG-P-1201A',
  aliases: ['DRG P 1201A', 'P-1201A'],
  description: 'Primary cooling water pump',
  equipmentType: 'PUMP',
  nativeDiscipline: 'Mechanical',
  ssmDiscipline: 'MECH',
  system: {
    systemKey: 'DRG-CW-01',
    systemDescription: 'Cooling water distribution',
    systemLabel: 'Cooling Water',
    systemEvidence: [
      {
        sourceFile: 'dragon-mel.xlsx',
        sourceRef: { kind: 'sheet-row', sheet: 'MEL', row: 412 },
        propertyOrColumn: 'System Description',
        rule: 'system.fromMelDescription',
        inputRevision: 'C',
      },
    ],
    systemConfidenceTier: EVIDENCE_TIER.TRACKING_DOCUMENT,
    systemConflictStatus: 'AGREED',
  },
  hierarchyAttributes: {
    building: 'B-40',
    level: 'L2',
  },
  modelObjectReferences: [
    {
      modelFile: 'dragon-mech.ifc',
      objectId: '3kJ9dQwEr0xuP2hTn5vBmZ',
      category: 'IfcPump',
    },
  ],
  sourceStatuses: ['MODEL_CONFIRMED'],
  resolvedParent: {
    parentAssetId: 'asset-0007',
    relationshipType: 'POWERS',
    evidenceTier: EVIDENCE_TIER.ENGINEERED_DOCUMENT,
    provenance: {
      sourceFile: 'dragon-power-study.xlsx',
      sourceRef: { kind: 'sheet-row', sheet: 'Register', row: 88 },
      propertyOrColumn: 'Upstream Device',
      rule: 'parent.fromPowerRegister',
      fallbackRung: 1,
    },
  },
  dependencies: [],
  provenance: [
    {
      sourceFile: 'dragon-model.ifc',
      sourceRef: { kind: 'model-object', objectId: '3kJ9dQwEr0xuP2hTn5vBmZ' },
      propertyOrColumn: 'Tag',
      rule: 'identity.fromModelTag',
      profileRevision: '2026.08.1',
    },
  ],
  reviewStatus: 'UNREVIEWED',
};

/** An asset resolved to the root: `null` parent is a decision, not a gap. */
export const DRAGON_INCOMER: CanonicalAsset = {
  ...DRAGON_PUMP,
  assetId: 'asset-0007',
  canonicalTag: 'DRG-SWB-01',
  aliases: [],
  description: 'Main switchboard',
  equipmentType: 'SWITCHBOARD',
  nativeDiscipline: 'Electrical',
  ssmDiscipline: 'ELEC',
  hierarchyAttributes: {},
  sourceStatuses: ['MODEL_ONLY', 'DUPLICATE_MODEL_TAG'],
  resolvedParent: null,
};

export const DRAGON_TAG_OBSERVATION: SourceObservation = {
  observationId: 'obs-0001',
  source: 'MEL',
  rawTag: ' drg-p-1201a ',
  attributes: {
    Description: 'Primary cooling water pump',
    'Line Number': 412,
    Spare: false,
    Commissioned: null,
  },
  provenance: {
    sourceFile: 'dragon-mel.xlsx',
    sourceRef: { kind: 'sheet-row', sheet: 'MEL', row: 412 },
  },
};

export const DRAGON_DISCIPLINE_CLAIM: AttributeClaim = {
  subjectAssetId: 'asset-0001',
  attribute: 'ssmDiscipline',
  proposedValue: 'MECH',
  source: 'MEL',
  rule: 'discipline.fromMel',
  evidenceTier: EVIDENCE_TIER.TRACKING_DOCUMENT,
  provenance: DRAGON_TAG_OBSERVATION.provenance,
};

export const DRAGON_CONTROL_CLAIM: RelationshipClaim = {
  subjectAssetId: 'asset-0001',
  targetAssetId: 'asset-0031',
  kind: 'dependency',
  relationshipType: 'CONTROLS',
  source: 'FLOW',
  rule: 'relate.fromControlNarrative',
  evidenceTier: EVIDENCE_TIER.INFERRED,
  provenance: {
    sourceFile: 'dragon-flow.xlsx',
    sourceRef: { kind: 'sheet-row', sheet: 'Loops', row: 12 },
    manualDecision: 'engineer confirmed the loop drives the pump',
  },
};
