/**
 * `writeDragonFixtureSubset` (P0-1): split files that add back up to the
 * federated one.
 *
 * The invariant these tests exist for is the one the 1.0 acceptance suite
 * leans on -- "federated vs split representations of one site" is only a
 * comparison of representations if the split really is a partition. So the
 * assertions below are about tagged objects, ids, guids and properties, not
 * about row counts of scaffolding: a split file legitimately carries its own
 * file and layer nodes, exactly as a real second NWD does.
 */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { openExtractionCache } from '../dist/index.js';
import {
  DRAGON_SOURCE_MODEL_IDS,
  DRAGON_TAG_PROPERTY,
  writeDragonFixture,
  writeDragonFixtureSubset,
} from '../dist/fixtures/dragon.js';

import { makeTempDirectory } from './support.mjs';

const MECHANICAL = [DRAGON_SOURCE_MODEL_IDS.mechanical];
const CONTROLS = [DRAGON_SOURCE_MODEL_IDS.controls, DRAGON_SOURCE_MODEL_IDS.controlsPlc];

let directory = '';

before(() => {
  directory = makeTempDirectory('subset');
});

after(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** Opens a written cache, hands it to `read`, and always closes it. */
function withCache(path, read) {
  const cache = openExtractionCache(path);
  try {
    return read(cache);
  } finally {
    cache.close();
  }
}

/** Every tagged object as `objectId -> {tag, guid, properties}`. */
function taggedObjects(cache) {
  const tagged = new Map();
  for (const object of cache.allObjects()) {
    const properties = cache
      .propertiesOf(object.id)
      .map((property) => [property.category, property.name, property.valueText]);
    const tag = properties.find(
      ([category, name, value]) =>
        category === DRAGON_TAG_PROPERTY.category &&
        name === DRAGON_TAG_PROPERTY.name &&
        value !== null,
    );
    if (tag === undefined) {
      continue;
    }
    tagged.set(object.id, { tag: tag[2], guid: object.instanceGuid, properties });
  }
  return tagged;
}

/** Writes a subset under `label` and reads it with `read`. */
function withSubset(label, opts, read) {
  const path = join(directory, `${label}.sqlite`);
  writeDragonFixtureSubset(path, opts);
  return withCache(path, read);
}

/** The federated fixture, read the same way. */
function withFederated(read) {
  const path = join(directory, 'federated.sqlite');
  writeDragonFixture(path);
  return withCache(path, read);
}

test('splitting by source model partitions every tagged object exactly', () => {
  const federated = withFederated(taggedObjects);
  const mechanical = withSubset('mech', { sourceModels: MECHANICAL }, taggedObjects);
  const controls = withSubset('ctrl', { sourceModels: CONTROLS }, taggedObjects);

  // Disjoint: no object id is claimed by both halves.
  const shared = [...mechanical.keys()].filter((id) => controls.has(id));
  assert.deepEqual(shared, []);

  // Complete: together they are the federated file's tagged objects, and each
  // one carries the same guid and the same properties it carried there.
  assert.equal(mechanical.size + controls.size, federated.size);
  for (const [objectId, split] of [...mechanical, ...controls]) {
    assert.deepEqual(split, federated.get(objectId), `object ${objectId}`);
  }
});

test('the halves are the 24 and 10 the acceptance suite counts', () => {
  assert.equal(withFederated(taggedObjects).size, 34);
  assert.equal(withSubset('mech-count', { sourceModels: MECHANICAL }, taggedObjects).size, 24);
  assert.equal(withSubset('ctrl-count', { sourceModels: CONTROLS }, taggedObjects).size, 10);
});

test('an appended model kept without its host is re-rooted rather than dropped', () => {
  // The PLC modules hang off controls equipment. Keeping only the appended
  // model must not lose them, or a partition by source model would not be one.
  const plcOnly = withSubset(
    'plc',
    { sourceModels: [DRAGON_SOURCE_MODEL_IDS.controlsPlc] },
    (cache) => ({
      objectCount: cache.objectCount(),
      roots: cache.rootObjects().map((object) => object.displayName),
      sourceModels: cache.sourceModels().map((model) => model.fileName),
    }),
  );
  assert.equal(plcOnly.objectCount, 4);
  assert.deepEqual(plcOnly.roots, ['Module 01', 'Module 02', 'Module 01', 'Module 02']);
  // The host model went with the other half, so this one has no parent to name.
  assert.deepEqual(plcOnly.sourceModels, ['Dragon-Controls-PLC.nwc']);
});

test('a split file can claim any basename it likes', () => {
  const shared = 'Dragon-Area.nwd';
  const mechanical = withSubset('named-mech', { sourceModels: MECHANICAL, inputFileName: shared }, (cache) =>
    cache.meta().inputFileName,
  );
  const controls = withSubset('named-ctrl', { sourceModels: CONTROLS, inputFileName: shared }, (cache) =>
    cache.meta().inputFileName,
  );
  assert.equal(mechanical, shared);
  assert.equal(controls, shared);
  assert.equal(withFederated((cache) => cache.meta().inputFileName), 'Dragon-Coordination.nwd');
});

test('a tag filter partitions the tags by tag and nothing else', () => {
  const mah = withSubset('mah', { tagFilter: (tag) => tag.startsWith('MAH') }, taggedObjects);
  const rest = withSubset('rest', { tagFilter: (tag) => !tag.startsWith('MAH') }, taggedObjects);
  const federated = withFederated(taggedObjects);

  assert.equal(mah.size, 16);
  assert.equal(mah.size + rest.size, federated.size);
  assert.deepEqual(
    [...mah.keys()].filter((id) => rest.has(id)),
    [],
  );
  for (const [objectId, split] of [...mah, ...rest]) {
    assert.deepEqual(split, federated.get(objectId), `object ${objectId}`);
  }
});

test('a rejected tag takes its own components with it', () => {
  // Every MAH carries one Solid child. Dropping the equipment must drop the
  // solid too, or the split file would hold a component of nothing.
  const withoutMah = withSubset(
    'no-mah',
    { tagFilter: (tag) => !tag.startsWith('MAH') },
    (cache) => [...cache.allObjects()].filter((object) => object.className === 'Solid').length,
  );
  const federatedSolids = withFederated(
    (cache) => [...cache.allObjects()].filter((object) => object.className === 'Solid').length,
  );
  assert.equal(federatedSolids, 24);
  assert.equal(withoutMah, 8, 'the 16 MAH solids left with their equipment');
});

test('a set with no members left in this file is not carried into it', () => {
  const controlsSets = withSubset('ctrl-sets', { sourceModels: CONTROLS }, (cache) =>
    cache.selectionSets().map((set) => set.name),
  );
  // Air Handling holds only mechanical equipment, so neither it nor the folder
  // that held it belongs in the controls file. PLC Panels does.
  assert.deepEqual(controlsSets, ['PLC Panels']);

  const mechanicalSets = withSubset('mech-sets', { sourceModels: MECHANICAL }, (cache) =>
    cache.selectionSets().map((set) => [set.name, set.children.map((child) => child.name)]),
  );
  assert.deepEqual(mechanicalSets, [['Dragon Systems', ['Air Handling']]]);
});

test('one set name can exist in several split files', () => {
  const names = (label, prefixes) =>
    withSubset(label, { tagFilter: (tag) => prefixes.some((p) => tag.startsWith(p)) }, (cache) =>
      cache
        .selectionSets()
        .flatMap((set) => [set, ...set.children])
        .map((set) => [set.name, set.memberObjectIds.length]),
    );
  // MAH001 and MAH002 are both Air Handling, so splitting them puts the same
  // set name in two files with different members. Per-source resolution has to
  // union them, not pick one.
  assert.deepEqual(names('mah1', ['MAH001']), [
    ['Dragon Systems', 0],
    ['Air Handling', 12],
  ]);
  assert.deepEqual(names('mah2', ['MAH002']), [
    ['Dragon Systems', 0],
    ['Air Handling', 4],
  ]);
});

test('naming a source model Dragon does not have is a typo, not an empty file', () => {
  assert.throws(
    () => writeDragonFixtureSubset(join(directory, 'nope.sqlite'), { sourceModels: [9] }),
    /no source model 9/,
  );
});
