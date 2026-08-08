import assert from 'node:assert/strict';
import test from 'node:test';

import { buildIdentityIndex, resolveTag, resolveTags } from '../dist/index.js';
import {
  CASE_COLLISION_ASSETS,
  DRAGON_ASSETS,
  LONE_ASSET,
  NORMALIZING_CONFIG,
} from './dist/dragon.fixture.js';

test('a batch answers every tag, in the order it was asked', () => {
  const index = buildIdentityIndex(DRAGON_ASSETS);
  const tags = ['MAH001-10-01', 'NOT-A-TAG', 'TIT603-20-04'];
  const { outcomes } = resolveTags(index, tags);

  assert.equal(outcomes.length, tags.length);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.evidenceTag),
    tags,
  );
  assert.deepEqual(
    outcomes.map((outcome) => outcome.status),
    ['matched', 'unmatched', 'matched'],
  );
});

test('a batch collects both review kinds, in first-occurrence order', () => {
  const index = buildIdentityIndex(CASE_COLLISION_ASSETS, NORMALIZING_CONFIG);
  const { reviewItems } = resolveTags(index, ['MAH001-10-0', 'Mah001-10-01']);
  assert.deepEqual(
    reviewItems.map((item) => [item.kind, item.evidenceTag]),
    [
      ['fuzzy-identity', 'MAH001-10-0'],
      ['ambiguous-suffix', 'Mah001-10-01'],
    ],
  );
});

test('one tag asked twice is one decision, not two', () => {
  const index = buildIdentityIndex(LONE_ASSET);
  const { outcomes, reviewItems } = resolveTags(index, ['MAH001-10-02', 'MAH001-10-02']);
  assert.equal(outcomes.length, 2);
  assert.deepEqual(outcomes[0], outcomes[1]);
  assert.equal(reviewItems.length, 1);
});

test('the same question twice gets the same answer, index rebuild included', () => {
  const tags = ['MAH001-10-01', 'MAH001-10-0', 'MAH001-10-01-SPARE', 'PLC001_10_01'];
  const first = resolveTags(buildIdentityIndex(DRAGON_ASSETS), tags);
  const second = resolveTags(buildIdentityIndex(DRAGON_ASSETS), tags);
  assert.deepEqual(first, second);

  // Order of the asset universe must not change any answer either.
  const reversed = resolveTags(buildIdentityIndex([...DRAGON_ASSETS].reverse()), tags);
  assert.deepEqual(reversed.outcomes, first.outcomes);
});

test('an empty universe matches nothing and proposes nothing', () => {
  const index = buildIdentityIndex([]);
  assert.deepEqual(index.assets, []);
  const { outcomes, reviewItems } = resolveTags(index, ['MAH001-10-01']);
  assert.equal(outcomes[0].status, 'unmatched');
  assert.deepEqual(outcomes[0].candidates, []);
  assert.deepEqual(reviewItems, []);
});

test('an empty batch is an empty answer, not an error', () => {
  const index = buildIdentityIndex(DRAGON_ASSETS);
  assert.deepEqual(resolveTags(index, []), { outcomes: [], reviewItems: [] });
});

test('an empty evidence tag is a blank cell, not a tag to reconcile', () => {
  const index = buildIdentityIndex(DRAGON_ASSETS);
  const { outcomes, reviewItems } = resolveTags(index, ['']);
  assert.equal(outcomes[0].status, 'unmatched');
  assert.deepEqual(outcomes[0].candidates, []);
  assert.deepEqual(reviewItems, []);
});

test('an asset with no tag has no identity to be reached by', () => {
  const index = buildIdentityIndex([
    ...LONE_ASSET,
    { assetId: 'asset-0099', canonicalTag: '' },
  ]);
  assert.deepEqual(
    index.assets.map((asset) => asset.assetId),
    ['asset-0001'],
  );
  assert.equal(resolveTag(index, '').status, 'unmatched');
});

test('an index is reusable across as many questions as a compile asks', () => {
  const index = buildIdentityIndex(DRAGON_ASSETS);
  const once = resolveTag(index, 'MAH001-10-01-SPARE');
  const again = resolveTag(index, 'MAH001-10-01-SPARE');
  assert.deepEqual(once, again);
});
