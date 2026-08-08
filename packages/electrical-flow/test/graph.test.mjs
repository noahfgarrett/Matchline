import assert from 'node:assert/strict';
import test from 'node:test';

import { buildIdentityIndex } from '@matchline/identity';

import { buildElectricalFlowFromIndex } from '../dist/index.js';
import {
  DRAGON_ALIASES,
  DRAGON_ASSETS,
  DRAGON_ENRICHMENT,
  DRAGON_OBSERVATIONS,
} from './dist/dragon.fixture.js';

function dragonFlow() {
  const index = buildIdentityIndex(DRAGON_ASSETS, DRAGON_ALIASES);
  return buildElectricalFlowFromIndex(DRAGON_OBSERVATIONS, index, DRAGON_ENRICHMENT);
}

test('a chain the model confirms becomes model-confirmed nodes keyed by asset id', () => {
  const flow = dragonFlow();

  for (const assetId of ['asset-0001', 'asset-0002', 'asset-0003', 'asset-0004', 'asset-0005']) {
    const node = flow.nodes.get(assetId);
    assert.ok(node, `${assetId} is a node`);
    assert.equal(node.matchStatus, 'model-confirmed');
    assert.equal(node.assetId, assetId);
  }

  assert.equal(flow.nodes.get('asset-0001').tag, 'UTL001-00-01');
  assert.equal(flow.nodes.get('asset-0001').identityTier, 'exact');
});

test('a tag no asset claims is a real node, visible and never model-authoritative', () => {
  const flow = dragonFlow();

  const bus = flow.nodes.get('tag:BUS-UNKNOWN-01');
  assert.ok(bus, 'the unknown bus mid-chain is kept as a node');
  assert.equal(bus.matchStatus, 'flow-only');
  assert.equal(bus.tag, 'BUS-UNKNOWN-01');
  // The whole point of §9.3: visible, promotable, and carrying no model claim.
  assert.equal(bus.assetId, undefined);
  assert.equal(bus.identityTier, undefined);
  assert.equal(bus.enrichment, undefined);

  // It really is mid-chain, not an orphan appended to the graph.
  assert.equal(bus.fedBy.length, 1);
  assert.equal(bus.fedBy[0].nodeId, 'asset-0003');
  assert.equal(bus.feeds.length, 1);
  assert.equal(bus.feeds[0].nodeId, 'asset-0004');
});

test('an instrument only the PMD knows is pmd-only; a matched one is confirmed', () => {
  const flow = dragonFlow();

  const sourceOnly = flow.nodes.get('tag:PIT001-10-09');
  assert.equal(sourceOnly.matchStatus, 'pmd-only');
  assert.equal(sourceOnly.assetId, undefined);
  assert.equal(sourceOnly.feeds.length, 0);
  assert.equal(sourceOnly.fedBy.length, 0);
  assert.equal(sourceOnly.pmdRelations.length, 1);
  assert.equal(sourceOnly.pmdRelations[0].nodeId, 'asset-0003');
  assert.equal(sourceOnly.pmdRelations[0].direction, 'incoming');

  const matched = flow.nodes.get('asset-0005');
  assert.equal(matched.matchStatus, 'model-confirmed');
  assert.equal(matched.pmdRelations.length, 1);

  // The panel lists both instruments, and neither is a feed.
  const panel = flow.nodes.get('asset-0003');
  assert.deepEqual(
    panel.pmdRelations.map((ref) => ref.nodeId),
    ['asset-0005', 'tag:PIT001-10-09'],
  );
  assert.ok(panel.pmdRelations.every((ref) => ref.direction === 'outgoing'));
});

test('two spellings of one asset merge into one node keeping both spellings', () => {
  const flow = dragonFlow();

  const panel = flow.nodes.get('asset-0003');
  assert.deepEqual(panel.evidenceTags, ['PANEL-1', 'PNL001-10-01']);
  // Exact beats alias, so the model's own spelling is the one displayed.
  assert.equal(panel.tag, 'PNL001-10-01');
  assert.equal(panel.identityTier, 'exact');
  assert.equal(flow.nodes.has('tag:PANEL-1'), false);
});

