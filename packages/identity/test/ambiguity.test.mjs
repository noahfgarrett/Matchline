import assert from 'node:assert/strict';
import test from 'node:test';

import { reviewItemSummary } from '@matchline/domain';

import { buildIdentityIndex, resolveTag, resolveTags } from '../dist/index.js';
import {
  ALIAS_TO_MISSING_CONFIG,
  ANATOMY_COLLISION_ASSETS,
  ANATOMY_CONFIG,
  CASE_COLLISION_ASSETS,
  DRAGON_ASSETS,
  DUPLICATE_TAG_ASSETS,
  NESTED_STEM_ASSETS,
  NORMALIZING_CONFIG,
  SIBLING_ASSETS,
} from './dist/dragon.fixture.js';

test('two canonical tags that normalize alike are a review item, not a pick', () => {
  const index = buildIdentityIndex(CASE_COLLISION_ASSETS, NORMALIZING_CONFIG);
  const { outcomes, reviewItems } = resolveTags(index, ['Mah001-10-01']);

  const [outcome] = outcomes;
  assert.equal(outcome.status, 'unmatched');

  assert.equal(reviewItems.length, 1);
  const [item] = reviewItems;
  assert.equal(item.kind, 'ambiguous-suffix');
  assert.equal(item.evidenceTag, 'Mah001-10-01');
  assert.deepEqual(item.candidateAssetIds, ['asset-0001', 'asset-0009']);
  assert.equal(reviewItemSummary(item), 'tag Mah001-10-01: 2 assets could claim it');
});

test('refusing to decide at one tier stops the ladder rather than guessing lower', () => {
  const index = buildIdentityIndex(CASE_COLLISION_ASSETS, NORMALIZING_CONFIG);
  const { outcomes, reviewItems } = resolveTags(index, ['Mah001-10-01']);
  // Edit distance would happily propose both of them; the ambiguity is the
  // answer, and a fuzzy proposal on top would only muddy the decision.
  assert.deepEqual(outcomes[0].candidates, []);
  assert.deepEqual(
    reviewItems.map((item) => item.kind),
    ['ambiguous-suffix'],
  );
});

test('an evidence tag extending two canonical tags matches neither', () => {
  const index = buildIdentityIndex(NESTED_STEM_ASSETS);
  const { outcomes, reviewItems } = resolveTags(index, ['MAH001-10-01-A']);
  assert.equal(outcomes[0].status, 'unmatched');
  assert.equal(reviewItems.length, 1);
  assert.deepEqual(reviewItems[0].candidateAssetIds, ['asset-0001', 'asset-0008']);
});

test('two canonical tags extending the evidence tag are equally ambiguous', () => {
  const index = buildIdentityIndex(SIBLING_ASSETS);
  const { outcomes, reviewItems } = resolveTags(index, ['MAH001-10-01']);
  assert.equal(outcomes[0].status, 'unmatched');
  assert.deepEqual(reviewItems[0].candidateAssetIds, ['asset-0006', 'asset-0007']);
});

test('letter-suffixed siblings extend a common stem, never one another', () => {
  const index = buildIdentityIndex(SIBLING_ASSETS);

  const own = resolveTag(index, 'MAH001-10-01-A');
  assert.equal(own.status, 'matched');
  assert.equal(own.tier, 'exact');
  assert.equal(own.assetId, 'asset-0006');

  // A third sibling nobody modelled must not be handed to A or B: -A and -B
  // extend the same stem, which relates them to it and not to each other.
  const stranger = resolveTag(index, 'MAH001-10-01-C');
  assert.equal(stranger.status, 'unmatched');
  assert.deepEqual(
    stranger.candidates.map((candidate) => candidate.assetId),
    ['asset-0006', 'asset-0007'],
  );
  assert.deepEqual(
    stranger.candidates.map((candidate) => candidate.tier),
    ['fuzzy-proposal', 'fuzzy-proposal'],
  );
});

test('two anatomy-identical model tags are ambiguous, not merged', () => {
  const index = buildIdentityIndex(ANATOMY_COLLISION_ASSETS, ANATOMY_CONFIG);
  const { outcomes, reviewItems } = resolveTags(index, ['MAH001_10-01']);
  assert.equal(outcomes[0].status, 'unmatched');
  assert.deepEqual(reviewItems[0].candidateAssetIds, ['asset-0001', 'asset-0009']);
});

test('a duplicated canonical tag resolves once, to the first assetId', () => {
  const index = buildIdentityIndex(DUPLICATE_TAG_ASSETS);
  const { outcomes, reviewItems } = resolveTags(index, ['DUP001-10-01']);

  const [outcome] = outcomes;
  assert.equal(outcome.status, 'matched');
  // Supplied second, chosen first: code-unit order, not arrival order.
  assert.equal(outcome.assetId, 'asset-0011');
  assert.ok(outcome.detail.includes('2 assets'));

  // The duplicate itself is the asset catalog's review item, raised upstream.
  // Repeating it here would double-count one decision.
  assert.deepEqual(reviewItems, []);
});

test('an alias whose target no asset carries is terminal, not a fall-through', () => {
  const index = buildIdentityIndex(DRAGON_ASSETS, ALIAS_TO_MISSING_CONFIG);
  // Without the alias this spelling suffix-matches asset-0001, which is
  // precisely the asset the site said it is NOT.
  const bare = resolveTag(buildIdentityIndex(DRAGON_ASSETS), 'MAH001-10-01-SPARE');
  assert.equal(bare.assetId, 'asset-0001');

  const outcome = resolveTag(index, 'MAH001-10-01-SPARE');
  assert.equal(outcome.status, 'unmatched');
  assert.deepEqual(outcome.candidates, []);
});

test('an unresolvable alias tells a person which target went missing', () => {
  const index = buildIdentityIndex(DRAGON_ASSETS, ALIAS_TO_MISSING_CONFIG);
  const { reviewItems } = resolveTags(index, ['MAH001-10-01-SPARE', 'MAH001-10-01-SPARE']);
  assert.deepEqual(reviewItems, [
    {
      kind: 'unresolvable-alias',
      evidenceTag: 'MAH001-10-01-SPARE',
      aliasTarget: 'NOT-IN-THE-MODEL',
    },
  ]);
});

test('a fuzzy proposal is never offered for a spelling the site already aliased', () => {
  const index = buildIdentityIndex(DRAGON_ASSETS, ALIAS_TO_MISSING_CONFIG);
  const outcome = resolveTag(index, 'MAH001-10-01-SPARE');
  assert.deepEqual(outcome.candidates, []);
});
