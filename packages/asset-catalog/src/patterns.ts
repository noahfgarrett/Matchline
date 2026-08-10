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

/**
 * Whether a filename-pattern rule's `match` is one this package can run (P0-8).
 *
 * Exactly one `*`. Zero would make the rule an exact match wearing a pattern's
 * clothes, and two would make `$1` ambiguous -- a rule whose author cannot tell
 * which run of characters they captured is a rule that assigns the wrong
 * building to a whole file.
 */
export function isCapturePattern(pattern: string): boolean {
  return pattern.indexOf('*') !== -1 && pattern.indexOf('*') === pattern.lastIndexOf('*');
}

/**
 * Matches `value` against a one-star pattern and returns what the star covered,
 * or `null` when it does not match.
 *
 * The capture may be empty: `*` stands for any run of characters *including
 * none*, exactly as it does in {@link isTagAccepted}, and a rule whose `$1`
 * expands to nothing states a blank value, which the caller drops as it drops
 * every other blank.
 *
 * Case-sensitive, and no regular expression anywhere near it -- for the same
 * reasons this file's header gives.
 *
 * @throws Error when `pattern` does not carry exactly one `*`. Callers validate
 * with {@link isCapturePattern} first and report a typed configuration error;
 * this throw is the guard on that contract, not a path a profile can reach.
 */
export function captureFromPattern(value: string, pattern: string): string | null {
  const star = pattern.indexOf('*');
  if (!isCapturePattern(pattern)) {
    throw new Error(`capture pattern ${JSON.stringify(pattern)} needs exactly one '*'`);
  }
  const prefix = pattern.slice(0, star);
  const suffix = pattern.slice(star + 1);
  if (prefix.length + suffix.length > value.length) {
    return null;
  }
  if (!value.startsWith(prefix) || !value.endsWith(suffix)) {
    return null;
  }
  return value.slice(prefix.length, value.length - suffix.length);
}

/**
 * Substitutes a pattern's capture into an assigned value.
 *
 * `$1` is the only thing that means anything; every other character, `$`
 * included, is literal. One placeholder and no escape vocabulary, because a
 * profile author reading `$1` should not have to know a second rule to predict
 * what they get.
 */
export function applyCapture(value: string, capture: string): string {
  return value.replaceAll('$1', capture);
}
