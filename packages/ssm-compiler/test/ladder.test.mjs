/**
 * The parent ladder walk (PRODUCT.md §11.1, §11.5).
 *
 * Every count here was worked out on paper before it was asserted. The two
 * load-bearing behaviors are the tie that stops the walk and the demotion that
 * lets it continue -- opposite answers to "may we consult a weaker rung?", and
 * the difference between them is whether the strong rung reached a conclusion.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { compileSnapshot } from '../dist/index.js';
import {
  BUILDING,
  claim,
  claims,
  DRAGON_HIERARCHY,
  subject,
  SYSTEM,
} from './dist/dragon.fixture.js';

const CHILD = 'asset-child';
const LEFT = 'asset-parent-a';
const RIGHT = 'asset-parent-b';
const FALLBACK = 'asset-parent-c';

const IN_SYSTEM = { [BUILDING]: 'D1', [SYSTEM]: '001' };
const OTHER_SYSTEM = { [BUILDING]: 'D1', [SYSTEM]: '002' };

test('a tier with two candidates raises ambiguous-parent and stops the ladder', () => {
  const snapshot = compileSnapshot({
    subjects: [
      subject(CHILD, IN_SYSTEM),
      subject(LEFT, IN_SYSTEM),
      subject(RIGHT, IN_SYSTEM),
      subject(FALLBACK, IN_SYSTEM),
    ],
    claims: claims({
      structural: [
        claim('flow-family', CHILD, LEFT, 1),
        claim('flow-family', CHILD, RIGHT, 2),
        // A perfectly good weaker candidate that must never be consulted.
        claim('family-role', CHILD, FALLBACK, 3),
      ],
    }),
    hierarchy: DRAGON_HIERARCHY,
  });

  const child = snapshot.nodes.get(CHILD);
  assert.equal(child.parent.status, 'unresolved');
  assert.equal(child.parent.parentAssetId, null);
  assert.deepEqual(snapshot.reviewItems, [
    {
      kind: 'ambiguous-parent',
      assetId: CHILD,
      ladderSource: 'flow-family',
      candidateParentIds: [LEFT, RIGHT],
    },
  ]);
  // No fall-through: all three claims lost, including the one below the tie.
  assert.equal(child.losingClaims.length, 3);
  assert.equal(snapshot.stats.ambiguousCount, 1);
  assert.equal(snapshot.stats.unresolvedCount, 1);
});

test('two claims naming the same parent at one tier are one candidate, not a tie', () => {
  const snapshot = compileSnapshot({
    subjects: [subject(CHILD, IN_SYSTEM), subject(LEFT, IN_SYSTEM)],
    claims: claims({
      structural: [claim('flow-family', CHILD, LEFT, 1), claim('flow-family', CHILD, LEFT, 2)],
    }),
    hierarchy: DRAGON_HIERARCHY,
  });

  const child = snapshot.nodes.get(CHILD);
  assert.equal(child.parent.parentAssetId, LEFT);
  assert.equal(snapshot.stats.ambiguousCount, 0);
  // The claim that did not win the slot is still retained.
  assert.equal(child.losingClaims.length, 1);
});

test('a demoted parent lets a weaker rung inside the boundary take over', () => {
  const snapshot = compileSnapshot({
    subjects: [
      subject(CHILD, IN_SYSTEM),
      // The flow-anchored parent sits in another system.
      subject(LEFT, OTHER_SYSTEM),
      // The family+role parent is in the child's own system.
      subject(FALLBACK, IN_SYSTEM),
    ],
    claims: claims({
      structural: [claim('flow-family', CHILD, LEFT, 1), claim('family-role', CHILD, FALLBACK, 2)],
    }),
    hierarchy: DRAGON_HIERARCHY,
  });

  const child = snapshot.nodes.get(CHILD);
  assert.equal(child.parent.status, 'resolved');
  assert.equal(child.parent.parentAssetId, FALLBACK);
  assert.equal(child.parent.ladderSource, 'family-role');
  // The stronger rung's parent is recorded as taken away, and listed as a dependency.
  assert.deepEqual(child.parent.demotedFrom, { parentAssetId: LEFT, boundaryLevelId: 'system' });
  assert.deepEqual(
    child.dependencies.map((entry) => `${entry.parentAssetId}:${entry.relationshipType}`),
    [`${LEFT}:DEPENDENCY`],
  );
  assert.equal(snapshot.stats.demotedToDependencyCount, 1);
});

test('a missing boundary stops the walk: no weaker rung is asked to resolve an unknown', () => {
  const snapshot = compileSnapshot({
    subjects: [
      subject(CHILD, IN_SYSTEM),
      subject(LEFT, { [BUILDING]: 'D1' }),
      subject(FALLBACK, IN_SYSTEM),
    ],
    claims: claims({
      structural: [claim('flow-family', CHILD, LEFT, 1), claim('family-role', CHILD, FALLBACK, 2)],
    }),
    hierarchy: DRAGON_HIERARCHY,
  });

  const child = snapshot.nodes.get(CHILD);
  assert.equal(child.parent.status, 'unresolved');
  assert.equal(child.parent.parentAssetId, null);
  assert.deepEqual(snapshot.reviewItems, [
    { kind: 'missing-boundary', assetId: LEFT, levelId: 'system' },
  ]);
});

test('§11.5: a manual parent is kept across a boundary the fold would have broken', () => {
  const snapshot = compileSnapshot({
    subjects: [
      subject(CHILD, { [BUILDING]: 'D1', [SYSTEM]: '001' }),
      subject(LEFT, { [BUILDING]: 'D9', [SYSTEM]: '999' }),
    ],
    claims: claims({ structural: [claim('manual', CHILD, LEFT)] }),
    hierarchy: DRAGON_HIERARCHY,
  });

  const child = snapshot.nodes.get(CHILD);
  assert.equal(child.parent.status, 'resolved');
  assert.equal(child.parent.parentAssetId, LEFT);
  assert.equal(child.parent.ladderSource, 'manual');
  assert.equal(child.parent.demotedFrom, undefined);
  assert.deepEqual(child.dependencies, []);
  assert.equal(snapshot.stats.demotedToDependencyCount, 0);
  assert.deepEqual(snapshot.reviewItems, []);
});

test('§11.5: a manual parent is kept even when a boundary value is unknown', () => {
  const snapshot = compileSnapshot({
    subjects: [subject(CHILD, IN_SYSTEM), subject(LEFT, {})],
    claims: claims({ structural: [claim('manual', CHILD, LEFT)] }),
    hierarchy: DRAGON_HIERARCHY,
  });

  assert.equal(snapshot.nodes.get(CHILD).parent.parentAssetId, LEFT);
  assert.deepEqual(snapshot.reviewItems, []);
});

test('a makeRoot directive roots the asset and skips every rung', () => {
  const snapshot = compileSnapshot({
    subjects: [subject(CHILD, IN_SYSTEM), subject(LEFT, IN_SYSTEM)],
    claims: claims({
      // A manual parent claim would have won outright; make-root outranks it.
      structural: [claim('manual', CHILD, LEFT), claim('flow-family', CHILD, LEFT, 2)],
      makeRoot: [
        {
          childAssetId: CHILD,
          provenance: {
            sourceFile: 'site-profile',
            sourceRef: { kind: 'sheet-row', sheet: 'manualOverrides', row: 1 },
          },
        },
      ],
    }),
    hierarchy: DRAGON_HIERARCHY,
  });

  const child = snapshot.nodes.get(CHILD);
  assert.equal(child.parent.status, 'root');
  assert.equal(child.parent.parentAssetId, null);
  assert.equal(child.parent.ladderSource, null);
  assert.equal(child.parent.winningClaim, undefined);
  assert.equal(child.losingClaims.length, 2);
  assert.deepEqual(snapshot.reviewItems, []);
});

test('the model-tree rung is synthesized from the cache suggestion and folds like any other', () => {
  const kept = compileSnapshot({
    subjects: [subject(CHILD, IN_SYSTEM, LEFT), subject(LEFT, IN_SYSTEM)],
    claims: claims({}),
    hierarchy: DRAGON_HIERARCHY,
  });
  assert.equal(kept.nodes.get(CHILD).parent.parentAssetId, LEFT);
  assert.equal(kept.nodes.get(CHILD).parent.ladderSource, 'model-tree');

  const demoted = compileSnapshot({
    subjects: [subject(CHILD, IN_SYSTEM, LEFT), subject(LEFT, OTHER_SYSTEM)],
    claims: claims({}),
    hierarchy: DRAGON_HIERARCHY,
  });
  assert.equal(demoted.nodes.get(CHILD).parent.status, 'root');
  assert.equal(demoted.stats.demotedToDependencyCount, 1);
});

test('a model-tree suggestion naming an unknown asset, or the asset itself, produces nothing', () => {
  const snapshot = compileSnapshot({
    subjects: [subject(CHILD, IN_SYSTEM, CHILD), subject(LEFT, IN_SYSTEM, 'asset-not-here')],
    claims: claims({}),
    hierarchy: DRAGON_HIERARCHY,
  });

  assert.equal(snapshot.nodes.get(CHILD).parent.status, 'root');
  assert.deepEqual(snapshot.nodes.get(CHILD).losingClaims, []);
  // A claim naming an asset outside the compile is kept as evidence but can
  // never win: the dead suggestion stays visible instead of vanishing.
  assert.equal(snapshot.nodes.get(LEFT).parent.status, 'root');
  assert.equal(snapshot.nodes.get(LEFT).losingClaims.length, 1);
});

test('a rung the site disabled never wins, and its claims are retained as losers', () => {
  const snapshot = compileSnapshot({
    subjects: [subject(CHILD, IN_SYSTEM), subject(LEFT, IN_SYSTEM), subject(FALLBACK, IN_SYSTEM)],
    claims: claims({
      structural: [claim('flow-family', CHILD, LEFT, 1), claim('family-role', CHILD, FALLBACK, 2)],
    }),
    ladder: { tiers: ['manual', 'explicit-model', 'family-role'] },
    hierarchy: DRAGON_HIERARCHY,
  });

  const child = snapshot.nodes.get(CHILD);
  assert.equal(child.parent.parentAssetId, FALLBACK);
  assert.equal(child.parent.ladderSource, 'family-role');
  assert.deepEqual(
    child.losingClaims.map((entry) => entry.ladderSource),
    ['flow-family'],
  );
});

test('losing claims are retained in ladder order, strongest rung first', () => {
  const snapshot = compileSnapshot({
    subjects: [
      subject(CHILD, IN_SYSTEM),
      subject(LEFT, OTHER_SYSTEM),
      subject(RIGHT, OTHER_SYSTEM),
      subject(FALLBACK, OTHER_SYSTEM),
    ],
    claims: claims({
      structural: [
        claim('prior-ssm', CHILD, FALLBACK, 3),
        claim('flow-family', CHILD, LEFT, 1),
        claim('explicit-model', CHILD, RIGHT, 2),
      ],
    }),
    hierarchy: DRAGON_HIERARCHY,
  });

  const child = snapshot.nodes.get(CHILD);
  // Every rung's parent was in another system, so all three demoted and the
  // asset roots -- with the strongest demotion on the decision.
  assert.equal(child.parent.status, 'root');
  assert.deepEqual(child.parent.demotedFrom, { parentAssetId: RIGHT, boundaryLevelId: 'system' });
  assert.deepEqual(
    child.losingClaims.map((entry) => entry.ladderSource),
    ['explicit-model', 'flow-family', 'prior-ssm'],
  );
  assert.equal(snapshot.stats.demotedToDependencyCount, 3);
  assert.equal(child.dependencies.length, 3);
});
