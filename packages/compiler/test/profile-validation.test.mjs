/**
 * `validateProfile`: a typo in a profile is refused, not obeyed.
 *
 * Every field checked here is a string a person typed into a closed vocabulary,
 * and every one of them behaves like a deliberate choice when it misses. A
 * misspelled ladder rung disables that evidence; a misspelled level key finds no
 * value on any asset and files the whole site under `(unassigned)`. Both look
 * exactly like a site that decided to do that, which is why they have to fail
 * loudly instead.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { compileProject, ProfileConfigError } from '../dist/index.js';
import { fullInput, HIERARCHY, openDragonCache, siteProfile } from './support.mjs';

let handle = null;

before(() => {
  handle = openDragonCache('profile-validation');
});

after(() => {
  handle?.close();
});

/** Compiles Dragon under a profile with one section replaced. */
function compileWith(profileOverrides) {
  return compileProject(fullInput(handle.cache, { profile: siteProfile(profileOverrides) }));
}

/** The default hierarchy with one level's field rewritten. */
function levelWith(patch) {
  return {
    levels: [HIERARCHY.levels[0], { ...HIERARCHY.levels[1], ...patch }],
  };
}

function refusal(profileOverrides) {
  try {
    compileWith(profileOverrides);
  } catch (error) {
    assert.ok(error instanceof ProfileConfigError, `expected a ProfileConfigError, got ${error}`);
    return error;
  }
  return assert.fail('the profile was accepted');
}

test('a ladder tier the engine does not have is refused, naming the field', () => {
  const error = refusal({ ladder: { tiers: ['manual', 'explicit_model'] } });

  assert.equal(error.reason.kind, 'unknown-ladder-tier');
  assert.equal(error.reason.field, 'ladder.tiers[1]');
  assert.equal(error.reason.value, 'explicit_model');
  assert.match(error.message, /ladder\.tiers\[1\] says 'explicit_model'/);
  assert.match(error.message, /explicit-model/, 'and says what it could have said');
});

test('a level key no asset carries is refused rather than filed under (unassigned)', () => {
  const error = refusal({ hierarchy: levelWith({ attributeKey: 'system' }) });

  assert.equal(error.reason.kind, 'unknown-attribute-key');
  assert.equal(error.reason.field, 'hierarchy.levels[1].keyAttributeKey');
  assert.equal(error.reason.levelId, 'system');
  assert.match(error.message, /systemKey/);
});

test('a boundary attribute is checked like a key, because the fold compares it', () => {
  const error = refusal({ hierarchy: levelWith({ boundaryAttributeKey: 'sytemKey' }) });

  assert.equal(error.reason.field, 'hierarchy.levels[1].boundaryAttributeKey');
  assert.equal(error.reason.value, 'sytemKey');
});

test('a missing-value policy outside the union is refused', () => {
  const error = refusal({ hierarchy: levelWith({ missingValuePolicy: 'unassigned' }) });

  assert.equal(error.reason.kind, 'unknown-missing-value-policy');
  assert.equal(error.reason.field, 'hierarchy.levels[1].missingValuePolicy');
  assert.match(error.message, /unassigned-group/);
});

test('a sibling order outside the union is refused', () => {
  const error = refusal({ hierarchy: levelWith({ sort: 'alphabetical' }) });

  assert.equal(error.reason.kind, 'unknown-level-sort');
  assert.equal(error.reason.field, 'hierarchy.levels[1].sort');
  assert.match(error.message, /label, key/);
});

test('a level may name a derived attribute the profile actually defines', () => {
  const project = compileWith({
    derivedAttributes: [
      {
        attributeId: 'zone',
        displayName: 'Zone',
        resolverChain: [{ kind: 'tag-segment', segment: 'unit' }],
      },
    ],
    hierarchy: levelWith({ displayAttributeKey: 'zone' }),
  });

  assert.equal(project.completeness.levels.length, 2);
});

test('the ladder as shipped, and the default hierarchy, are both accepted', () => {
  assert.doesNotThrow(() => compileWith({}));
});
