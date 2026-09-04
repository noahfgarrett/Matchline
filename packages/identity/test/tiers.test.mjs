import assert from 'node:assert/strict';
import test from 'node:test';

import { buildIdentityIndex, resolveTag } from '../dist/index.js';
import {
  ALIAS_BEATS_SUFFIX_CONFIG,
  ALIAS_CONFIG,
  ANATOMY_CONFIG,
  DRAGON_ANATOMY_IGNORING_SPARE,
  DRAGON_ASSETS,
  EMPTY_ANATOMY,
  LONE_ASSET,
  LOWERCASE_MODEL_ASSETS,
  NORMALIZED_BEATS_ANATOMY_CONFIG,
  NORMALIZING_CONFIG,
  SINGLE_SIBLING_ASSETS,
} from './dist/dragon.fixture.js';

test('an identical spelling matches at the exact tier', () => {
  const index = buildIdentityIndex(DRAGON_ASSETS);
  const outcome = resolveTag(index, 'MAH001-10-01');
  assert.equal(outcome.status, 'matched');
  assert.equal(outcome.assetId, 'asset-0001');
  assert.equal(outcome.tier, 'exact');
  assert.ok(outcome.detail.includes('MAH001-10-01'));
});

test('a spelling no tier can place is unmatched, never assigned', () => {
  const index = buildIdentityIndex(DRAGON_ASSETS);
  const outcome = resolveTag(index, 'MAH001-10-02');
  assert.equal(outcome.status, 'unmatched');
});

test('normalization is applied to the evidence tag and the canonical tag alike', () => {
  const evidenceSide = buildIdentityIndex(DRAGON_ASSETS, NORMALIZING_CONFIG);
  const messy = resolveTag(evidenceSide, ' mah001-10-01 ');
  assert.equal(messy.status, 'matched');
  assert.equal(messy.tier, 'normalized');
  assert.equal(messy.assetId, 'asset-0001');
  assert.ok(messy.detail.includes('both normalize to "MAH001-10-01"'));

  // The model wrote this one in lower case, so only the canonical side needs
  // the transform. Symmetry is what makes both directions work.
  const canonicalSide = buildIdentityIndex(LOWERCASE_MODEL_ASSETS, NORMALIZING_CONFIG);
  const clean = resolveTag(canonicalSide, 'MAH003-10-01');
  assert.equal(clean.status, 'matched');
  assert.equal(clean.tier, 'normalized');
  assert.equal(clean.assetId, 'asset-0030');
});

test('normalization matches spellings the steps make equal, and no others', () => {
  const index = buildIdentityIndex(DRAGON_ASSETS, NORMALIZING_CONFIG);
  const outcome = resolveTag(index, ' mah001-10-99 ');
  assert.equal(outcome.status, 'unmatched');
  assert.deepEqual(outcome.candidates, []);
});

test('an explicit alias matches, and only exactly as the site wrote it', () => {
  const index = buildIdentityIndex(DRAGON_ASSETS, ALIAS_CONFIG);

  const hit = resolveTag(index, 'AHU-1');
  assert.equal(hit.status, 'matched');
  assert.equal(hit.tier, 'alias');
  assert.equal(hit.assetId, 'asset-0001');
  assert.ok(hit.detail.includes('AHU-1'));

  // Aliases are entered facts, not patterns: case-folding one would be a guess.
  assert.equal(resolveTag(index, 'ahu-1').status, 'unmatched');
});

test('an alias naming a tag no asset carries resolves nothing', () => {
  const index = buildIdentityIndex(DRAGON_ASSETS, ALIAS_CONFIG);
  assert.equal(resolveTag(index, 'GHOST-1').status, 'unmatched');
});

