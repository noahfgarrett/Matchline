/**
 * Dragon-site identity fixtures (DECISIONS.md #6: all invented data is Dragon).
 *
 * Typed here rather than written inline in the .mjs tests so an asset list or
 * profile the tests lean on cannot drift out of what the types actually allow.
 */
import type { NormalizationStep, TagAnatomyConfig } from '@matchline/domain';

import type { IdentityAsset, IdentityConfig } from '../dist/index.js';

/** The model-first universe: five tagged assets from the Dragon extraction. */
export const DRAGON_ASSETS: ReadonlyArray<IdentityAsset> = [
  { assetId: 'asset-0001', canonicalTag: 'MAH001-10-01' },
  { assetId: 'asset-0002', canonicalTag: 'PLC001-10-01' },
  { assetId: 'asset-0003', canonicalTag: 'VFD001-10-01' },
  { assetId: 'asset-0004', canonicalTag: 'TIT603-20-04' },
  { assetId: 'asset-0005', canonicalTag: 'MAH002-10-01' },
];

/** One asset, for tiers that need a universe with nothing else to collide with. */
export const LONE_ASSET: ReadonlyArray<IdentityAsset> = [
  { assetId: 'asset-0001', canonicalTag: 'MAH001-10-01' },
];

/** The model itself wrote this tag in lower case. */
export const LOWERCASE_MODEL_ASSETS: ReadonlyArray<IdentityAsset> = [
  { assetId: 'asset-0030', canonicalTag: 'mah003-10-01' },
];

/** Two model objects, one tag: the DUPLICATE_MODEL_TAG world (PRODUCT.md §9.3). */
export const DUPLICATE_TAG_ASSETS: ReadonlyArray<IdentityAsset> = [
  { assetId: 'asset-0020', canonicalTag: 'DUP001-10-01' },
  { assetId: 'asset-0011', canonicalTag: 'DUP001-10-01' },
];

/** Two distinct canonical tags that collapse onto one under upper-casing. */
export const CASE_COLLISION_ASSETS: ReadonlyArray<IdentityAsset> = [
  { assetId: 'asset-0001', canonicalTag: 'MAH001-10-01' },
  { assetId: 'asset-0009', canonicalTag: 'mah001-10-01' },
];

/** Letter-suffixed siblings, and no bare stem asset (DECISIONS.md: distinct). */
export const SIBLING_ASSETS: ReadonlyArray<IdentityAsset> = [
  { assetId: 'asset-0006', canonicalTag: 'MAH001-10-01-A' },
  { assetId: 'asset-0007', canonicalTag: 'MAH001-10-01-B' },
];

/** One sibling only, so the suffix tier has exactly one candidate. */
export const SINGLE_SIBLING_ASSETS: ReadonlyArray<IdentityAsset> = [
  { assetId: 'asset-0006', canonicalTag: 'MAH001-10-01-A' },
];

/** A stem and a longer tag, so one evidence tag can extend both. */
export const NESTED_STEM_ASSETS: ReadonlyArray<IdentityAsset> = [
  { assetId: 'asset-0001', canonicalTag: 'MAH001-10-01' },
  { assetId: 'asset-0008', canonicalTag: 'MAH001-10' },
];

/** Two model tags that decompose identically under the Dragon anatomy. */
export const ANATOMY_COLLISION_ASSETS: ReadonlyArray<IdentityAsset> = [
  { assetId: 'asset-0001', canonicalTag: 'MAH001-10-01' },
  { assetId: 'asset-0009', canonicalTag: 'MAH001_10_01' },
];

/** Near neighbours of `MAH001-10-01`, for ranking and capping proposals. */
export const FUZZY_NEIGHBOURS: ReadonlyArray<IdentityAsset> = [
  { assetId: 'asset-0101', canonicalTag: 'MAH001-10-02' },
  { assetId: 'asset-0102', canonicalTag: 'MAH001-10-03' },
  { assetId: 'asset-0103', canonicalTag: 'MAH001-10-11' },
  { assetId: 'asset-0104', canonicalTag: 'MAH001-1O-O1' },
  { assetId: 'asset-0105', canonicalTag: 'TIT603-20-04' },
];

/** Trim then upper-case, the two steps a site reaches for first. */
export const TRIM_UPPERCASE: ReadonlyArray<NormalizationStep> = [
  { kind: 'trim' },
  { kind: 'uppercase' },
];

/**
 * The Dragon convention, tolerant of either separator.
 *
 * No `ignoredSuffixes`: this site has not declared any trailing token
 * disposable, so the anatomy says nothing about one.
 */
export const DRAGON_ANATOMY: TagAnatomyConfig = {
  separators: ['-', '_'],
  segments: {
    role: { kind: 'alphaPrefix', token: 0 },
    system: { kind: 'digitSuffix', token: 0 },
    unit: { kind: 'token', token: 1 },
    instance: { kind: 'token', token: 2 },
  },
  familyKeyTemplate: '{system}-{token:1}-{token:2}',
};

/** The same site, having declared `-SPARE` disposable. */
export const DRAGON_ANATOMY_IGNORING_SPARE: TagAnatomyConfig = {
  ...DRAGON_ANATOMY,
  ignoredSuffixes: ['-SPARE'],
};

/** An anatomy that states nothing: no segments, no family key. */
export const EMPTY_ANATOMY: TagAnatomyConfig = {
  separators: ['-'],
  segments: {},
};

export const NORMALIZING_CONFIG: IdentityConfig = { tagNormalization: TRIM_UPPERCASE };

export const ALIAS_CONFIG: IdentityConfig = {
  aliases: new Map([
    ['AHU-1', 'MAH001-10-01'],
    ['GHOST-1', 'NOT-IN-THE-MODEL'],
  ]),
};

export const ANATOMY_CONFIG: IdentityConfig = { anatomy: DRAGON_ANATOMY };

/** An alias that deliberately contradicts what the suffix tier would say. */
export const ALIAS_BEATS_SUFFIX_CONFIG: IdentityConfig = {
  aliases: new Map([['MAH001-10-01-SPARE', 'PLC001-10-01']]),
};

/** Rewrites one underscore spelling, so normalization pre-empts the anatomy. */
export const NORMALIZED_BEATS_ANATOMY_CONFIG: IdentityConfig = {
  tagNormalization: [{ kind: 'alias', from: 'MAH001_10_01', to: 'MAH001-10-01' }],
  anatomy: DRAGON_ANATOMY,
};
