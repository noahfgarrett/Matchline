/**
 * Cycles, stats, empty input and determinism (ENGINE.md E3 step 4).
 *
 * Determinism is the one property that cannot be argued from reading the code,
 * so it is asserted the only honest way: compile the same facts in three
 * different orders and compare the serialized snapshots byte for byte.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ladderRung } from '@matchline/relationship-claims';

import { compileSnapshot } from '../dist/index.js';
import {
  BUILDING,
  claim,
  claims,
  DRAGON_HIERARCHY,
  DRAGON_INPUT,
  MAH,
  PANEL,
  PLC,
  RIO,
  subject,
  SYSTEM,
  TIT,
  VFD,
} from './dist/dragon.fixture.js';

const IN_SYSTEM = { [BUILDING]: 'D1', [SYSTEM]: '001' };

/** Map iteration order is part of the snapshot contract, so it is serialized. */
function serialize(snapshot) {
  return JSON.stringify({
    nodes: [...snapshot.nodes.entries()],
    reviewItems: snapshot.reviewItems,
    stats: snapshot.stats,
  });
}

function rotate(list, by) {
  const offset = by % list.length;
  return [...list.slice(offset), ...list.slice(0, offset)];
}

test('a three-node cycle is broken at the weakest winning rung', () => {
  // a <- b (explicit-model), b <- c (flow-family), c <- a (family-role).
  const snapshot = compileSnapshot({
    subjects: [subject('asset-a', IN_SYSTEM), subject('asset-b', IN_SYSTEM), subject('asset-c', IN_SYSTEM)],
    claims: claims({
      structural: [
        claim('explicit-model', 'asset-a', 'asset-b', 1),
        claim('flow-family', 'asset-b', 'asset-c', 2),
        claim('family-role', 'asset-c', 'asset-a', 3),
      ],
    }),
    hierarchy: DRAGON_HIERARCHY,
  });

  // family-role is the latest rung in the ladder, so asset-c loses its parent.
  const broken = snapshot.nodes.get('asset-c');
  assert.equal(broken.parent.status, 'unresolved');
  assert.equal(broken.parent.parentAssetId, null);
  assert.equal(broken.parent.ladderSource, null);
  assert.equal(broken.parent.winningClaim, undefined);
  // The rejected claim is retained, never discarded.
  assert.deepEqual(
    broken.losingClaims.map((entry) => entry.targetAssetId),
    ['asset-a'],
  );

  assert.equal(snapshot.nodes.get('asset-a').parent.parentAssetId, 'asset-b');
  assert.equal(snapshot.nodes.get('asset-b').parent.parentAssetId, 'asset-c');
  assert.deepEqual(snapshot.reviewItems, [
    { kind: 'structural-cycle', assetIds: ['asset-a', 'asset-b', 'asset-c'] },
  ]);
  assert.equal(snapshot.stats.cycleCount, 1);
  assert.equal(snapshot.stats.unresolvedCount, 1);
});

test('a cycle whose members tie on rung is broken at the largest asset id', () => {
  const snapshot = compileSnapshot({
    subjects: [subject('asset-x', IN_SYSTEM), subject('asset-y', IN_SYSTEM)],
    claims: claims({
      structural: [
        claim('family-role', 'asset-x', 'asset-y', 1),
        claim('family-role', 'asset-y', 'asset-x', 2),
      ],
    }),
    hierarchy: DRAGON_HIERARCHY,
  });

  assert.equal(snapshot.nodes.get('asset-y').parent.status, 'unresolved');
  assert.equal(snapshot.nodes.get('asset-x').parent.parentAssetId, 'asset-y');
  assert.deepEqual(snapshot.reviewItems, [
    { kind: 'structural-cycle', assetIds: ['asset-x', 'asset-y'] },
  ]);
});

test('two independent cycles are broken independently', () => {
  const snapshot = compileSnapshot({
    subjects: ['asset-a', 'asset-b', 'asset-p', 'asset-q'].map((assetId) =>
      subject(assetId, IN_SYSTEM),
    ),
    claims: claims({
      structural: [
        claim('family-role', 'asset-a', 'asset-b', 1),
        claim('family-role', 'asset-b', 'asset-a', 2),
        claim('family-role', 'asset-p', 'asset-q', 3),
        claim('family-role', 'asset-q', 'asset-p', 4),
      ],
    }),
    hierarchy: DRAGON_HIERARCHY,
  });

  assert.equal(snapshot.stats.cycleCount, 2);
  assert.equal(snapshot.nodes.get('asset-b').parent.status, 'unresolved');
  assert.equal(snapshot.nodes.get('asset-q').parent.status, 'unresolved');
  assert.equal(snapshot.reviewItems.length, 2);
});

