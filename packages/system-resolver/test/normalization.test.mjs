import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeSystemValue, resolveSystems } from '../dist/index.js';
import {
  ALIAS_CONFIG,
  DRAGON_ANATOMY,
  FULL_TRAIL,
  MAH001,
  NO_NORMALIZATION,
  PAD_CONFIG,
  PLC001_PREFIXED,
  STRIP_PREFIX_CONFIG,
  TAG_THEN_MEL,
  TIT603,
  VFD001_UNPADDED,
} from './dist/dragon.fixture.js';

function keyClaimOf(subject, config, context = {}) {
  return resolveSystems([subject], config, context).bySubject.get(subject.assetId);
}

test('§5.5: a known prefix is removed only because the profile said so', () => {
  const resolved = keyClaimOf(PLC001_PREFIXED, STRIP_PREFIX_CONFIG);
  assert.equal(resolved.resolution.systemKey, '001');
  assert.equal(resolved.keyClaim.rawValue, 'UPN-001');
  assert.equal(resolved.keyClaim.proposedValue, '001');
});

test('§5.5: an alias rewrites 1 to 001 and the raw 1 survives on the claim', () => {
  const resolved = keyClaimOf(VFD001_UNPADDED, ALIAS_CONFIG);
  assert.equal(resolved.resolution.systemKey, '001');
  assert.equal(resolved.keyClaim.rawValue, '1');
  assert.deepEqual(resolved.keyClaim.transforms, [
    { step: { kind: 'alias', from: '1', to: '001' }, from: '1', to: '001' },
  ]);
});

test('§5.5: padStart states the leading zeros out loud', () => {
  const resolved = keyClaimOf(VFD001_UNPADDED, PAD_CONFIG);
  assert.equal(resolved.resolution.systemKey, '001');
  assert.equal(resolved.keyClaim.rawValue, '1');
  assert.deepEqual(resolved.keyClaim.transforms, [
    { step: { kind: 'padStart', length: 3, fill: '0' }, from: '1', to: '001' },
  ]);
});

test('§5.5: with no transforms configured, 1 stays 1 -- never silently padded', () => {
  const resolved = keyClaimOf(VFD001_UNPADDED, NO_NORMALIZATION);
  assert.equal(resolved.resolution.systemKey, '1');
  assert.deepEqual(resolved.keyClaim.transforms, []);
});

test('§5.5: leading zeros already in the source are never stripped either', () => {
  const resolved = keyClaimOf(MAH001, TAG_THEN_MEL, { anatomy: DRAGON_ANATOMY });
  assert.equal(resolved.resolution.systemKey, '001');
});

test('every configured step is recorded, no-ops included', () => {
  const resolved = keyClaimOf(PLC001_PREFIXED, FULL_TRAIL);
  assert.equal(resolved.resolution.systemKey, '001');
  assert.deepEqual(
    resolved.keyClaim.transforms.map((record) => [record.step.kind, record.from, record.to]),
    [
      ['trim', 'UPN-001', 'UPN-001'],
      ['stripPrefix', 'UPN-001', '001'],
      ['uppercase', '001', '001'],
      ['padStart', '001', '001'],
      ['alias', '001', '001'],
    ],
  );
});

test('surrounding whitespace is stripped at the property boundary', () => {
  const resolved = keyClaimOf(VFD001_UNPADDED, NO_NORMALIZATION);
  assert.equal(resolved.keyClaim.rawValue, '1');
});

test('a plain 603 passes through untouched', () => {
  const resolved = keyClaimOf(TIT603, NO_NORMALIZATION);
  assert.equal(resolved.resolution.systemKey, '603');
  assert.equal(resolved.resolution.systemLabel, '603');
});

test('normalizeSystemValue reports the raw value, the result and the trail', () => {
  const normalized = normalizeSystemValue('upn-1', [
    { kind: 'uppercase' },
    { kind: 'stripPrefix', prefix: 'UPN-' },
    { kind: 'padStart', length: 3, fill: '0' },
  ]);
  assert.equal(normalized.raw, 'upn-1');
  assert.equal(normalized.value, '001');
  assert.equal(normalized.transforms.length, 3);
});

test('a stripPrefix that does not apply leaves the value alone', () => {
  const normalized = normalizeSystemValue('001', [{ kind: 'stripPrefix', prefix: 'UPN-' }]);
  assert.equal(normalized.value, '001');
});

test('an alias only fires on an exact match', () => {
  const normalized = normalizeSystemValue('10', [{ kind: 'alias', from: '1', to: '001' }]);
  assert.equal(normalized.value, '10');
});

test('a zero-length pad fill is treated as no request rather than looping', () => {
  const normalized = normalizeSystemValue('1', [{ kind: 'padStart', length: 3, fill: '' }]);
  assert.equal(normalized.value, '1');
});
