/**
 * Text and tag primitives, ported from the donor's `core/text.js` and
 * `compiler/nesting.js`.
 *
 * Deliberately dumb: no site rules, no regular-expression anatomy. Real tag
 * normalization belongs to `@matchline/identity` and real tag decomposition to
 * `@matchline/tag-anatomy`; a learned rule set is matched against training
 * spellings, so trimming and case-folding is all that is wanted here.
 */

/** Donor `clean`: null-safe trim. */
export function clean(value: string | undefined): string {
  return value === undefined ? '' : value.trim();
}

/**
 * Donor `normPart`, plus whitespace collapsing.
 *
 * The donor only trimmed, so `AIR  HANDLING` and `AIR HANDLING` learned as two
 * patterns. Collapsing runs of whitespace is a deliberate hardening: a double
 * space in a spreadsheet cell is never a real distinction.
 */
export function normalizeText(value: string | undefined): string {
  return clean(value).replace(/\s+/g, ' ').toLowerCase();
}

/** Donor `maskedDescription`'s masking half: every digit run becomes `#`. */
export function maskDigits(value: string): string {
  return value.replace(/\d+/g, '#');
}

/**
 * Donor `maskedDescription`: the class key a description is looked up by.
 *
 * `AIR HANDLING UNIT 001` and `AIR HANDLING UNIT 002` collapse onto
 * `air handling unit #`, which is the whole point -- the instance number is
 * nomenclature, the words are the role.
 */
export function descriptionPattern(description: string | undefined): string {
  return maskDigits(normalizeText(description));
}

/**
 * Identity key for a training tag. The donor's `tagKey` ran the site's
 * configured tag rules first; here it is trim + case-fold only (see the module
 * note).
 */
export function tagKey(tag: string | undefined): string {
  return clean(tag).toLowerCase();
}

/** Donor `tagBody`: the tag with every separator removed. */
export function tagBody(tag: string | undefined): string {
  return tagKey(tag).replace(/[^a-z0-9]/g, '');
}

/** Donor `coordsOf`: the tag's digit runs, in order. `MAH001-10-01` -> 001,10,01. */
export function numberRunsOf(tag: string | undefined): ReadonlyArray<string> {
  return tagKey(tag).match(/\d+/g) ?? [];
}

/**
 * The class label a training row carries.
 *
 * The donor read this straight off the registry export's Equipment
 * Classification column. A Matchline `TrainingRow` has no such column, so the
 * label is derived from the tag's role token instead: the first token whose
 * leading letter run is at least two characters (`MAH001-10-01` -> `MAH`,
 * `B14-TT-7001-02A` -> `TT`), falling back to the first letter run of any
 * length. That is the same thing the donor's column held -- the role the
 * description is being learned to predict -- and it keeps the learned table's
 * confidence honest, because one masked description really can carry two role
 * labels across a site.
 */
export function roleClassOf(tag: string | undefined): string {
  const tokens = tagKey(tag).split(/[^a-z0-9]+/);
  let fallback = '';
  for (const token of tokens) {
    const letters = token.match(/^[a-z]+/);
    if (letters === null) continue;
    const run = letters[0];
    if (run.length >= 2) return run.toUpperCase();
    if (fallback === '') fallback = run;
  }
  return fallback.toUpperCase();
}

/**
 * Donor `sharedRun`: the longest run of digit groups two tags have in common,
 * in the same order. This is the "number nomenclature picks the instance" half
 * of the policy -- `TIT002-10-02` shares all three runs with `VFD002-10-02` and
 * only one with `VFD001-10-01`.
 */
export function sharedRun(a: ReadonlyArray<string>, b: ReadonlyArray<string>): number {
  let best = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let n = 0;
      while (i + n < a.length && j + n < b.length && a[i + n] === b[j + n]) n++;
      if (n > best) best = n;
    }
  }
  return best;
}

/** Rounds for byte-stable serialization; `NaN`/infinities collapse to 0. */
export function round(value: number, places: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