test('a separator variant matches at the anatomy tier', () => {
  const index = buildIdentityIndex(DRAGON_ASSETS, ANATOMY_CONFIG);
  const outcome = resolveTag(index, 'MAH001_10_01');
  assert.equal(outcome.status, 'matched');
  assert.equal(outcome.tier, 'anatomy');
  assert.equal(outcome.assetId, 'asset-0001');
  assert.ok(outcome.detail.includes('role=MAH'));
  assert.ok(outcome.detail.includes('familyKey=001-10-01'));
});

test('a shared family with a different role is not an anatomy identity', () => {
  const index = buildIdentityIndex(LONE_ASSET, ANATOMY_CONFIG);
  const outcome = resolveTag(index, 'PLC001_10_01');
  assert.equal(outcome.status, 'unmatched');
  assert.deepEqual(outcome.candidates, []);
});

test('a tag that only partly parses never reaches the anatomy tier', () => {
  const index = buildIdentityIndex(DRAGON_ASSETS, ANATOMY_CONFIG);
  const outcome = resolveTag(index, 'MAH001');
  // `MAH001` has one token, so unit and instance cannot be extracted. The
  // suffix tier picks it up instead -- which is the proof anatomy did not.
  assert.equal(outcome.status, 'matched');
  assert.equal(outcome.tier, 'suffix-unambiguous');
  assert.equal(outcome.assetId, 'asset-0001');
});

test('an anatomy that states nothing cannot claim an identity', () => {
  const index = buildIdentityIndex(DRAGON_ASSETS, { anatomy: EMPTY_ANATOMY });
  assert.equal(index.byAnatomyKey.size, 0);
  const outcome = resolveTag(index, 'MAH001_10_01');
  assert.equal(outcome.status, 'unmatched');
});

test('anatomy identity never reaches past the tokens the anatomy addressed', () => {
  // The Dragon anatomy reads tokens 0-2 and says nothing about a fourth, so
  // two letter-suffixed siblings decompose to the same segments and the same
  // family key. Treating that as one identity would merge two distinct assets
  // on a part of the tag the site never taught (DECISIONS.md).
  const siblings = buildIdentityIndex(
    [{ assetId: 'asset-0007', canonicalTag: 'MAH001-10-01-B' }],
    ANATOMY_CONFIG,
  );
  const sibling = resolveTag(siblings, 'MAH001-10-01-A');
  assert.equal(sibling.status, 'unmatched');

  // An undeclared trailing token is the same story: the suffix tier can relate
  // it, the anatomy tier may not claim it is the same thing.
  const stem = buildIdentityIndex(LONE_ASSET, ANATOMY_CONFIG);
  assert.equal(resolveTag(stem, 'MAH001-10-01-SPARE').tier, 'suffix-unambiguous');
});

test('a suffix the site declared disposable is an anatomy identity', () => {
  const index = buildIdentityIndex(DRAGON_ASSETS, { anatomy: DRAGON_ANATOMY_IGNORING_SPARE });
  const outcome = resolveTag(index, 'MAH001-10-01-SPARE');
  assert.equal(outcome.status, 'matched');
  assert.equal(outcome.tier, 'anatomy');
  assert.equal(outcome.assetId, 'asset-0001');
});

test('an evidence tag that extends exactly one canonical tag matches', () => {
  const index = buildIdentityIndex(DRAGON_ASSETS);
  const outcome = resolveTag(index, 'MAH001-10-01-SPARE');
  assert.equal(outcome.status, 'matched');
  assert.equal(outcome.tier, 'suffix-unambiguous');
  assert.equal(outcome.assetId, 'asset-0001');
  assert.ok(outcome.detail.includes('extends canonical tag "MAH001-10-01"'));
});

test('a canonical tag that extends the evidence tag matches the same way', () => {
  const index = buildIdentityIndex(SINGLE_SIBLING_ASSETS);
  const outcome = resolveTag(index, 'MAH001-10-01');
  assert.equal(outcome.status, 'matched');
  assert.equal(outcome.tier, 'suffix-unambiguous');
  assert.equal(outcome.assetId, 'asset-0006');
  assert.ok(outcome.detail.includes('extends the evidence tag'));
});

