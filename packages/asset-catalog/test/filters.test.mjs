import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { buildAssetCatalog, AssetCatalogConfigError, FILTER_STAGES } from '../dist/index.js';
import { openExtractionCache } from '../../model-schema/dist/index.js';
import { writeDragonFixture } from '../../model-schema/dist/fixtures/dragon.js';

import { DRAGON_MAPPINGS, makeTempDirectory, NO_FILTERS, stageCounts } from './support.mjs';

/**
 * The Dragon fixture, counted by hand from its generator:
 *
 *   Mechanical (source model 1): 1 File + 2 Layers + 2 x (12 Equipment
 *     + 12 Solids)                                                     = 51
 *   Controls   (source model 2): 1 File + 2 Layers + 2 x (5 Equipment
 *     + 4 Terminals)                                                   = 21
 *   Controls PLC (source model 3): 2 x 2 Modules                       =  4
 *                                                                  total 76
 *
 * Only the 34 Equipment objects carry `Dragon Data > Tag`, so 42 objects are
 * untagged. Per building: 6 MAH001 + 2 MAH002 + 4 TIT603 + 1 PLC001 + 4 VFD001
 * = 17 tags, and there are two buildings (level segments `10` and `20`).
 */
const TOTAL_OBJECTS = 76;
const TAGGED_OBJECTS = 34;
const UNTAGGED_OBJECTS = TOTAL_OBJECTS - TAGGED_OBJECTS;

let directory = '';
let cache = null;

before(() => {
  directory = makeTempDirectory('filters');
  const path = join(directory, 'dragon.sqlite');
  writeDragonFixture(path);
  cache = openExtractionCache(path);
});

after(() => {
  cache?.close();
  rmSync(directory, { recursive: true, force: true });
});

test('every stage is reported, in the documented order, even when unconfigured', () => {
  const { impact } = buildAssetCatalog(cache, DRAGON_MAPPINGS, NO_FILTERS);
  assert.deepEqual(
    impact.candidatesAfterEachFilter.map((stage) => stage.stage),
    [...FILTER_STAGES],
  );
});

test('an unfiltered profile keeps every tagged object and drops every untagged one', () => {
  const { assets, impact } = buildAssetCatalog(cache, DRAGON_MAPPINGS, NO_FILTERS);
  assert.equal(assets.length, TAGGED_OBJECTS);
  assert.equal(impact.totalObjects, TOTAL_OBJECTS);
  assert.equal(impact.finalAssetCount, TAGGED_OBJECTS);
  assert.equal(impact.untaggedDroppedCount, UNTAGGED_OBJECTS);
  assert.deepEqual(stageCounts(impact), [
    ['source-model-files', 76, 0],
    ['classes', 76, 0],
    ['selection-sets', 76, 0],
    ['tag-presence', 76, 42],
    ['tag-patterns', 34, 0],
  ]);
});

test('requireTagProperty false keeps untagged objects as assets', () => {
  const { assets, impact } = buildAssetCatalog(cache, DRAGON_MAPPINGS, {
    ...NO_FILTERS,
    requireTagProperty: false,
  });
  assert.equal(assets.length, TOTAL_OBJECTS);
  assert.equal(impact.untaggedDroppedCount, 0);
  assert.equal(
    assets.filter((asset) => asset.canonicalTag === '').length,
    UNTAGGED_OBJECTS,
  );
});

test('an untagged asset is identified by its cache ordinal, not by an empty tag', () => {
  const { assets } = buildAssetCatalog(cache, DRAGON_MAPPINGS, {
    ...NO_FILTERS,
    requireTagProperty: false,
  });
  const root = assets.find((asset) => asset.objectIds[0] === 1);
  assert.equal(root.assetId, 'object:1');
  assert.equal(root.canonicalTag, '');
  assert.equal(root.provenance.canonicalTag, undefined);
});

