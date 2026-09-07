import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSystemCatalog, resolveSystems } from '../dist/index.js';
import {
  ANATOMY_THEN_UPN,
  APPROVED_MEL,
  APPROVED_NAME_FROM_PROPERTY,
  DRAGON_ANATOMY,
  MAH001,
  MAH101,
  MAH105,
  APPROVED_NAME_OVER_MEL_DESCRIPTION,
  APPROVED_NAME_THEN_MEL,
  TWO_UPNS,
  UPN_AND_APPROVED_NAME,
  UPN_AND_EXACT_NAME,
  UPN_FROM_TAG,
  VFD101,
} from './dist/dragon.fixture.js';

/**
 * The approved VF Exto vocabulary, inside the resolver.
 *
 * Two rungs, and one directive behind both: the UPN is carried in the equipment
 * tag. `MAH101-01` and `VFD101-01` are the same system because the tag says so,
 * and the System Name that goes with it is the one the Upload Template spells —
 * not a description a site happens to have written next to it.
 *
 * Everything asserted here is the vendored rulebook's own answer. Nothing in
 * this package decides what an approved UPN is.
 */

const { catalog } = buildSystemCatalog(APPROVED_MEL);
const base = { anatomy: DRAGON_ANATOMY, catalog, melRows: APPROVED_MEL };

function resolveOne(subject, config, context = base) {
  return resolveSystems([subject], config, context).bySubject.get(subject.assetId);
}

/* ------------------------------------------------------------ upn-from-tag */

test('the UPN comes out of the tag whatever role is in front of it', () => {
  assert.equal(resolveOne(MAH101, UPN_FROM_TAG).resolution.systemKey, '101');
  assert.equal(resolveOne(VFD101, UPN_FROM_TAG).resolution.systemKey, '101');
});

test('the rung needs no tag anatomy at all', () => {
  const resolved = resolveOne(MAH101, UPN_FROM_TAG, { catalog, melRows: APPROVED_MEL });
  assert.equal(resolved.resolution.systemKey, '101');
  assert.equal(
    resolved.skippedRungs.length,
    0,
    'an anatomy rung would have been skipped as not-configured; this one is not',
  );
});

test('a tag carrying no approved UPN is skipped, not guessed at', () => {
  const resolved = resolveOne(MAH001, UPN_FROM_TAG);
  assert.equal(resolved.resolution, null);
  assert.equal(resolved.skippedRungs[0].reason, 'no-upn-candidate');
  assert.match(resolved.skippedRungs[0].detail, /MAH001-10-01/);
});

test('a tag carrying two approved UPNs names both rather than taking the first', () => {
  const resolved = resolveOne(TWO_UPNS, UPN_FROM_TAG);
  assert.equal(resolved.resolution, null);
  const [skipped] = resolved.skippedRungs;
  assert.equal(skipped.reason, 'ambiguous-upn');
  assert.deepEqual(skipped.candidates, ['101', '102']);
});

test('the claim is addressable: the tag it was read out of, on the model object', () => {
  const { keyClaim } = resolveOne(MAH101, UPN_FROM_TAG);
  assert.equal(keyClaim.provenance.propertyOrColumn, 'approved UPN in the equipment tag');
  assert.deepEqual(keyClaim.provenance.sourceRef, { kind: 'model-object', objectId: '51201' });
  assert.equal(keyClaim.source, 'MODEL');
});

test('it coexists with the anatomy rung, and the profile order decides', () => {
  // Dragon's anatomy cuts `001` out of MAH001-10-01; the approved-UPN rung
  // finds nothing there. The first rung answers and the second one says why it
  // could not, which is the whole of "either may be first".
  const resolved = resolveOne(MAH001, ANATOMY_THEN_UPN);
  assert.equal(resolved.resolution.systemKey, '001');
  assert.deepEqual(
    resolved.skippedRungs.map((rung) => [rung.component, rung.reason]),
    [['upn-from-tag', 'no-upn-candidate']],
  );
});

/* ------------------------------------------------------- exto-system-name */

