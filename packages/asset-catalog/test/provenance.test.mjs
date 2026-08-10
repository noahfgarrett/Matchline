import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { buildAssetCatalog } from '../dist/index.js';
import { openExtractionCache } from '../../model-schema/dist/index.js';
import { writeDragonFixture } from '../../model-schema/dist/fixtures/dragon.js';

import {
  DRAGON_MAPPINGS,
  makeTempDirectory,
  NO_FILTERS,
  TAG_ONLY_MAPPINGS,
  writeSyntheticCache,
} from './support.mjs';

let directory = '';
let cache = null;

before(() => {
  directory = makeTempDirectory('provenance');
  const path = join(directory, 'dragon.sqlite');
  writeDragonFixture(path);
  cache = openExtractionCache(path);
});

after(() => {
  cache?.close();
  rmSync(directory, { recursive: true, force: true });
});

function assetFor(tag, mappings = DRAGON_MAPPINGS, filters = NO_FILTERS) {
  const { assets } = buildAssetCatalog(cache, mappings, filters);
  const asset = assets.find((candidate) => candidate.canonicalTag === tag);
  assert.ok(asset !== undefined, `no asset tagged ${tag}`);
  return asset;
}

test('every populated field records the property it was read from', () => {
  const asset = assetFor('MAH001-10-01');
  assert.deepEqual(
    Object.entries(asset.provenance).map(([field, provenance]) => [field, provenance.property]),
    [
      ['canonicalTag', { category: 'Dragon Data', name: 'Tag' }],
      ['description', { category: 'Item', name: 'Name' }],
      ['equipmentType', { category: 'Item', name: 'Type' }],
      ['building', { category: 'Dragon Data', name: 'Building' }],
    ],
  );
});

test('field provenance is a domain Provenance addressing the model object', () => {
  const asset = assetFor('MAH001-10-01');
  assert.deepEqual(asset.provenance.building, {
    origin: 'model-property',
    sourceFile: 'Dragon-Mechanical.nwc',
    sourceRef: { kind: 'model-object', objectId: '3' },
    propertyOrColumn: 'Dragon Data > Building',
    rule: 'asset-catalog:building',
    // P0-8: which rung of the field's chain answered, counted both ways --
    // from 1 for a reader (`fallbackRung`, the engine's own vocabulary) and from
    // 0 for a caller indexing the chain. A mapping written as a single property
    // is a one-rung chain, so rung 0 is the only rung there is.
    fallbackRung: 1,
    property: { category: 'Dragon Data', name: 'Building' },
    rungIndex: 0,
    sourceSpecificChain: false,
    objectId: 3,
  });
  assert.equal(asset.building, 'D1');
});

test('provenance names the source model the value came from, not the project file', () => {
  assert.equal(assetFor('MAH001-10-01').provenance.canonicalTag.sourceFile, 'Dragon-Mechanical.nwc');
  assert.equal(assetFor('VFD001-10-01').provenance.canonicalTag.sourceFile, 'Dragon-Controls.nwc');
});

test('an unmapped role leaves the field and its provenance off entirely', () => {
  const asset = assetFor('MAH001-10-01', TAG_ONLY_MAPPINGS);
  assert.equal(asset.description, undefined);
  assert.equal(asset.nativeDiscipline, undefined);
  assert.deepEqual(Object.keys(asset.provenance), ['canonicalTag']);
  assert.ok(!('description' in asset));
});

test('a mapped property the object does not carry is absent, never invented', () => {
  const mappings = {
    ...TAG_ONLY_MAPPINGS,
    description: { category: 'Dragon Data', name: 'Service' },
  };
  // Dragon writes Service with a value for MAH and with no value for TIT.
  assert.equal(assetFor('MAH001-10-01', mappings).description, 'Chilled Water');
  const empty = assetFor('TIT603-10-01', mappings);
  assert.equal(empty.description, undefined);
  assert.deepEqual(Object.keys(empty.provenance), ['canonicalTag']);
});

test('a field reads from the first of the asset objects carrying it', () => {
  const mappings = {
    ...TAG_ONLY_MAPPINGS,
    equipmentType: { category: 'Controls Data', name: 'Slot' },
  };
  const { assets } = buildAssetCatalog(cache, mappings, {
    requireTagProperty: false,
    collapseComponents: true,
    includedClasses: ['Equipment', 'Module'],
  });
  const plc = assets.find((asset) => asset.canonicalTag === 'PLC001-10-01');
  // Only the collapsed modules carry Slot; object 55 is the first of them.
  assert.deepEqual(plc.objectIds, [54, 55, 56]);
  assert.equal(plc.equipmentType, '01');
  assert.equal(plc.provenance.equipmentType.objectId, 55);
  assert.equal(plc.provenance.equipmentType.sourceFile, 'Dragon-Controls-PLC.nwc');
});

test('a tag is read from the asset itself, never from a component it absorbed', () => {
  const path = join(directory, 'component-tag.sqlite');
  writeSyntheticCache(path, {
    objects: [
      { id: 1, parentId: null, pathIndex: 0, depth: 0, className: 'Equipment' },
      { id: 2, parentId: 1, pathIndex: 0, depth: 1, className: 'Solid' },
    ],
    properties: [
      { objectId: 1, category: 'Dragon Data', name: 'Building', valueText: 'D1' },
      { objectId: 2, category: 'Dragon Data', name: 'Tag', valueText: 'MAH001-10-99' },
      { objectId: 2, category: 'Dragon Data', name: 'Building', valueText: 'D2' },
    ],
  });
  const componentCache = openExtractionCache(path);
  try {
    const { assets } = buildAssetCatalog(
      componentCache,
      { ...TAG_ONLY_MAPPINGS, building: { category: 'Dragon Data', name: 'Building' } },
      { requireTagProperty: false, collapseComponents: true },
    );
    assert.equal(assets.length, 1);
    // The component's tag would rename the whole asset after one of its parts.
    assert.equal(assets[0].canonicalTag, '');
    // Other fields do fall through to a component, and the owner still wins.
    assert.equal(assets[0].building, 'D1');
    assert.equal(assets[0].provenance.building.objectId, 1);
  } finally {
    componentCache.close();
  }
});

test('a property repeated on one object is read once, at its first reading', () => {
  const mappings = {
    ...TAG_ONLY_MAPPINGS,
    description: { category: 'Dragon Data', name: 'Note' },
  };
  // The Dragon fixture writes Note twice on its first MAH.
  const asset = assetFor('MAH001-10-01', mappings);
  assert.equal(asset.description, 'Verify with vendor');
});

test('a value is trimmed and nothing else about it is changed', () => {
  const path = join(directory, 'whitespace.sqlite');
  writeSyntheticCache(path, {
    objects: [{ id: 1, parentId: null, pathIndex: 0, depth: 0, className: 'Equipment' }],
    properties: [
      { objectId: 1, category: 'Dragon Data', name: 'Tag', valueText: '\tmah001-10-01 \n' },
      { objectId: 1, category: 'Dragon Data', name: 'Building', valueText: ' d 1 ' },
    ],
  });
  const whitespaceCache = openExtractionCache(path);
  try {
    const { assets } = buildAssetCatalog(
      whitespaceCache,
      { ...TAG_ONLY_MAPPINGS, building: { category: 'Dragon Data', name: 'Building' } },
      { requireTagProperty: true, collapseComponents: false },
    );
    // Case is left alone: folding it is identity work, not filtering.
    assert.equal(assets[0].canonicalTag, 'mah001-10-01');
    assert.equal(assets[0].building, 'd 1');
  } finally {
    whitespaceCache.close();
  }
});
