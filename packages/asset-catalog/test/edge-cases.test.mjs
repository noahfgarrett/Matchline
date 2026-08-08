import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { buildAssetCatalog, isTagAccepted } from '../dist/index.js';
import { openExtractionCache } from '../../model-schema/dist/index.js';
import { writeDragonFixture } from '../../model-schema/dist/fixtures/dragon.js';

import {
  DRAGON_MAPPINGS,
  makeTempDirectory,
  NO_FILTERS,
  TAG_ONLY_MAPPINGS,
  stageCounts,
  writeSyntheticCache,
} from './support.mjs';

let directory = '';

before(() => {
  directory = makeTempDirectory('edge-cases');
});

after(() => {
  rmSync(directory, { recursive: true, force: true });
});

function withCache(name, content, run) {
  const path = join(directory, `${name}.sqlite`);
  writeSyntheticCache(path, content);
  const cache = openExtractionCache(path);
  try {
    return run(cache);
  } finally {
    cache.close();
  }
}

test('an empty cache produces an empty catalog and zeroed counts', () => {
  const result = withCache('empty', { objects: [], properties: [] }, (cache) =>
    buildAssetCatalog(cache, TAG_ONLY_MAPPINGS, NO_FILTERS),
  );
  assert.deepEqual(result.assets, []);
  assert.deepEqual(result.reviewItems, []);
  assert.deepEqual(result.impact, {
    totalObjects: 0,
    candidatesAfterEachFilter: [
      { stage: 'source-model-files', inCount: 0, droppedCount: 0 },
      { stage: 'classes', inCount: 0, droppedCount: 0 },
      { stage: 'selection-sets', inCount: 0, droppedCount: 0 },
      { stage: 'tag-presence', inCount: 0, droppedCount: 0 },
      { stage: 'tag-patterns', inCount: 0, droppedCount: 0 },
    ],
    collapsedCount: 0,
    finalAssetCount: 0,
    duplicateTagCount: 0,
    untaggedDroppedCount: 0,
  });
});

test('an empty cache still rejects a selection set it does not have', () => {
  assert.throws(
    () =>
      withCache('empty-sets', { objects: [] }, (cache) =>
        buildAssetCatalog(cache, TAG_ONLY_MAPPINGS, {
          ...NO_FILTERS,
          selectionSetNames: ['Air Handling'],
        }),
      ),
    /the cache has no selection sets/,
  );
});

test('a cache with objects but no properties filters every object out', () => {
  const result = withCache(
    'no-properties',
    {
      objects: [
        { id: 1, parentId: null, pathIndex: 0, depth: 0, className: 'Equipment' },
        { id: 2, parentId: 1, pathIndex: 0, depth: 1, className: 'Solid' },
      ],
    },
    (cache) => buildAssetCatalog(cache, TAG_ONLY_MAPPINGS, NO_FILTERS),
  );
  assert.deepEqual(result.assets, []);
  assert.equal(result.impact.untaggedDroppedCount, 2);
  assert.deepEqual(stageCounts(result.impact)[3], ['tag-presence', 2, 2]);
});

test('an object the cache attributes to no source model cannot satisfy an include', () => {
  const content = {
    objects: [{ id: 1, sourceModelId: null, parentId: null, pathIndex: 0, depth: 0 }],
    properties: [{ objectId: 1, category: 'Dragon Data', name: 'Tag', valueText: 'MAH001-10-01' }],
  };
  const included = withCache('no-source-model', content, (cache) =>
    buildAssetCatalog(cache, TAG_ONLY_MAPPINGS, {
      ...NO_FILTERS,
      includedSourceModelFiles: ['Dragon-Synthetic.nwc'],
    }),
  );
  assert.equal(included.assets.length, 0);

  const unfiltered = withCache('no-source-model', content, (cache) =>
    buildAssetCatalog(cache, TAG_ONLY_MAPPINGS, NO_FILTERS),
  );
  assert.equal(unfiltered.assets.length, 1);
  assert.equal(unfiltered.assets[0].sourceModelId, null);
  // With no source model to name, provenance falls back to the extracted file.
  assert.equal(unfiltered.assets[0].provenance.canonicalTag.sourceFile, 'Dragon-Synthetic.nwd');
});

test('an object with no class cannot satisfy a class include but survives exclusions', () => {
  const content = {
    objects: [{ id: 1, parentId: null, pathIndex: 0, depth: 0, className: null }],
    properties: [{ objectId: 1, category: 'Dragon Data', name: 'Tag', valueText: 'MAH001-10-01' }],
  };
  const included = withCache('no-class', content, (cache) =>
    buildAssetCatalog(cache, TAG_ONLY_MAPPINGS, { ...NO_FILTERS, includedClasses: ['Equipment'] }),
  );
  assert.equal(included.assets.length, 0);

  const excluded = withCache('no-class', content, (cache) =>
    buildAssetCatalog(cache, TAG_ONLY_MAPPINGS, { ...NO_FILTERS, excludedClasses: ['Equipment'] }),
  );
  assert.equal(excluded.assets.length, 1);
});

