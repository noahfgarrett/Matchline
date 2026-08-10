/**
 * Ordered fallback chains and per-source mapping overrides
 * (RELEASE-1.0-PLAN P0-8, hard gate 5).
 *
 * A synthetic cache rather than Dragon, because what is being tested is which
 * of several ADDRESSES a field is read from, and that needs objects whose
 * properties are spread across the rungs on purpose:
 *
 * ```text
 * source `alpha`                        source `beta`
 *   1  ALPHA-1  Site > Building  = A1     11  BETA-1  Site > Building = B1
 *   2  ALPHA-2  Element > Level  = L2     12  BETA-2  Element > Level = L12
 *   3  ALPHA-3  (neither)                 13  BETA-3  Site > Building = B3
 *                                                     Element > Level = L13
 * ```
 *
 * Both sources use the same profile. `alpha` reads the global chain
 * `[Site > Building, Element > Level]`; `beta` is given an override that reads
 * `Element > Level` alone, so the same object can answer differently in the two
 * files and the test can tell which chain ran.
 */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { buildAssetCatalog } from '../dist/index.js';
import { openExtractionCache } from '../../model-schema/dist/index.js';

import { makeTempDirectory, NO_FILTERS, writeSyntheticCache } from './support.mjs';

const TAG = { category: 'Item', name: 'Tag' };
const BUILDING = { category: 'Site', name: 'Building' };
const LEVEL = { category: 'Element', name: 'Level' };

/** The pre-P0-8 spelling: one property, every source. */
const SINGLE = { equipmentTag: TAG, building: BUILDING };

/** The same profile with `building` as a two-rung chain. */
const CHAINED = { equipmentTag: TAG, building: { chain: [BUILDING, LEVEL] } };

let directory = '';
const opened = [];

function openCache(label, content) {
  const path = join(directory, `${label}.sqlite`);
  writeSyntheticCache(path, content);
  const cache = openExtractionCache(path);
  opened.push(cache);
  return cache;
}

let alpha = null;
let beta = null;

before(() => {
  directory = makeTempDirectory('chains');
  alpha = openCache('alpha', {
    objects: [
      { id: 1, displayName: 'ALPHA-1' },
      { id: 2, displayName: 'ALPHA-2' },
      { id: 3, displayName: 'ALPHA-3' },
    ],
    properties: [
      { objectId: 1, category: 'Item', name: 'Tag', valueText: 'ALPHA-1' },
      { objectId: 1, category: 'Site', name: 'Building', valueText: 'A1' },
      { objectId: 2, category: 'Item', name: 'Tag', valueText: 'ALPHA-2' },
      { objectId: 2, category: 'Element', name: 'Level', valueText: 'L2' },
      { objectId: 3, category: 'Item', name: 'Tag', valueText: 'ALPHA-3' },
    ],
  });
  beta = openCache('beta', {
    objects: [
      { id: 11, displayName: 'BETA-1' },
      { id: 12, displayName: 'BETA-2' },
      { id: 13, displayName: 'BETA-3' },
    ],
    properties: [
      { objectId: 11, category: 'Item', name: 'Tag', valueText: 'BETA-1' },
      { objectId: 11, category: 'Site', name: 'Building', valueText: 'B1' },
      { objectId: 12, category: 'Item', name: 'Tag', valueText: 'BETA-2' },
      { objectId: 12, category: 'Element', name: 'Level', valueText: 'L12' },
      { objectId: 13, category: 'Item', name: 'Tag', valueText: 'BETA-3' },
      { objectId: 13, category: 'Site', name: 'Building', valueText: 'B3' },
      { objectId: 13, category: 'Element', name: 'Level', valueText: 'L13' },
    ],
  });
});

after(() => {
  for (const cache of opened) {
    cache.close();
  }
  rmSync(directory, { recursive: true, force: true });
});

/** `tag -> [value, rungIndex, sourceSpecificChain]` for the `building` field. */
function buildingShape(catalog) {
  return catalog.assets.map((asset) => [
    asset.canonicalTag,
    asset.building,
    asset.provenance.building?.rungIndex,
    asset.provenance.building?.sourceSpecificChain,
  ]);
}

test('a mapping written as one property behaves exactly as a one-rung chain', () => {
  const single = buildAssetCatalog([{ sourceId: 'alpha', cache: alpha }], SINGLE, NO_FILTERS);
  const lifted = buildAssetCatalog(
    [{ sourceId: 'alpha', cache: alpha }],
    { equipmentTag: { chain: [TAG] }, building: { chain: [BUILDING] } },
    NO_FILTERS,
  );
  assert.deepEqual(buildingShape(lifted), buildingShape(single));
  assert.deepEqual(buildingShape(single), [
    ['ALPHA-1', 'A1', 0, false],
    ['ALPHA-2', undefined, undefined, undefined],
    ['ALPHA-3', undefined, undefined, undefined],
  ]);
});

