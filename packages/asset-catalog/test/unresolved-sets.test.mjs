import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { buildAssetCatalog, AssetCatalogConfigError } from '../dist/index.js';
import { openExtractionCache } from '../../model-schema/dist/index.js';

import { DRAGON_MAPPINGS, makeTempDirectory, NO_FILTERS, writeSyntheticCache } from './support.mjs';

/**
 * A filter that names a set nobody could resolve.
 *
 * The cache can say three different things about a set's membership: here are
 * the objects, there are no objects, and nobody found out. The first two are
 * answers and this catalog applies them. The third is not, and the only honest
 * response to it is to refuse — a saved search that would not run is exactly
 * the case where returning zero assets looks identical to "this model has no
 * equipment" (docs/RELEASE-1.0-PLAN.md P0-3).
 */

const TAG = { category: 'Dragon Data', name: 'Tag' };

let directory = '';

after(() => {
  rmSync(directory, { recursive: true, force: true });
});

before(() => {
  directory = makeTempDirectory('unresolved-sets');
});

/**
 * Two tagged objects, and sets over them. `sets` decides what is resolved.
 */
function cacheWith(name, sets) {
  const path = join(directory, `${name}.sqlite`);
  writeSyntheticCache(path, {
    objects: [
      { id: 1, displayName: 'MAH001-10-01', className: 'Equipment' },
      { id: 2, displayName: 'MAH001-10-02', className: 'Equipment' },
    ],
    properties: [
      { objectId: 1, category: TAG.category, name: TAG.name, valueText: 'MAH001-10-01' },
      { objectId: 2, category: TAG.category, name: TAG.name, valueText: 'MAH001-10-02' },
    ],
    selectionSets: sets,
  });
  return openExtractionCache(path);
}

function catalogFor(cache, selectionSetNames) {
  return buildAssetCatalog(cache, DRAGON_MAPPINGS, { ...NO_FILTERS, selectionSetNames });
}

function refusal(run) {
  try {
    run();
  } catch (error) {
    return error;
  }
  return null;
}

test('a filter naming an unresolved search set is refused, not answered with nothing', () => {
  const cache = cacheWith('direct', [
    { id: 1, name: 'Fan Search', kind: 'search', membershipResolved: false, memberObjectIds: [] },
  ]);
  try {
    const failure = refusal(() => catalogFor(cache, ['Fan Search']));
    assert.ok(failure instanceof AssetCatalogConfigError, `expected a refusal, got ${failure}`);
    assert.deepEqual(failure.reason, {
      kind: 'unresolved-selection-set',
      name: 'Fan Search',
      unresolvedName: 'Fan Search',
      // Named because a project holds many sources and only one of them failed
      // to resolve this set; the person fixing it has to know which model.
      sourceId: 'model',
    });
    // The message has to name the set: the person reading it has to find it in
    // Navisworks.
    assert.match(failure.message, /Fan Search/);
    assert.match(failure.message, /not an empty one/);
  } finally {
    cache.close();
  }
});

test('a resolved search set that matched nothing is an answer, and filters to nothing', () => {
  const cache = cacheWith('empty-but-resolved', [
    { id: 1, name: 'Fan Search', kind: 'search', membershipResolved: true, memberObjectIds: [] },
  ]);
  try {
    // The distinction the column exists for: same zero members, different fact.
    const { assets } = catalogFor(cache, ['Fan Search']);
    assert.equal(assets.length, 0);
  } finally {
    cache.close();
  }
});

test('a resolved set filters normally, so the refusal is about the flag and nothing else', () => {
  const cache = cacheWith('resolved', [
    { id: 1, name: 'Fans', kind: 'selection', memberObjectIds: [1] },
  ]);
  try {
    const { assets } = catalogFor(cache, ['Fans']);
    assert.equal(assets.length, 1);
    assert.equal(assets[0].canonicalTag, 'MAH001-10-01');
  } finally {
    cache.close();
  }
});

test('naming a folder that contains an unresolved set is refused too, and names both', () => {
  const cache = cacheWith('via-folder', [
    { id: 1, name: 'Dragon Systems', kind: 'folder', memberObjectIds: [] },
    { id: 2, parentId: 1, name: 'Fans', kind: 'selection', memberObjectIds: [1] },
    {
      id: 3,
      parentId: 1,
      name: 'Fan Search',
      kind: 'search',
      membershipResolved: false,
      memberObjectIds: [],
    },
  ]);
  try {
    // A folder means its contents. One unresolved child makes the folder's
    // membership incomplete, and an incomplete filter is the same silent
    // wrongness as an unresolved one.
    const failure = refusal(() => catalogFor(cache, ['Dragon Systems']));
    assert.ok(failure instanceof AssetCatalogConfigError, `expected a refusal, got ${failure}`);
    assert.equal(failure.reason.kind, 'unresolved-selection-set');
    assert.equal(failure.reason.name, 'Dragon Systems');
    assert.equal(failure.reason.unresolvedName, 'Fan Search');
    assert.match(failure.message, /Dragon Systems.*Fan Search/);
  } finally {
    cache.close();
  }
});

test('an unresolved set nobody named does not stop anything', () => {
  const cache = cacheWith('untouched', [
    { id: 1, name: 'Fans', kind: 'selection', memberObjectIds: [1, 2] },
    {
      id: 2,
      name: 'Fan Search',
      kind: 'search',
      membershipResolved: false,
      memberObjectIds: [],
    },
  ]);
  try {
    // Refusing over a set the profile never mentions would block projects for a
    // saved search nobody uses.
    assert.equal(catalogFor(cache, ['Fans']).assets.length, 2);
    assert.equal(buildAssetCatalog(cache, DRAGON_MAPPINGS, NO_FILTERS).assets.length, 2);
  } finally {
    cache.close();
  }
});

test('a v1 cache refuses on a search set, because v1 never resolved one', () => {
  // v1 recorded searches without members and without a way to say so. The
  // reader takes that at face value (readV1MembershipResolved), so an old cache
  // filtered by a search set refuses rather than quietly filtering to nothing —
  // which is what this build would have done before schema v2.
  const path = join(directory, 'v1-search.sqlite');
  writeSyntheticCache(path, {
    meta: { schema_version: '1' },
    objects: [{ id: 1, displayName: 'MAH001-10-01', className: 'Equipment' }],
    properties: [{ objectId: 1, category: TAG.category, name: TAG.name, valueText: 'MAH001-10-01' }],
    selectionSets: [{ id: 1, name: 'Legacy Search', kind: 'search', memberObjectIds: [] }],
  });
  const cache = openExtractionCache(path);
  try {
    const failure = refusal(() => catalogFor(cache, ['Legacy Search']));
    assert.ok(failure instanceof AssetCatalogConfigError, `expected a refusal, got ${failure}`);
    assert.equal(failure.reason.kind, 'unresolved-selection-set');
    assert.equal(failure.reason.unresolvedName, 'Legacy Search');
  } finally {
    cache.close();
  }
});
