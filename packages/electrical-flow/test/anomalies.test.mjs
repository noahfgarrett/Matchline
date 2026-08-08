import assert from 'node:assert/strict';
import test from 'node:test';

import { buildIdentityIndex } from '@matchline/identity';

import { buildElectricalFlow, buildElectricalFlowFromIndex } from '../dist/index.js';
import { snapshot } from './support.mjs';
import {
  CHORDED_RING_OBSERVATIONS,
  DRAGON_ALIASES,
  PMD_SELF_LOOP_OBSERVATIONS,
  RING_OBSERVATIONS,
  SELF_LOOP_ASSETS,
  SELF_LOOP_OBSERVATIONS,
  TWO_RINGS_OBSERVATIONS,
} from './dist/dragon.fixture.js';

test('two spellings of one asset feeding each other drop the edge and report it', () => {
  const index = buildIdentityIndex(SELF_LOOP_ASSETS, DRAGON_ALIASES);
  const flow = buildElectricalFlowFromIndex(SELF_LOOP_OBSERVATIONS, index);

  assert.equal(flow.edges.length, 0);
  assert.equal(flow.stats.edgeCount, 0);
  assert.equal(flow.nodes.size, 1);

  // The node survives the edge: the panel was observed, whatever the row meant.
  const panel = flow.nodes.get('asset-0003');
  assert.deepEqual(panel.evidenceTags, ['PANEL-1', 'PNL001-10-01']);
  assert.equal(panel.feeds.length, 0);
  assert.equal(panel.fedBy.length, 0);
  assert.deepEqual(flow.roots, []);

  assert.equal(flow.flowAnomalies.length, 1);
  const anomaly = flow.flowAnomalies[0];
  assert.equal(anomaly.kind, 'self-loop');
  assert.equal(anomaly.nodeId, 'asset-0003');
  assert.equal(anomaly.fromTag, 'PANEL-1');
  assert.equal(anomaly.toTag, 'PNL001-10-01');
  assert.equal(anomaly.edgeKind, 'feed');
  assert.equal(anomaly.sourceKind, 'cable-schedule');
  assert.equal(anomaly.provenance.sourceRef.row, 9);
});

test('a ring feed keeps every edge and is reported once, by a stable path', () => {
  const flow = buildElectricalFlow(RING_OBSERVATIONS, { outcomes: new Map() });

  // A ring is a real arrangement (§10 alternate feeds): nothing is pruned.
  assert.equal(flow.edges.length, 3);
  assert.equal(flow.stats.edgeCount, 3);
  assert.equal(flow.stats.cycleCount, 1);
  assert.deepEqual(flow.roots, []);

  const cycles = flow.flowAnomalies.filter((anomaly) => anomaly.kind === 'cycle');
  assert.equal(cycles.length, 1);
  assert.deepEqual(cycles[0].path, ['tag:RING-A', 'tag:RING-B', 'tag:RING-C']);
});

test('the cycle path does not depend on which edge the observations listed first', () => {
  const forward = buildElectricalFlow(RING_OBSERVATIONS, { outcomes: new Map() });
  const rotated = buildElectricalFlow(
    [RING_OBSERVATIONS[1], RING_OBSERVATIONS[2], RING_OBSERVATIONS[0]],
    { outcomes: new Map() },
  );
  const reversed = buildElectricalFlow([...RING_OBSERVATIONS].reverse(), {
    outcomes: new Map(),
  });

  assert.equal(snapshot(rotated), snapshot(forward));
  assert.equal(snapshot(reversed), snapshot(forward));
});

test('a PMD relation that collapses onto one node is dropped the same way', () => {
  const index = buildIdentityIndex(SELF_LOOP_ASSETS, DRAGON_ALIASES);
  const flow = buildElectricalFlowFromIndex(PMD_SELF_LOOP_OBSERVATIONS, index);

  assert.equal(flow.edges.length, 0);
  assert.equal(flow.nodes.get('asset-0003').pmdRelations.length, 0);
  assert.equal(flow.flowAnomalies[0].kind, 'self-loop');
  assert.equal(flow.flowAnomalies[0].edgeKind, 'pmd-relation');
  assert.equal(flow.flowAnomalies[0].sourceKind, 'pmd');
});

test('a component holding several loops is reported once, by its shortest', () => {
  const flow = buildElectricalFlow(CHORDED_RING_OBSERVATIONS, { outcomes: new Map() });

  assert.equal(flow.edges.length, 5);
  assert.equal(flow.stats.cycleCount, 1);
  // The fourth node is inside the component but not on the shortest loop
  // through the smallest node id: one named loop is what a reviewer can act on.
  assert.deepEqual(flow.flowAnomalies[0].path, ['tag:RING-A', 'tag:RING-B', 'tag:RING-C']);
  assert.equal(flow.nodes.has('tag:RING-D'), true);
});

test('two independent rings are two anomalies, ordered by path', () => {
  const flow = buildElectricalFlow(TWO_RINGS_OBSERVATIONS, { outcomes: new Map() });

  assert.equal(flow.stats.cycleCount, 2);
  assert.deepEqual(
    flow.flowAnomalies.map((anomaly) => anomaly.path),
    [
      ['tag:RING-A', 'tag:RING-B', 'tag:RING-C'],
      ['tag:RING-X', 'tag:RING-Y'],
    ],
  );
});

test('self-loops are reported before cycles', () => {
  const index = buildIdentityIndex(SELF_LOOP_ASSETS, DRAGON_ALIASES);
  const flow = buildElectricalFlowFromIndex(
    [...SELF_LOOP_OBSERVATIONS, ...RING_OBSERVATIONS],
    index,
  );

  assert.deepEqual(
    flow.flowAnomalies.map((anomaly) => anomaly.kind),
    ['self-loop', 'cycle'],
  );
  assert.equal(flow.stats.cycleCount, 1);
  assert.equal(flow.stats.edgeCount, 3);
});

test('a chain that does not close reports no cycle', () => {
  const flow = buildElectricalFlow([RING_OBSERVATIONS[0], RING_OBSERVATIONS[1]], {
    outcomes: new Map(),
  });

  assert.equal(flow.stats.cycleCount, 0);
  assert.deepEqual(flow.flowAnomalies, []);
  assert.deepEqual(flow.roots, ['tag:RING-A']);
});