test('parallel cables stay two distinct edges between the same pair', () => {
  const flow = dragonFlow();

  const parallel = flow.edges.filter(
    (edge) => edge.fromNodeId === 'asset-0002' && edge.toNodeId === 'asset-0003',
  );
  assert.equal(parallel.length, 2);
  assert.deepEqual(
    parallel.map((edge) => edge.via),
    ['C-1001', 'C-1002'],
  );
  assert.notEqual(parallel[0].edgeId, parallel[1].edgeId);
  assert.equal(parallel[0].provenance.sourceRef.row, 2);
  assert.equal(parallel[1].provenance.sourceRef.row, 3);
});

test('edges are one per observation, ordered and identified deterministically', () => {
  const flow = dragonFlow();

  assert.equal(flow.edges.length, DRAGON_OBSERVATIONS.length);
  assert.deepEqual(
    flow.edges.map((edge) => [edge.edgeId, edge.fromNodeId, edge.toNodeId, edge.kind]),
    [
      ['edge-0001', 'asset-0001', 'asset-0002', 'feed'],
      ['edge-0002', 'asset-0002', 'asset-0003', 'feed'],
      ['edge-0003', 'asset-0002', 'asset-0003', 'feed'],
      ['edge-0004', 'asset-0003', 'asset-0004', 'feed'],
      ['edge-0005', 'asset-0003', 'asset-0005', 'pmd-relation'],
      ['edge-0006', 'asset-0003', 'tag:BUS-UNKNOWN-01', 'feed'],
      ['edge-0007', 'asset-0003', 'tag:PIT001-10-09', 'pmd-relation'],
      ['edge-0008', 'tag:BUS-UNKNOWN-01', 'asset-0004', 'feed'],
    ],
  );
});

test('a cross-source feed keeps the relationship type its source stated', () => {
  const flow = dragonFlow();

  const fromEasyPower = flow.edges.find((edge) => edge.sourceKind === 'easypower');
  assert.equal(fromEasyPower.relationshipType, 'POWERS');
  assert.equal(fromEasyPower.via, undefined);

  const fromCable = flow.edges.find((edge) => edge.via === 'C-1003');
  assert.equal(fromCable.sourceKind, 'cable-schedule');
  assert.equal(fromCable.relationshipType, 'WIRED_TO');
});

test('the node fed by nothing is the only root', () => {
  const flow = dragonFlow();
  assert.deepEqual(flow.roots, ['asset-0001']);
});

test('model enrichment attaches to matched nodes and nowhere else', () => {
  const flow = dragonFlow();

  const panel = flow.nodes.get('asset-0003');
  assert.equal(panel.enrichment.description, 'Dragon 480V distribution panel');
  assert.equal(panel.enrichment.building, 'Dragon Utilities');
  assert.equal(panel.enrichment.systemKey, '001');
  assert.equal(panel.enrichment.sourceModelFile, 'Dragon-Electrical.nwd');

  // A matched node with nothing supplied simply has none.
  assert.equal(flow.nodes.get('asset-0001').enrichment, undefined);
  // Enrichment for an asset nothing observed cannot invent a node.
  assert.equal(flow.nodes.has('asset-9999'), false);
});

test('the stats describe the graph that was built', () => {
  const flow = dragonFlow();

  assert.deepEqual(flow.stats, {
    nodeCount: 7,
    edgeCount: 8,
    modelConfirmedCount: 5,
    flowOnlyCount: 1,
    pmdOnlyCount: 1,
    // The panel (two parallel cables) and the VFD (two genuine feeders).
    multiFeedNodeCount: 2,
    cycleCount: 0,
  });
  assert.equal(flow.nodes.size, flow.stats.nodeCount);
});

test('a load reached two ways lists both feeders', () => {
  const flow = dragonFlow();

  const vfd = flow.nodes.get('asset-0004');
  assert.deepEqual(
    vfd.fedBy.map((ref) => [ref.nodeId, ref.edgeId, ref.direction]),
    [
      ['asset-0003', 'edge-0004', 'incoming'],
      ['tag:BUS-UNKNOWN-01', 'edge-0008', 'incoming'],
    ],
  );
  assert.equal(vfd.feeds.length, 0);
});

test('nodes iterate in code-unit ascending id order', () => {
  const flow = dragonFlow();
  assert.deepEqual(
    [...flow.nodes.keys()],
    [
      'asset-0001',
      'asset-0002',
      'asset-0003',
      'asset-0004',
      'asset-0005',
      'tag:BUS-UNKNOWN-01',
      'tag:PIT001-10-09',
    ],
  );
});
