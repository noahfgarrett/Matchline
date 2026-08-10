/**
 * Many model sources, one asset universe (RELEASE-1.0-PLAN P0-1).
 *
 * The Dragon fixture is a federated file carrying a Mechanical source model and
 * a Controls one; `writeDragonFixtureSubset` splits it into caches whose tagged
 * objects partition it exactly. That is what lets these tests compare two
 * REPRESENTATIONS of one site rather than two sites, and it is why they can
 * assert exact counts: 24 mechanical assets plus 10 controls assets is the
 * federated fixture's own 34.
 */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import {
  AssetCatalogConfigError,
  buildAssetCatalog,
  buildUniversePropertyCatalog,
} from '../dist/index.js';
import { openExtractionCache } from '../../model-schema/dist/index.js';
import {
  DRAGON_SOURCE_MODEL_IDS,
  writeDragonFixture,
  writeDragonFixtureSubset,
} from '../../model-schema/dist/fixtures/dragon.js';

import {
  assetShape,
  DRAGON_MAPPINGS,
  makeTempDirectory,
  NO_FILTERS,
  stageCounts,
  TAG_ONLY_MAPPINGS,
} from './support.mjs';

const MECHANICAL_MODELS = [DRAGON_SOURCE_MODEL_IDS.mechanical];
const CONTROLS_MODELS = [DRAGON_SOURCE_MODEL_IDS.controls, DRAGON_SOURCE_MODEL_IDS.controlsPlc];

let directory = '';
const opened = [];

/** A cache holding part of Dragon, closed for us when the suite ends. */
function openSubset(label, opts) {
  const path = join(directory, `${label}.sqlite`);
  writeDragonFixtureSubset(path, opts);
  const cache = openExtractionCache(path);
  opened.push(cache);
  return cache;
}

let federated = null;
let mechanical = null;
let controls = null;
/** The mechanical half again, as a second registered source. */
let mechanicalTwin = null;

before(() => {
  directory = makeTempDirectory('multi-source');
  const federatedPath = join(directory, 'federated.sqlite');
  writeDragonFixture(federatedPath);
  federated = openExtractionCache(federatedPath);
  opened.push(federated);

  mechanical = openSubset('mech', {
    sourceModels: MECHANICAL_MODELS,
    inputFileName: 'Dragon-Mechanical.nwd',
  });
  controls = openSubset('ctrl', {
    sourceModels: CONTROLS_MODELS,
    inputFileName: 'Dragon-Controls.nwd',
  });
  mechanicalTwin = openSubset('mech-2', {
    sourceModels: MECHANICAL_MODELS,
    inputFileName: 'Dragon-Mechanical.nwd',
  });
});

after(() => {
  for (const cache of opened) {
    cache.close();
  }
  rmSync(directory, { recursive: true, force: true });
});

/* --------------------------------------------- the single-source anchor --- */

test('a universe of one behaves exactly as the deprecated single-cache call', () => {
  const asArray = buildAssetCatalog([{ sourceId: 'model', cache: federated }], DRAGON_MAPPINGS, NO_FILTERS);
  const asCache = buildAssetCatalog(federated, DRAGON_MAPPINGS, NO_FILTERS);
  assert.deepEqual(asArray, asCache);
});

test('a universe of one names its source on every asset', () => {
  const { assets, impact } = buildAssetCatalog(
    [{ sourceId: 'dragon', cache: federated }],
    DRAGON_MAPPINGS,
    NO_FILTERS,
  );
  assert.equal(assets.length, 34);
  assert.ok(assets.every((asset) => asset.sourceId === 'dragon'));
  assert.deepEqual([...impact.bySource.keys()], ['dragon']);
  assert.equal(impact.bySource.get('dragon').finalAssetCount, 34);
});

/* ------------------------------------------------- federated vs split --- */

