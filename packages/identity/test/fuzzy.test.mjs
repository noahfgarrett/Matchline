import assert from 'node:assert/strict';
import test from 'node:test';

import { reviewItemSummary } from '@matchline/domain';

import {
  buildIdentityIndex,
  DEFAULT_FUZZY_MAX_DISTANCE,
  FUZZY_CANDIDATE_LIMIT,
  boundedDistance,
  resolveTag,
  resolveTags,
} from '../dist/index.js';
import { FUZZY_NEIGHBOURS, LONE_ASSET } from './dist/dragon.fixture.js';

test('a near miss is never a match, however near it is', () => {
  const index = buildIdentityIndex(LONE_ASSET);
  const outcome = resolveTag(index, 'MAH001-10-02');
  assert.equal(outcome.status, 'unmatched');
  assert.deepEqual(outcome.candidates, [
    { assetId: 'asset-0001', tier: 'fuzzy-proposal', distance: 1 },
  ]);
});

test('proposals are ranked by distance, then by canonical tag', () => {
  const index = buildIdentityIndex(FUZZY_NEIGHBOURS);
  const outcome = resolveTag(index, 'MAH001-1O-01');
  assert.deepEqual(outcome.candidates, [
    { assetId: 'asset-0104', tier: 'fuzzy-proposal', distance: 1 },
    { assetId: 'asset-0101', tier: 'fuzzy-proposal', distance: 2 },
    { assetId: 'asset-0102', tier: 'fuzzy-proposal', distance: 2 },
  ]);
});

test('proposals are capped, because a whole register is not a shortlist', () => {
  const index = buildIdentityIndex(FUZZY_NEIGHBOURS);
  const outcome = resolveTag(index, 'MAH001-1O-01');
  assert.equal(FUZZY_CANDIDATE_LIMIT, 3);
  assert.equal(outcome.candidates.length, FUZZY_CANDIDATE_LIMIT);
});

test('the configured distance decides what is even a proposal', () => {
  const index = buildIdentityIndex(FUZZY_NEIGHBOURS, { fuzzyMaxDistance: 1 });
  const outcome = resolveTag(index, 'MAH001-1O-01');
  assert.deepEqual(
    outcome.candidates.map((candidate) => candidate.assetId),
    ['asset-0104'],
  );

  const strict = buildIdentityIndex(FUZZY_NEIGHBOURS, { fuzzyMaxDistance: 0 });
  assert.deepEqual(resolveTag(strict, 'MAH001-1O-01').candidates, []);
  assert.equal(DEFAULT_FUZZY_MAX_DISTANCE, 2);
});

test('proposals arrive with a review item that says what has to be decided', () => {
  const index = buildIdentityIndex(LONE_ASSET);
  const { reviewItems } = resolveTags(index, ['MAH001-10-02']);
  assert.equal(reviewItems.length, 1);
  const [item] = reviewItems;
  assert.equal(item.kind, 'fuzzy-identity');
  assert.deepEqual(item.candidates, [{ assetId: 'asset-0001', distance: 1 }]);
  assert.equal(reviewItemSummary(item), 'tag MAH001-10-02: 1 fuzzy candidates need review');
});

test('nothing within reach raises nothing to review', () => {
  const index = buildIdentityIndex(LONE_ASSET);
  const { outcomes, reviewItems } = resolveTags(index, ['COMPLETELY-OTHER']);
  assert.deepEqual(outcomes[0].candidates, []);
  assert.deepEqual(reviewItems, []);
});

test('the disabled fuzzy tier proposes nothing at all', () => {
  const index = buildIdentityIndex(LONE_ASSET, {
    enabledTiers: ['exact', 'normalized', 'alias', 'anatomy', 'suffix-unambiguous'],
  });
  const { outcomes, reviewItems } = resolveTags(index, ['MAH001-10-02']);
  assert.deepEqual(outcomes[0].candidates, []);
  assert.deepEqual(reviewItems, []);
});

test('distance is bounded, symmetric and reports the real edit count', () => {
  assert.equal(boundedDistance('MAH001-10-01', 'MAH001-10-01', 2), 0);
  assert.equal(boundedDistance('MAH001-10-01', 'MAH001-10-02', 2), 1);
  assert.equal(boundedDistance('MAH001-10-02', 'MAH001-10-01', 2), 1);
  assert.equal(boundedDistance('MAH001-10-01', 'MAH001-1001', 2), 1);
  // Past the bound the exact figure is not computed, only that it exceeded.
  assert.equal(boundedDistance('MAH001-10-01', 'TIT603-20-04', 2), 3);
  assert.equal(boundedDistance('', 'MAH', 2), 3);
});
