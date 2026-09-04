import assert from 'node:assert/strict';
import test from 'node:test';

import { reviewItemSummary } from '../dist/index.js';
import {
  DRAGON_REVIEW_ITEMS,
  DUPLICATE_ACROSS_SOURCES,
  DUPLICATE_WITHIN_ONE_SOURCE,
} from './dist/review.fixture.js';

test('every review item kind summarizes to a non-empty line', () => {
  assert.equal(DRAGON_REVIEW_ITEMS.length, 18);
  const kinds = new Set();
  for (const item of DRAGON_REVIEW_ITEMS) {
    kinds.add(item.kind);
    assert.ok(reviewItemSummary(item).length > 0, `${item.kind} summarized to nothing`);
  }
  assert.equal(kinds.size, DRAGON_REVIEW_ITEMS.length);
});

test('a system conflict keeps every competing claim, losers included', () => {
  const [conflict] = DRAGON_REVIEW_ITEMS;
  assert.equal(conflict.kind, 'system-conflict');
  assert.deepEqual(
    conflict.claims.map((claim) => claim.proposedValue),
    ['002', '001'],
  );
  assert.equal(reviewItemSummary(conflict), 'asset asset-0001: 2 competing system claims');
});

test('a duplicate model tag names both objects rather than merging them', () => {
  const duplicate = DRAGON_REVIEW_ITEMS[1];
  assert.deepEqual(duplicate.objectIds, [4, 57]);
  assert.equal(
    reviewItemSummary(duplicate),
    'tag MAH001-10-01: 2 model objects share it',
  );
});

test('a tag claimed by two sources names both of them', () => {
  assert.equal(
    reviewItemSummary(DUPLICATE_ACROSS_SOURCES),
    'tag MAH001-10-01: 2 model objects share it across sources dragon-mech-a, dragon-mech-b',
  );
});

test('a duplicate inside one source does not grow a source clause', () => {
  assert.equal(
    reviewItemSummary(DUPLICATE_WITHIN_ONE_SOURCE),
    'tag MAH001-10-01: 2 model objects share it',
  );
});

test('one system key with several descriptions is a review item, not a pick', () => {
  const catalog = DRAGON_REVIEW_ITEMS[2];
  assert.equal(
    reviewItemSummary(catalog),
    'system 001: 2 conflicting descriptions',
  );
});

test('a fuzzy identity arrives as ranked candidates for a person to pick from', () => {
  const fuzzy = DRAGON_REVIEW_ITEMS[3];
  assert.equal(fuzzy.kind, 'fuzzy-identity');
  assert.deepEqual(
    fuzzy.candidates.map((candidate) => candidate.distance),
    [1, 2],
  );
  assert.equal(
    reviewItemSummary(fuzzy),
    'tag MAH001-10-1: 2 fuzzy candidates need review',
  );
});

test('an ambiguous suffix names every asset that could claim the tag', () => {
  const ambiguous = DRAGON_REVIEW_ITEMS[4];
  assert.deepEqual(ambiguous.candidateAssetIds, ['asset-0001', 'asset-0009']);
  assert.equal(reviewItemSummary(ambiguous), 'tag 10-01: 2 assets could claim it');
});

test('a tied ladder tier names the tier it stopped at, not the assets it skipped', () => {
  const ambiguousParent = DRAGON_REVIEW_ITEMS[5];
  assert.equal(ambiguousParent.kind, 'ambiguous-parent');
  assert.equal(ambiguousParent.ladderSource, 'family-role');
  assert.equal(
    reviewItemSummary(ambiguousParent),
    'asset asset-0004: 2 parents tied at tier family-role',
  );
});

test('a structural cycle is reported whole rather than snapped at an edge', () => {
  const cycle = DRAGON_REVIEW_ITEMS[6];
  assert.deepEqual(cycle.assetIds, ['asset-0002', 'asset-0003', 'asset-0004']);
  assert.equal(reviewItemSummary(cycle), 'structural cycle across 3 assets');
});

test('a missing boundary value names the level that could not be compared', () => {
  const missing = DRAGON_REVIEW_ITEMS[7];
  assert.equal(
    reviewItemSummary(missing),
    'asset asset-0009: boundary level building has no value',
  );
});

test('a refused manual parent names both ends and the boundary it crossed', () => {
  const refused = DRAGON_REVIEW_ITEMS[8];
  assert.equal(refused.kind, 'manual-boundary-demotion');
  // P0-4: the item a person reads when their own decision did not nest. It has
  // to say what they chose, not only that something was refused.
  assert.equal(
    reviewItemSummary(refused),
    'asset asset-0650: the manual parent asset-0603 crosses boundary level system, ' +
      'so it is a dependency rather than a parent',
  );
});

