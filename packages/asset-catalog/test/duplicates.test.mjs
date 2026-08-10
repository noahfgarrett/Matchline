import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { buildAssetCatalog } from '../dist/index.js';
import { reviewItemSummary } from '@matchline/domain';
import { openExtractionCache } from '../../model-schema/dist/index.js';

import { makeTempDirectory, TAG_ONLY_MAPPINGS, writeSyntheticCache } from './support.mjs';

/**
 * One tag on three objects, one tag on one, and two objects with nothing
 * usable in the tag property:
 *
 *   1 File                    (property absent)
 *   2 Equipment  "MAH001-10-01"
 *   3 Equipment  "MAH001-10-01"
 *   4 Equipment  "MAH002-10-01"
 *   5 Equipment  "  MAH001-10-01  "  -> trims onto the duplicate
 *   6 Equipment  "   "                -> blank after trimming, so untagged
 */
const DUPLICATES = {
  objects: [
    { id: 1, parentId: null, pathIndex: 0, depth: 0, displayName: 'Model', className: 'File' },
    { id: 2, parentId: 1, pathIndex: 0, depth: 1, displayName: 'First', className: 'Equipment' },
    { id: 3, parentId: 1, pathIndex: 1, depth: 1, displayName: 'Second', className: 'Equipment' },
    { id: 4, parentId: 1, pathIndex: 2, depth: 1, displayName: 'Unique', className: 'Equipment' },
    { id: 5, parentId: 1, pathIndex: 3, depth: 1, displayName: 'Padded', className: 'Equipment' },
    { id: 6, parentId: 1, pathIndex: 4, depth: 1, displayName: 'Blank', className: 'Equipment' },
  ],
  properties: [
    { objectId: 2, category: 'Dragon Data', name: 'Tag', valueText: 'MAH001-10-01' },
    { objectId: 3, category: 'Dragon Data', name: 'Tag', valueText: 'MAH001-10-01' },
    { objectId: 4, category: 'Dragon Data', name: 'Tag', valueText: 'MAH002-10-01' },
    { objectId: 5, category: 'Dragon Data', name: 'Tag', valueText: '  MAH001-10-01  ' },
    { objectId: 6, category: 'Dragon Data', name: 'Tag', valueText: '   ' },
  ],
};

const FILTERS = { requireTagProperty: true, collapseComponents: false };

let directory = '';
let cache = null;

before(() => {
  directory = makeTempDirectory('duplicates');
  const path = join(directory, 'duplicates.sqlite');
  writeSyntheticCache(path, DUPLICATES);
  cache = openExtractionCache(path);
});

after(() => {
  cache?.close();
  rmSync(directory, { recursive: true, force: true });
});

test('a blank tag is not a tag', () => {
  const { impact } = buildAssetCatalog(cache, TAG_ONLY_MAPPINGS, FILTERS);
  // The File has no tag property at all; the Blank object has one that says
  // nothing. Both are untagged.
  assert.equal(impact.untaggedDroppedCount, 2);
  assert.equal(impact.finalAssetCount, 4);
});

test('a tag is trimmed and otherwise left exactly as the model spells it', () => {
  const { assets } = buildAssetCatalog(cache, TAG_ONLY_MAPPINGS, FILTERS);
  const padded = assets.find((asset) => asset.objectIds[0] === 5);
  assert.equal(padded.canonicalTag, 'MAH001-10-01');
});

test('every asset sharing a tag is flagged, and none of them is merged away', () => {
  const { assets } = buildAssetCatalog(cache, TAG_ONLY_MAPPINGS, FILTERS);
  const duplicates = assets.filter((asset) => asset.canonicalTag === 'MAH001-10-01');
  assert.equal(duplicates.length, 3);
  assert.ok(duplicates.every((asset) => asset.status === 'DUPLICATE_MODEL_TAG'));
  assert.deepEqual(
    duplicates.map((asset) => asset.objectIds),
    [[2], [3], [5]],
  );
});

test('a unique tag stays confirmed even when another tag is duplicated', () => {
  const { assets } = buildAssetCatalog(cache, TAG_ONLY_MAPPINGS, FILTERS);
  const unique = assets.find((asset) => asset.canonicalTag === 'MAH002-10-01');
  assert.equal(unique.status, 'MODEL_CONFIRMED');
  assert.equal(unique.assetId, 'tag:MAH002-10-01');
});

test('a duplicated tag disambiguates the asset id with the object it came from', () => {
  const { assets } = buildAssetCatalog(cache, TAG_ONLY_MAPPINGS, FILTERS);
  // An object ordinal only addresses something together with its source, so the
  // disambiguator is the whole key, not the bare number.
  assert.deepEqual(
    assets.map((asset) => asset.assetId),
    [
      'tag:MAH001-10-01#model/2',
      'tag:MAH001-10-01#model/3',
      'tag:MAH002-10-01',
      'tag:MAH001-10-01#model/5',
    ],
  );
});

test('one review item per duplicated tag, listing every object that claims it', () => {
  const { reviewItems, impact } = buildAssetCatalog(cache, TAG_ONLY_MAPPINGS, FILTERS);
  assert.deepEqual(reviewItems, [
    {
      kind: 'duplicate-model-tag',
      canonicalTag: 'MAH001-10-01',
      objectIds: [2, 3, 5],
      sources: [{ sourceId: 'model', objectIds: [2, 3, 5] }],
    },
  ]);
  assert.equal(impact.duplicateTagCount, 1);
  assert.equal(reviewItemSummary(reviewItems[0]), 'tag MAH001-10-01: 3 model objects share it');
});

