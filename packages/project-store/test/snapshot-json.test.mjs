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

test('the P0-4 and P0-6 additions survive the round trip', () => {
  // A snapshot a 1.0 compile produces and a 0.8.1 one could not: a manual
  // parent the boundary refused, the review item that explains it, and a level
  // path carrying a display label beside its key. Anything the reader drops
  // here is a decision or an explanation the project silently loses overnight.
  const snapshot = {
    nodes: new Map([
      [
        'RIO603-10-01',
        {
          assetId: 'RIO603-10-01',
          parent: {
            parentAssetId: null,
            ladderSource: null,
            status: 'root',
            demotedFrom: {
              parentAssetId: 'PNL603-10-01',
              boundaryLevelId: 'system',
              manual: true,
            },
          },
          dependencies: [],
          levelPath: [
            { levelId: 'building', value: 'D1' },
            { levelId: 'system', value: '650', label: '650 Remote IO' },
          ],
          losingClaims: [],
        },
      ],
    ]),
    reviewItems: [
      {
        kind: 'manual-boundary-demotion',
        assetId: 'RIO603-10-01',
        parentAssetId: 'PNL603-10-01',
        boundaryLevelId: 'system',
      },
    ],
    stats: {
      nodeCount: 1,
      rootCount: 1,
      demotedToDependencyCount: 1,
      unresolvedCount: 0,
      cycleCount: 0,
      ambiguousCount: 0,
    },
  };

  const restored = deserializeSnapshot(JSON.parse(canonicalJson(serializeSnapshot(snapshot))));
  assert.deepEqual(restored, snapshot);
});

test('a level path written before P0-6 comes back without inventing a label', () => {
  const snapshot = dragonSnapshot();
  const restored = deserializeSnapshot(JSON.parse(canonicalJson(serializeSnapshot(snapshot))));
  const entry = restored.nodes.get('MCC-D1-01').levelPath[0];
  assert.deepEqual(entry, { levelId: 'building', value: 'D1' });
  assert.equal('label' in entry, false, 'absent stays absent; the key is what it is called');
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

test('a duplicate-tag item round-trips the sources that claim the tag', () => {
  // An object id is an ordinal within one source (P0-1), so an item that says
  // only "objects 17 and 42" is not navigable once a project holds two models.
  // Dropping `sources` on the way back out of storage would turn a reviewable
  // duplicate into an unreviewable one, silently.
  const snapshot = dragonSnapshot();
  const duplicate = snapshot.reviewItems.find((item) => item.kind === 'duplicate-model-tag');
  duplicate.sources = [
    { sourceId: 'dragon-controls', objectIds: [42] },
    { sourceId: 'dragon-mechanical', objectIds: [17] },
  ];

  const restored = deserializeSnapshot(JSON.parse(JSON.stringify(serializeSnapshot(snapshot))));
  const restoredDuplicate = restored.reviewItems.find(
    (item) => item.kind === 'duplicate-model-tag',
  );
  assert.deepEqual(restoredDuplicate, {
    kind: 'duplicate-model-tag',
    canonicalTag: 'MAH001-10-01',
    objectIds: [17, 42],
    sources: [
      { sourceId: 'dragon-controls', objectIds: [42] },
      { sourceId: 'dragon-mechanical', objectIds: [17] },
    ],
  });
});

test('a duplicate-tag item written before the universe existed round-trips without a sources key', () => {
  // v3 project files carry no `sources`. Absent must stay absent rather than
  // becoming an invented one-source list: "nothing was recorded" and "one
  // source claimed it" are different facts.
  const snapshot = dragonSnapshot();
  const restored = deserializeSnapshot(JSON.parse(JSON.stringify(serializeSnapshot(snapshot))));
  const restoredDuplicate = restored.reviewItems.find(
    (item) => item.kind === 'duplicate-model-tag',
  );
  assert.equal('sources' in restoredDuplicate, false);
});

test('a malformed source on a duplicate-tag item is refused by field, not accepted loosely', () => {
  const snapshot = dragonSnapshot();
  const duplicate = snapshot.reviewItems.find((item) => item.kind === 'duplicate-model-tag');
  duplicate.sources = [{ sourceId: 'dragon-mechanical', objectIds: [17] }];
  const good = JSON.parse(JSON.stringify(serializeSnapshot(snapshot)));
  const index = good.reviewItems.findIndex((item) => item.kind === 'duplicate-model-tag');

  const missingId = structuredClone(good);
  delete missingId.reviewItems[index].sources[0].sourceId;
  assert.equal(
    reason(() => deserializeSnapshot(missingId)).field,
    `snapshot.reviewItems[${index}].sources[0].sourceId`,
  );

  const badObjectId = structuredClone(good);
  badObjectId.reviewItems[index].sources[0].objectIds = ['17'];
  assert.equal(
    reason(() => deserializeSnapshot(badObjectId)).field,
    `snapshot.reviewItems[${index}].sources[0].objectIds[0]`,
  );
});
