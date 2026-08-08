/**
 * Accepted-tag-pattern matching: glob-lite, and deliberately nothing more.
 *
 * `*` stands for any run of characters, including none. Every other character
 * is literal. There is no `?`, no character class, no escaping and no regular
 * expression: a Site Profile is hand-editable JSON, and a profile must never
 * be able to hand the engine a pattern that backtracks catastrophically or
 * that means something different from what its author read.
 *
 * Comparison is case-sensitive. Case folding is identity work (E2), not a
 * filter, and doing it here would quietly accept tags the profile did not ask
 * for.
 */

/** Splits on `*` and matches the literal pieces in order. No regex involved. */
function matchesPattern(value: string, pattern: string): boolean {
  const literals = pattern.split('*');
  if (literals.length === 1) {
    return value === pattern;
  }

  const first = literals[0] ?? '';
  const last = literals[literals.length - 1] ?? '';
  if (!value.startsWith(first)) {
    return false;
  }
  // Checked before the middle scan: with `first` consumed, an overlapping
  // suffix would otherwise be matched twice on inputs shorter than the pattern.
  if (!value.endsWith(last)) {
    return false;
  }
  if (first.length + last.length > value.length) {
    return false;
  }

  let cursor = first.length;
  const end = value.length - last.length;
  for (let index = 1; index < literals.length - 1; index += 1) {
    const literal = literals[index];
    if (literal === undefined || literal.length === 0) {
      continue;
    }
    const found = value.indexOf(literal, cursor);
    if (found === -1 || found + literal.length > end) {
      return false;
    }
    cursor = found + literal.length;
  }
  return true;
}

/**
 * Whether a tag is accepted.
 *
 * An empty or absent pattern list accepts every tag -- "the site did not
 * restrict tag shapes", not "the site accepts nothing".
 */
export function isTagAccepted(tag: string, patterns: ReadonlyArray<string> | undefined): boolean {
  if (patterns === undefined || patterns.length === 0) {
    return true;
  }
  return patterns.some((pattern) => matchesPattern(tag, pattern));
}
