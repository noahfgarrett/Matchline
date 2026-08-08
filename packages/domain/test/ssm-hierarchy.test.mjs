import assert from 'node:assert/strict';
import test from 'node:test';

import { LADDER_SOURCE_ORDER, relationshipKindOf } from '../dist/index.js';
import {
  DRAGON_HIERARCHY,
  DRAGON_LADDER,
  DRAGON_MANUAL_OVERRIDES,
  DRAGON_ROLE_GRAPH,
  DRAGON_SNAPSHOT,
} from './dist/ssm-hierarchy.fixture.js';

test('the default ladder is the §11.1 order, strongest rung first', () => {
  assert.deepEqual(LADDER_SOURCE_ORDER, [
    'manual',
    'explicit-model',
    'profile-lookup',
    'flow-family',
    'family-role',
    'learned-description',
    'prior-ssm',
    'model-tree',
  ]);
});

test('a site disables a rung by leaving it out, and the rest keep their order', () => {
  assert.equal(DRAGON_LADDER.tiers.includes('learned-description'), false);
  assert.equal(DRAGON_LADDER.tiers.length, LADDER_SOURCE_ORDER.length - 1);
  const positions = DRAGON_LADDER.tiers.map((tier) => LADDER_SOURCE_ORDER.indexOf(tier));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions);
});

test('the role graph states each nesting once and in one direction', () => {
  assert.deepEqual(
    DRAGON_ROLE_GRAPH.rules.map((rule) => `${rule.parentRole}>${rule.childRole}`),
    ['MAH>PLC', 'PLC>VFD', 'VFD>TIT'],
  );
});

test('a manual override can name a parent or explicitly root an asset', () => {
  const [nested, rooted] = DRAGON_MANUAL_OVERRIDES;
  assert.equal(nested.parentAssetId, 'asset-0003');
  assert.equal(rooted.parentAssetId, null);
  assert.equal('parentAssetId' in rooted, true);
});

test('every hierarchy level states its own boundary and missing-value policy', () => {
  assert.deepEqual(
    DRAGON_HIERARCHY.levels.map((level) => level.levelId),
    ['building', 'ssm-discipline', 'system'],
  );
  assert.equal(
    DRAGON_HIERARCHY.levels.every((level) => level.boundary),
    true,
  );
  assert.deepEqual(
    DRAGON_HIERARCHY.levels.map((level) => level.missingValuePolicy),
    ['review', 'unassigned-group', 'provisional-root'],
  );
});

test('a resolved parent carries the claim and the rung that won the slot', () => {
  const node = DRAGON_SNAPSHOT.nodes.get('asset-0002');
  assert.equal(node.parent.status, 'resolved');
  assert.equal(node.parent.parentAssetId, 'asset-0001');
  assert.equal(node.parent.ladderSource, 'flow-family');
  assert.equal(node.parent.winningClaim.ladderSource, 'flow-family');
  assert.equal(node.parent.winningClaim.subjectAssetId, 'asset-0002');
  assert.equal(node.parent.winningClaim.targetAssetId, 'asset-0001');
  assert.equal(relationshipKindOf(node.parent.winningClaim.relationshipType), 'structural-parent');
});

test('a losing claim is retained on the node rather than discarded', () => {
  const node = DRAGON_SNAPSHOT.nodes.get('asset-0002');
  assert.equal(node.losingClaims.length, 1);
  assert.equal(node.losingClaims[0].ladderSource, 'family-role');
  assert.equal(node.losingClaims[0].targetAssetId, 'asset-0007');
});

test('a root states a null parent and no winning claim, by decision', () => {
  const node = DRAGON_SNAPSHOT.nodes.get('asset-0001');
  assert.equal(node.parent.status, 'root');
  assert.equal(node.parent.parentAssetId, null);
  assert.equal(node.parent.ladderSource, null);
  assert.equal('winningClaim' in node.parent, false);
});

test('a boundary demotion keeps the removed parent as a visible dependency', () => {
  const node = DRAGON_SNAPSHOT.nodes.get('asset-0650');
  assert.equal(node.parent.parentAssetId, null);
  assert.deepEqual(node.parent.demotedFrom, {
    parentAssetId: 'asset-0603',
    boundaryLevelId: 'system',
  });
  assert.deepEqual(
    node.dependencies.map((dependency) => dependency.parentAssetId),
    ['asset-0603'],
  );
  assert.equal(node.dependencies[0].relationshipType, 'POWERS');
});

test('an asset the compiler refused to place is unresolved, not rooted', () => {
  const node = DRAGON_SNAPSHOT.nodes.get('asset-0009');
  assert.equal(node.parent.status, 'unresolved');
  assert.deepEqual(node.levelPath, []);
  assert.deepEqual(DRAGON_SNAPSHOT.reviewItems, [
    { kind: 'missing-boundary', assetId: 'asset-0009', levelId: 'building' },
  ]);
});

test('snapshot stats agree with the nodes they count', () => {
  const nodes = [...DRAGON_SNAPSHOT.nodes.values()];
  assert.equal(DRAGON_SNAPSHOT.stats.nodeCount, nodes.length);
  assert.equal(
    DRAGON_SNAPSHOT.stats.rootCount,
    nodes.filter((node) => node.parent.status === 'root').length,
  );
  assert.equal(
    DRAGON_SNAPSHOT.stats.unresolvedCount,
    nodes.filter((node) => node.parent.status === 'unresolved').length,
  );
  assert.equal(
    DRAGON_SNAPSHOT.stats.demotedToDependencyCount,
    nodes.filter((node) => node.parent.demotedFrom !== undefined).length,
  );
});
