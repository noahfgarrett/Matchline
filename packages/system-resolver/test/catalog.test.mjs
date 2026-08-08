import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSystemCatalog } from '../dist/index.js';
import { DRAGON_MEL, MESSY_MEL } from './dist/dragon.fixture.js';

test('the §5.4 MEL becomes one catalog entry per system', () => {
  const { catalog, reviewItems } = buildSystemCatalog(DRAGON_MEL);
  assert.equal(catalog.size, 2);
  assert.deepEqual(catalog.get('001'), {
    description: 'Mechanical Dry Air Handling',
    sourceRowCount: 1,
    aliases: [],
  });
  assert.deepEqual(catalog.get('603'), {
    description: 'Process Temperature',
    sourceRowCount: 1,
    aliases: [],
  });
  assert.deepEqual(reviewItems, []);
});

test('a key with two descriptions keeps the first and raises a review item', () => {
  const { catalog, reviewItems } = buildSystemCatalog(MESSY_MEL);
  assert.equal(catalog.get('001').description, 'Mechanical Dry Air Handling');
  assert.equal(reviewItems.length, 1);
  assert.deepEqual(reviewItems[0], {
    kind: 'system-catalog-conflict',
    systemKey: '001',
    descriptions: ['Mechanical Dry Air Handling', 'Mech Dry Air Handling'],
  });
});

test('every row naming a key counts toward sourceRowCount, description or not', () => {
  const { catalog } = buildSystemCatalog(MESSY_MEL);
  assert.equal(catalog.get('001').sourceRowCount, 4);
});

test('a key written with stray whitespace folds in as an alias, not a new system', () => {
  const { catalog } = buildSystemCatalog(MESSY_MEL);
  assert.deepEqual(catalog.get('001').aliases, [' 001']);
  assert.equal(catalog.has(' 001'), false);
});

test('leading zeros are sacred: 1 and 001 are different systems', () => {
  const { catalog } = buildSystemCatalog(MESSY_MEL);
  assert.equal(catalog.get('001').description, 'Mechanical Dry Air Handling');
  assert.equal(catalog.get('1').description, 'Utility Water');
  assert.equal(catalog.get('1').sourceRowCount, 1);
});

test('rows with a blank key or no key at all build nothing', () => {
  const { catalog } = buildSystemCatalog(MESSY_MEL);
  assert.deepEqual([...catalog.keys()], ['001', '1']);
});

test('a system named without any description has no description key at all', () => {
  const { catalog } = buildSystemCatalog([{ systemKey: '900' }]);
  assert.equal('description' in catalog.get('900'), false);
  assert.equal(catalog.get('900').sourceRowCount, 1);
});

test('an empty MEL yields an empty catalog and nothing to review', () => {
  const { catalog, reviewItems } = buildSystemCatalog([]);
  assert.equal(catalog.size, 0);
  assert.deepEqual(reviewItems, []);
});

test('the same rows build a byte-identical catalog every time', () => {
  const first = buildSystemCatalog(MESSY_MEL);
  const second = buildSystemCatalog(MESSY_MEL);
  assert.equal(
    JSON.stringify([...first.catalog]) + JSON.stringify(first.reviewItems),
    JSON.stringify([...second.catalog]) + JSON.stringify(second.reviewItems),
  );
});
