import assert from 'node:assert/strict';
import test from 'node:test';

import { COMPONENT_EVIDENCE_TIER, buildSystemCatalog, resolveSystems } from '../dist/index.js';
import {
  COMPOSITE_CONFIG,
  COMPOSITE_LITERAL,
  COMPOSITE_MISSING_INPUT,
  COMPOSITE_PROPS_ONLY,
  DIRECT_COLUMN,
  DRAGON_ANATOMY,
  DRAGON_MEL,
  KEY_JOIN_AFTER_TAG,
  KEY_JOIN_FIRST,
  MAH001,
  MAH001_MODEL_SAYS_002,
  PLC001_PREFIXED,
  TAG_THEN_MEL,
  THREE_RUNG_KEY,
  TIT603,
  UNTAGGED,
  VFD001_UNPADDED,
} from './dist/dragon.fixture.js';

const { catalog } = buildSystemCatalog(DRAGON_MEL);
const base = { anatomy: DRAGON_ANATOMY, catalog, melRows: DRAGON_MEL };

function resolveOne(subject, config, context = base) {
  return resolveSystems([subject], config, context).bySubject.get(subject.assetId);
}

test('a mel-lookup on systemKey placed first has no key to join on', () => {
  const resolved = resolveOne(MAH001, KEY_JOIN_FIRST);
  assert.equal(resolved.resolution, null);
  assert.equal(resolved.skippedRungs[0].reason, 'no-join-key');
});

test('the same lookup one rung lower joins on what the tag segment resolved', () => {
  const resolved = resolveOne(MAH001, KEY_JOIN_AFTER_TAG);
  assert.equal(resolved.resolution.systemKey, '001');
  assert.equal(resolved.agreement, 'agreement');
  assert.deepEqual(
    resolved.claims.map((claim) => [claim.component, claim.proposedValue]),
    [
      ['tag-segment', '001'],
      ['mel-lookup', '001'],
    ],
  );
});

test('a key join finds nothing when the MEL never heard of the key', () => {
  const resolved = resolveOne(TIT603, KEY_JOIN_AFTER_TAG, { ...base, catalog: new Map() });
  assert.equal(resolved.resolution.systemKey, '603');
  assert.equal(resolved.skippedRungs[0].reason, 'no-value');
});

test('a tag join needs rows the catalog cannot stand in for', () => {
  const resolved = resolveOne(MAH001_MODEL_SAYS_002, THREE_RUNG_KEY, {
    anatomy: DRAGON_ANATOMY,
    catalog,
  });
  assert.equal(
    resolved.skippedRungs.some(
      (rung) => rung.component === 'mel-lookup' && rung.reason === 'not-configured',
    ),
    true,
  );
});

test('a tag-segment rung with no anatomy configured is skipped, not guessed', () => {
  const resolved = resolveOne(MAH001, TAG_THEN_MEL, { catalog, melRows: DRAGON_MEL });
  assert.equal(resolved.resolution, null);
  assert.deepEqual(
    { reason: resolved.skippedRungs[0].reason, component: resolved.skippedRungs[0].component },
    { reason: 'not-configured', component: 'tag-segment' },
  );
});

test('§5.2: a composite assembles an area and a tag segment', () => {
  const resolved = resolveOne(MAH001_MODEL_SAYS_002, COMPOSITE_CONFIG);
  assert.equal(resolved.resolution.systemKey, 'B1-001');
  assert.equal(resolved.keyClaim.provenance.propertyOrColumn, 'composite {prop:Dragon.Area}-{segment:system}');
});

test('a composite is only as trustworthy as its weakest input', () => {
  const derived = resolveOne(MAH001_MODEL_SAYS_002, COMPOSITE_CONFIG);
  const stated = resolveOne(MAH001_MODEL_SAYS_002, COMPOSITE_PROPS_ONLY);
  assert.equal(derived.resolution.systemConfidenceTier, 1);
  assert.equal(stated.resolution.systemKey, 'B1-002');
  assert.equal(stated.resolution.systemConfidenceTier, 4);
});

test('a composite missing one input yields nothing rather than half a key', () => {
  const resolved = resolveOne(MAH001_MODEL_SAYS_002, COMPOSITE_MISSING_INPUT);
  assert.equal(resolved.resolution, null);
  assert.equal(resolved.skippedRungs[0].reason, 'no-value');
});

test('a composite with no placeholders is a profile constant and is refused', () => {
  const resolved = resolveOne(MAH001, COMPOSITE_LITERAL);
  assert.equal(resolved.resolution, null);
  assert.equal(resolved.skippedRungs[0].reason, 'not-configured');
});

test('a composite whose segment the anatomy cannot cut yields nothing', () => {
  const resolved = resolveOne(UNTAGGED, COMPOSITE_CONFIG);
  assert.equal(resolved.resolution, null);
});

test('a direct column is an explicit statement and reads as model evidence', () => {
  const resolved = resolveOne(TIT603, DIRECT_COLUMN);
  assert.equal(resolved.resolution.systemKey, '603');
  assert.equal(resolved.keyClaim.component, 'direct-column');
  assert.equal(resolved.keyClaim.evidenceTier, 4);
  assert.equal(resolved.keyClaim.provenance.propertyOrColumn, 'Dragon > UPN');
});

test('a subject that never states the property is skipped with no-value', () => {
  const resolved = resolveOne(MAH001, DIRECT_COLUMN);
  assert.equal(resolved.resolution, null);
  assert.equal(resolved.skippedRungs[0].reason, 'no-value');
});

test('the component tier mapping puts the human and the model at the ceiling', () => {
  assert.deepEqual(COMPONENT_EVIDENCE_TIER, {
    manual: 4,
    'model-field': 4,
    'direct-column': 4,
    'mel-lookup': 2,
    'tag-segment': 1,
    composite: 1,
  });
});

test('a subject with no source file stated still carries addressable provenance', () => {
  const resolved = resolveOne(PLC001_PREFIXED, DIRECT_COLUMN);
  assert.equal(resolved.keyClaim.provenance.sourceFile, '');
  assert.deepEqual(resolved.keyClaim.provenance.sourceRef, {
    kind: 'model-object',
    objectId: 'dragon-0003',
  });
});

test('bySubject keeps input order and keys on assetId', () => {
  const subjects = [MAH001, MAH001_MODEL_SAYS_002, TIT603, VFD001_UNPADDED, UNTAGGED];
  const result = resolveSystems(subjects, THREE_RUNG_KEY, base);
  assert.deepEqual(
    [...result.bySubject.keys()],
    subjects.map((subject) => subject.assetId),
  );
});

test('the same subjects and profile resolve identically every run', () => {
  const subjects = [MAH001, MAH001_MODEL_SAYS_002, TIT603, VFD001_UNPADDED, UNTAGGED];
  const first = resolveSystems(subjects, THREE_RUNG_KEY, base);
  const second = resolveSystems(subjects, THREE_RUNG_KEY, base);
  assert.equal(
    JSON.stringify([...first.bySubject]) + JSON.stringify(first.reviewItems),
    JSON.stringify([...second.bySubject]) + JSON.stringify(second.reviewItems),
  );
});

test('review items come out in subject order', () => {
  const result = resolveSystems([MAH001, MAH001_MODEL_SAYS_002], THREE_RUNG_KEY, base);
  assert.deepEqual(
    result.reviewItems.map((item) => item.assetId),
    ['dragon-0002'],
  );
});