test('an asset claimed as its own parent is a one-member cycle, not a stack overflow', () => {
  const snapshot = compileSnapshot({
    subjects: [subject('asset-a', IN_SYSTEM)],
    claims: claims({ structural: [claim('family-role', 'asset-a', 'asset-a')] }),
    hierarchy: DRAGON_HIERARCHY,
  });

  assert.equal(snapshot.nodes.get('asset-a').parent.status, 'unresolved');
  assert.deepEqual(snapshot.reviewItems, [{ kind: 'structural-cycle', assetIds: ['asset-a'] }]);
  assert.equal(snapshot.stats.cycleCount, 1);
});

test('one parent named by two rungs is one demotion, matching the one dependency', () => {
  const snapshot = compileSnapshot({
    subjects: [
      subject('asset-child', IN_SYSTEM),
      subject('asset-far', { [BUILDING]: 'D1', [SYSTEM]: '002' }),
    ],
    claims: claims({
      structural: [
        claim('flow-family', 'asset-child', 'asset-far', 1),
        claim('family-role', 'asset-child', 'asset-far', 2),
      ],
    }),
    hierarchy: DRAGON_HIERARCHY,
  });

  assert.equal(snapshot.stats.demotedToDependencyCount, 1);
  assert.equal(snapshot.nodes.get('asset-child').dependencies.length, 1);
  // Both claims are retained; neither won.
  assert.equal(snapshot.nodes.get('asset-child').losingClaims.length, 2);
});

test('a parent demoted twice keeps the strongest rung as the dependency provenance', () => {
  // Two rungs name the same out-of-system parent, so the walk demotes twice.
  // The reviewer asking "why is this not under asset-far?" is asking about the
  // strongest rung that named it -- the weaker rung's provenance overwriting it
  // would answer with the wrong row and the wrong rung.
  const snapshot = compileSnapshot({
    subjects: [
      subject('asset-child', IN_SYSTEM),
      subject('asset-far', { [BUILDING]: 'D1', [SYSTEM]: '002' }),
    ],
    claims: claims({
      structural: [
        claim('profile-lookup', 'asset-child', 'asset-far', 11),
        claim('prior-ssm', 'asset-child', 'asset-far', 77),
      ],
    }),
    hierarchy: DRAGON_HIERARCHY,
  });

  const child = snapshot.nodes.get('asset-child');
  assert.equal(child.dependencies.length, 1);
  const [demoted] = child.dependencies;
  assert.equal(demoted.parentAssetId, 'asset-far');
  assert.equal(demoted.provenance.rule, 'ssm.boundaryDemotion');
  assert.equal(demoted.provenance.sourceRef.row, 11, 'the profile-lookup row, not the prior-ssm one');
  assert.equal(demoted.provenance.fallbackRung, ladderRung('profile-lookup'));
  // And the demotion record agrees with the dependency it produced.
  assert.deepEqual(child.parent.demotedFrom, {
    parentAssetId: 'asset-far',
    boundaryLevelId: 'system',
  });
});

test('two children blocked by the same unstated parent raise one review item', () => {
  const snapshot = compileSnapshot({
    subjects: [
      subject('asset-one', IN_SYSTEM),
      subject('asset-two', IN_SYSTEM),
      subject('asset-gap', { [BUILDING]: 'D1' }),
    ],
    claims: claims({
      structural: [
        claim('flow-family', 'asset-one', 'asset-gap', 1),
        claim('flow-family', 'asset-two', 'asset-gap', 2),
      ],
    }),
    hierarchy: DRAGON_HIERARCHY,
  });

  assert.deepEqual(snapshot.reviewItems, [
    { kind: 'missing-boundary', assetId: 'asset-gap', levelId: 'system' },
  ]);
  assert.equal(snapshot.stats.unresolvedCount, 2);
});

test('subjects sharing an asset id collapse to the first', () => {
  const snapshot = compileSnapshot({
    subjects: [subject('asset-a', IN_SYSTEM), subject('asset-a', { [BUILDING]: 'D9' })],
    claims: claims({}),
    hierarchy: DRAGON_HIERARCHY,
  });

  assert.equal(snapshot.nodes.size, 1);
  assert.equal(snapshot.nodes.get('asset-a').levelPath[0].value, 'D1');
});

test('a makeRoot directive for an asset outside the compile is ignored', () => {
  const snapshot = compileSnapshot({
    subjects: [subject('asset-a', IN_SYSTEM)],
    claims: claims({
      makeRoot: [
        {
          childAssetId: 'asset-not-here',
          provenance: {
            sourceFile: 'site-profile',
            sourceRef: { kind: 'sheet-row', sheet: 'manualOverrides', row: 1 },
          },
        },
      ],
    }),
    hierarchy: DRAGON_HIERARCHY,
  });

  assert.equal(snapshot.nodes.size, 1);
  assert.equal(snapshot.stats.nodeCount, 1);
});

