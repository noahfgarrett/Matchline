import assert from 'node:assert/strict';
import test from 'node:test';

import { buildIdentityIndex } from '@matchline/identity';

import {
  buildElectricalFlow,
  buildElectricalFlowFromIndex,
  sourceStatusOf,
} from '../dist/index.js';
import { reorder, snapshot } from './support.mjs';
import {
  DRAGON_ALIASES,
  DRAGON_ASSETS,
  DRAGON_ENRICHMENT,
  DRAGON_OBSERVATIONS,
  FUZZY_ASSETS,
  FUZZY_OBSERVATIONS,
  MIXED_APPEARANCE_OBSERVATIONS,
} from './dist/dragon.fixture.js';

test('no observations produce an empty flow, not a broken one', () => {
  const flow = buildElectricalFlow([], { outcomes: new Map() });

  assert.equal(flow.nodes.size, 0);
  assert.deepEqual(flow.edges, []);
  assert.deepEqual(flow.roots, []);
  assert.deepEqual(flow.reviewItems, []);
  assert.deepEqual(flow.flowAnomalies, []);
  assert.deepEqual(flow.stats, {
    nodeCount: 0,
    edgeCount: 0,
    modelConfirmedCount: 0,
    flowOnlyCount: 0,
    pmdOnlyCount: 0,
    multiFeedNodeCount: 0,
    cycleCount: 0,
  });
});

test('an empty identity universe leaves every tag visible as source-only', () => {
  const flow = buildElectricalFlow(DRAGON_OBSERVATIONS, { outcomes: new Map() });

  assert.equal(flow.stats.modelConfirmedCount, 0);
  assert.equal(flow.nodes.size, 8);
  assert.ok([...flow.nodes.values()].every((node) => node.assetId === undefined));
  // Nothing was dropped for failing to match.
  assert.equal(flow.edges.length, DRAGON_OBSERVATIONS.length);
});

test('a tag seen in both a feed and the PMD is flow-only, feed presence dominating', () => {
  const flow = buildElectricalFlow(MIXED_APPEARANCE_OBSERVATIONS, { outcomes: new Map() });

  assert.equal(flow.nodes.get('tag:JB001-10-05').matchStatus, 'flow-only');
  assert.equal(flow.nodes.get('tag:SRC001-10-01').matchStatus, 'flow-only');
  assert.equal(flow.nodes.get('tag:PIT001-10-09').matchStatus, 'pmd-only');
  assert.equal(flow.stats.flowOnlyCount, 2);
  assert.equal(flow.stats.pmdOnlyCount, 1);
});

test('identity can be supplied as a function instead of a map', () => {
  const index = buildIdentityIndex(DRAGON_ASSETS, DRAGON_ALIASES);
  const viaIndex = buildElectricalFlowFromIndex(DRAGON_OBSERVATIONS, index, DRAGON_ENRICHMENT);

  const outcomes = new Map(
    [...viaIndex.nodes.values()].flatMap((node) =>
      node.assetId === undefined
        ? []
        : node.evidenceTags.map((tag) => [
            tag,
            { status: 'matched', evidenceTag: tag, assetId: node.assetId, tier: 'exact', detail: '' },
          ]),
    ),
  );
  const viaFunction = buildElectricalFlow(
    DRAGON_OBSERVATIONS,
    { outcomes: (tag) => outcomes.get(tag) },
    DRAGON_ENRICHMENT,
  );

  // Same asset ids, so the same graph -- only the recorded tiers differ.
  assert.deepEqual([...viaFunction.nodes.keys()], [...viaIndex.nodes.keys()]);
  assert.deepEqual(viaFunction.edges, viaIndex.edges);
  assert.deepEqual(viaFunction.stats, viaIndex.stats);
});

test('a tag with no outcome at all is treated as unmatched, not as an error', () => {
  const flow = buildElectricalFlow(DRAGON_OBSERVATIONS, { outcomes: () => undefined });

  assert.equal(flow.stats.modelConfirmedCount, 0);
  assert.equal(flow.nodes.get('tag:UTL001-00-01').matchStatus, 'flow-only');
});

test('identity review items are carried onto the flow untouched', () => {
  const index = buildIdentityIndex(FUZZY_ASSETS);
  const flow = buildElectricalFlowFromIndex(FUZZY_OBSERVATIONS, index);

  assert.equal(flow.reviewItems.length, 1);
  assert.equal(flow.reviewItems[0].kind, 'fuzzy-identity');
  assert.equal(flow.reviewItems[0].evidenceTag, 'VFD001-10-02');

  // A proposal is never a match: the near-miss stays its own node.
  assert.equal(flow.nodes.get('tag:VFD001-10-02').matchStatus, 'flow-only');
  assert.equal(flow.nodes.get('tag:VFD001-10-02').assetId, undefined);
  assert.deepEqual(flow.flowAnomalies, []);
});

test('the projection does not depend on the order observations arrive in', () => {
  const index = buildIdentityIndex(DRAGON_ASSETS, DRAGON_ALIASES);
  const original = buildElectricalFlowFromIndex(DRAGON_OBSERVATIONS, index, DRAGON_ENRICHMENT);

  const shuffled = buildElectricalFlowFromIndex(
    reorder(DRAGON_OBSERVATIONS),
    index,
    DRAGON_ENRICHMENT,
  );
  const reversed = buildElectricalFlowFromIndex(
    [...DRAGON_OBSERVATIONS].reverse(),
    index,
    DRAGON_ENRICHMENT,
  );

  assert.equal(snapshot(shuffled), snapshot(original));
  assert.equal(snapshot(reversed), snapshot(original));
});

test('match statuses name the §9.3 states they stand for', () => {
  assert.equal(sourceStatusOf('model-confirmed'), 'MODEL_CONFIRMED');
  assert.equal(sourceStatusOf('flow-only'), 'FLOW_ONLY');
  assert.equal(sourceStatusOf('pmd-only'), 'PMD_ONLY');
});
