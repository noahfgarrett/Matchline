/**
 * `(anatomy, tag) -> segments | no-match`.
 *
 * Pure and deterministic: no clock, no randomness, no I/O, no shared state.
 * The same config and tag produce an identical result every call, which is
 * what lets a preview be quoted to a user before they publish a profile.
 *
 * Anatomy does not normalize. Trimming, case folding and padding are explicit
 * System Resolver steps (PRODUCT.md §5.5) so that a tag arriving with stray
 * whitespace shows up as a miss a person can see rather than as a silent fix.
 */
import type { SegmentName, TagAnatomyConfig } from '@matchline/domain';

import { extractSegment } from './extract.js';
import { expandTemplate, type TemplateContext } from './template.js';
import { SEGMENT_NAMES, joinSeparator, tokenize } from './tokens.js';

/** Why a tag did not match. */
export type AnatomyMissReason = 'empty-tag' | 'no-tokens' | 'extractor-miss';

export interface AnatomyMatch {
  readonly matched: true;
  /** Only the segments the anatomy configured; all of them are present. */
  readonly segments: Readonly<Partial<Record<SegmentName, string>>>;
  /** Present only when the anatomy configured `familyKeyTemplate`. */
  readonly familyKey?: string;
  /** Present only when the anatomy configured `localFamilyTemplate`. */
  readonly localFamily?: string;
  /** The tag after `ignoredSuffixes` stripping -- what the tokens came from. */
  readonly normalizedTag: string;
}

export interface AnatomyMiss {
  readonly matched: false;
  readonly reason: AnatomyMissReason;
  /** Names the segment or placeholder that failed, for the wizard to show. */
  readonly detail: string;
}

export type AnatomyResult = AnatomyMatch | AnatomyMiss;

/**
 * Removes at most one ignored suffix, longest match first.
 *
 * Comparison is case-sensitive: a site that writes `-Spare` and `-SPARE` has
 * two conventions and should say so, rather than have the engine guess.
 */
function stripIgnoredSuffix(tag: string, suffixes: ReadonlyArray<string>): string {
  const candidates = [...suffixes]
    .filter((suffix) => suffix.length > 0)
    .sort((left, right) => right.length - left.length);
  const hit = candidates.find((suffix) => tag.endsWith(suffix));
  return hit === undefined ? tag : tag.slice(0, tag.length - hit.length);
}

function miss(reason: AnatomyMissReason, detail: string): AnatomyMiss {
  return { matched: false, reason, detail };
}

/** Segments a single tag, or explains why it could not. */
export function applyAnatomy(config: TagAnatomyConfig, tag: string): AnatomyResult {
  if (tag.length === 0) {
    return miss('empty-tag', 'the tag is empty');
  }

  const normalizedTag = stripIgnoredSuffix(tag, config.ignoredSuffixes ?? []);
  if (normalizedTag.length === 0) {
    return miss('empty-tag', `"${tag}" is nothing but an ignored suffix`);
  }

  const tokens = tokenize(config.separators, normalizedTag);
  if (tokens.length === 0) {
    return miss('no-tokens', `"${normalizedTag}" is nothing but separators`);
  }

  const join = joinSeparator(config.separators);
  const segments: Partial<Record<SegmentName, string>> = {};
  for (const name of SEGMENT_NAMES) {
    const extractor = config.segments[name];
    if (extractor === undefined) {
      continue;
    }
    const outcome = extractSegment(extractor, tokens, join);
    if (!outcome.ok) {
      return miss('extractor-miss', `segment "${name}": ${outcome.detail}`);
    }
    segments[name] = outcome.value;
  }

  const context: TemplateContext = { segments, tokens, join };

  let familyKey: string | undefined;
  if (config.familyKeyTemplate !== undefined) {
    const expanded = expandTemplate(config.familyKeyTemplate, context);
    if (!expanded.ok) {
      return miss('extractor-miss', `familyKeyTemplate: ${expanded.detail}`);
    }
    familyKey = expanded.value;
  }

  let localFamily: string | undefined;
  if (config.localFamilyTemplate !== undefined) {
    const expanded = expandTemplate(config.localFamilyTemplate, context);
    if (!expanded.ok) {
      return miss('extractor-miss', `localFamilyTemplate: ${expanded.detail}`);
    }
    localFamily = expanded.value;
  }

  // Optional keys are omitted rather than set to undefined: under
  // exactOptionalPropertyTypes an absent family key and a family key that is
  // undefined are different statements.
  return {
    matched: true,
    segments,
    ...(familyKey === undefined ? {} : { familyKey }),
    ...(localFamily === undefined ? {} : { localFamily }),
    normalizedTag,
  };
}