test('two split sources produce the same asset universe as one federated source', () => {
  const asOne = buildAssetCatalog(
    [{ sourceId: 'dragon', cache: federated }],
    DRAGON_MAPPINGS,
    NO_FILTERS,
  );
  const asTwo = buildAssetCatalog(
    [
      { sourceId: 'dragon-mechanical', cache: mechanical },
      { sourceId: 'dragon-controls', cache: controls },
    ],
    DRAGON_MAPPINGS,
    NO_FILTERS,
  );

  assert.equal(asTwo.assets.length, 34);
  // The tags and their ids are the site, not the file layout: an unduplicated
  // tag names no source, so splitting the file cannot rename anything.
  assert.deepEqual(
    asTwo.assets.map((asset) => asset.assetId).sort(),
    asOne.assets.map((asset) => asset.assetId).sort(),
  );
  assert.deepEqual(asTwo.reviewItems, asOne.reviewItems);
  assert.equal(asTwo.impact.totalObjects, asOne.impact.totalObjects);
  assert.equal(asTwo.impact.finalAssetCount, asOne.impact.finalAssetCount);
});

test('the split halves are 24 mechanical and 10 controls', () => {
  const { impact } = buildAssetCatalog(
    [
      { sourceId: 'dragon-mechanical', cache: mechanical },
      { sourceId: 'dragon-controls', cache: controls },
    ],
    DRAGON_MAPPINGS,
    NO_FILTERS,
  );
  assert.equal(impact.bySource.get('dragon-mechanical').finalAssetCount, 24);
  assert.equal(impact.bySource.get('dragon-controls').finalAssetCount, 10);
  assert.equal(impact.finalAssetCount, 34);
});

/* --------------------------------------------------------- determinism --- */

test('the output does not depend on the order the sources were passed in', () => {
  const forwards = buildAssetCatalog(
    [
      { sourceId: 'a-mechanical', cache: mechanical },
      { sourceId: 'b-controls', cache: controls },
    ],
    DRAGON_MAPPINGS,
    NO_FILTERS,
  );
  const backwards = buildAssetCatalog(
    [
      { sourceId: 'b-controls', cache: controls },
      { sourceId: 'a-mechanical', cache: mechanical },
    ],
    DRAGON_MAPPINGS,
    NO_FILTERS,
  );
  assert.deepEqual(backwards, forwards);
  // Not merely equal by content: the assets come back in source-id order, so a
  // consumer that indexes by position sees the same thing too.
  assert.deepEqual(
    forwards.assets.slice(0, 24).map((asset) => asset.sourceId),
    Array.from({ length: 24 }, () => 'a-mechanical'),
  );
});

test('a source id decides the order, not the file name or the array', () => {
  const catalog = buildAssetCatalog(
    [
      { sourceId: 'z-first-in-array', cache: controls },
      { sourceId: 'a-second-in-array', cache: mechanical },
    ],
    DRAGON_MAPPINGS,
    NO_FILTERS,
  );
  assert.deepEqual(
    [...catalog.impact.bySource.keys()],
    ['a-second-in-array', 'z-first-in-array'],
  );
});

/* ------------------------------------------------- same basename, gate 4 --- */

test('two sources that share a raw file name both contribute their assets', () => {
  // Both halves claim `Dragon-Area.nwd`. Keying anything on the file name would
  // lose one of them.
  const shared = 'Dragon-Area.nwd';
  const areaMech = openSubset('area-mech', {
    sourceModels: MECHANICAL_MODELS,
    inputFileName: shared,
  });
  const areaCtrl = openSubset('area-ctrl', {
    sourceModels: CONTROLS_MODELS,
    inputFileName: shared,
  });

  const { assets, impact } = buildAssetCatalog(
    [
      { sourceId: 'dragon-area-mech', cache: areaMech },
      { sourceId: 'dragon-area-ctrl', cache: areaCtrl },
    ],
    DRAGON_MAPPINGS,
    NO_FILTERS,
  );
  assert.equal(assets.length, 34);
  assert.equal(impact.duplicateTagCount, 0, 'two different areas share a name, not tags');
  assert.ok(assets.some((asset) => asset.canonicalTag === 'MAH001-10-01'));
  assert.ok(assets.some((asset) => asset.canonicalTag === 'PLC001-10-01'));
  assert.equal(new Set(assets.map((asset) => asset.assetId)).size, 34);
});

