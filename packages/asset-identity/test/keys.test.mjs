/**
 * The evidence order (RELEASE-1.0-PLAN P0-9).
 *
 * "profile-mapped stable id property > source persistent id + authoring object
 * id > source persistent id + InstanceGuid > deterministic source-relative
 * structural key > tag (last-resort reconciliation only). Content hash never
 * part of identity."
 *
 * What is asserted here is the order, what each tier is scoped to, and the one
 * property that makes the whole thing worth having: nothing content-derived
 * gets into a key.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { STABLE_KEY_TIER_ORDER, stableObjectIdentities } from '../dist/index.js';
import { evidence, MODEL_GUID, SOURCE_ID } from './support.mjs';

test('an object that states everything is identified at every tier, strongest first', () => {
  const identities = stableObjectIdentities(
    evidence({ stableIdPropertyValue: 'REG-000123' }),
  );
  assert.deepEqual(
    identities.map((identity) => identity.tier),
    [...STABLE_KEY_TIER_ORDER],
  );
  // The source is recorded on every identity, so a reviewer can go and look at
  // the object; it is not part of the key (see the next test).
  assert.ok(identities.every((identity) => identity.logicalSourceId === SOURCE_ID));
});

test('a tier with no evidence is absent, never a placeholder key', () => {
  // Two objects that state nothing must not match each other, which is exactly
  // what a `guid/<model>/` key with an empty tail would do.
  const identities = stableObjectIdentities(
    evidence({ authoringId: null, instanceGuid: '   ' }),
  );
  assert.deepEqual(
    identities.map((identity) => identity.tier),
    ['structural', 'tag'],
  );
});

test('the model tiers are scoped by the SOURCE MODEL, so re-registering a file keeps the key', () => {
  // P0-9 says "source persistent id", and the source model's GUID is what that
  // is. The project's own source id is a project fact, and re-registering the
  // same NWD is not a site rebuild.
  const first = stableObjectIdentities(evidence({ logicalSourceId: 'dragon-a' }));
  const second = stableObjectIdentities(evidence({ logicalSourceId: 'dragon-b' }));
  assert.deepEqual(
    first.map((identity) => identity.stableObjectKey),
    second.map((identity) => identity.stableObjectKey),
  );
});

test('the model tiers fall back to the logical source when the cache names no model', () => {
  // Without a scope, `auth/id-MAH001-10-01` from two different files would be
  // one key. The logical source is the only scope left, so it is used.
  const [authoring] = stableObjectIdentities(
    evidence({ sourceModelPersistentId: null, logicalSourceId: 'dragon-a' }),
  );
  const [other] = stableObjectIdentities(
    evidence({ sourceModelPersistentId: null, logicalSourceId: 'dragon-b' }),
  );
  assert.equal(authoring.tier, 'authoring-id');
  assert.notEqual(authoring.stableObjectKey, other.stableObjectKey);
});

test('the stable-id property is deliberately unscoped: it follows equipment between files', () => {
  const here = stableObjectIdentities(
    evidence({ stableIdPropertyValue: 'REG-000123' }),
  );
  const moved = stableObjectIdentities(
    evidence({
      stableIdPropertyValue: 'REG-000123',
      sourceModelPersistentId: '00000000-0000-4000-8000-000000009999',
      logicalSourceId: 'dragon-controls',
      structuralPath: [4, 4],
      instanceGuid: null,
      authoringId: null,
    }),
  );
  assert.equal(here[0].stableObjectKey, moved[0].stableObjectKey);
  assert.equal(here[0].tier, 'stable-id-property');
});

test('the structural key is the shape of the tree and the class, and nothing else', () => {
  const before = stableObjectIdentities(evidence());
  // Everything content-derived changed: a rebuilt cache, new properties, a new
  // tag. The tree shape did not.
  const after = stableObjectIdentities(
    evidence({ canonicalTag: 'MAH001-10-99', authoringId: 'id-MAH001-10-99' }),
  );
  const structuralOf = (identities) =>
    identities.find((identity) => identity.tier === 'structural').stableObjectKey;
  assert.equal(structuralOf(before), structuralOf(after));

  // Moving the object is what a structural key is allowed to notice.
  const moved = stableObjectIdentities(evidence({ structuralPath: [0, 2, 2] }));
  assert.notEqual(structuralOf(before), structuralOf(moved));
});

test('keys escape injectively, so no value can spell another object key', () => {
  // A GUID with a slash in it is not a GUID, but an authoring id is free text
  // and a site can write anything in one.
  const slashed = stableObjectIdentities(evidence({ authoringId: 'a/b' }));
  const compound = stableObjectIdentities(
    evidence({ sourceModelPersistentId: `${MODEL_GUID}/a`, authoringId: 'b' }),
  );
  const authoringOf = (identities) =>
    identities.find((identity) => identity.tier === 'authoring-id').stableObjectKey;
  assert.notEqual(authoringOf(slashed), authoringOf(compound));
});

test('an object the cache does not place carries no structural key', () => {
  const identities = stableObjectIdentities(evidence({ structuralPath: [] }));
  assert.equal(
    identities.some((identity) => identity.tier === 'structural'),
    false,
  );
});

test('an untagged asset carries no tag identity', () => {
  const identities = stableObjectIdentities(evidence({ canonicalTag: '' }));
  assert.equal(
    identities.some((identity) => identity.tier === 'tag'),
    false,
  );
});
