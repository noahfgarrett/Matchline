import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { openExtractionCache } from '../dist/index.js';
import { writeDragonFixture } from '../dist/fixtures/dragon.js';

/**
 * Round-trip: the Dragon generator writes a cache, the reader reads it back,
 * and the structure it reports is the structure that was written.
 */

let directory = '';
let cache = null;

before(() => {
  directory = mkdtempSync(join(tmpdir(), 'matchline-model-schema-cache-'));
  const path = join(directory, 'dragon.sqlite');
  writeDragonFixture(path);
  cache = openExtractionCache(path);
});

after(() => {
  cache?.close();
  rmSync(directory, { recursive: true, force: true });
});

test('meta is typed, and its counts are numbers rather than decimal strings', () => {
  const meta = cache.meta();
  assert.equal(meta.schemaVersion, '3');
  assert.equal(meta.inputFileName, 'Dragon-Coordination.nwd');
  assert.equal(meta.inputSha256.length, 64);
  assert.equal(meta.inputBytes, 104857600);
  assert.equal(meta.extractedAtUtc, '2026-01-15T09:30:00Z');
  assert.equal(meta.adapterVersion, 'navisworks-2025');
  assert.equal(meta.objectCount, 76);
  // Optional in the DDL, present here because a v3 writer records them.
  assert.equal(meta.units, 'Meters');
  assert.equal(meta.uiLanguage, 'en-US');
});

test('every object is reachable depth-first from the roots', () => {
  const walked = [...cache.walk()];
  assert.equal(walked.length, cache.objectCount());
  assert.equal(walked.length, [...cache.allObjects()].length);

  const ids = walked.map((object) => object.id);
  assert.equal(new Set(ids).size, ids.length, 'walk visited an object twice');
  // Extraction ordinals are assigned depth-first, so a depth-first walk of the
  // cache must come back out in id order.
  assert.deepEqual(ids, [...ids].sort((left, right) => left - right));
});

test('roots and children come back in path_index order', () => {
  const roots = cache.rootObjects();
  assert.deepEqual(
    roots.map((object) => object.displayName),
    ['Dragon-Mechanical.nwc', 'Dragon-Controls.nwc'],
  );
  assert.deepEqual(
    roots.map((object) => object.pathIndex),
    [0, 1],
  );

  const buildings = cache.childrenOf(roots[0].id);
  assert.deepEqual(
    buildings.map((object) => object.displayName),
    ['D1', 'D2'],
  );
  assert.deepEqual(
    buildings.map((object) => object.pathIndex),
    [0, 1],
  );

  const equipment = cache.childrenOf(buildings[0].id);
  assert.equal(equipment.length, 12);
  assert.deepEqual(
    equipment.map((object) => object.pathIndex),
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  );
  assert.equal(equipment[0].displayName, 'MAH001-10-01');
  assert.equal(equipment[0].depth, 2);
});

test('the source model tree nests appended models under their host', () => {
  const roots = cache.sourceModels();
  assert.equal(roots.length, 2);
  assert.deepEqual(
    roots.map((model) => model.fileName),
    ['Dragon-Mechanical.nwc', 'Dragon-Controls.nwc'],
  );
  assert.deepEqual(roots[0].children, []);
  assert.equal(roots[1].children.length, 1);
  assert.equal(roots[1].children[0].fileName, 'Dragon-Controls-PLC.nwc');
  assert.equal(roots[1].children[0].parentId, roots[1].id);
});

test('an unknown object id is undefined rather than an error', () => {
  assert.equal(cache.object(9999), undefined);
  assert.deepEqual(cache.childrenOf(9999), []);
  assert.deepEqual(cache.propertiesOf(9999), []);
});

test('bounding boxes are present or absent whole, never partial', () => {
  const objects = [...cache.allObjects()];
  const withBox = objects.filter((object) => object.bbox !== null);
  const withoutBox = objects.filter((object) => object.bbox === null);
  assert.equal(withBox.length, 58);
  assert.equal(withoutBox.length, 18);

  const box = withBox[0].bbox;
  assert.equal(box.maxX - box.minX, 5);
  assert.ok(withoutBox.some((object) => object.className === 'Layer'));
});

