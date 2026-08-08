import assert from 'node:assert/strict';
import test from 'node:test';

import { computeSequence, disciplinePolarity } from '../dist/index.js';
import {
  CROSS_GROUP_SNAPSHOT,
  DRAGON_ASSETS,
  DRAGON_SNAPSHOT,
  PARENT_CYCLE_SNAPSHOT,
  snapshotOf,
} from './dist/dragon.fixture.js';
import { reorder } from './support.mjs';

/** `{ assetId: sequence }`. */
function numbers(result) {
  return Object.fromEntries(result.sequences.map((entry) => [entry.assetId, entry.sequence]));
}

function assetsOf(...assetIds) {
  return DRAGON_ASSETS.filter((asset) => assetIds.includes(asset.assetId));
}

test('an electrical chain is numbered top-down: source before load', () => {
  const byAsset = numbers(computeSequence(DRAGON_SNAPSHOT, DRAGON_ASSETS));

  // GIS603-00-01 → XFM603-10-01 → PNL603-10-01 → VFD603-10-01
  assert.equal(byAsset['asset-0001'], 1);
  assert.equal(byAsset['asset-0002'], 2);
  assert.equal(byAsset['asset-0003'], 3);
  assert.equal(byAsset['asset-0004'], 4);
});

test('a mechanical chain is numbered bottom-up: every child before its parent', () => {
  const byAsset = numbers(computeSequence(DRAGON_SNAPSHOT, DRAGON_ASSETS));

  // TIT2201-20-03 → VFD2201-20-02 → MAH2201-20-01
  assert.equal(byAsset['asset-0012'], 1);
  assert.equal(byAsset['asset-0011'], 2);
  assert.equal(byAsset['asset-0010'], 3);
});

test('numbering restarts in every (building, discipline, system) group', () => {
  const result = computeSequence(DRAGON_SNAPSHOT, DRAGON_ASSETS);

  assert.deepEqual(
    result.groups.map((group) => [
      group.key.building,
      group.key.discipline,
      group.key.systemKey,
      group.polarity,
      group.assetIds,
    ]),
    [
      ['Dragon Screening', 'I&C', '777', 'bottom-up', ['asset-0030']],
      ['Dragon Screening', 'I&C', '900', 'bottom-up', ['asset-0040']],
      [
        'Dragon Utilities',
        'Electrical',
        '603',
        'top-down',
        ['asset-0001', 'asset-0002', 'asset-0003', 'asset-0004'],
      ],
      ['Dragon Utilities', 'I&C', '650', 'bottom-up', ['asset-0021', 'asset-0020']],
      [
        'Dragon Utilities',
        'Mechanical',
        '2201',
        'bottom-up',
        ['asset-0012', 'asset-0011', 'asset-0010'],
      ],
    ],
  );
  assert.equal(result.sequences.length, DRAGON_ASSETS.length);
  assert.deepEqual(result.unsequencedAssetIds, []);
});

test('a parent outside the asset own group is not a parent here — numbering stays group-scoped', () => {
  // The RIO's parent decision resolves onto the panel in system 603, which the
  // hard-boundary fold would never produce. The RIO still roots inside 650.
  const assets = assetsOf('asset-0001', 'asset-0002', 'asset-0003', 'asset-0004', 'asset-0020', 'asset-0021');
  const result = computeSequence(CROSS_GROUP_SNAPSHOT, assets);
  const byAsset = numbers(result);

  assert.equal(byAsset['asset-0004'], 4, 'the 603 chain is unaffected');
  assert.equal(byAsset['asset-0021'], 1, 'FMS650 numbers first in its own group');
  assert.equal(byAsset['asset-0020'], 2, 'the RIO roots in 650, not under the 603 panel');
  assert.deepEqual(
    result.groups.map((group) => group.key.systemKey),
    ['603', '650'],
  );
});

test('an asset the snapshot never mentions is numbered as a root of its group', () => {
  const result = computeSequence(snapshotOf([]), assetsOf('asset-0001', 'asset-0002'));

  assert.deepEqual(numbers(result), { 'asset-0001': 1, 'asset-0002': 2 });
});

