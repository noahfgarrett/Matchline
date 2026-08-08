import assert from 'node:assert/strict';
import test from 'node:test';

import { reviewItemSummary } from '../dist/index.js';
import { DRAGON_REVIEW_ITEMS } from './dist/review.fixture.js';

test('every review item kind summarizes to a non-empty line', () => {
  assert.equal(DRAGON_REVIEW_ITEMS.length, 9);
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

test('a proposal-grade learned rule arrives as review, carrying its confidence', () => {
  const proposal = DRAGON_REVIEW_ITEMS[8];
  assert.equal(proposal.kind, 'nesting-proposal');
  assert.equal(proposal.confidence, 0.875);
  assert.equal(
    reviewItemSummary(proposal),
    'asset asset-0004: proposed parent asset-0003 (VFD parents TIT (7/8 sightings))',
  );
});

test('an unknown review item kind is rejected rather than silently summarized', () => {
  assert.throws(
    () => reviewItemSummary({ kind: 'vibes' }),
    /unhandled ReviewItem.*vibes/s,
  );
});
