import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { after, before } from 'node:test';

import { AUTHORING_ID_KINDS, hasV3Columns, openExtractionCache } from '../dist/index.js';
import { writeDragonFixture, writeDragonFixtureSubset } from '../dist/fixtures/dragon.js';
import { writeRevitShapedFixture } from '../dist/fixtures/revit.js';
import { makeTempDirectory } from './support.mjs';

/**
 * Schema v3 is about naming one object twice and getting the same answer.
 *
 * v1 and v2 could say what an object is called and where it sits; neither could
 * say who made it, what kind of id that was, or what shape of tree it hangs in
 * — so the only durable handle on an object was its Navisworks InstanceGuid,
 * which does not survive a republish. This file is the contract for what v3
 * added: `authoring_id_kind`, `structural_key` and `flags` on objects,
 * `source_file_name` and `source_guid` on models, `guid` on selection sets, and
 * `units` / `ui_language` in meta.
 *
 * `schema-v2.test.mjs` covers the other half of the same promise: caches
 * written before any of this still open.
 */

let directory = '';
let cache;

before(() => {
  directory = makeTempDirectory('schema-v3');
  const path = join(directory, 'dragon.sqlite');
  writeDragonFixture(path);
  cache = openExtractionCache(path);
});

after(() => {
  cache?.close();
  rmSync(directory, { recursive: true, force: true });
});

/** The object carrying one Dragon tag, or `undefined`. */
function objectByName(handle, displayName) {
  return [...handle.allObjects()].find((object) => object.displayName === displayName);
}

test('a v3 cache declares v3, and the reader says so once rather than probing', () => {
  assert.equal(cache.meta().schemaVersion, '3');
  assert.equal(hasV3Columns('3'), true);
  assert.equal(hasV3Columns('2'), false);
  assert.equal(hasV3Columns('1'), false);
});

test('meta carries the units and the language the extraction ran under', () => {
  // Optional in the DDL and absent from every older cache, which is why the
  // reader types them nullable rather than requiring them.
  assert.equal(cache.meta().units, 'Meters');
  assert.equal(cache.meta().uiLanguage, 'en-US');
});

test('an authoring id arrives with the system that issued it, never on its own', () => {
  const equipment = objectByName(cache, 'MAH001-10-01');
  assert.equal(equipment.authoringId, 'id-MAH001-10-01');
  assert.equal(equipment.authoringIdKind, 'revit-element-id');

  // The pairing is the invariant: an id whose origin is unknown is not one of
  // the well-known ids, and a kind with no id names nothing. Two authoring
  // systems can issue the same digits, so a reader that had the id without the
  // kind could merge two different pieces of equipment.
  for (const object of cache.allObjects()) {
    assert.equal(
      object.authoringId === null,
      object.authoringIdKind === null,
      `object ${String(object.id)} states one of authoring_id / authoring_id_kind but not the other`,
    );
    if (object.authoringIdKind !== null) {
      assert.ok(AUTHORING_ID_KINDS.includes(object.authoringIdKind));
    }
  }
});

test('an authoring id kind this reader does not know is refused, not shrugged at', () => {
  const path = join(directory, 'bad-kind.sqlite');
  writeDragonFixture(path);
  const db = new DatabaseSync(path);
  try {
    db.exec("UPDATE objects SET authoring_id_kind = 'sketchup-thing' WHERE authoring_id IS NOT NULL");
  } finally {
    db.close();
  }

  const broken = openExtractionCache(path);
  try {
    assert.throws(
      () => [...broken.allObjects()],
      (error) => {
        assert.equal(error.name, 'CacheValidationError');
        assert.equal(error.reason.kind, 'malformed-row');
        assert.equal(error.reason.column, 'authoring_id_kind');
        return true;
      },
    );
  } finally {
    broken.close();
  }
});

test('every object has a structural key, and no two objects share one', () => {
  const keys = [...cache.allObjects()].map((object) => object.structuralKey);
  assert.equal(keys.length, cache.objectCount());
  for (const key of keys) {
    assert.match(key, /^[0-9a-f]{64}$/, 'a structural key is a lowercase SHA-256 hex digest');
  }
  assert.equal(new Set(keys).size, keys.length, 'two objects share a structural key');
});