test('no duplicates means no review items', () => {
  const { reviewItems, impact } = buildAssetCatalog(cache, TAG_ONLY_MAPPINGS, {
    ...FILTERS,
    acceptedTagPatterns: ['MAH002*'],
  });
  assert.deepEqual(reviewItems, []);
  assert.equal(impact.duplicateTagCount, 0);
});

test('review items are ordered by tag, whatever order the objects arrive in', () => {
  const { reviewItems } = buildAssetCatalog(
    cache,
    TAG_ONLY_MAPPINGS,
    { ...FILTERS, requireTagProperty: false },
  );
  // Untagged objects share no tag: an absent tag is not a duplicate claim.
  assert.deepEqual(
    reviewItems.map((item) => item.canonicalTag),
    ['MAH001-10-01'],
  );
});

test('untagged assets are never duplicates of one another', () => {
  const { assets } = buildAssetCatalog(cache, TAG_ONLY_MAPPINGS, {
    ...FILTERS,
    requireTagProperty: false,
  });
  const untagged = assets.filter((asset) => asset.canonicalTag === '');
  assert.equal(untagged.length, 2);
  assert.ok(untagged.every((asset) => asset.status === 'MODEL_CONFIRMED'));
  assert.deepEqual(
    untagged.map((asset) => asset.assetId),
    ['object:model/1', 'object:model/6'],
  );
});

test('collapsing a duplicate away leaves the survivor confirmed', () => {
  const nested = {
    objects: [
      { id: 1, parentId: null, pathIndex: 0, depth: 0, className: 'Equipment' },
      { id: 2, parentId: 1, pathIndex: 0, depth: 1, className: 'Solid' },
    ],
    properties: [
      { objectId: 1, category: 'Dragon Data', name: 'Tag', valueText: 'TIT603-10-01' },
      { objectId: 2, category: 'Dragon Data', name: 'Tag', valueText: 'TIT603-10-01' },
    ],
  };
  const path = join(directory, 'nested-duplicate.sqlite');
  writeSyntheticCache(path, nested);
  const nestedCache = openExtractionCache(path);
  try {
    const { assets, reviewItems } = buildAssetCatalog(nestedCache, TAG_ONLY_MAPPINGS, {
      requireTagProperty: true,
      collapseComponents: true,
    });
    // The child repeats its parent's tag, which is what a component looks like
    // in a real model. Collapse resolves it before duplicate detection runs.
    assert.equal(assets.length, 1);
    assert.equal(assets[0].status, 'MODEL_CONFIRMED');
    assert.deepEqual(assets[0].objectIds, [1, 2]);
    assert.deepEqual(reviewItems, []);
  } finally {
    nestedCache.close();
  }
});

/**
 * The `#` that separates a duplicate's object key is also a character a site can
 * write in a tag:
 *
 *   2 Equipment  "X"     duplicated with 3, so its id ends `#model/2`
 *   3 Equipment  "X"
 *   4 Equipment  "X#2"   unique, and the shape a duplicate id used to take
 *   5 Equipment  "X%23"  unique, and spelled exactly like object 4's escape
 *
 * Escaping the tag is what keeps all four apart: an unescaped `#` in an id is
 * always the separator, never part of a tag.
 */
const HASH_TAGS = {
  objects: [
    { id: 1, parentId: null, pathIndex: 0, depth: 0, displayName: 'Model', className: 'File' },
    { id: 2, parentId: 1, pathIndex: 0, depth: 1, displayName: 'A', className: 'Equipment' },
    { id: 3, parentId: 1, pathIndex: 1, depth: 1, displayName: 'B', className: 'Equipment' },
    { id: 4, parentId: 1, pathIndex: 2, depth: 1, displayName: 'C', className: 'Equipment' },
    { id: 5, parentId: 1, pathIndex: 3, depth: 1, displayName: 'D', className: 'Equipment' },
  ],
  properties: [
    { objectId: 2, category: 'Dragon Data', name: 'Tag', valueText: 'X' },
    { objectId: 3, category: 'Dragon Data', name: 'Tag', valueText: 'X' },
    { objectId: 4, category: 'Dragon Data', name: 'Tag', valueText: 'X#2' },
    { objectId: 5, category: 'Dragon Data', name: 'Tag', valueText: 'X%23' },
  ],
};

test('a literal # in a tag can never collide with a duplicate id suffix', () => {
  const path = join(directory, 'hash.sqlite');
  writeSyntheticCache(path, HASH_TAGS);
  const hashes = openExtractionCache(path);
  try {
    const { assets } = buildAssetCatalog(hashes, TAG_ONLY_MAPPINGS, FILTERS);
    const ids = assets.map((asset) => asset.assetId);
    assert.deepEqual(ids, [
      'tag:X#model/2',
      'tag:X#model/3',
      'tag:X%232',
      'tag:X%2523',
    ]);
    assert.equal(new Set(ids).size, ids.length);
  } finally {
    hashes.close();
  }
});