test('two sources under one id are refused rather than silently merged', () => {
  let failure = null;
  try {
    buildAssetCatalog(
      [
        { sourceId: 'dragon', cache: mechanical },
        { sourceId: 'dragon', cache: controls },
      ],
      DRAGON_MAPPINGS,
      NO_FILTERS,
    );
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof AssetCatalogConfigError);
  assert.deepEqual(failure.reason, { kind: 'duplicate-source-id', sourceId: 'dragon' });
});

test('a blank source id is refused: an id is what addresses a source', () => {
  assert.throws(
    () => buildAssetCatalog([{ sourceId: '', cache: mechanical }], DRAGON_MAPPINGS, NO_FILTERS),
    (error) => error instanceof AssetCatalogConfigError && error.reason.kind === 'blank-source-id',
  );
});

/* ----------------------------------------------- duplicates across files --- */

test('one tag registered by two sources is a duplicate naming both of them', () => {
  const { assets, reviewItems, impact } = buildAssetCatalog(
    [
      { sourceId: 'dragon-mech-a', cache: mechanical },
      { sourceId: 'dragon-mech-b', cache: mechanicalTwin },
    ],
    DRAGON_MAPPINGS,
    NO_FILTERS,
  );

  // Every one of the 24 mechanical tags is now carried twice.
  assert.equal(impact.duplicateTagCount, 24);
  assert.equal(assets.length, 48, 'never merged: both readings survive (§9.3)');

  const mah = reviewItems.filter(
    (item) => item.kind === 'duplicate-model-tag' && item.canonicalTag === 'MAH001-10-01',
  );
  assert.equal(mah.length, 1, 'one item per tag, not one per source');
  assert.deepEqual(mah[0].sources, [
    { sourceId: 'dragon-mech-a', objectIds: [3] },
    { sourceId: 'dragon-mech-b', objectIds: [3] },
  ]);
  // The flat list repeats 3 because both sources number an object 3. That is
  // exactly why an object id alone cannot be navigated to.
  assert.deepEqual(mah[0].objectIds, [3, 3]);
});

test('a duplicate across sources disambiguates by source, not by ordinal', () => {
  const { assets } = buildAssetCatalog(
    [
      { sourceId: 'dragon-mech-a', cache: mechanical },
      { sourceId: 'dragon-mech-b', cache: mechanicalTwin },
    ],
    DRAGON_MAPPINGS,
    NO_FILTERS,
  );
  const mah = assets
    .filter((asset) => asset.canonicalTag === 'MAH001-10-01')
    .map((asset) => asset.assetId);
  assert.deepEqual(mah, ['tag:MAH001-10-01#dragon-mech-a/3', 'tag:MAH001-10-01#dragon-mech-b/3']);
  assert.equal(new Set(assets.map((asset) => asset.assetId)).size, assets.length);
});

test('a tag unique to the universe keeps a source-free id even beside a duplicate', () => {
  const { assets } = buildAssetCatalog(
    [
      { sourceId: 'dragon-mech-a', cache: mechanical },
      { sourceId: 'dragon-mech-b', cache: mechanicalTwin },
      { sourceId: 'dragon-controls', cache: controls },
    ],
    DRAGON_MAPPINGS,
    NO_FILTERS,
  );
  const plc = assets.filter((asset) => asset.canonicalTag === 'PLC001-10-01');
  assert.equal(plc.length, 1);
  assert.equal(plc[0].assetId, 'tag:PLC001-10-01');
  assert.equal(plc[0].status, 'MODEL_CONFIRMED');
});

/* ---------------------------------------------------------- the filters --- */