test('the first rung that states a value wins, and the rest are not consulted', () => {
  const catalog = buildAssetCatalog([{ sourceId: 'beta', cache: beta }], CHAINED, NO_FILTERS);
  assert.deepEqual(buildingShape(catalog), [
    // Rung 0 answered.
    ['BETA-1', 'B1', 0, false],
    // Rung 0 said nothing here, so rung 1 did.
    ['BETA-2', 'L12', 1, false],
    // Both rungs state a value; the earlier one is the site's preference.
    ['BETA-3', 'B3', 0, false],
  ]);
});

test('a chain nothing answers leaves the field off the asset, never defaulted', () => {
  const catalog = buildAssetCatalog([{ sourceId: 'alpha', cache: alpha }], CHAINED, NO_FILTERS);
  const bare = catalog.assets.find((asset) => asset.canonicalTag === 'ALPHA-3');
  assert.equal(bare.building, undefined);
  assert.equal('building' in bare, false, 'absent, not present-and-empty');
  assert.equal(bare.provenance.building, undefined);
});

test('a source with an override reads through it, and its provenance says so', () => {
  const mappings = {
    equipmentTag: TAG,
    building: { chain: [BUILDING, LEVEL], bySource: [{ sourceId: 'beta', chain: [LEVEL] }] },
  };
  const catalog = buildAssetCatalog(
    [
      { sourceId: 'alpha', cache: alpha },
      { sourceId: 'beta', cache: beta },
    ],
    mappings,
    NO_FILTERS,
  );
  assert.deepEqual(buildingShape(catalog), [
    // `alpha` never named an override, so it walks the global chain.
    ['ALPHA-1', 'A1', 0, false],
    ['ALPHA-2', 'L2', 1, false],
    ['ALPHA-3', undefined, undefined, undefined],
    // `beta` reads `Element > Level` alone: BETA-1 states only a Building, so
    // the override finds nothing rather than falling back to the global chain.
    ['BETA-1', undefined, undefined, undefined],
    ['BETA-2', 'L12', 0, true],
    ['BETA-3', 'L13', 0, true],
  ]);
});

test('provenance names the rung that answered, both ways round', () => {
  const catalog = buildAssetCatalog([{ sourceId: 'beta', cache: beta }], CHAINED, NO_FILTERS);
  const second = catalog.assets.find((asset) => asset.canonicalTag === 'BETA-2');
  assert.deepEqual(second.provenance.building.property, LEVEL);
  assert.equal(second.provenance.building.rungIndex, 1, 'zero-based, for a caller');
  assert.equal(second.provenance.building.fallbackRung, 2, 'one-based, for a reader');
  assert.equal(
    second.provenance.building.propertyOrColumn,
    'Element > Level',
    'the display string is the rung that answered, not the first rung',
  );
});

/* --------------------------------------------------------- the tag chain --- */

test('the equipment tag is a chain too, read per object', () => {
  // The tag decides identity, so its chain is walked for each object rather
  // than for the asset: an object that answers rung 1 is tagged just as much as
  // one that answers rung 0.
  const cache = openCache('tags', {
    objects: [
      { id: 1, displayName: 'primary' },
      { id: 2, displayName: 'secondary' },
      { id: 3, displayName: 'untagged' },
    ],
    properties: [
      { objectId: 1, category: 'Item', name: 'Tag', valueText: 'T-1' },
      { objectId: 2, category: 'Legacy', name: 'Asset No', valueText: 'T-2' },
    ],
  });
  const catalog = buildAssetCatalog(
    [{ sourceId: 'tags', cache }],
    { equipmentTag: { chain: [TAG, { category: 'Legacy', name: 'Asset No' }] } },
    NO_FILTERS,
  );
  assert.deepEqual(
    catalog.assets.map((asset) => [
      asset.canonicalTag,
      asset.provenance.canonicalTag.rungIndex,
    ]),
    [
      ['T-1', 0],
      ['T-2', 1],
    ],
    'the untagged object is dropped by requireTagProperty, as it always was',
  );
});

test('an accepted-tag-pattern filter judges whichever rung supplied the tag', () => {
  const cache = openCache('tag-patterns', {
    objects: [
      { id: 1, displayName: 'kept' },
      { id: 2, displayName: 'dropped' },
    ],
    properties: [
      { objectId: 1, category: 'Legacy', name: 'Asset No', valueText: 'EQ-001' },
      { objectId: 2, category: 'Legacy', name: 'Asset No', valueText: 'SCRAP-9' },
    ],
  });
  const catalog = buildAssetCatalog(
    [{ sourceId: 'tag-patterns', cache }],
    { equipmentTag: { chain: [TAG, { category: 'Legacy', name: 'Asset No' }] } },
    { ...NO_FILTERS, acceptedTagPatterns: ['EQ-*'] },
  );
  assert.deepEqual(
    catalog.assets.map((asset) => asset.canonicalTag),
    ['EQ-001'],
  );
});
