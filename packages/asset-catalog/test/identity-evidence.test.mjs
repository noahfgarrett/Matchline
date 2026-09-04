/**
 * The durable identity evidence every asset carries (RELEASE-1.0-PLAN P0-9).
 *
 * The catalog's own `assetId` is content-derived and always will be -- that is
 * the right answer for one compile. What P0-9 needs on top of it is what the
 * MODEL says about which object this is, published verbatim so
 * `@matchline/asset-identity` can tie two compiles together. This file pins that
 * reading: which object it is about, where the source model's persistent id
 * comes from, and that nothing content-derived leaks into it.
 */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { buildAssetCatalog } from '../dist/index.js';
import { openExtractionCache } from '../../model-schema/dist/index.js';

import { DRAGON_MAPPINGS, makeTempDirectory, NO_FILTERS, writeSyntheticCache } from './support.mjs';

const MODEL_GUID = '00000000-0000-4000-8000-000000001001';

/** The same decisions as `NO_FILTERS`, with component collapse switched on. */
const COLLAPSE_FILTERS = { requireTagProperty: true, collapseComponents: true };

let directory = '';
const open = [];

/** One cache, built for one assertion, closed with the suite. */
function cacheOf(label, content) {
  const path = join(directory, `${label}.sqlite`);
  writeSyntheticCache(path, content);
  const cache = openExtractionCache(path);
  open.push(cache);
  return cache;
}

before(() => {
  directory = makeTempDirectory('identity-evidence');
});

after(() => {
  for (const cache of open) {
    cache.close();
  }
  rmSync(directory, { recursive: true, force: true });
});

/** A tagged object at the bottom of a three-deep tree. */
function nestedEquipment(overrides = {}) {
  return {
    sourceModels: [
      {
        id: 1,
        parentId: null,
        fileName: 'Dragon-Mechanical.nwc',
        displayName: 'Mechanical',
        guid: MODEL_GUID,
        ...(overrides.sourceModel ?? {}),
      },
    ],
    objects: [
      { id: 1, parentId: null, pathIndex: 0, depth: 0, displayName: 'Dragon', className: 'File' },
      { id: 2, parentId: 1, pathIndex: 3, depth: 1, displayName: 'D1', className: 'Layer' },
      {
        id: 3,
        parentId: 2,
        pathIndex: 7,
        depth: 2,
        displayName: 'MAH001-10-01',
        className: 'Equipment',
        instanceGuid: '00000000-0000-4000-8000-000000000003',
        authoringId: 'id-MAH001-10-01',
        ...(overrides.equipment ?? {}),
      },
    ],
    properties: [
      { objectId: 3, category: 'Dragon Data', name: 'Tag', valueText: 'MAH001-10-01' },
    ],
  };
}

test('an asset carries its representative object`s ids, class and position', () => {
  const { assets } = buildAssetCatalog(cacheOf('nested', nestedEquipment()), DRAGON_MAPPINGS, NO_FILTERS);
  const asset = assets.find((candidate) => candidate.canonicalTag === 'MAH001-10-01');

  assert.deepEqual(asset.identityEvidence, {
    sourceModelPersistentId: MODEL_GUID,
    instanceGuid: '00000000-0000-4000-8000-000000000003',
    authoringId: 'id-MAH001-10-01',
    // Which authoring system issued that id: part of the evidence, because two
    // systems can number an object the same.
    authoringIdKind: 'revit-element-id',
    // Root first, the object itself last: sibling positions, not object ids.
    structuralPath: [0, 3, 7],
    className: 'Equipment',
    // The extractor's own digest of the ancestor chain, published verbatim.
    structuralKey: '3'.padStart(64, 'b'),
  });
});

test('the source model persistent id is the GUID, and its file name only as a fallback', () => {
  const named = buildAssetCatalog(
    cacheOf('no-guid', nestedEquipment({ sourceModel: { guid: null } })),
    DRAGON_MAPPINGS,
    NO_FILTERS,
  );
  assert.equal(
    named.assets[0].identityEvidence.sourceModelPersistentId,
    'Dragon-Mechanical.nwc',
  );

  const anonymous = buildAssetCatalog(
    cacheOf('anonymous', nestedEquipment({ sourceModel: { guid: null, fileName: null } })),
    DRAGON_MAPPINGS,
    NO_FILTERS,
  );
  assert.equal(anonymous.assets[0].identityEvidence.sourceModelPersistentId, null);
});

test('an object the model states nothing about is evidence that it states nothing', () => {
  const { assets } = buildAssetCatalog(
    cacheOf('bare', nestedEquipment({ equipment: { instanceGuid: null, authoringId: null } })),
    DRAGON_MAPPINGS,
    NO_FILTERS,
  );
  const evidence = assets[0].identityEvidence;
  assert.equal(evidence.instanceGuid, null);
  assert.equal(evidence.authoringId, null);
  // The position in the tree is what is left, and it is always there.
  assert.deepEqual(evidence.structuralPath, [0, 3, 7]);
});

test('a collapsed component`s ids never become the asset`s: the representative answers', () => {
  const cache = cacheOf('collapsed', {
    sourceModels: [
      { id: 1, parentId: null, fileName: 'Dragon-Mechanical.nwc', guid: MODEL_GUID },
    ],
    objects: [
      {
        id: 1,
        parentId: null,
        pathIndex: 0,
        depth: 0,
        displayName: 'SKD001-10-01',
        className: 'Equipment',
        instanceGuid: 'guid-skid',
        authoringId: 'id-skid',
      },
      {
        id: 2,
        parentId: 1,
        pathIndex: 0,
        depth: 1,
        displayName: 'PMP001-10-01',
        className: 'Equipment',
        instanceGuid: 'guid-pump',
        authoringId: 'id-pump',
      },
    ],
    properties: [
      { objectId: 1, category: 'Dragon Data', name: 'Tag', valueText: 'SKD001-10-01' },
      { objectId: 2, category: 'Dragon Data', name: 'Tag', valueText: 'PMP001-10-01' },
    ],
  });

  const { assets } = buildAssetCatalog(cache, DRAGON_MAPPINGS, COLLAPSE_FILTERS);
  assert.equal(assets.length, 1, 'the pump was absorbed into the skid');
  assert.equal(assets[0].identityEvidence.instanceGuid, 'guid-skid');
  assert.equal(assets[0].identityEvidence.authoringId, 'id-skid');
});
