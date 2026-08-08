import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { buildAssetCatalog } from '../dist/index.js';
import { openExtractionCache } from '../../model-schema/dist/index.js';
import { writeDragonFixture } from '../../model-schema/dist/fixtures/dragon.js';

import { DRAGON_MAPPINGS, makeTempDirectory, TAG_ONLY_MAPPINGS, writeSyntheticCache } from './support.mjs';

/**
 * A chain built to exercise collapse and nothing else:
 *
 *   1 File "Model"            (no tag, never a candidate)
 *   2   Equipment "A"         tag ASSY-01
 *   3     Assembly "B"        tag ASSY-01-B
 *   4       Part "C"          tag ASSY-01-C
 *   5         Solid           (no tag)
 *   6     Layer "X"           (no tag -- a gap in the candidate chain)
 *   7       Equipment "D"     tag ASSY-01-D
 *
 * With every tagged object a candidate, B and C collapse into A through each
 * other, and D collapses into A across the untagged Layer between them.
 */
const CHAIN = {
  objects: [
    { id: 1, parentId: null, pathIndex: 0, depth: 0, displayName: 'Model', className: 'File' },
    { id: 2, parentId: 1, pathIndex: 0, depth: 1, displayName: 'A', className: 'Equipment' },
    { id: 3, parentId: 2, pathIndex: 0, depth: 2, displayName: 'B', className: 'Assembly' },
    { id: 4, parentId: 3, pathIndex: 0, depth: 3, displayName: 'C', className: 'Part' },
    { id: 5, parentId: 4, pathIndex: 0, depth: 4, displayName: 'Solid', className: 'Solid' },
    { id: 6, parentId: 2, pathIndex: 1, depth: 2, displayName: 'X', className: 'Layer' },
    { id: 7, parentId: 6, pathIndex: 0, depth: 3, displayName: 'D', className: 'Equipment' },
  ],
  properties: [
    { objectId: 2, category: 'Dragon Data', name: 'Tag', valueText: 'ASSY-01' },
    { objectId: 3, category: 'Dragon Data', name: 'Tag', valueText: 'ASSY-01-B' },
    { objectId: 4, category: 'Dragon Data', name: 'Tag', valueText: 'ASSY-01-C' },
    { objectId: 7, category: 'Dragon Data', name: 'Tag', valueText: 'ASSY-01-D' },
  ],
};

const COLLAPSING = { requireTagProperty: true, collapseComponents: true };

let directory = '';
let dragon = null;
let chain = null;

before(() => {
  directory = makeTempDirectory('collapse');
  const dragonPath = join(directory, 'dragon.sqlite');
  writeDragonFixture(dragonPath);
  dragon = openExtractionCache(dragonPath);

  const chainPath = join(directory, 'chain.sqlite');
  writeSyntheticCache(chainPath, CHAIN);
  chain = openExtractionCache(chainPath);
});

after(() => {
  dragon?.close();
  chain?.close();
  rmSync(directory, { recursive: true, force: true });
});

test('collapse absorbs a whole chain into its topmost candidate', () => {
  const { assets, impact } = buildAssetCatalog(chain, TAG_ONLY_MAPPINGS, COLLAPSING);
  assert.equal(assets.length, 1);
  assert.equal(assets[0].canonicalTag, 'ASSY-01');
  assert.deepEqual(assets[0].objectIds, [2, 3, 4, 7]);
  assert.equal(impact.collapsedCount, 3);
  assert.equal(impact.finalAssetCount, 1);
});

test('a separately commissionable class escapes collapse and keeps its own components', () => {
  const { assets, impact } = buildAssetCatalog(chain, TAG_ONLY_MAPPINGS, {
    ...COLLAPSING,
    separatelyCommissionableClasses: ['Assembly'],
  });
  assert.deepEqual(
    assets.map((asset) => [asset.canonicalTag, asset.objectIds]),
    [
      // D still reaches A: B escaping does not put itself between them.
      ['ASSY-01', [2, 7]],
      ['ASSY-01-B', [3, 4]],
    ],
  );
  assert.equal(impact.collapsedCount, 2);
});