test('a UPN with one approved name takes it when the profile allows that', () => {
  const resolved = resolveOne(MAH101, UPN_AND_APPROVED_NAME);
  assert.equal(resolved.resolution.systemKey, '101');
  assert.equal(resolved.resolution.systemLabel, '101  Cleanroom Makeup Air System');
  assert.equal(
    resolved.descriptionClaim.provenance.rule,
    'exto-approved-list:unique-upn',
    'the label says which of the two accepting outcomes produced it',
  );
});

test('the approved name is the whole label, never the key printed twice', () => {
  const { systemLabel } = resolveOne(MAH101, UPN_AND_APPROVED_NAME).resolution;
  assert.equal(systemLabel, '101  Cleanroom Makeup Air System');
  assert.ok(!systemLabel.startsWith('101 101'), 'the approved spelling already opens with the UPN');
});

test('without the toggle, a UPN with one name still needs a description that agrees', () => {
  const resolved = resolveOne(MAH101, UPN_AND_EXACT_NAME);
  assert.equal(resolved.resolution.systemKey, '101', 'the key is unaffected');
  assert.equal(resolved.descriptionClaim, null);
  const [skipped] = resolved.skippedRungs;
  assert.equal(skipped.reason, 'description-mismatch');
  assert.deepEqual(skipped.candidates, ['101  Cleanroom Makeup Air System']);
});

test('a MEL description above the rung is what it checks, and an exact match wins', () => {
  const resolved = resolveOne(MAH101, APPROVED_NAME_OVER_MEL_DESCRIPTION);
  assert.equal(
    resolved.descriptionClaim.proposedValue,
    'Cleanroom Makeup Air System',
    'the MEL rung is first, so its own words are the resolved description',
  );
  const approved = resolved.claims.find((claim) => claim.component === 'exto-system-name');
  assert.equal(
    approved.provenance.rule,
    'exto-approved-list:exact',
    'and the rung below it confirms those words ARE the approved name',
  );
  assert.equal(
    resolved.resolution.systemLabel,
    '101 Cleanroom Makeup Air System',
    'a rung that did not win does not get to write the label; chain order is chain order',
  );
});

test('placed first, the approved name IS the label and the MEL fills the rest', () => {
  const named = resolveOne(MAH101, APPROVED_NAME_THEN_MEL);
  assert.equal(named.resolution.systemLabel, '101  Cleanroom Makeup Air System');

  // 105 owns two approved names and the MEL calls it "Rooftop air conditioning".
  // The approved rung refuses and lists both, the MEL rung underneath answers,
  // and the register still carries a description rather than nothing.
  const unnamed = resolveOne(MAH105, APPROVED_NAME_THEN_MEL);
  assert.equal(unnamed.resolution.systemDescription, 'Rooftop air conditioning');
  const [skipped] = unnamed.skippedRungs;
  assert.equal(skipped.reason, 'description-mismatch');
  assert.deepEqual(skipped.candidates, [
    '105  Air Condensing unit/Cooling Coil/Heating Coil',
    '105  General Air Handler System (AC)',
  ]);
});

test('the rung can read the description off a model property instead', () => {
  const resolved = resolveOne(MAH105, APPROVED_NAME_FROM_PROPERTY);
  assert.equal(resolved.resolution.systemLabel, '105  General Air Handler System (AC)');
  assert.match(
    resolved.descriptionClaim.provenance.propertyOrColumn,
    /Dragon > System Description/,
  );
});

test('a description chain with no key above it has nothing to name', () => {
  const resolved = resolveOne(MAH001, UPN_AND_APPROVED_NAME);
  assert.equal(resolved.resolution, null);
  assert.deepEqual(
    resolved.skippedRungs.map((rung) => rung.reason),
    ['no-upn-candidate', 'no-join-key'],
  );
});

test('same input, same output, every run', () => {
  const subjects = [MAH101, VFD101, MAH105, TWO_UPNS, MAH001];
  const once = resolveSystems(subjects, APPROVED_NAME_THEN_MEL, base);
  const twice = resolveSystems(subjects, APPROVED_NAME_THEN_MEL, base);
  assert.deepEqual([...once.bySubject], [...twice.bySubject]);
});
