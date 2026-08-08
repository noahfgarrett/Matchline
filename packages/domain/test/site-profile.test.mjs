import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DRAGON_ANATOMY,
  DRAGON_FILTERS,
  DRAGON_MINIMAL_PROFILE,
  DRAGON_NORMALIZATION,
  DRAGON_PROFILE,
  DRAGON_RESOLVER,
} from './dist/site-profile.fixture.js';

test('a profile addresses properties by category and name, never by name alone', () => {
  assert.deepEqual(DRAGON_PROFILE.propertyMappings.equipmentTag, {
    category: 'Dragon Data',
    name: 'Tag',
  });
  assert.equal(DRAGON_PROFILE.propertyMappings.description?.category, 'Item');
});

test('a draft profile omits the sections it has not taught yet', () => {
  assert.equal('tagAnatomy' in DRAGON_MINIMAL_PROFILE, false);
  assert.equal('systemResolver' in DRAGON_MINIMAL_PROFILE, false);
  assert.equal(DRAGON_MINIMAL_PROFILE.propertyMappings.equipmentTag.name, 'Tag');
});

test('the two filter decisions a site cannot inherit are always stated', () => {
  for (const filters of [DRAGON_FILTERS, DRAGON_MINIMAL_PROFILE.assetFilters]) {
    assert.equal(typeof filters.requireTagProperty, 'boolean');
    assert.equal(typeof filters.collapseComponents, 'boolean');
  }
});

test('separately commissionable classes survive component collapse', () => {
  assert.equal(DRAGON_FILTERS.collapseComponents, true);
  assert.deepEqual(DRAGON_FILTERS.separatelyCommissionableClasses, ['Module']);
});

test('the anatomy names one extractor per segment it teaches', () => {
  assert.deepEqual(Object.keys(DRAGON_ANATOMY.segments).sort(), [
    'instance',
    'role',
    'system',
    'unit',
  ]);
  assert.equal(DRAGON_ANATOMY.segments.role?.kind, 'alphaPrefix');
  assert.equal(DRAGON_ANATOMY.segments.system?.kind, 'digitSuffix');
});

test('every resolution component kind is constructible', () => {
  assert.deepEqual(
    DRAGON_RESOLVER.keyChain.map((component) => component.kind),
    ['model-field', 'tag-segment', 'direct-column', 'mel-lookup', 'composite', 'manual'],
  );
});

test('every normalization step kind is constructible and ordered by the profile', () => {
  assert.deepEqual(
    DRAGON_NORMALIZATION.map((step) => step.kind),
    ['trim', 'uppercase', 'stripPrefix', 'padStart', 'alias'],
  );
});

test('leading-zero handling is an explicit step, not an implicit conversion', () => {
  const pad = DRAGON_NORMALIZATION.find((step) => step.kind === 'padStart');
  assert.ok(pad !== undefined);
  assert.equal(pad.length, 3);
  assert.equal(pad.fill, '0');
});

test('a conflicting resolver chain defaults to review rather than a silent vote', () => {
  assert.equal(DRAGON_RESOLVER.conflictPolicy, 'review');
});