test('an extension that is not at a separator boundary is not a suffix match', () => {
  const index = buildIdentityIndex(LONE_ASSET);
  // `MAH001-10-012` continues `MAH001-10-01` mid-token, which relates nothing.
  const outcome = resolveTag(index, 'MAH001-10-012');
  assert.notEqual(outcome.status, 'matched');
});

test('a tier reachable two ways is reported at the stronger tier', () => {
  const exactOverSuffix = buildIdentityIndex([
    ...SINGLE_SIBLING_ASSETS,
    { assetId: 'asset-0001', canonicalTag: 'MAH001-10-01' },
  ]);
  const exact = resolveTag(exactOverSuffix, 'MAH001-10-01-A');
  assert.equal(exact.tier, 'exact');
  assert.equal(exact.assetId, 'asset-0006');

  const normalizedOverAnatomy = buildIdentityIndex(
    DRAGON_ASSETS,
    NORMALIZED_BEATS_ANATOMY_CONFIG,
  );
  const normalized = resolveTag(normalizedOverAnatomy, 'MAH001_10_01');
  assert.equal(normalized.tier, 'normalized');
  assert.equal(normalized.assetId, 'asset-0001');

  const aliasOverSuffix = buildIdentityIndex(DRAGON_ASSETS, ALIAS_BEATS_SUFFIX_CONFIG);
  const alias = resolveTag(aliasOverSuffix, 'MAH001-10-01-SPARE');
  assert.equal(alias.tier, 'alias');
  assert.equal(alias.assetId, 'asset-0002');
});

test('a disabled tier does not run', () => {
  const index = buildIdentityIndex(DRAGON_ASSETS, { enabledTiers: ['exact'] });
  const outcome = resolveTag(index, 'MAH001-10-01-SPARE');
  assert.equal(outcome.status, 'unmatched');
  assert.deepEqual(outcome.candidates, []);
  assert.equal(resolveTag(index, 'MAH001-10-01').tier, 'exact');
});

test('a unicodeFold step matches an en-dashed spelling of a hyphenated tag', () => {
  const index = buildIdentityIndex(DRAGON_ASSETS, {
    tagNormalization: [{ kind: 'unicodeFold' }],
  });
  const outcome = resolveTag(index, 'MAH001–10–01');
  assert.equal(outcome.status, 'matched');
  assert.equal(outcome.tier, 'normalized');
  assert.equal(outcome.assetId, 'asset-0001');
});

test('without the step the same en-dashed spelling matches nothing', () => {
  const index = buildIdentityIndex(DRAGON_ASSETS);
  assert.equal(resolveTag(index, 'MAH001–10–01').status, 'unmatched');
});

test('a fuzzy-free lookup reports the same match and ranks no proposals', () => {
  const index = buildIdentityIndex(DRAGON_ASSETS);
  assert.equal(resolveTag(index, 'MAH001-10-01', { includeFuzzy: false }).tier, 'exact');

  // `MAH001-10-1` is one edit away, so the default lookup proposes it and the
  // fuzzy-free one refuses to spend the distance pass at all.
  const proposed = resolveTag(index, 'MAH001-10-1');
  assert.ok(proposed.candidates.length > 0);
  assert.deepEqual(resolveTag(index, 'MAH001-10-1', { includeFuzzy: false }).candidates, []);
});

test('a matched duplicate tag says how many assets carry it', () => {
  const index = buildIdentityIndex([
    { assetId: 'asset-a', canonicalTag: 'DUP001-10-01' },
    { assetId: 'asset-b', canonicalTag: 'DUP001-10-01' },
  ]);
  const outcome = resolveTag(index, 'DUP001-10-01');
  assert.equal(outcome.status, 'matched');
  assert.equal(outcome.assetId, 'asset-a');
  assert.equal(outcome.sharingAssets, 2);
});
