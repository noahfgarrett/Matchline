/**
 * Properties that must hold across every source: determinism, deduplication,
 * the empty compile, and the structural/dependency split.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { LADDER_SOURCE_ORDER, relationshipKindOf } from '@matchline/domain';

import {
  assembleRelationshipClaims,
  DEPENDENCY_RULE,
  LADDER_SOURCE_EVIDENCE_TIER,
  LADDER_SOURCE_KIND,
  LADDER_SOURCE_RELATIONSHIP_TYPE,
  LADDER_SOURCE_RULE,
  ladderRung,
  UNASSEMBLED_LADDER_SOURCES,
} from '../dist/index.js';
import {
  DRAGON_FLOW_EDGES,
  DRAGON_LEARNED,
  DRAGON_MANUAL_OVERRIDES,
  DRAGON_PRIOR_SSM,
  DRAGON_PROFILE_LOOKUP,
  DRAGON_ROLE_GRAPH,
  DRAGON_SUBJECTS,
  PARALLEL_FEED_EDGE,
  resolveDragonTag,
} from './dist/dragon.fixture.js';

/** Every source wired at once, which is how a real compile arrives. */
const EVERY_SOURCE = {
  roleGraph: DRAGON_ROLE_GRAPH,
  flowEdges: DRAGON_FLOW_EDGES,
  learned: DRAGON_LEARNED,
  priorSsm: DRAGON_PRIOR_SSM,
  profileLookup: DRAGON_PROFILE_LOOKUP,
  manualOverrides: DRAGON_MANUAL_OVERRIDES,
  resolveTag: resolveDragonTag,
};

function snapshot(assembled) {
  return JSON.stringify(assembled);
}

/** A fixed reordering: a random shuffle would make a failure unreproducible. */
function reorder(items) {
  const odd = items.filter((_, index) => index % 2 === 1);
  const even = items.filter((_, index) => index % 2 === 0);
  return [...odd.reverse(), ...even.reverse()];
}

test('the same inputs in a different order assemble to the same claims', () => {
  // Subjects and flow edges are sets: they carry their own addresses, so the
  // order the caller happens to hand them over in must not reach the output.
  // Profile tables are not sets -- an entry's position is its address -- so
  // reordering one is a different profile, and it is deliberately not shuffled
  // here.
  const straight = assembleRelationshipClaims(DRAGON_SUBJECTS, EVERY_SOURCE);
  const shuffled = assembleRelationshipClaims(reorder(DRAGON_SUBJECTS), {
    ...EVERY_SOURCE,
    flowEdges: reorder(DRAGON_FLOW_EDGES),
  });

  assert.equal(snapshot(shuffled), snapshot(straight));
});

test('claims are ordered by child, then by ladder rung', () => {
  const assembled = assembleRelationshipClaims(DRAGON_SUBJECTS, EVERY_SOURCE);
  const keys = assembled.structural.map(
    (claim) => `${claim.subjectAssetId}:${ladderRung(claim.ladderSource)}`,
  );

  assert.deepEqual([...keys].sort(), keys);
  assert.deepEqual(
    assembled.structural.map((claim) => `${claim.subjectAssetId}@${claim.ladderSource}`),
    [
      'asset-0002@flow-family',
      'asset-0003@flow-family',
      'asset-0003@learned-description',
      'asset-0003@prior-ssm',
      'asset-0004@manual',
      'asset-0004@profile-lookup',
      'asset-0004@family-role',
    ],
  );
});

test('two cables between one pair are one dependency, keeping the first row', () => {
  const assembled = assembleRelationshipClaims(DRAGON_SUBJECTS, {
    ...EVERY_SOURCE,
    flowEdges: [PARALLEL_FEED_EDGE, ...DRAGON_FLOW_EDGES],
  });
  const feed = assembled.dependencies.filter(
    (claim) => claim.subjectAssetId === 'asset-0002' && claim.targetAssetId === 'asset-0001',
  );

  assert.equal(feed.length, 1);
  assert.equal(feed[0].provenance.sourceRef.row, 18);
  assert.equal(assembled.dependencies.length, 3);
});

test('two profile rows stating one pairing are one claim, keeping the first row', () => {
  const assembled = assembleRelationshipClaims(DRAGON_SUBJECTS, {
    resolveTag: resolveDragonTag,
    profileLookup: DRAGON_PROFILE_LOOKUP,
  });

  assert.equal(assembled.structural.length, 1);
  assert.equal(assembled.structural[0].provenance.sourceRef.row, 1);
});

test('an empty compile produces empty lists rather than absent ones', () => {
  const assembled = assembleRelationshipClaims([], { resolveTag: () => null });

  assert.deepEqual(assembled, {
    structural: [],
    dependencies: [],
    proposals: [],
    makeRoot: [],
    skipped: [],
  });
});

test('subjects with no sources wired produce nothing at all', () => {
  const assembled = assembleRelationshipClaims(DRAGON_SUBJECTS, {
    resolveTag: resolveDragonTag,
  });

  assert.deepEqual(assembled.structural, []);
  assert.deepEqual(assembled.dependencies, []);
  assert.deepEqual(assembled.skipped, []);
});

test('structural claims may nest and dependency claims may not', () => {
  const assembled = assembleRelationshipClaims(DRAGON_SUBJECTS, EVERY_SOURCE);

  for (const claim of assembled.structural) {
    assert.equal(claim.kind, 'structural-parent');
    assert.equal(relationshipKindOf(claim.relationshipType), 'structural-parent');
  }
  for (const claim of assembled.dependencies) {
    // The type says what the connection is; the kind says what it may do. A
    // POWERS dependency still never re-parents (PRODUCT.md §8.2).
    assert.equal(claim.kind, 'dependency');
    assert.equal(claim.rule, DEPENDENCY_RULE);
    assert.equal(relationshipKindOf(claim.relationshipType), 'structural-parent');
  }
});

test('every ladder rung has a tier, a source, a type and a rule', () => {
  for (const source of LADDER_SOURCE_ORDER) {
    assert.ok(LADDER_SOURCE_EVIDENCE_TIER[source] >= 1);
    assert.ok(LADDER_SOURCE_KIND[source].length > 0);
    assert.equal(
      relationshipKindOf(LADDER_SOURCE_RELATIONSHIP_TYPE[source]),
      'structural-parent',
    );
    assert.ok(LADDER_SOURCE_RULE[source].startsWith('relate.'));
  }
  assert.equal(ladderRung('manual'), 1);
  assert.equal(ladderRung('model-tree'), LADDER_SOURCE_ORDER.length);
});

test('the model-tree rung is never assembled here', () => {
  const assembled = assembleRelationshipClaims(DRAGON_SUBJECTS, EVERY_SOURCE);

  assert.deepEqual(UNASSEMBLED_LADDER_SOURCES, ['model-tree']);
  assert.equal(
    [...assembled.structural, ...assembled.dependencies].some(
      (claim) => claim.ladderSource === 'model-tree',
    ),
    false,
  );
});