test('a source-model include is matched inside each source', () => {
  const { assets, impact } = buildAssetCatalog(
    [
      { sourceId: 'dragon-mechanical', cache: mechanical },
      { sourceId: 'dragon-controls', cache: controls },
    ],
    DRAGON_MAPPINGS,
    { ...NO_FILTERS, includedSourceModelFiles: ['Dragon-Controls.nwc'] },
  );
  // Only the controls source has that model, so the mechanical one contributes
  // nothing -- and says so, rather than the universe reporting one number.
  assert.equal(assets.length, 10);
  assert.equal(impact.bySource.get('dragon-mechanical').finalAssetCount, 0);
  assert.equal(impact.bySource.get('dragon-controls').finalAssetCount, 10);
  assert.deepEqual(stageCounts(impact.bySource.get('dragon-mechanical'))[0], [
    'source-model-files',
    51,
    51,
  ]);
});

test('stage counts are the sum of the sources, and the breakdown is kept', () => {
  const { impact } = buildAssetCatalog(
    [
      { sourceId: 'dragon-mechanical', cache: mechanical },
      { sourceId: 'dragon-controls', cache: controls },
    ],
    DRAGON_MAPPINGS,
    NO_FILTERS,
  );
  assert.deepEqual(stageCounts(impact), [
    ['source-model-files', 76, 0],
    ['classes', 76, 0],
    ['selection-sets', 76, 0],
    ['tag-presence', 76, 42],
    ['tag-patterns', 34, 0],
  ]);
  assert.equal(impact.totalObjects, 76);
  assert.equal(impact.bySource.get('dragon-mechanical').totalObjects, 51);
  assert.equal(impact.bySource.get('dragon-controls').totalObjects, 25);
  assert.equal(impact.untaggedDroppedCount, 42);
});

test('a selection set is resolved per source and its membership unioned', () => {
  // Splitting the MAH tags puts `Air Handling` in both files with different
  // members. Naming it has to mean both, not whichever source answered first.
  const mah001 = openSubset('mah001', { tagFilter: (tag) => tag.startsWith('MAH001') });
  const mah002 = openSubset('mah002', { tagFilter: (tag) => tag.startsWith('MAH002') });

  const { assets } = buildAssetCatalog(
    [
      { sourceId: 'dragon-mah-001', cache: mah001 },
      { sourceId: 'dragon-mah-002', cache: mah002 },
    ],
    DRAGON_MAPPINGS,
    { ...NO_FILTERS, selectionSetNames: ['Air Handling'] },
  );
  assert.equal(assets.length, 16, '12 MAH001 from one source and 4 MAH002 from the other');
});

test('a set only one source has is not an error', () => {
  const { assets } = buildAssetCatalog(
    [
      { sourceId: 'dragon-mechanical', cache: mechanical },
      { sourceId: 'dragon-controls', cache: controls },
    ],
    DRAGON_MAPPINGS,
    { ...NO_FILTERS, selectionSetNames: ['PLC Panels'] },
  );
  // Sets belong to the file that defines them; the mechanical source simply has
  // nothing to contribute.
  assert.equal(assets.length, 2);
  assert.ok(assets.every((asset) => asset.canonicalTag.startsWith('PLC')));
});

test('a set no source has is still the profile error it always was', () => {
  let failure = null;
  try {
    buildAssetCatalog(
      [
        { sourceId: 'dragon-mechanical', cache: mechanical },
        { sourceId: 'dragon-controls', cache: controls },
      ],
      DRAGON_MAPPINGS,
      { ...NO_FILTERS, selectionSetNames: ['Chilled Water'] },
    );
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof AssetCatalogConfigError);
  assert.equal(failure.reason.kind, 'unknown-selection-set');
  // The names offered are the union across sources, in source-id order then
  // traversal order: a person cannot fix a typo against one file when the
  // project reads several.
  assert.deepEqual(failure.reason.available, ['PLC Panels', 'Dragon Systems', 'Air Handling']);
});