test('a separately commissionable class named at the top of a chain changes nothing', () => {
  const { assets, impact } = buildAssetCatalog(chain, TAG_ONLY_MAPPINGS, {
    ...COLLAPSING,
    separatelyCommissionableClasses: ['Equipment'],
  });
  // A was never absorbed, and D escapes into an asset of its own.
  assert.deepEqual(
    assets.map((asset) => [asset.canonicalTag, asset.objectIds]),
    [
      ['ASSY-01', [2, 3, 4]],
      ['ASSY-01-D', [7]],
    ],
  );
  assert.equal(impact.collapsedCount, 2);
});

test('collapseComponents false leaves every candidate its own asset', () => {
  const { assets, impact } = buildAssetCatalog(chain, TAG_ONLY_MAPPINGS, {
    ...COLLAPSING,
    collapseComponents: false,
  });
  assert.deepEqual(
    assets.map((asset) => asset.objectIds),
    [[2], [3], [4], [7]],
  );
  assert.equal(impact.collapsedCount, 0);
});

test('an object outside the candidate set never joins an asset', () => {
  const { assets } = buildAssetCatalog(chain, TAG_ONLY_MAPPINGS, COLLAPSING);
  const objectIds = assets.flatMap((asset) => asset.objectIds);
  // The untagged File, Layer and Solid are not candidates, so collapse has no
  // reason to pull them in: an asset is made of candidates only.
  assert.deepEqual(objectIds, [2, 3, 4, 7]);
});

test('Dragon geometry and modules collapse into the equipment they belong to', () => {
  const { assets, impact } = buildAssetCatalog(dragon, DRAGON_MAPPINGS, {
    requireTagProperty: false,
    collapseComponents: true,
    includedClasses: ['Equipment', 'Solid', 'Module', 'Terminal'],
  });
  // 34 Equipment + 24 Solids + 4 Modules + 8 Terminals = 70 candidates; the 36
  // components all have an Equipment ancestor.
  assert.equal(impact.collapsedCount, 36);
  assert.equal(assets.length, 34);
  const plc = assets.find((asset) => asset.canonicalTag === 'PLC001-10-01');
  assert.deepEqual(plc.objectIds, [54, 55, 56]);
});

test('a collapsed component keeps its own source model out of the asset record', () => {
  const { assets } = buildAssetCatalog(dragon, DRAGON_MAPPINGS, {
    requireTagProperty: false,
    collapseComponents: true,
    includedClasses: ['Equipment', 'Module'],
  });
  const plc = assets.find((asset) => asset.canonicalTag === 'PLC001-10-01');
  // The PLC is in Dragon-Controls.nwc; its modules are in the nested PLC model.
  assert.equal(plc.sourceModelId, 2);
  assert.equal(dragon.object(55).sourceModelId, 3);
});

test('separately commissionable Dragon modules stay their own assets', () => {
  const { assets, impact } = buildAssetCatalog(dragon, DRAGON_MAPPINGS, {
    requireTagProperty: false,
    collapseComponents: true,
    includedClasses: ['Equipment', 'Solid', 'Module', 'Terminal'],
    separatelyCommissionableClasses: ['Module'],
  });
  assert.equal(impact.collapsedCount, 32);
  assert.equal(assets.length, 38);
  assert.equal(assets.filter((asset) => asset.canonicalTag === '').length, 4);
});

test('collapse of tagged equipment alone is a no-op on Dragon', () => {
  const collapsed = buildAssetCatalog(dragon, DRAGON_MAPPINGS, {
    requireTagProperty: true,
    collapseComponents: true,
  });
  const flat = buildAssetCatalog(dragon, DRAGON_MAPPINGS, {
    requireTagProperty: true,
    collapseComponents: false,
  });
  // No tagged Dragon object is an ancestor of another, so there is nothing to
  // absorb: turning collapse on must not change the answer.
  assert.deepEqual(collapsed.assets, flat.assets);
  assert.equal(collapsed.impact.collapsedCount, 0);
});