test('a group whose parent links form a cycle has no root, and says so', () => {
  const assets = [
    { assetId: 'asset-0101', canonicalTag: 'PNL110-10-01', building: 'Dragon Utilities', discipline: 'Electrical', systemKey: '110' },
    { assetId: 'asset-0102', canonicalTag: 'PNL120-10-01', building: 'Dragon Utilities', discipline: 'Electrical', systemKey: '110' },
  ];
  const result = computeSequence(PARENT_CYCLE_SNAPSHOT, assets);

  assert.deepEqual(result.sequences, []);
  assert.deepEqual(result.unsequencedAssetIds, ['asset-0101', 'asset-0102']);
});

test('polarity: the donor default, and the per-discipline override', () => {
  assert.equal(disciplinePolarity('Electrical'), 'top-down');
  assert.equal(disciplinePolarity('LSS'), 'top-down');
  assert.equal(disciplinePolarity('Security'), 'top-down');
  // The donor's default pattern also matches Fire, which its own comment omits.
  assert.equal(disciplinePolarity('Fire Protection'), 'top-down');
  assert.equal(disciplinePolarity('Mechanical'), 'bottom-up');
  assert.equal(disciplinePolarity('I&C'), 'bottom-up');
  assert.equal(disciplinePolarity(''), 'bottom-up');

  assert.equal(disciplinePolarity('Electrical', { Electrical: 'bottom-up' }), 'bottom-up');
  assert.equal(disciplinePolarity('  Mechanical  ', { Mechanical: 'top-down' }), 'top-down');
});

test('an override flips a whole group without touching the tree', () => {
  const result = computeSequence(DRAGON_SNAPSHOT, DRAGON_ASSETS, {
    polarity: { Electrical: 'bottom-up' },
  });
  const byAsset = numbers(result);

  assert.equal(byAsset['asset-0004'], 1, 'the VFD is now commissioned first');
  assert.equal(byAsset['asset-0001'], 4, 'and the GIS last');
});

test('sequencing is deterministic under a reordered asset list', () => {
  const straight = computeSequence(DRAGON_SNAPSHOT, DRAGON_ASSETS);
  const shuffled = computeSequence(DRAGON_SNAPSHOT, reorder([...DRAGON_ASSETS]));

  assert.deepEqual(shuffled, straight);
});

test('siblings are ordered by tag, not by the order they arrive', () => {
  const parent = { assetId: 'asset-0300', canonicalTag: 'MAH400-20-01', building: 'B', discipline: 'Mechanical', systemKey: '400' };
  const siblings = [
    { assetId: 'asset-0303', canonicalTag: 'TIT400-20-10', building: 'B', discipline: 'Mechanical', systemKey: '400' },
    { assetId: 'asset-0302', canonicalTag: 'TIT400-20-02', building: 'B', discipline: 'Mechanical', systemKey: '400' },
  ];
  const snapshot = snapshotOf([
    { assetId: 'asset-0300', parent: { parentAssetId: null, ladderSource: null, status: 'root' }, dependencies: [], levelPath: [], losingClaims: [] },
    ...siblings.map((sibling) => ({
      assetId: sibling.assetId,
      parent: { parentAssetId: 'asset-0300', ladderSource: 'explicit-model', status: 'resolved' },
      dependencies: [],
      levelPath: [],
      losingClaims: [],
    })),
  ]);

  // -02 before -10: natural order, not the code-unit order that puts -10 first.
  assert.deepEqual(numbers(computeSequence(snapshot, [parent, ...siblings])), {
    'asset-0302': 1,
    'asset-0303': 2,
    'asset-0300': 3,
  });
});

test('empty inputs produce empty output', () => {
  const result = computeSequence(snapshotOf([]), []);

  assert.deepEqual(result.sequences, []);
  assert.deepEqual(result.groups, []);
  assert.deepEqual(result.unsequencedAssetIds, []);
});