test('properties come back in the order the extractor encountered them', () => {
  const equipment = [...cache.allObjects()].find(
    (object) => object.displayName === 'MAH001-10-01',
  );
  const properties = cache.propertiesOf(equipment.id);
  assert.deepEqual(
    properties.map((property) => `${property.category}/${property.name}`),
    [
      'Item/Name',
      'Item/Type',
      'Dragon Data/Tag',
      'Dragon Data/Building',
      'Dragon Data/UPN',
      'Dragon Data/Manufacturer',
      'Dragon Data/Service',
      'Dragon Data/Note',
      'Dragon Data/Note',
    ],
  );
  assert.equal(properties[0].valueText, 'MAH001-10-01');
  assert.equal(properties[0].valueType, 'DisplayString');
  assert.equal(properties[0].categoryInternal, 'item');
});

test('an object with no properties reads as an empty list, not a failure', () => {
  const bare = [...cache.allObjects()].filter(
    (object) => cache.propertiesOf(object.id).length === 0,
  );
  assert.equal(bare.length, 1);
  assert.equal(bare[0].id, 51);
  assert.equal(bare[0].className, 'Solid');
});

test('a property with no value keeps its row and reports null', () => {
  const turbine = [...cache.allObjects()].find(
    (object) => object.displayName === 'TIT603-10-01',
  );
  const service = cache
    .propertiesOf(turbine.id)
    .find((property) => property.name === 'Service');
  assert.notEqual(service, undefined);
  assert.equal(service.valueText, null);
  assert.equal(service.valueType, 'DisplayString');
});

test('selection sets nest by folder and carry their members', () => {
  const roots = cache.selectionSets();
  assert.equal(roots.length, 2);
  assert.equal(roots[0].name, 'Dragon Systems');
  assert.equal(roots[0].kind, 'folder');
  assert.deepEqual(roots[0].memberObjectIds, []);

  const airHandling = roots[0].children[0];
  assert.equal(airHandling.name, 'Air Handling');
  assert.equal(airHandling.kind, 'selection');
  assert.equal(airHandling.memberObjectIds.length, 16);
  for (const objectId of airHandling.memberObjectIds) {
    assert.ok(cache.object(objectId).displayName.startsWith('MAH'));
  }

  assert.equal(roots[1].name, 'PLC Panels');
  assert.equal(roots[1].kind, 'search');
  assert.equal(roots[1].memberObjectIds.length, 2);
});

test('warnings keep their severity, code and object link', () => {
  const warnings = cache.warnings();
  assert.equal(warnings.length, 2);
  assert.equal(warnings[0].severity, 'warning');
  assert.equal(warnings[0].code, 'PROPERTY_READ_FAILED');
  assert.equal(warnings[0].objectId, 51);
  assert.equal(warnings[1].severity, 'info');
  assert.equal(warnings[1].objectId, null);
});

test('a cache file with no write permission still opens', () => {
  // The only way this passes is if the handle is opened read-only: SQLite
  // cannot open a mode 0444 file for writing, even for its owner.
  const path = join(directory, 'readonly.sqlite');
  writeDragonFixture(path);
  chmodSync(path, 0o444);
  const readOnly = openExtractionCache(path);
  try {
    assert.equal(readOnly.path, path);
    assert.equal(readOnly.objectCount(), 76);
    assert.equal([...readOnly.walk()].length, 76);
  } finally {
    readOnly.close();
    chmodSync(path, 0o644);
  }
});

test('a closed cache refuses further reads and closes idempotently', () => {
  const path = join(directory, 'closed.sqlite');
  writeDragonFixture(path);
  const closable = openExtractionCache(path);
  assert.equal(closable.objectCount(), 76);
  closable.close();
  closable.close();
  assert.throws(() => closable.rootObjects(), /extraction cache is closed/);
  // meta was read at open time, so it survives the handle being released.
  assert.equal(closable.meta().objectCount, 76);
});