test('a class filter is one rule for the whole universe', () => {
  const { assets, impact } = buildAssetCatalog(
    [
      { sourceId: 'dragon-mechanical', cache: mechanical },
      { sourceId: 'dragon-controls', cache: controls },
    ],
    DRAGON_MAPPINGS,
    { ...NO_FILTERS, requireTagProperty: false, excludedClasses: ['Solid', 'Terminal', 'Module'] },
  );
  assert.equal(assets.length, 40);
  assert.equal(impact.bySource.get('dragon-mechanical').finalAssetCount, 27);
  assert.equal(impact.bySource.get('dragon-controls').finalAssetCount, 13);
});

/* ------------------------------------------------------------- collapse --- */

test('collapse never reaches across a source boundary', () => {
  // The PLC modules are in the appended PLC model. Registering that model as a
  // source of its own puts the modules and their host in different caches, and
  // ancestry does not survive that: the modules stay their own assets.
  const host = openSubset('collapse-host', { sourceModels: [DRAGON_SOURCE_MODEL_IDS.controls] });
  const appended = openSubset('collapse-appended', {
    sourceModels: [DRAGON_SOURCE_MODEL_IDS.controlsPlc],
  });

  const filters = {
    requireTagProperty: false,
    collapseComponents: true,
    includedClasses: ['Equipment', 'Module'],
  };
  const split = buildAssetCatalog(
    [
      { sourceId: 'dragon-controls', cache: host },
      { sourceId: 'dragon-controls-plc', cache: appended },
    ],
    DRAGON_MAPPINGS,
    filters,
  );
  const together = buildAssetCatalog([{ sourceId: 'dragon', cache: controls }], DRAGON_MAPPINGS, filters);

  assert.equal(together.impact.collapsedCount, 4, 'one cache: the 4 modules collapse into 2 PLCs');
  assert.equal(split.impact.collapsedCount, 0, 'two caches: there is no ancestry to follow');
  assert.equal(split.assets.length, together.assets.length + 4);
  const plc = split.assets.find((asset) => asset.canonicalTag === 'PLC001-10-01');
  assert.deepEqual(plc.objectKeys, [{ sourceId: 'dragon-controls', objectId: 54 }]);
});

test('every object key of an asset names the source that asset came from', () => {
  const { assets } = buildAssetCatalog(
    [
      { sourceId: 'dragon-mechanical', cache: mechanical },
      { sourceId: 'dragon-controls', cache: controls },
    ],
    DRAGON_MAPPINGS,
    { requireTagProperty: false, collapseComponents: true, includedClasses: ['Equipment', 'Solid', 'Module'] },
  );
  for (const asset of assets) {
    assert.ok(asset.objectKeys.every((key) => key.sourceId === asset.sourceId), asset.assetId);
    assert.deepEqual(
      asset.objectIds,
      asset.objectKeys.map((key) => key.objectId),
      'the deprecated alias is the same list',
    );
  }
});

/* --------------------------------------------------- source assignments --- */

test('a source assignment fills a field the model left empty', () => {
  const source = {
    sourceId: 'dragon-controls',
    cache: controls,
    assignments: { nativeDiscipline: 'Controls' },
  };
  // Dragon's controls equipment carries no Service property at all, so this is
  // the case gate 6 exists for: a whole file whose discipline only the project
  // knows. Mapping a property changes nothing while no object states one.
  for (const mappings of [
    DRAGON_MAPPINGS,
    { ...DRAGON_MAPPINGS, nativeDiscipline: { category: 'Dragon Data', name: 'Service' } },
  ]) {
    const { assets } = buildAssetCatalog([source], mappings, NO_FILTERS);
    const plc = assets.find((asset) => asset.canonicalTag === 'PLC001-10-01');
    assert.equal(plc.nativeDiscipline, 'Controls');
    assert.deepEqual(plc.provenance.nativeDiscipline, {
      origin: 'source-assignment',
      sourceFile: 'Dragon-Controls.nwd',
      sourceRef: { kind: 'model-object', objectId: '54' },
      rule: 'source-assignment',
      objectId: 54,
    });
  }
});