test('the structural key is the shape of the tree, so a split file keeps it', () => {
  // The mechanical half of Dragon, on its own. Its objects were not moved --
  // same parents, same sibling positions -- so their keys must be identical to
  // the federated file's, which is what makes the key usable for reconciling
  // one compile against another.
  const splitPath = join(directory, 'mechanical.sqlite');
  writeDragonFixtureSubset(splitPath, {
    sourceModels: [1],
    inputFileName: 'Dragon-Mechanical.nwd',
  });
  const split = openExtractionCache(splitPath);
  try {
    const federated = objectByName(cache, 'MAH001-10-01');
    const alone = objectByName(split, 'MAH001-10-01');
    assert.ok(alone, 'the mechanical subset holds the mechanical equipment');
    assert.equal(alone.structuralKey, federated.structuralKey);
  } finally {
    split.close();
  }
});

test('moving an object changes its key, and does not change its siblings before it', () => {
  const path = join(directory, 'reordered.sqlite');
  writeDragonFixture(path);
  const reordered = openExtractionCache(path);
  try {
    // Two pieces of equipment under one building: the first sits at position 0,
    // the second at position 1. Inserting a sibling ahead of the second is what
    // a republish does, and only the objects at or after the insertion point
    // may change -- otherwise every re-extraction would look like a rebuild.
    const first = objectByName(reordered, 'MAH001-10-01');
    const second = objectByName(reordered, 'MAH001-10-02');
    assert.equal(first.parentId, second.parentId);
    assert.ok(first.pathIndex < second.pathIndex);
    assert.notEqual(first.structuralKey, second.structuralKey);

    // Same names, same classes, different positions: the key is the position
    // too, or two siblings would collide.
    const federatedFirst = objectByName(cache, 'MAH001-10-01');
    assert.equal(first.structuralKey, federatedFirst.structuralKey);
  } finally {
    reordered.close();
  }
});

test('flags come back as named booleans, and null means the cache never looked', () => {
  const layer = objectByName(cache, 'D1');
  assert.deepEqual(layer.flags, {
    isHidden: false,
    isLayer: true,
    isInsert: false,
    isComposite: false,
    isCollection: true,
    hasModel: false,
  });

  const equipment = objectByName(cache, 'MAH001-10-01');
  assert.equal(equipment.flags.isInsert, true);
  assert.equal(equipment.flags.isComposite, true);
  assert.equal(equipment.flags.isLayer, false);

  const file = objectByName(cache, 'Dragon-Mechanical.nwc');
  assert.equal(file.flags.hasModel, true);
});

test('a source model names the file it was converted from as well as the one Navisworks read', () => {
  const [mechanical] = cache.sourceModels();
  assert.equal(mechanical.fileName, 'Dragon-Mechanical.nwc');
  assert.equal(mechanical.sourceFileName, 'Dragon-Mechanical.rvt');

  // Two identities, deliberately: `guid` is what a reflective probe over three
  // candidate member names found, `sourceGuid` is Model.SourceGuid read
  // directly, and a cache carrying both can say whether they agree.
  assert.match(mechanical.guid, /^[0-9a-f-]{36}$/);
  assert.match(mechanical.sourceGuid, /^[0-9a-f-]{36}$/);
  assert.notEqual(mechanical.guid, mechanical.sourceGuid);
});

test('a selection set carries its own guid, which a rename would not change', () => {
  const [folder] = cache.selectionSets();
  assert.equal(folder.name, 'Dragon Systems');
  assert.match(folder.guid, /^[0-9a-f-]{36}$/);

  const guids = [folder.guid, ...folder.children.map((child) => child.guid)];
  assert.equal(new Set(guids).size, guids.length, 'two sets share a guid');
});

test('the Revit-shaped fixture promotes the element id into the column', () => {
  const path = join(directory, 'revit.sqlite');
  writeRevitShapedFixture(path);
  const revit = openExtractionCache(path);
  try {
    assert.equal(revit.meta().schemaVersion, '3');
    assert.equal(revit.meta().units, 'Feet');

    const equipment = [...revit.allObjects()].filter(
      (object) => object.className === 'Composite Object',
    );
    assert.ok(equipment.length > 0, 'the Revit fixture has composite elements');
    for (const object of equipment) {
      assert.equal(object.authoringIdKind, 'revit-element-id');
      assert.match(object.authoringId, /^[0-9]+$/);
    }

    // Geometry below an element carries no element id of its own, which is what
    // stops a solid from being reconciled as if it were the equipment.
    const geometry = [...revit.allObjects()].filter((object) => object.className === 'Geometry');
    assert.ok(geometry.length > 0);
    for (const object of geometry) {
      assert.equal(object.authoringId, null);
      assert.equal(object.authoringIdKind, null);
    }

    const [model] = revit.sourceModels();
    assert.equal(model.sourceFileName, 'B14-Mechanical.rvt');
  } finally {
    revit.close();
  }
});
