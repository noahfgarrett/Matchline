import type { TagAnatomyConfig } from '@matchline/domain';

/**
 * Anatomies for the invented Dragon site and its awkward neighbours.
 *
 * Typed here rather than written inline in the .mjs tests so that a config the
 * tests rely on cannot drift out of what `TagAnatomyConfig` actually allows.
 */

/** The Dragon convention: `MAH001-10-01` -> MAH / 001 / 10 / 01. */
export const DRAGON_ANATOMY: TagAnatomyConfig = {
  separators: ['-'],
  ignoredSuffixes: ['-A', '-SPARE'],
  segments: {
    role: { kind: 'alphaPrefix', token: 0 },
    system: { kind: 'digitSuffix', token: 0 },
    unit: { kind: 'token', token: 1 },
    instance: { kind: 'token', token: 2 },
  },
  familyKeyTemplate: '{system}-{token:1}-{token:2}',
  localFamilyTemplate: '{tokens:1-2}',
};

/** The same site with no templates: family keys are optional output. */
export const DRAGON_SEGMENTS_ONLY: TagAnatomyConfig = {
  separators: ['-'],
  segments: {
    role: { kind: 'alphaPrefix', token: 0 },
    system: { kind: 'digitSuffix', token: 0 },
  },
};

/**
 * A site whose separator is ` - ` but which also uses a bare `-` inside tags.
 * Longest-first matching is what keeps `A - B-C` from becoming `['A ', ' B', 'C']`.
 */
export const OVERLAPPING_SEPARATORS: TagAnatomyConfig = {
  separators: [' - ', '-'],
  segments: {
    role: { kind: 'token', token: 0 },
    system: { kind: 'token', token: 1 },
  },
};

/** Two unrelated separators, both multi-character-safe. */
export const MULTI_SEPARATOR: TagAnatomyConfig = {
  separators: ['::', '-'],
  segments: {
    role: { kind: 'alphaPrefix', token: 0 },
    system: { kind: 'token', token: 1 },
    instance: { kind: 'token', token: 2 },
  },
};

/** Ranges: `unit` spans two tokens, `instance` slices characters. */
export const RANGE_ANATOMY: TagAnatomyConfig = {
  separators: ['-'],
  segments: {
    unit: { kind: 'tokenRange', from: 1, to: 2 },
    instance: { kind: 'charRange', token: 0, from: 3, to: 6 },
  },
};

/** No separators at all: the whole tag is one token to slice up. */
export const UNSEPARATED_ANATOMY: TagAnatomyConfig = {
  separators: [],
  segments: {
    role: { kind: 'charRange', token: 0, from: 0, to: 3 },
    system: { kind: 'charRange', token: 0, from: 3, to: 6 },
  },
};

/** `{token:5}` is not there; the template has to fail rather than half-expand. */
export const TEMPLATE_OUT_OF_RANGE: TagAnatomyConfig = {
  separators: ['-'],
  segments: { system: { kind: 'digitSuffix', token: 0 } },
  familyKeyTemplate: '{system}-{token:5}',
};

/** A template naming a segment this anatomy never extracts. */
export const TEMPLATE_UNEXTRACTED_SEGMENT: TagAnatomyConfig = {
  separators: ['-'],
  segments: { system: { kind: 'digitSuffix', token: 0 } },
  familyKeyTemplate: '{role}-{system}',
};

/** A template placeholder the engine has no meaning for. */
export const TEMPLATE_UNKNOWN_PLACEHOLDER: TagAnatomyConfig = {
  separators: ['-'],
  segments: { system: { kind: 'digitSuffix', token: 0 } },
  localFamilyTemplate: '{building}/{system}',
};