test('an object property beats the assignment for the same field', () => {
  const mappings = {
    ...DRAGON_MAPPINGS,
    nativeDiscipline: { category: 'Dragon Data', name: 'Service' },
  };
  const { assets } = buildAssetCatalog(
    [
      {
        sourceId: 'dragon-mechanical',
        cache: mechanical,
        assignments: { building: 'ASSIGNED', nativeDiscipline: 'ASSIGNED' },
      },
    ],
    mappings,
    NO_FILTERS,
  );
  // MAH001 states both a Building and a Service in the model.
  const mah = assets.find((asset) => asset.canonicalTag === 'MAH001-10-01');
  assert.equal(mah.building, 'D1');
  assert.equal(mah.nativeDiscipline, 'Chilled Water');
  assert.equal(mah.provenance.building.origin, 'model-property');
  assert.equal(mah.provenance.nativeDiscipline.origin, 'model-property');

  // TIT states a Service property with no value, so there is nothing to beat.
  const tit = assets.find((asset) => asset.canonicalTag === 'TIT603-10-01');
  assert.equal(tit.nativeDiscipline, 'ASSIGNED');
  assert.equal(tit.provenance.nativeDiscipline.origin, 'source-assignment');
});

test('an assignment applies to its own source and to no other', () => {
  const { assets } = buildAssetCatalog(
    [
      {
        sourceId: 'dragon-controls',
        cache: controls,
        assignments: { nativeDiscipline: 'Controls' },
      },
      { sourceId: 'dragon-mechanical', cache: mechanical },
    ],
    { ...DRAGON_MAPPINGS, nativeDiscipline: { category: 'Dragon Data', name: 'Service' } },
    NO_FILTERS,
  );
  assert.equal(
    assets.find((asset) => asset.canonicalTag === 'PLC001-10-01').nativeDiscipline,
    'Controls',
  );
  assert.equal(
    assets.find((asset) => asset.canonicalTag === 'TIT603-10-01').nativeDiscipline,
    undefined,
    'the mechanical source assigns nothing, so the field stays missing',
  );
});

test('a blank assignment is not a value', () => {
  const { assets } = buildAssetCatalog(
    [{ sourceId: 'dragon-controls', cache: controls, assignments: { building: '   ' } }],
    TAG_ONLY_MAPPINGS,
    NO_FILTERS,
  );
  assert.ok(assets.every((asset) => asset.building === undefined));
});

test('custom assignments arrive as attributes, in key order, and never as fields', () => {
  const { assets } = buildAssetCatalog(
    [
      {
        sourceId: 'dragon-controls',
        cache: controls,
        assignments: {
          custom: new Map([
            ['package', 'P-104'],
            ['contractor', 'Wyvern Controls'],
          ]),
        },
      },
      { sourceId: 'dragon-mechanical', cache: mechanical },
    ],
    DRAGON_MAPPINGS,
    NO_FILTERS,
  );
  const plc = assets.find((asset) => asset.canonicalTag === 'PLC001-10-01');
  assert.deepEqual(
    [...plc.assignedAttributes.entries()],
    [
      ['contractor', 'Wyvern Controls'],
      ['package', 'P-104'],
    ],
  );
  const mah = assets.find((asset) => asset.canonicalTag === 'MAH001-10-01');
  assert.equal(mah.assignedAttributes.size, 0, 'a source that assigns nothing assigns nothing');
});

/* --------------------------------------------- the universe property catalog --- */

test('the universe catalog reports overall and per-source coverage', () => {
  const catalog = buildUniversePropertyCatalog([
    { sourceId: 'dragon-mechanical', cache: mechanical },
    { sourceId: 'dragon-controls', cache: controls },
  ]);
  const tag = catalog.find(
    (entry) => entry.category === 'Dragon Data' && entry.name === 'Tag',
  );
  // 34 of 76 objects across the universe carry a tag: 24 of the mechanical
  // source's 51, and 10 of the controls source's 25.
  assert.equal(tag.objectCount, 34);
  assert.equal(tag.objectFraction, 34 / 76);
  assert.deepEqual(
    [...tag.bySource.entries()].map(([sourceId, coverage]) => [
      sourceId,
      coverage.objectCount,
      coverage.sourceObjectCount,
    ]),
    [
      ['dragon-controls', 10, 25],
      ['dragon-mechanical', 24, 51],
    ],
  );
});

