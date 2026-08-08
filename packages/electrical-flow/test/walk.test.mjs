import assert from 'node:assert/strict';
import test from 'node:test';

import { buildIdentityIndex } from '@matchline/identity';

import { buildElectricalFlow, buildElectricalFlowFromIndex, walkSourceToLoad } from '../dist/index.js';
import { walkIds } from './support.mjs';
import {
  DRAGON_ALIASES,
  DRAGON_ASSETS,
  DRAGON_OBSERVATIONS,
  RING_OBSERVATIONS,
} from './dist/dragon.fixture.js';

function dragonFlow() {
  const index = buildIdentityIndex(DRAGON_ASSETS, DRAGON_ALIASES);
  return buildElectricalFlowFromIndex(DRAGON_OBSERVATIONS, index);
}

test('the walk goes source to load, depth first, children by node id', () => {
  const flow = dragonFlow();
  const visits = [...walkSourceToLoad(flow, 'asset-0001')];

  assert.deepEqual(
    visits.map((visit) => [visit.node.nodeId, visit.depth, visit.viaEdgeId]),
    [
      ['asset-0001', 0, undefined],
      ['asset-0002', 1, 'edge-0001'],
      ['asset-0003', 2, 'edge-0002'],
      ['asset-0004', 3, 'edge-0004'],
      ['tag:BUS-UNKNOWN-01', 3, 'edge-0006'],
    ],
  );
});

test('PMD relations are listed at each node and never walked into', () => {
  const flow = dragonFlow();
  const visits = [...walkSourceToLoad(flow, 'asset-0001')];

  const panel = visits.find((visit) => visit.node.nodeId === 'asset-0003');
  assert.deepEqual(
    panel.pmdRelations.map((ref) => ref.nodeId),
    ['asset-0005', 'tag:PIT001-10-09'],
  );

  // The instruments hang off the panel as badges; they are not rungs of the tree.
  const reached = walkIds(visits);
  assert.equal(reached.includes('asset-0005'), false);
  assert.equal(reached.includes('tag:PIT001-10-09'), false);
});

test('a node reachable two ways is visited once, under the first path', () => {
  const flow = dragonFlow();
  const reached = walkIds(walkSourceToLoad(flow, 'asset-0001'));

  assert.equal(reached.filter((nodeId) => nodeId === 'asset-0004').length, 1);
  assert.equal(new Set(reached).size, reached.length);
});

test('a ring feed terminates instead of unrolling', () => {
  const flow = buildElectricalFlow(RING_OBSERVATIONS, { outcomes: new Map() });
  const visits = [...walkSourceToLoad(flow, 'tag:RING-A')];

  assert.deepEqual(
    visits.map((visit) => [visit.node.nodeId, visit.depth]),
    [
      ['tag:RING-A', 0],
      ['tag:RING-B', 1],
      ['tag:RING-C', 2],
    ],
  );
});

test('walking from a leaf yields just the leaf, and from an unknown id nothing', () => {
  const flow = dragonFlow();

  assert.deepEqual(walkIds(walkSourceToLoad(flow, 'asset-0004')), ['asset-0004']);
  assert.deepEqual(walkIds(walkSourceToLoad(flow, 'asset-4242')), []);
});

test('the walk is an iterator, consumable one step at a time', () => {
  const flow = dragonFlow();
  const walk = walkSourceToLoad(flow, 'asset-0001');

  const first = walk.next();
  assert.equal(first.done, false);
  assert.equal(first.value.node.nodeId, 'asset-0001');
  assert.equal(walk.next().value.node.nodeId, 'asset-0002');
});
