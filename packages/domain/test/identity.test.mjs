import assert from 'node:assert/strict';
import test from 'node:test';

import { IDENTITY_TIER_ORDER } from '../dist/index.js';
import {
  DRAGON_EXACT_MATCH,
  DRAGON_FUZZY_MISS,
  DRAGON_HOPELESS_MISS,
  DRAGON_IDENTITY_OUTCOMES,
  DRAGON_SUFFIX_MATCH,
} from './dist/identity.fixture.js';

test('the tier ladder is the one PRODUCT.md §9.2 lists, in order', () => {
  assert.deepEqual(IDENTITY_TIER_ORDER, [
    'exact',
    'normalized',
    'alias',
    'anatomy',
    'suffix-unambiguous',
    'fuzzy-proposal',
  ]);
});

test('fuzzy is the weakest tier, so it can never outrank a real match', () => {
  assert.equal(IDENTITY_TIER_ORDER.at(-1), 'fuzzy-proposal');
  assert.equal(IDENTITY_TIER_ORDER.indexOf('exact'), 0);
});

test('an outcome discriminates on status', () => {
  const matched = DRAGON_IDENTITY_OUTCOMES.filter((outcome) => outcome.status === 'matched');
  const unmatched = DRAGON_IDENTITY_OUTCOMES.filter((outcome) => outcome.status === 'unmatched');
  assert.equal(matched.length, 2);
  assert.equal(unmatched.length, 2);
});

test('a match names the tier and the evidence that tier used', () => {
  assert.equal(DRAGON_EXACT_MATCH.tier, 'exact');
  assert.ok(DRAGON_EXACT_MATCH.detail.includes('MAH001-10-01'));
  assert.equal(DRAGON_SUFFIX_MATCH.tier, 'suffix-unambiguous');
  assert.ok(DRAGON_SUFFIX_MATCH.detail.includes('MAH001-10-01'));
});

test('a fuzzy candidate is always a proposal, never a tier a match can carry', () => {
  const [candidate] = DRAGON_FUZZY_MISS.candidates;
  assert.equal(candidate.tier, 'fuzzy-proposal');
  assert.equal(candidate.distance, 1);
  assert.equal(DRAGON_FUZZY_MISS.status, 'unmatched');
});

test('a miss with nothing near it carries no candidates at all', () => {
  assert.deepEqual(DRAGON_HOPELESS_MISS.candidates, []);
});
