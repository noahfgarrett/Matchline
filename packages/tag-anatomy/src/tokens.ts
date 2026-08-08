/**
 * Tokenizing and character classification.
 *
 * Everything here is structural. No pattern is ever compiled from profile
 * text, so a profile cannot hand the engine a regular expression to run --
 * `acceptedTagPatterns` belongs to the asset catalog, not to anatomy.
 */
import type { SegmentName } from '@matchline/domain';

/**
 * Every `SegmentName`, in the order previews and reports walk them.
 *
 * Order is fixed here rather than taken from the profile so that two runs over
 * the same tags produce identical output regardless of how the profile object
 * was written.
 */
export const SEGMENT_NAMES = ['role', 'system', 'unit', 'instance'] as const satisfies
  ReadonlyArray<SegmentName>;

/**
 * Compile-time completeness guard. Adding a member to `SegmentName` without
 * adding it here resolves this to `false` and the assignment stops compiling.
 */
type EverySegmentNameListed =
  Exclude<SegmentName, (typeof SEGMENT_NAMES)[number]> extends never ? true : false;

const SEGMENT_NAMES_ARE_COMPLETE: EverySegmentNameListed = true;
void SEGMENT_NAMES_ARE_COMPLETE;

/** ASCII letters only: tags are identifiers, not prose. */
function isAlpha(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

/** ASCII digits only, so `٣` is not silently a three. */
function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

/** The leading run of letters in `token`, possibly empty. */
export function alphaPrefixOf(token: string): string {
  let end = 0;
  while (end < token.length && isAlpha(token.charCodeAt(end))) {
    end += 1;
  }
  return token.slice(0, end);
}

/** The trailing run of digits in `token`, possibly empty. */
export function digitSuffixOf(token: string): string {
  let start = token.length;
  while (start > 0 && isDigit(token.charCodeAt(start - 1))) {
    start -= 1;
  }
  return token.slice(start);
}

/**
 * Separators ordered longest-first so that `--` wins over `-` where both are
 * configured. `Array.prototype.sort` is stable, so separators of equal length
 * keep the order the profile wrote them in. Empty separators are dropped: they
 * would match at every position and split the tag into nothing.
 */
export function activeSeparators(separators: ReadonlyArray<string>): readonly string[] {
  return [...separators]
    .filter((separator) => separator.length > 0)
    .sort((left, right) => right.length - left.length);
}

/**
 * Splits `value` on the configured separators, dropping empty tokens.
 *
 * With no usable separator the whole value is one token, which is what a site
 * whose tags are a single unbroken string needs.
 */
export function tokenize(separators: ReadonlyArray<string>, value: string): readonly string[] {
  const active = activeSeparators(separators);
  if (active.length === 0) {
    return value.length === 0 ? [] : [value];
  }

  const tokens: string[] = [];
  let tokenStart = 0;
  let index = 0;
  while (index < value.length) {
    const hit = active.find((separator) => value.startsWith(separator, index));
    if (hit === undefined) {
      index += 1;
      continue;
    }
    if (index > tokenStart) {
      tokens.push(value.slice(tokenStart, index));
    }
    index += hit.length;
    tokenStart = index;
  }
  if (value.length > tokenStart) {
    tokens.push(value.slice(tokenStart));
  }
  return tokens;
}

/**
 * What a `tokenRange` segment and a `{tokens:N-M}` placeholder rejoin with.
 *
 * The tokenizer discards which separator it saw, so rejoining picks the
 * profile's first separator. A site whose separators differ mid-tag should
 * address the characters it wants with `charRange` instead.
 */
export function joinSeparator(separators: ReadonlyArray<string>): string {
  return separators.find((separator) => separator.length > 0) ?? '';
}
