import assert from 'node:assert/strict';
import test from 'node:test';

import { EVIDENCE_TIER, relationshipKindOf } from '../dist/index.js';
import {
  DRAGON_CONTROL_CLAIM,
  DRAGON_DISCIPLINE_CLAIM,
  DRAGON_INCOMER,
  DRAGON_PUMP,
  DRAGON_TAG_OBSERVATION,
} from './dist/canonical-asset.fixture.js';

test('a fully populated asset carries its identity, system and parent', () => {
  assert.equal(DRAGON_PUMP.canonicalTag, 'DRG-P-1201A');
  assert.deepEqual(DRAGON_PUMP.aliases, ['DRG P 1201A', 'P-1201A']);
  assert.equal(DRAGON_PUMP.system.systemLabel, 'Cooling Water');
  assert.equal(DRAGON_PUMP.resolvedParent?.parentAssetId, 'asset-0007');
});

test('a root asset states a null parent rather than omitting the field', () => {
  assert.equal(DRAGON_INCOMER.resolvedParent, null);
  assert.ok('resolvedParent' in DRAGON_INCOMER);
});

test('an absent hierarchy attribute is missing, not undefined-valued', () => {
  assert.deepEqual(DRAGON_INCOMER.hierarchyAttributes, {});
  assert.equal('building' in DRAGON_INCOMER.hierarchyAttributes, false);
});

test('an asset records every source status that applies to it', () => {
  assert.deepEqual(DRAGON_INCOMER.sourceStatuses, ['MODEL_ONLY', 'DUPLICATE_MODEL_TAG']);
});

test('model evidence outranks every other tier', () => {
  const tiers = [
    EVIDENCE_TIER.INFERRED,
    EVIDENCE_TIER.TRACKING_DOCUMENT,
    EVIDENCE_TIER.ENGINEERED_DOCUMENT,
    EVIDENCE_TIER.MODEL,
  ];
  assert.deepEqual([...tiers].sort((a, b) => a - b), tiers);
  assert.equal(Math.max(...tiers), EVIDENCE_TIER.MODEL);
});

test('a parent claim is backed by a relationship that is allowed to nest', () => {
  const parent = DRAGON_PUMP.resolvedParent;
  assert.ok(parent !== null);
  assert.equal(relationshipKindOf(parent.relationshipType), 'structural-parent');
  assert.equal(parent.provenance.fallbackRung, 1);
});

test('a control relationship stays a dependency and never re-parents', () => {
  assert.equal(DRAGON_CONTROL_CLAIM.kind, 'dependency');
  assert.equal(relationshipKindOf(DRAGON_CONTROL_CLAIM.relationshipType), 'dependency');
  assert.equal(DRAGON_PUMP.dependencies.length, 0);
});

test('provenance addresses a model object and a sheet row in their own shapes', () => {
  const [modelProvenance] = DRAGON_PUMP.provenance;
  assert.equal(modelProvenance.sourceRef.kind, 'model-object');
  assert.equal(modelProvenance.sourceRef.objectId, '3kJ9dQwEr0xuP2hTn5vBmZ');

  const sheetRef = DRAGON_TAG_OBSERVATION.provenance.sourceRef;
  assert.equal(sheetRef.kind, 'sheet-row');
  assert.equal(sheetRef.sheet, 'MEL');
  assert.equal(sheetRef.row, 412);
});

test('a raw observation keeps the tag exactly as the source wrote it', () => {
  assert.equal(DRAGON_TAG_OBSERVATION.rawTag, ' drg-p-1201a ');
  assert.notEqual(DRAGON_TAG_OBSERVATION.rawTag, DRAGON_PUMP.canonicalTag);
});

test('an observation preserves mixed-typed cell values, including explicit blanks', () => {
  assert.equal(DRAGON_TAG_OBSERVATION.attributes['Line Number'], 412);
  assert.equal(DRAGON_TAG_OBSERVATION.attributes.Spare, false);
  assert.equal(DRAGON_TAG_OBSERVATION.attributes.Commissioned, null);
});

test('an attribute claim is a proposal carrying its own tier and rule', () => {
  assert.equal(DRAGON_DISCIPLINE_CLAIM.attribute, 'ssmDiscipline');
  assert.equal(DRAGON_DISCIPLINE_CLAIM.proposedValue, 'MECH');
  assert.equal(DRAGON_DISCIPLINE_CLAIM.rule, 'discipline.fromMel');
  assert.equal(DRAGON_DISCIPLINE_CLAIM.evidenceTier, EVIDENCE_TIER.TRACKING_DOCUMENT);
});
