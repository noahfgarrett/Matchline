import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSystemCatalog, resolveSystems } from '../dist/index.js';
import {
  COLLIDING_MEL,
  PAD_KEY_CORROBORATION,
  PAD_THEN_MEL,
  UNPADDED_MEL,
  VFD001_UNPADDED,
} from './dist/dragon.fixture.js';

function resolveOne(subject, config, context) {
  return resolveSystems([subject], config, context).bySubject.get(subject.assetId);
}

function skipOf(resolved, chain) {
  return resolved.skippedRungs.find((rung) => rung.chain === chain);
}

test('§5.5: a padded key still finds the system the MEL spelled unpadded', () => {
  const { catalog } = buildSystemCatalog(UNPADDED_MEL);
  const resolved = resolveOne(VFD001_UNPADDED, PAD_THEN_MEL, { catalog, melRows: UNPADDED_MEL });
  assert.equal(resolved.resolution.systemKey, '001');
  assert.equal(resolved.resolution.systemDescription, 'Utility Water');
  assert.deepEqual(resolved.descriptionClaim.provenance.sourceRef, {
    kind: 'sheet-row',
    sheet: 'MEL',
    row: 2,
  });
});

test('the same join works with MEL rows alone and no catalog built', () => {
  const resolved = resolveOne(VFD001_UNPADDED, PAD_THEN_MEL, { melRows: UNPADDED_MEL });
  assert.equal(resolved.resolution.systemDescription, 'Utility Water');
});

test('two MEL keys that normalization collapses onto one yield nothing, never a guess', () => {
  const { catalog } = buildSystemCatalog(COLLIDING_MEL);
  const resolved = resolveOne(VFD001_UNPADDED, PAD_THEN_MEL, { catalog, melRows: COLLIDING_MEL });
  assert.equal(resolved.resolution.systemKey, '001');
  assert.equal('systemDescription' in resolved.resolution, false);

  const skipped = skipOf(resolved, 'descriptionChain');
  assert.equal(skipped.reason, 'ambiguous-join');
  assert.ok(skipped.detail.includes('1'));
  assert.ok(skipped.detail.includes('001'));
});

test('the ambiguity is the same with MEL rows alone', () => {
  const resolved = resolveOne(VFD001_UNPADDED, PAD_THEN_MEL, { melRows: COLLIDING_MEL });
  assert.equal(skipOf(resolved, 'descriptionChain').reason, 'ambiguous-join');
});

test('a systemKey lookup corroborates the padded key and stays in the claim set', () => {
  const { catalog } = buildSystemCatalog(UNPADDED_MEL);
  const resolved = resolveOne(VFD001_UNPADDED, PAD_KEY_CORROBORATION, {
    catalog,
    melRows: UNPADDED_MEL,
  });
  assert.equal(resolved.agreement, 'agreement');
  assert.deepEqual(
    resolved.claims.map((claim) => [claim.component, claim.rawValue, claim.proposedValue]),
    [
      ['model-field', '1', '001'],
      // The MEL's own spelling is what the rung read; the pad is on the record.
      ['mel-lookup', '1', '001'],
    ],
  );
});

test('an ambiguous corroboration rung yields no key claim of its own', () => {
  const { catalog } = buildSystemCatalog(COLLIDING_MEL);
  const resolved = resolveOne(VFD001_UNPADDED, PAD_KEY_CORROBORATION, {
    catalog,
    melRows: COLLIDING_MEL,
  });
  assert.equal(resolved.resolution.systemKey, '001');
  assert.equal(resolved.agreement, 'single-source');
  assert.equal(skipOf(resolved, 'keyChain').reason, 'ambiguous-join');
});
