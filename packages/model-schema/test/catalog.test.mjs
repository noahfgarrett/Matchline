import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { buildPropertyCatalog, openExtractionCache } from '../dist/index.js';
import { writeDragonFixture } from '../dist/fixtures/dragon.js';
import { writeEmptyCache } from './support.mjs';

/**
 * The expectations below are computed by hand from the Dragon layout, not
 * captured from a run:
 *
 *   Mechanical (source model 1): 1 file node + 2 buildings
 *     + 2 buildings x 12 equipment (6 MAH001, 2 MAH002, 4 TIT603)
 *     + one Solid child per equipment                              = 51 objects
 *   Controls (source model 2): 1 file node + 2 buildings
 *     + 2 buildings x (1 PLC + 4 VFD) + one Terminal per VFD       = 21 objects
 *   PLC modules, in the appended model (source model 3): 2 per PLC =  4 objects
 *                                                                 -------------
 *                                                                    76 objects
 *
 * The last mechanical Solid (object 51) carries no properties at all, so
 * Item/Name and Item/Type cover 75 of 76 objects and 50 of source model 1's 51.
 */

let directory = '';
let cache = null;
let catalog = [];

before(() => {
  directory = mkdtempSync(join(tmpdir(), 'matchline-model-schema-catalog-'));
  const path = join(directory, 'dragon.sqlite');
  writeDragonFixture(path);
  cache = openExtractionCache(path);
  catalog = buildPropertyCatalog(cache);
});

after(() => {
  cache?.close();
  rmSync(directory, { recursive: true, force: true });
});

function entryFor(category, name) {
  const found = catalog.find((entry) => entry.category === category && entry.name === name);
  assert.notEqual(found, undefined, `no catalog entry for ${category}/${name}`);
  return found;
}

test('the catalog holds one entry per distinct category and name', () => {
  assert.equal(catalog.length, 11);
  const keys = catalog.map((entry) => `${entry.category}/${entry.name}`);
  assert.equal(new Set(keys).size, keys.length);
});

test('entries are ordered by coverage, then category, then name', () => {
  assert.deepEqual(
    catalog.map((entry) => `${entry.category}/${entry.name}`),
    [
      'Item/Name',
      'Item/Type',
      'Dragon Data/Building',
      'Dragon Data/Tag',
      'Dragon Data/UPN',
      'Dragon Data/Manufacturer',
      'Dragon Data/Service',
      'Controls Data/Loop',
      'Controls Data/Slot',
      'Controls Data/Firmware',
      'Dragon Data/Note',
    ],
  );
});

test('object coverage counts objects and its fraction is against the whole cache', () => {
  const name = entryFor('Item', 'Name');
  assert.equal(name.objectCount, 75);
  assert.equal(name.objectFraction, 75 / 76);

  const building = entryFor('Dragon Data', 'Building');
  // 4 building nodes plus all 34 tagged equipment objects.
  assert.equal(building.objectCount, 38);
  assert.equal(building.objectFraction, 0.5);

  const tag = entryFor('Dragon Data', 'Tag');
  assert.equal(tag.objectCount, 34);
  assert.equal(tag.objectFraction, 34 / 76);
});

test('a property repeated on one object counts that object once', () => {
  const note = entryFor('Dragon Data', 'Note');
  // Two rows, one object: coverage is about objects, distinct values are not.
  assert.equal(note.objectCount, 1);
  assert.equal(note.distinctValueCount, 2);
  assert.deepEqual(note.exampleValues, ['Verify with vendor', 'Coordinate with controls']);
});

test('distinct value counts ignore rows that carry no value', () => {
  const service = entryFor('Dragon Data', 'Service');
  // All 24 mechanical equipment objects carry Service; the 8 TIT603 rows are
  // valueless, leaving two distinct values.
  assert.equal(service.objectCount, 24);
  assert.equal(service.distinctValueCount, 2);
  assert.deepEqual(service.exampleValues, ['Chilled Water', 'Hot Water']);
});

