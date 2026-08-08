import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSystemCatalog, resolveSystems } from '../dist/index.js';
import {
  CUSTOM_LABEL,
  DRAGON_ANATOMY,
  DRAGON_MEL,
  MAH001,
  MANUAL_DESCRIPTION_ONLY,
  TAG_THEN_MEL,
  UNTAGGED,
} from './dist/dragon.fixture.js';

const { catalog } = buildSystemCatalog(DRAGON_MEL);
const dragonContext = { anatomy: DRAGON_ANATOMY, catalog, melRows: DRAGON_MEL };

function resolveOne(subject, config, context = dragonContext) {
  const result = resolveSystems([subject], config, context);
  return { result, subject: result.bySubject.get(subject.assetId) };
}

test('§5.4: the tag names the system and the MEL describes it', () => {
  const { result, subject } = resolveOne(MAH001, TAG_THEN_MEL);
  assert.equal(subject.resolution.systemKey, '001');
  assert.equal(subject.resolution.systemDescription, 'Mechanical Dry Air Handling');
  assert.equal(subject.resolution.systemLabel, '001 Mechanical Dry Air Handling');
  assert.equal(subject.resolution.systemConflictStatus, 'AGREED');
  assert.equal(subject.agreement, 'single-source');
  assert.deepEqual(result.reviewItems, []);
});

test('the winning key claim carries the rung, the rule and the model address', () => {
  const { subject } = resolveOne(MAH001, TAG_THEN_MEL);
  const claim = subject.keyClaim;
  assert.equal(claim.attribute, 'systemKey');
  assert.equal(claim.component, 'tag-segment');
  assert.equal(claim.source, 'MODEL');
  assert.equal(claim.rungIndex, 0);
  assert.equal(claim.rule, 'systemResolver.keyChain[0].tag-segment');
  assert.equal(claim.provenance.fallbackRung, 1);
  assert.equal(claim.provenance.propertyOrColumn, 'tag segment "system"');
  assert.equal(claim.provenance.sourceFile, 'Dragon-Mechanical.nwd');
  assert.deepEqual(claim.provenance.sourceRef, { kind: 'model-object', objectId: '41201' });
});

test('a tag-derived key is inferred evidence, not model evidence', () => {
  const { subject } = resolveOne(MAH001, TAG_THEN_MEL);
  assert.equal(subject.resolution.systemConfidenceTier, 1);
});

test('the description claim points back at the MEL row it came from', () => {
  const { subject } = resolveOne(MAH001, TAG_THEN_MEL);
  const claim = subject.descriptionClaim;
  assert.equal(claim.attribute, 'systemDescription');
  assert.equal(claim.source, 'MEL');
  assert.equal(claim.evidenceTier, 2);
  assert.equal(claim.provenance.sourceFile, 'Dragon-MEL.xlsx');
  assert.deepEqual(claim.provenance.sourceRef, { kind: 'sheet-row', sheet: 'MEL', row: 2 });
});

test('both chains keep their claims and the evidence lists every one', () => {
  const { subject } = resolveOne(MAH001, TAG_THEN_MEL);
  assert.equal(subject.claims.length, 2);
  assert.equal(subject.resolution.systemEvidence.length, 2);
});

test('a site can punctuate its own label', () => {
  const { subject } = resolveOne(MAH001, CUSTOM_LABEL);
  assert.equal(subject.resolution.systemLabel, '001 / Mechanical Dry Air Handling');
});

test('with no MEL at all the label is the bare key', () => {
  const { subject } = resolveOne(MAH001, TAG_THEN_MEL, { anatomy: DRAGON_ANATOMY });
  assert.equal(subject.resolution.systemKey, '001');
  assert.equal('systemDescription' in subject.resolution, false);
  assert.equal(subject.resolution.systemLabel, '001');
});

test('a label template naming a description it cannot fill falls back to the key', () => {
  const { subject } = resolveOne(MAH001, CUSTOM_LABEL, { anatomy: DRAGON_ANATOMY });
  assert.equal(subject.resolution.systemLabel, '001');
});

test('a human can supply the description without touching the key', () => {
  const { subject } = resolveOne(MAH001, TAG_THEN_MEL, {
    anatomy: DRAGON_ANATOMY,
    manual: MANUAL_DESCRIPTION_ONLY,
  });
  assert.equal(subject.resolution.systemKey, '001');
  assert.equal(subject.resolution.systemDescription, 'Dry Air, North Bay');
  assert.equal(subject.descriptionClaim.component, 'manual');
  assert.equal(subject.descriptionClaim.rungIndex, 1);
  assert.equal(subject.descriptionClaim.provenance.fallbackRung, 2);
});

test('a subject no rung can speak for resolves to nothing, not to a guess', () => {
  const { subject } = resolveOne(UNTAGGED, TAG_THEN_MEL);
  assert.equal(subject.resolution, null);
  assert.equal(subject.keyClaim, null);
  assert.equal(subject.agreement, 'unresolved');
  assert.deepEqual(subject.claims, []);
});

test('an unresolved subject still records why each rung stayed silent', () => {
  const { subject } = resolveOne(UNTAGGED, TAG_THEN_MEL);
  assert.equal(subject.skippedRungs.length, 2);
  assert.equal(subject.skippedRungs[0].chain, 'keyChain');
  assert.equal(subject.skippedRungs[0].reason, 'no-value');
  assert.equal(subject.skippedRungs[1].chain, 'descriptionChain');
  assert.equal(subject.skippedRungs[1].reason, 'no-join-key');
});

test('no subjects resolve to no entries and nothing to review', () => {
  const result = resolveSystems([], TAG_THEN_MEL, dragonContext);
  assert.equal(result.bySubject.size, 0);
  assert.deepEqual(result.reviewItems, []);
});

test('resolving with no context at all is silent, not a crash', () => {
  const result = resolveSystems([MAH001], TAG_THEN_MEL);
  assert.equal(result.bySubject.get('dragon-0001').resolution, null);
  assert.equal(result.bySubject.get('dragon-0001').skippedRungs[0].reason, 'not-configured');
});