test('empty input compiles to an empty snapshot', () => {
  const snapshot = compileSnapshot({
    subjects: [],
    claims: claims({}),
    hierarchy: DRAGON_HIERARCHY,
  });

  assert.equal(snapshot.nodes.size, 0);
  assert.deepEqual(snapshot.reviewItems, []);
  assert.deepEqual(snapshot.stats, {
    nodeCount: 0,
    rootCount: 0,
    demotedToDependencyCount: 0,
    unresolvedCount: 0,
    cycleCount: 0,
    ambiguousCount: 0,
  });
});

test('a hierarchy with no levels folds nothing and roots everything it cannot nest', () => {
  const snapshot = compileSnapshot({
    subjects: [subject('asset-a', {}), subject('asset-b', {})],
    claims: claims({ structural: [claim('flow-family', 'asset-a', 'asset-b')] }),
    hierarchy: { levels: [] },
  });

  // No enabled boundary means nothing to differ over: the parent is kept.
  assert.equal(snapshot.nodes.get('asset-a').parent.parentAssetId, 'asset-b');
  assert.deepEqual(snapshot.nodes.get('asset-a').levelPath, []);
});

test('the Dragon compile has the counts worked out on paper', () => {
  const snapshot = compileSnapshot(DRAGON_INPUT);

  assert.deepEqual(
    [...snapshot.nodes.keys()],
    [
      MAH,
      PLC,
      VFD,
      TIT,
      'asset-0005-tit',
      'asset-0006-xfmr',
      PANEL,
      RIO,
    ],
  );
  assert.deepEqual(snapshot.stats, {
    nodeCount: 8,
    // MAH, the D2 transformer, the panel (cross-building demotion) and the RIO
    // (cross-system demotion).
    rootCount: 4,
    demotedToDependencyCount: 2,
    unresolvedCount: 0,
    cycleCount: 0,
    ambiguousCount: 0,
  });
  assert.deepEqual(snapshot.reviewItems, []);
  assert.equal(snapshot.nodes.get('asset-0005-tit').parent.ladderSource, 'model-tree');
  assert.equal(snapshot.nodes.get(PANEL).parent.demotedFrom.boundaryLevelId, 'building');
  assert.equal(snapshot.nodes.get(RIO).parent.demotedFrom.boundaryLevelId, 'system');
});

test('shuffled subjects and shuffled claims produce an identical snapshot', () => {
  const baseline = serialize(compileSnapshot(DRAGON_INPUT));

  const reversed = serialize(
    compileSnapshot({
      ...DRAGON_INPUT,
      subjects: [...DRAGON_INPUT.subjects].reverse(),
      claims: {
        structural: [...DRAGON_INPUT.claims.structural].reverse(),
        dependencies: [...DRAGON_INPUT.claims.dependencies].reverse(),
        makeRoot: [...DRAGON_INPUT.claims.makeRoot].reverse(),
      },
    }),
  );

  const rotated = serialize(
    compileSnapshot({
      ...DRAGON_INPUT,
      subjects: rotate(DRAGON_INPUT.subjects, 3),
      claims: {
        structural: rotate(DRAGON_INPUT.claims.structural, 2),
        dependencies: rotate(DRAGON_INPUT.claims.dependencies, 1),
        makeRoot: DRAGON_INPUT.claims.makeRoot,
      },
    }),
  );

  assert.equal(reversed, baseline);
  assert.equal(rotated, baseline);
});

test('review items are deduped and ordered deterministically', () => {
  const input = {
    subjects: [
      subject('asset-child', { [BUILDING]: 'D1', [SYSTEM]: '001' }),
      subject('asset-a', { [BUILDING]: 'D1', [SYSTEM]: '001' }),
      subject('asset-b', { [BUILDING]: 'D1', [SYSTEM]: '001' }),
      subject('asset-gap', { [BUILDING]: 'D1' }),
      subject('asset-lonely', { [BUILDING]: 'D1', [SYSTEM]: '001' }),
    ],
    claims: claims({
      structural: [
        // Two candidates at one rung: ambiguous.
        claim('flow-family', 'asset-child', 'asset-a', 1),
        claim('flow-family', 'asset-child', 'asset-b', 2),
        // A parent whose system was never stated: missing boundary.
        claim('flow-family', 'asset-lonely', 'asset-gap', 3),
      ],
    }),
    hierarchy: DRAGON_HIERARCHY,
  };

  const first = compileSnapshot(input);
  const shuffled = compileSnapshot({
    ...input,
    subjects: [...input.subjects].reverse(),
    claims: { ...input.claims, structural: [...input.claims.structural].reverse() },
  });

  assert.deepEqual(first.reviewItems, [
    {
      kind: 'ambiguous-parent',
      assetId: 'asset-child',
      ladderSource: 'flow-family',
      candidateParentIds: ['asset-a', 'asset-b'],
    },
    { kind: 'missing-boundary', assetId: 'asset-gap', levelId: 'system' },
  ]);
  assert.deepEqual(shuffled.reviewItems, first.reviewItems);
});
