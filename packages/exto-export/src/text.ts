/**
 * Text primitives, ported from the donor's `core/text.js` and
 * `compiler/itemmasters.js`.
 *
 * Deliberately dumb, for the same reason `@matchline/learned-rules/src/text.ts`
 * is: an item-master table is matched against the spellings a prior registry
 * export actually used, so trimming and case-folding is all that is wanted. Real
 * tag normalization belongs to `@matchline/identity`.
 */

/** Donor `clean` (`core/text.js`): null-safe trim. */
export function clean(value: string | undefined): string {
  return value === undefined ? '' : value.trim();
}

/**
 * Donor `normPart` (`compiler/itemmasters.js`), plus whitespace collapsing.
 *
 * The donor only trimmed and lower-cased, so `MV  GEAR` and `MV GEAR` learned as
 * two keys. Collapsing runs of whitespace is the same deliberate hardening
 * `@matchline/learned-rules` applied to the sibling table: a double space in a
 * spreadsheet cell is never a real distinction.
 */
export function normalizePart(value: string | undefined): string {
  return clean(value).replace(/\s+/g, ' ').toLowerCase();
}

/**
 * Donor `firstWord`: the first whitespace-delimited word, normalized.
 *
 * The donor spelled this as `normPart(firstWord(description))` at both the
 * training and the lookup site; folding the two together here keeps the two
 * sites from drifting apart.
 */
export function firstWord(value: string | undefined): string {
  const words = normalizePart(value).split(' ');
  return words[0] ?? '';
}

/** Rounds for byte-stable serialization; `NaN`/infinities collapse to 0. */
export function round(value: number, places: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * UTF-16 code-unit comparison — `<` on strings, made explicit.
 *
 * Not `localeCompare`: its order depends on the machine's locale and ICU build,
 * and a byte-stable export cannot depend on either (`@matchline/mel-export`
 * makes the same choice for the same reason).
 */
export function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