test('source-model includes run first and match on file name', () => {
  const { assets, impact } = buildAssetCatalog(cache, DRAGON_MAPPINGS, {
    ...NO_FILTERS,
    includedSourceModelFiles: ['Dragon-Controls.nwc'],
  });
  // 21 objects belong to Dragon-Controls.nwc; the 4 PLC modules belong to the
  // nested Dragon-Controls-PLC.nwc and are not included by naming the parent.
  assert.deepEqual(stageCounts(impact), [
    ['source-model-files', 76, 55],
    ['classes', 21, 0],
    ['selection-sets', 21, 0],
    ['tag-presence', 21, 11],
    ['tag-patterns', 10, 0],
  ]);
  assert.equal(assets.length, 10);
  assert.ok(assets.every((asset) => asset.sourceModelId === 2));
});

test('a nested source model is included by its own file name', () => {
  const { assets } = buildAssetCatalog(cache, DRAGON_MAPPINGS, {
    ...NO_FILTERS,
    requireTagProperty: false,
    includedSourceModelFiles: ['Dragon-Controls-PLC.nwc'],
  });
  assert.equal(assets.length, 4);
  assert.ok(assets.every((asset) => asset.sourceModelId === 3));
});

test('a source-model include that matches nothing yields no assets', () => {
  const { assets, impact } = buildAssetCatalog(cache, DRAGON_MAPPINGS, {
    ...NO_FILTERS,
    includedSourceModelFiles: ['Dragon-Electrical.nwc'],
  });
  assert.equal(assets.length, 0);
  assert.equal(impact.candidatesAfterEachFilter[0].droppedCount, TOTAL_OBJECTS);
});

test('included classes keep only that class', () => {
  const { assets, impact } = buildAssetCatalog(cache, DRAGON_MAPPINGS, {
    ...NO_FILTERS,
    includedClasses: ['Equipment'],
  });
  assert.equal(assets.length, TAGGED_OBJECTS);
  assert.deepEqual(stageCounts(impact)[1], ['classes', 76, 42]);
  // The class filter already removed everything untagged, so the tag stage has
  // nothing left to drop: the order of the two is visible in the report.
  assert.deepEqual(stageCounts(impact)[3], ['tag-presence', 34, 0]);
});

test('an exclusion beats an inclusion for the same class', () => {
  const { assets, impact } = buildAssetCatalog(cache, DRAGON_MAPPINGS, {
    ...NO_FILTERS,
    includedClasses: ['Equipment'],
    excludedClasses: ['Equipment'],
  });
  assert.equal(assets.length, 0);
  assert.deepEqual(stageCounts(impact)[1], ['classes', 76, 76]);
});

test('excluded classes alone leave every other class in', () => {
  const { assets } = buildAssetCatalog(cache, DRAGON_MAPPINGS, {
    ...NO_FILTERS,
    requireTagProperty: false,
    excludedClasses: ['Solid', 'Terminal', 'Module'],
  });
  // 76 objects less 24 Solids, 8 Terminals and 4 Modules.
  assert.equal(assets.length, 40);
});

test('selection-set membership keeps the members of a named set', () => {
  const { assets, impact } = buildAssetCatalog(cache, DRAGON_MAPPINGS, {
    ...NO_FILTERS,
    selectionSetNames: ['Air Handling'],
  });
  // Air Handling holds every MAH: (6 MAH001 + 2 MAH002) x 2 buildings.
  assert.equal(assets.length, 16);
  assert.ok(assets.every((asset) => asset.canonicalTag.startsWith('MAH')));
  assert.deepEqual(stageCounts(impact)[2], ['selection-sets', 76, 60]);
});

test('naming a folder means the sets inside it', () => {
  const folder = buildAssetCatalog(cache, DRAGON_MAPPINGS, {
    ...NO_FILTERS,
    selectionSetNames: ['Dragon Systems'],
  });
  const child = buildAssetCatalog(cache, DRAGON_MAPPINGS, {
    ...NO_FILTERS,
    selectionSetNames: ['Air Handling'],
  });
  assert.deepEqual(folder.assets, child.assets);
});

test('several named sets are a union', () => {
  const { assets } = buildAssetCatalog(cache, DRAGON_MAPPINGS, {
    ...NO_FILTERS,
    selectionSetNames: ['Air Handling', 'PLC Panels'],
  });
  assert.equal(assets.length, 18);
});

