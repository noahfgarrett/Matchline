/**
 * Anatomy identity: two differently-punctuated tags that decompose identically.
 *
 * `MAH001-10-01` and `MAH001_10_01` are the same equipment written two ways,
 * and a site that taught its anatomy has already said so. Identity here is the
 * whole decomposition -- every configured segment, the family key, and the
 * tokens those were read out of -- so a shared family with a different role is
 * never mistaken for the same asset, and neither are two tags that agree only
 * on the part of the tag the anatomy happens to address.
 */
import type { TagAnatomyConfig } from '@matchline/domain';
import { applyAnatomy, SEGMENT_NAMES, tokenize } from '@matchline/tag-anatomy';

/** Key parts that address raw tokens rather than a named part of the tag. */
const TOKEN_PART = /^token\d+=/;

/**
 * Whether this anatomy says enough to establish identity at all.
 *
 * An anatomy with no segments and no family key gives every parsing tag the
 * same empty decomposition, which would make the tier claim every tag matches
 * every other. That is not identity, so the tier stays off.
 */
export function anatomyCanIdentify(config: TagAnatomyConfig): boolean {
  const hasSegment = SEGMENT_NAMES.some((name) => config.segments[name] !== undefined);
  return hasSegment || config.familyKeyTemplate !== undefined;
}

/**
 * A comparable key for a tag's decomposition, or `undefined` if it does not
 * parse. A partial parse is a miss: `applyAnatomy` only reports a match when
 * every configured segment and template resolved.
 */
export function anatomyIdentityKey(config: TagAnatomyConfig, tag: string): string | undefined {
  const result = applyAnatomy(config, tag);
  if (!result.matched) {
    return undefined;
  }

  const parts: string[] = [];

  // The tokens the anatomy actually saw, after any declared ignorable suffix
  // was stripped. Identity may not be claimed over a part of the tag the
  // anatomy never addressed: an anatomy that reads tokens 0-2 says nothing
  // about a fourth, so `MAH001-10-01-A` and `MAH001-10-01-B` would otherwise
  // decompose identically and merge -- exactly the silent merge DECISIONS.md
  // rules out ("suffixed tags are distinct identities"). A site that means a
  // trailing token to be disposable says so with `ignoredSuffixes`, and then
  // the tokens do match.
  const tokens = tokenize(config.separators, result.normalizedTag);
  tokens.forEach((token, position) => {
    parts.push(`token${position}=${token}`);
  });

  for (const name of SEGMENT_NAMES) {
    const value = result.segments[name];
    if (value === undefined) {
      continue;
    }
    parts.push(`${name}=${value}`);
  }
  if (config.familyKeyTemplate !== undefined) {
    parts.push(`familyKey=${result.familyKey ?? ''}`);
  }
  return parts.length === 0 ? undefined : parts.join('\u0000');
}

/**
 * The same key, rendered for a reviewer rather than for a map.
 *
 * The token parts are dropped: they are how the key refuses to reach past what
 * the anatomy addressed, not something a reviewer needs read back to them.
 */
export function describeAnatomyKey(key: string): string {
  return key.split('\u0000')
    .filter((part) => !TOKEN_PART.test(part))
    .join(', ');
}