test('example values are the first five distinct values in object-id order', () => {
  assert.deepEqual(entryFor('Item', 'Name').exampleValues, [
    'Dragon-Mechanical.nwc',
    'D1',
    'MAH001-10-01',
    'Solid',
    'MAH001-10-02',
  ]);
  assert.deepEqual(entryFor('Item', 'Type').exampleValues, [
    'File',
    'Layer',
    'Equipment',
    'Solid',
    'Module',
  ]);
  assert.deepEqual(entryFor('Dragon Data', 'Tag').exampleValues, [
    'MAH001-10-01',
    'MAH001-10-02',
    'MAH001-10-03',
    'MAH001-10-04',
    'MAH001-10-05',
  ]);
  assert.equal(entryFor('Dragon Data', 'Tag').distinctValueCount, 34);
  for (const entry of catalog) {
    assert.ok(entry.exampleValues.length <= 5, `${entry.name} listed too many examples`);
  }
});

test('distinct counts collapse repeated values', () => {
  assert.equal(entryFor('Item', 'Type').distinctValueCount, 6);
  assert.equal(entryFor('Dragon Data', 'Building').distinctValueCount, 2);
  assert.equal(entryFor('Dragon Data', 'UPN').distinctValueCount, 3);
  assert.equal(entryFor('Controls Data', 'Loop').distinctValueCount, 3);
  assert.equal(entryFor('Controls Data', 'Firmware').distinctValueCount, 1);
});

test('per-source-model coverage is measured against that model, not the cache', () => {
  const name = entryFor('Item', 'Name');
  assert.deepEqual([...name.bySourceModel.keys()], [1, 2, 3]);
  assert.deepEqual(name.bySourceModel.get(1), {
    sourceModelId: 1,
    objectCount: 50,
    sourceModelObjectCount: 51,
    objectFraction: 50 / 51,
  });
  assert.deepEqual(name.bySourceModel.get(3), {
    sourceModelId: 3,
    objectCount: 4,
    sourceModelObjectCount: 4,
    objectFraction: 1,
  });

  // Slot exists only in the appended PLC model: it covers all of that model
  // while covering 4 of 76 objects overall.
  const slot = entryFor('Controls Data', 'Slot');
  assert.deepEqual([...slot.bySourceModel.keys()], [3]);
  assert.equal(slot.bySourceModel.get(3).objectFraction, 1);
  assert.equal(slot.objectCount, 4);

  // Manufacturer is mechanical-only.
  const manufacturer = entryFor('Dragon Data', 'Manufacturer');
  assert.deepEqual([...manufacturer.bySourceModel.keys()], [1]);
  assert.deepEqual(manufacturer.bySourceModel.get(1), {
    sourceModelId: 1,
    objectCount: 24,
    sourceModelObjectCount: 51,
    objectFraction: 24 / 51,
  });
});

test('per-model object counts add up to the cache object count', () => {
  const name = entryFor('Item', 'Name');
  const total = [...name.bySourceModel.values()].reduce(
    (sum, coverage) => sum + coverage.sourceModelObjectCount,
    0,
  );
  assert.equal(total, cache.objectCount());
});

test('an empty cache produces an empty catalog rather than NaN coverage', () => {
  const path = join(directory, 'empty.sqlite');
  writeEmptyCache(path);
  const empty = openExtractionCache(path);
  try {
    assert.equal(empty.objectCount(), 0);
    assert.deepEqual(empty.rootObjects(), []);
    assert.deepEqual(empty.sourceModels(), []);
    assert.deepEqual(empty.selectionSets(), []);
    assert.deepEqual(empty.warnings(), []);
    assert.deepEqual([...empty.walk()], []);
    assert.deepEqual(buildPropertyCatalog(empty), []);
  } finally {
    empty.close();
  }
});

test('the catalog reports statistics only, with no role suggestions', () => {
  // Phase 1 ships numbers; deciding which property means "tag" is Phase 2.
  const keys = Object.keys(catalog[0]).sort();
  assert.deepEqual(keys, [
    'bySourceModel',
    'category',
    'distinctValueCount',
    'exampleValues',
    'name',
    'objectCount',
    'objectFraction',
  ]);
});
