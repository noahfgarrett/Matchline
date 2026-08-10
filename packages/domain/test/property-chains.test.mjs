/**
 * Ordered fallback chains, per-source overrides and the lift that gets a
 * pre-P0-8 profile into both (RELEASE-1.0-PLAN P0-8, hard gate 5).
 *
 * The lift is the load-bearing half. Every profile a site has already published
 * spells each mapping as one `PropertyRef`, and P0-8 says those "migrate
 * existing single mapping to a one-rung chain" — so a chain of one has to be
 * indistinguishable from what that profile always meant.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chainFor,
  isDerivedAttributeId,
  MAPPED_PROPERTY_FIELDS,
  migrateMappedProperty,
  migratePropertyMappings,
} from '../dist/index.js';

const TAG = { category: 'Dragon Data', name: 'Tag' };
const BUILDING = { category: 'Dragon Data', name: 'Building' };
const LEVEL = { category: 'Element', name: 'Level' };

test('a single property lifts to a one-rung chain with no per-source override', () => {
  assert.deepEqual(migrateMappedProperty(BUILDING), { chain: [BUILDING] });
});

test('a chain is returned as it was written', () => {
  assert.deepEqual(migrateMappedProperty({ chain: [BUILDING, LEVEL] }), {
    chain: [BUILDING, LEVEL],
  });
});

test('per-source overrides are read from a list of pairs into a map', () => {
  const migrated = migrateMappedProperty({
    chain: [BUILDING],
    bySource: [{ sourceId: 'dragon-architectural', chain: [LEVEL] }],
  });
  assert.deepEqual(migrated.chain, [BUILDING]);
  assert.deepEqual([...migrated.bySource], [['dragon-architectural', [LEVEL]]]);
});

test('migrating is idempotent: a mapping already in the current shape survives', () => {
  const once = migrateMappedProperty({
    chain: [BUILDING],
    bySource: [{ sourceId: 'a', chain: [LEVEL] }],
  });
  assert.deepEqual(migrateMappedProperty(once), once);
});

test('a source with an override reads through it; every other source reads the global chain', () => {
  const mapped = migrateMappedProperty({
    chain: [BUILDING, LEVEL],
    bySource: [{ sourceId: 'dragon-architectural', chain: [LEVEL] }],
  });
  assert.deepEqual(chainFor(mapped, 'dragon-architectural'), [LEVEL]);
  assert.deepEqual(chainFor(mapped, 'dragon-mechanical'), [BUILDING, LEVEL]);
});

test('an override REPLACES the global chain rather than extending it', () => {
  // Stated as its own test because the other reading is the tempting one, and
  // it is wrong: appending the global chain behind an override would silently
  // re-introduce the address the site just overrode.
  const mapped = migrateMappedProperty({
    chain: [BUILDING],
    bySource: [{ sourceId: 'dragon-architectural', chain: [LEVEL] }],
  });
  assert.deepEqual(chainFor(mapped, 'dragon-architectural'), [LEVEL]);
});

test('a whole pre-P0-8 mapping set lifts field by field', () => {
  const migrated = migratePropertyMappings({
    equipmentTag: TAG,
    building: BUILDING,
  });
  assert.deepEqual(migrated.equipmentTag, { chain: [TAG] });
  assert.deepEqual(migrated.building, { chain: [BUILDING] });
  assert.equal(migrated.description, undefined, 'an unmapped field stays unmapped');
});

test('the two spellings can be mixed in one mapping set', () => {
  const migrated = migratePropertyMappings({
    equipmentTag: TAG,
    building: { chain: [BUILDING, LEVEL] },
  });
  assert.deepEqual(migrated.equipmentTag.chain, [TAG]);
  assert.deepEqual(migrated.building.chain, [BUILDING, LEVEL]);
});

test('every mapped role is listed, so nothing can be lifted by accident and lost', () => {
  assert.deepEqual(MAPPED_PROPERTY_FIELDS, [
    'equipmentTag',
    'description',
    'equipmentType',
    'building',
    'nativeDiscipline',
    'wbs',
    'itemMaster',
    'equipmentClassification',
  ]);
  const everything = Object.fromEntries(MAPPED_PROPERTY_FIELDS.map((field) => [field, BUILDING]));
  const migrated = migratePropertyMappings(everything);
  for (const field of MAPPED_PROPERTY_FIELDS) {
    assert.deepEqual(migrated[field], { chain: [BUILDING] }, field);
  }
});

/* ------------------------------------------------ derived attribute ids --- */

test('an attribute id is kebab-case and nothing else', () => {
  for (const id of ['area', 'turnover-package', 'zone-2', 'a']) {
    assert.equal(isDerivedAttributeId(id), true, id);
  }
  for (const id of ['', 'Area', 'turnover_package', '-area', 'area-', 'a--b', 'a b']) {
    assert.equal(isDerivedAttributeId(id), false, id);
  }
});