test('filtering everything out is a result, not a failure', () => {
  const dragonPath = join(directory, 'dragon-empty-result.sqlite');
  writeDragonFixture(dragonPath);
  const cache = openExtractionCache(dragonPath);
  try {
    const { assets, reviewItems, impact } = buildAssetCatalog(cache, DRAGON_MAPPINGS, {
      ...NO_FILTERS,
      includedClasses: ['Pipe'],
    });
    assert.deepEqual(assets, []);
    assert.deepEqual(reviewItems, []);
    assert.equal(impact.totalObjects, 76);
    assert.equal(impact.finalAssetCount, 0);
    assert.deepEqual(stageCounts(impact), [
      ['source-model-files', 76, 0],
      ['classes', 76, 76],
      ['selection-sets', 0, 0],
      ['tag-presence', 0, 0],
      ['tag-patterns', 0, 0],
    ]);
  } finally {
    cache.close();
  }
});

test('two builds of the same cache are identical', () => {
  const path = join(directory, 'determinism-a.sqlite');
  writeDragonFixture(path);
  const cache = openExtractionCache(path);
  try {
    const filters = {
      requireTagProperty: false,
      collapseComponents: true,
      includedClasses: ['Equipment', 'Solid', 'Module', 'Terminal'],
      separatelyCommissionableClasses: ['Module'],
    };
    const first = buildAssetCatalog(cache, DRAGON_MAPPINGS, filters);
    const second = buildAssetCatalog(cache, DRAGON_MAPPINGS, filters);
    assert.deepEqual(first, second);
  } finally {
    cache.close();
  }
});

test('two separately written copies of the same fixture compile the same', () => {
  const firstPath = join(directory, 'determinism-b1.sqlite');
  const secondPath = join(directory, 'determinism-b2.sqlite');
  writeDragonFixture(firstPath);
  writeDragonFixture(secondPath);
  const first = openExtractionCache(firstPath);
  const second = openExtractionCache(secondPath);
  try {
    // Nothing in the output may depend on the file it was read from.
    assert.deepEqual(
      buildAssetCatalog(first, DRAGON_MAPPINGS, NO_FILTERS),
      buildAssetCatalog(second, DRAGON_MAPPINGS, NO_FILTERS),
    );
  } finally {
    first.close();
    second.close();
  }
});

test('glob-lite accepts everything when no pattern is configured', () => {
  assert.equal(isTagAccepted('MAH001-10-01', undefined), true);
  assert.equal(isTagAccepted('MAH001-10-01', []), true);
});

test('glob-lite matches prefixes, suffixes, middles and whole tags', () => {
  assert.equal(isTagAccepted('MAH001-10-01', ['MAH*']), true);
  assert.equal(isTagAccepted('MAH001-10-01', ['*-01']), true);
  assert.equal(isTagAccepted('MAH001-10-01', ['MAH*-10-*']), true);
  assert.equal(isTagAccepted('MAH001-10-01', ['MAH001-10-01']), true);
  assert.equal(isTagAccepted('MAH001-10-01', ['*']), true);
  assert.equal(isTagAccepted('MAH001-10-01', ['VFD*', 'MAH*']), true);
});

test('glob-lite rejects what the pattern does not describe', () => {
  assert.equal(isTagAccepted('MAH001-10-01', ['VFD*']), false);
  assert.equal(isTagAccepted('MAH001-10-01', ['MAH001-10-02']), false);
  assert.equal(isTagAccepted('MAH001-10-01', ['*-99']), false);
  assert.equal(isTagAccepted('MAH', ['MAH*-10-*']), false);
  // Case-sensitive on purpose: folding case is identity work, not filtering.
  assert.equal(isTagAccepted('mah001-10-01', ['MAH*']), false);
});

test('glob-lite treats regex syntax as literal text', () => {
  assert.equal(isTagAccepted('MAH001-10-01', ['MAH.*']), false);
  assert.equal(isTagAccepted('MAH.*', ['MAH.*']), true);
  assert.equal(isTagAccepted('a+b', ['a+b']), true);
  assert.equal(isTagAccepted('aaab', ['a+b']), false);
  assert.equal(isTagAccepted('[MAH]', ['[MAH]']), true);
  assert.equal(isTagAccepted('M', ['[MAH]']), false);
});

test('glob-lite handles overlapping literals around a wildcard', () => {
  assert.equal(isTagAccepted('aa', ['a*a']), true);
  assert.equal(isTagAccepted('a', ['a*a']), false);
  assert.equal(isTagAccepted('aXa', ['a*a']), true);
  assert.equal(isTagAccepted('', ['*']), true);
  assert.equal(isTagAccepted('', ['']), true);
});