test('a proposal-grade learned rule arrives as review, carrying its confidence', () => {
  const proposal = DRAGON_REVIEW_ITEMS[9];
  assert.equal(proposal.kind, 'nesting-proposal');
  assert.equal(proposal.confidence, 0.875);
  assert.equal(
    reviewItemSummary(proposal),
    'asset asset-0004: proposed parent asset-0003 (VFD parents TIT (7/8 sightings))',
  );
});

test('a dead claim rule names the rule that produced nothing, and why', () => {
  const dead = DRAGON_REVIEW_ITEMS[10];
  assert.equal(dead.kind, 'dead-claim-rule');
  assert.equal(
    reviewItemSummary(dead),
    'profile-lookup rule TIT603-10-01 -> MAH001-10-99 produced nothing (unresolvable-parent-tag)',
  );
});

test('an unresolvable alias names the spelling and the target no asset carries', () => {
  const alias = DRAGON_REVIEW_ITEMS[11];
  assert.equal(alias.kind, 'unresolvable-alias');
  assert.equal(
    reviewItemSummary(alias),
    'alias MAH-1 -> MAH001-10-99: no asset carries that tag',
  );
});

test('an absorbed tagged component names the tag that stopped naming an asset', () => {
  const absorbed = DRAGON_REVIEW_ITEMS[12];
  assert.equal(absorbed.kind, 'absorbed-tagged-component');
  assert.equal(
    reviewItemSummary(absorbed),
    'tag VFD001-10-01 was absorbed into asset-0001 (object 57)',
  );
});

test('an orphaned decision names the stored decision that no longer resolves', () => {
  const orphaned = DRAGON_REVIEW_ITEMS[13];
  assert.equal(orphaned.kind, 'orphaned-decision');
  assert.equal(
    reviewItemSummary(orphaned),
    'stored manual-parent decision tag:MAH009-10-01 -> tag:MAH001-10-01 no longer resolves (unknown-child)',
  );
  // The person's words survive the address they were recorded against.
  assert.equal(orphaned.note, 'Commissioned with the D1 train.');
});

test('an orphaned decision with no other end does not read as a decision about nothing', () => {
  assert.equal(
    reviewItemSummary({
      kind: 'orphaned-decision',
      decision: 'manual-system',
      childRef: 'tag:MAH009-10-01',
      parentRef: '',
      reason: 'unknown-child',
    }),
    'stored manual-system decision tag:MAH009-10-01 no longer resolves (unknown-child)',
  );
});

test('a level that stopped every nesting is one row, not one per asset', () => {
  const level = DRAGON_REVIEW_ITEMS[14];
  assert.equal(level.kind, 'missing-boundary-level');
  assert.equal(
    reviewItemSummary(level),
    'boundary level building: 34 assets could not be placed, because the level states no value on one side or the other',
  );
  // The count is the whole point, and the examples name real equipment.
  assert.equal(level.exampleAssetIds.length, 3);
});

test('a rule-driven demotion names the level and the rung it refused', () => {
  const demotion = DRAGON_REVIEW_ITEMS[15];
  assert.equal(demotion.kind, 'boundary-demotion');
  assert.equal(
    reviewItemSummary(demotion),
    'boundary level system: 12 parents from the flow-family rung became dependencies',
  );
});

test('unresolved systems are grouped by the reasons that explain them', () => {
  const unresolved = DRAGON_REVIEW_ITEMS[16];
  assert.equal(unresolved.kind, 'unresolved-system');
  assert.equal(
    reviewItemSummary(unresolved),
    '8 assets resolved no system (keyChain[0] model-field no-value)',
  );
});

test('a derived attribute assignment that no longer resolves names its field', () => {
  assert.equal(
    reviewItemSummary({
      kind: 'orphaned-decision',
      decision: 'derived-attribute',
      childRef: 'tag:MAH009-10-01',
      parentRef: '',
      field: 'turnover-package',
      reason: 'unknown-child',
    }),
    'stored derived-attribute decision tag:MAH009-10-01 for turnover-package no longer resolves (unknown-child)',
  );
});

test('an unknown review item kind is rejected rather than silently summarized', () => {
  assert.throws(
    () => reviewItemSummary({ kind: 'vibes' }),
    /unhandled ReviewItem.*vibes/s,
  );
});

test('a tag-only re-match against a vanished entry is a question, not a silence', () => {
  const rematch = DRAGON_REVIEW_ITEMS[17];
  assert.equal(rematch.kind, 'possible-rematch');
  // The asset and the tag, because the tag IS the whole of the evidence, and
  // the reason, because "it had vanished" and "it lived somewhere else" are
  // different things for a reviewer to check.
  assert.match(reviewItemSummary(rematch), /asset-0009/);
  assert.match(reviewItemSummary(rematch), /MAH009-10-01/);
  assert.match(reviewItemSummary(rematch), /reappeared/);
});