test('a property only one source carries is visibly absent from the other', () => {
  const catalog = buildUniversePropertyCatalog([
    { sourceId: 'dragon-mechanical', cache: mechanical },
    { sourceId: 'dragon-controls', cache: controls },
  ]);
  const firmware = catalog.find((entry) => entry.name === 'Firmware');
  // The overall number alone would read as "6% coverage, probably noise"; the
  // per-source breakdown is what says the mechanical file simply has none.
  assert.deepEqual([...firmware.bySource.keys()], ['dragon-controls']);
  assert.equal(firmware.bySource.get('dragon-controls').objectCount, 2);
});

test('the universe catalog keeps the source-model distribution inside a source', () => {
  const catalog = buildUniversePropertyCatalog([{ sourceId: 'dragon', cache: controls }]);
  const slot = catalog.find((entry) => entry.name === 'Slot');
  // Slot is only on the modules, which live in the appended PLC model.
  assert.deepEqual(
    [...slot.bySource.get('dragon').bySourceModel.keys()],
    [DRAGON_SOURCE_MODEL_IDS.controlsPlc],
  );
});

test('universe examples are ordered by source and then by object', () => {
  const catalog = buildUniversePropertyCatalog([
    { sourceId: 'a-controls', cache: controls },
    { sourceId: 'b-mechanical', cache: mechanical },
  ]);
  const shuffled = buildUniversePropertyCatalog([
    { sourceId: 'b-mechanical', cache: mechanical },
    { sourceId: 'a-controls', cache: controls },
  ]);
  assert.deepEqual(shuffled, catalog);

  const building = catalog.find(
    (entry) => entry.category === 'Dragon Data' && entry.name === 'Building',
  );
  assert.deepEqual([...building.exampleValues], ['D1', 'D2']);
  assert.equal(building.distinctValueCount, 2);
});

test('a universe with no sources is an empty catalog rather than a failure', () => {
  assert.deepEqual(buildUniversePropertyCatalog([]), []);
  const empty = buildAssetCatalog([], DRAGON_MAPPINGS, NO_FILTERS);
  assert.deepEqual(empty.assets, []);
  assert.deepEqual(empty.reviewItems, []);
  assert.equal(empty.impact.totalObjects, 0);
  assert.equal(empty.impact.bySource.size, 0);
  assert.deepEqual(stageCounts(empty.impact), [
    ['source-model-files', 0, 0],
    ['classes', 0, 0],
    ['selection-sets', 0, 0],
    ['tag-presence', 0, 0],
    ['tag-patterns', 0, 0],
  ]);
});

test('the asset shape is stable whichever way the site is split', () => {
  const federatedShape = assetShape(
    buildAssetCatalog([{ sourceId: 'dragon', cache: federated }], DRAGON_MAPPINGS, NO_FILTERS),
  );
  const splitShape = assetShape(
    buildAssetCatalog(
      [
        { sourceId: 'dragon-mechanical', cache: mechanical },
        { sourceId: 'dragon-controls', cache: controls },
      ],
      DRAGON_MAPPINGS,
      NO_FILTERS,
    ),
  );
  // Tags and ids agree; only the source each asset came from differs, which is
  // the provenance difference P0-1 excepts.
  assert.deepEqual(
    splitShape.map(([tag, assetId]) => [tag, assetId]),
    federatedShape.map(([tag, assetId]) => [tag, assetId]),
  );
  assert.deepEqual(new Set(federatedShape.map(([, , sourceId]) => sourceId)), new Set(['dragon']));
});