test('a selection set the model does not have is a typed error listing the ones it does', () => {
  let failure = null;
  try {
    buildAssetCatalog(cache, DRAGON_MAPPINGS, {
      ...NO_FILTERS,
      selectionSetNames: ['Air Handling', 'Chilled Water'],
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof AssetCatalogConfigError);
  assert.deepEqual(failure.reason, {
    kind: 'unknown-selection-set',
    name: 'Chilled Water',
    available: ['Dragon Systems', 'Air Handling', 'PLC Panels'],
  });
  assert.match(failure.message, /Chilled Water/);
  assert.match(failure.message, /Dragon Systems, Air Handling, PLC Panels/);
});

test('accepted tag patterns keep only tags of that shape', () => {
  const { assets, impact } = buildAssetCatalog(cache, DRAGON_MAPPINGS, {
    ...NO_FILTERS,
    acceptedTagPatterns: ['MAH*'],
  });
  assert.equal(assets.length, 16);
  assert.deepEqual(stageCounts(impact)[4], ['tag-patterns', 34, 18]);
});

test('a wildcard in the middle of a pattern matches across separators', () => {
  const { assets } = buildAssetCatalog(cache, DRAGON_MAPPINGS, {
    ...NO_FILTERS,
    acceptedTagPatterns: ['*-10-*'],
  });
  // Building D1 carries level segment 10: 12 mechanical + 5 controls tags.
  assert.equal(assets.length, 17);
});

test('several patterns are a union, and an exact pattern needs no wildcard', () => {
  const { assets } = buildAssetCatalog(cache, DRAGON_MAPPINGS, {
    ...NO_FILTERS,
    acceptedTagPatterns: ['MAH001-10-01', 'PLC*'],
  });
  assert.deepEqual(
    assets.map((asset) => asset.canonicalTag),
    ['MAH001-10-01', 'PLC001-10-01', 'PLC001-20-01'],
  );
});

test('an empty pattern list accepts every tag rather than none', () => {
  const withEmpty = buildAssetCatalog(cache, DRAGON_MAPPINGS, {
    ...NO_FILTERS,
    acceptedTagPatterns: [],
  });
  const withNone = buildAssetCatalog(cache, DRAGON_MAPPINGS, NO_FILTERS);
  assert.deepEqual(withEmpty.assets, withNone.assets);
});

test('tag patterns judge tags, not untagged objects', () => {
  const { assets } = buildAssetCatalog(cache, DRAGON_MAPPINGS, {
    ...NO_FILTERS,
    requireTagProperty: false,
    acceptedTagPatterns: ['MAH*'],
  });
  // 16 MAH assets, plus the 42 objects that have no tag to judge.
  assert.equal(assets.length, 58);
});

test('filters compose in order and each stage reports what it removed', () => {
  const { assets, impact } = buildAssetCatalog(cache, DRAGON_MAPPINGS, {
    ...NO_FILTERS,
    includedSourceModelFiles: ['Dragon-Mechanical.nwc'],
    includedClasses: ['Equipment', 'Solid'],
    selectionSetNames: ['Air Handling'],
    acceptedTagPatterns: ['MAH001*'],
  });
  assert.deepEqual(stageCounts(impact), [
    // 51 mechanical objects, of which 24 Equipment + 24 Solid survive classes,
    // of which the 16 MAH are in Air Handling, all tagged, 12 match MAH001*.
    ['source-model-files', 76, 25],
    ['classes', 51, 3],
    ['selection-sets', 48, 32],
    ['tag-presence', 16, 0],
    ['tag-patterns', 16, 4],
  ]);
  assert.equal(assets.length, 12);
});

test('every asset points back at the model object it came from', () => {
  const { assets } = buildAssetCatalog(cache, DRAGON_MAPPINGS, NO_FILTERS);
  for (const asset of assets) {
    assert.equal(asset.objectIds.length, 1);
    const object = cache.object(asset.objectIds[0]);
    assert.equal(object.displayName, asset.canonicalTag);
    assert.equal(asset.sourceModelId, object.sourceModelId);
    assert.equal(asset.status, 'MODEL_CONFIRMED');
    assert.equal(asset.assetId, `tag:${asset.canonicalTag}`);
  }
});
