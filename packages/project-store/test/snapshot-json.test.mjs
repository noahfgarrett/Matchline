import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import {
  canonicalJson,
  createProject,
  deserializeSnapshot,
  ProjectStoreError,
  serializeSnapshot,
} from '../dist/index.js';

import { dragonProfile, dragonSnapshot, steppingClock, tempDirectory } from './support.mjs';

/**
 * Snapshots hold their nodes in a Map, which JSON cannot express. These two
 * helpers are the conversion, and this file is the proof that the conversion
 * loses nothing and produces the same text twice.
 */

const temp = tempDirectory('snapshot');
after(() => {
  temp.cleanup();
});

function reason(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ProjectStoreError, `expected ProjectStoreError, got ${error}`);
    return error.reason;
  }
  throw new assert.AssertionError({ message: 'expected a throw, got none' });
}

test('serializing sorts nodes by assetId whatever order they were built in', () => {
  const snapshot = dragonSnapshot();
  assert.deepEqual([...snapshot.nodes.keys()], ['MCC-D1-01', 'MAH001-10-01'], 'unsorted on the way in');

  const serialized = serializeSnapshot(snapshot);
  assert.deepEqual(
    serialized.nodes.map((node) => node.assetId),
    ['MAH001-10-01', 'MCC-D1-01'],
  );
  assert.equal(serialized.reviewItems.length, 3);
  assert.deepEqual(serialized.stats, snapshot.stats);
});

test('the same snapshot built in a different order serializes to the same text', () => {
  const forwards = dragonSnapshot();
  const backwards = dragonSnapshot();
  const reordered = new Map([...backwards.nodes.entries()].reverse());
  const other = { ...backwards, nodes: reordered };

  assert.notDeepEqual([...forwards.nodes.keys()], [...reordered.keys()]);
  assert.equal(
    canonicalJson(serializeSnapshot(forwards)),
    canonicalJson(serializeSnapshot(other)),
  );
});

test('canonical JSON is insensitive to key insertion order', () => {
  assert.equal(
    canonicalJson({ system: '001', building: 'D1', tag: 'MAH001-10-01' }),
    canonicalJson({ tag: 'MAH001-10-01', building: 'D1', system: '001' }),
  );
  assert.equal(canonicalJson({ note: undefined, tag: 'MAH001-10-01' }), '{"tag":"MAH001-10-01"}');
  assert.equal(canonicalJson([1, undefined, null]), '[1,null,null]');
});

test('a snapshot survives serialize, canonical JSON, parse and deserialize', () => {
  const snapshot = dragonSnapshot();
  const text = canonicalJson(serializeSnapshot(snapshot));
  const restored = deserializeSnapshot(JSON.parse(text));

  assert.deepEqual(restored, snapshot);
  assert.deepEqual(
    [...restored.nodes.keys()],
    ['MAH001-10-01', 'MCC-D1-01'],
    'nodes come back in assetId order, whatever order they went in',
  );
  assert.equal(canonicalJson(serializeSnapshot(restored)), text, 'and re-serialize identically');
});

test('a snapshot round-trips through a project file', () => {
  const store = createProject(temp.file('snapshot.matchline'), {
    name: 'Dragon',
    now: steppingClock(),
  });
  try {
    const revision = store.saveProfile(dragonProfile());
    const compileId = store.recordCompile({
      inputHashes: {},
      profileRevision: revision,
      statsJson: dragonSnapshot().stats,
      startedAt: '2026-01-15T10:00:00.000Z',
      finishedAt: '2026-01-15T10:00:42.000Z',
    });
    store.saveSnapshot(compileId, serializeSnapshot(dragonSnapshot()));

    const latest = store.getLatestSnapshot(deserializeSnapshot);
    assert.equal(latest.compileId, compileId);
    assert.deepEqual(latest.snapshot, dragonSnapshot());
  } finally {
    store.close();
  }
});

test('a Map key that disagrees with its node is refused', () => {
  const snapshot = dragonSnapshot();
  const wrong = new Map(snapshot.nodes);
  wrong.set('MAH999-99-99', wrong.get('MAH001-10-01'));

  const failure = reason(() => serializeSnapshot({ ...snapshot, nodes: wrong }));
  assert.equal(failure.kind, 'invalid-snapshot');
  assert.equal(failure.field, 'nodes');
});

test('deserializing names the field that is wrong', () => {
  const good = JSON.parse(canonicalJson(serializeSnapshot(dragonSnapshot())));

  const noStats = { ...good, stats: undefined };
  assert.equal(reason(() => deserializeSnapshot(noStats)).field, 'snapshot.stats');

  const badTier = structuredClone(good);
  badTier.nodes[0].parent.winningClaim.evidenceTier = 9;
  assert.equal(
    reason(() => deserializeSnapshot(badTier)).field,
    'snapshot.nodes[0].parent.winningClaim.evidenceTier',
  );

  const badLadder = structuredClone(good);
  badLadder.nodes[0].parent.ladderSource = 'vibes';
  assert.equal(reason(() => deserializeSnapshot(badLadder)).field, 'snapshot.nodes[0].parent.ladderSource');

  // A root with a parent, or a resolved node without one, is a contradiction
  // rather than a shape error -- both are refused.
  const rootWithParent = structuredClone(good);
  rootWithParent.nodes[1].parent.parentAssetId = 'MAH001-10-01';
  assert.equal(
    reason(() => deserializeSnapshot(rootWithParent)).field,
    'snapshot.nodes[1].parent.parentAssetId',
  );

  const duplicate = structuredClone(good);
  duplicate.nodes.push(structuredClone(good.nodes[0]));
  assert.equal(reason(() => deserializeSnapshot(duplicate)).field, 'snapshot.nodes');

  const badReview = structuredClone(good);
  badReview.reviewItems[0].kind = 'vibes';
  assert.equal(reason(() => deserializeSnapshot(badReview)).field, 'snapshot.reviewItems[0].kind');

  const negativeCount = structuredClone(good);
  negativeCount.stats.rootCount = -1;
  assert.equal(reason(() => deserializeSnapshot(negativeCount)).field, 'snapshot.stats.rootCount');
});
