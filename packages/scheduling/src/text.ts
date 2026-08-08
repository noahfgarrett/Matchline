/**
 * The small text normalizers the commissioning outputs share.
 *
 * Each one is a port of a donor helper, restated here rather than imported,
 * because the donor's versions live inside a running app: `tagKey`
 * (`packages/legacy-parity/src/state.js`) routes through the active profile's
 * rule engine and a generation-keyed memo, and `natCmp`
 * (`packages/legacy-parity/src/core/text.js`) is an `Intl.Collator` built with
 * `undefined` for the locale. Neither is available — or wanted — in a pure,
 * deterministic engine package.
 *
 * Full tag identity (aliases, anatomy, suffix rules) is `@matchline/identity`'s
 * job. What is needed here is the donor's *raw* tag cleanup only: a P6 row and
 * a canonical asset that spell the same tag with a different dash or a stray
 * space must land on the same key.
 */

/** The donor's `clean`: `String(v ?? '')` then `.trim()`. */
export function clean(value: string | undefined | null): string {
  return value === undefined || value === null ? '' : value.trim();
}

/**
 * The comparison key for an equipment tag.
 *
 * A port of the donor's `cleanTagRaw` (`src/core/tags.js`) with its lowercase
 * fold: NFKC normalization, zero-width characters stripped, the Unicode dash
 * family folded onto ASCII `-`, and whitespace around a dash collapsed, so
 * `MAH001 - 10 - 01` and `MAH001‑10‑01` both key as `mah001-10-01`.
 */
export function tagKey(value: string | undefined | null): string {
  return clean(value)
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u2010-\u2015\u2212]/g, '-')
    .replace(/\s*-\s*/g, '-')
    .toLowerCase();
}

/**
 * The comparison key for a system identifier (the donor's `melUpnKey`,
 * `src/hierarchy/build.js`): trimmed, all internal whitespace removed,
 * lowercased.
 *
 * Note what it does not do: it never strips leading zeros. System identifiers
 * are strings (PRODUCT.md §5.5), so `001` and `1` remain two different systems
 * here exactly as they do in the System Catalog.
 */
export function systemKeyOf(value: string | undefined | null): string {
  return clean(value).replace(/\s+/g, '').toLowerCase();
}

/** Digit runs and non-digit runs, the chunks {@link naturalCompare} compares. */
const CHUNK_PATTERN = /\d+|\D+/g;

/** True when a chunk is a run of digits. */
function isDigitChunk(chunk: string): boolean {
  return chunk.charCodeAt(0) >= 0x30 && chunk.charCodeAt(0) <= 0x39;
}

/**
 * The donor's natural ordering, made host-independent.
 *
 * The donor compares with `new Intl.Collator(undefined, { numeric: true,
 * sensitivity: 'base' })`. Passing `undefined` for the locale means the host's
 * default locale decides the order, which would make the same project sequence
 * differently on two machines — unacceptable when "same inputs produce the same
 * output" is an acceptance criterion (PRODUCT.md §21). This is the same
 * reasoning `@matchline/spreadsheet-import`'s header fold gives for using a
 * locale-free `toLowerCase()`.
 *
 * The rule implemented instead, which agrees with the collator on the tags this
 * engine sees: split both strings into digit and non-digit runs; digit runs
 * compare by numeric value; non-digit runs compare case-insensitively by code
 * unit; a digit run sorts before a non-digit run. Ties are then broken by the
 * raw text (leading zeros first, then code-unit order) so the comparator is a
 * total order and never reports two different tags as equal.
 */
export function naturalCompare(left: string, right: string): number {
  const leftChunks = left.match(CHUNK_PATTERN) ?? [];
  const rightChunks = right.match(CHUNK_PATTERN) ?? [];
  const shared = Math.min(leftChunks.length, rightChunks.length);
  for (let index = 0; index < shared; index++) {
    const a = leftChunks[index];
    const b = rightChunks[index];
    if (a === undefined || b === undefined) break;
    const aDigits = isDigitChunk(a);
    const bDigits = isDigitChunk(b);
    if (aDigits !== bDigits) return aDigits ? -1 : 1;
    if (aDigits && bDigits) {
      const aValue = a.replace(/^0+(?=\d)/, '');
      const bValue = b.replace(/^0+(?=\d)/, '');
      if (aValue.length !== bValue.length) return aValue.length < bValue.length ? -1 : 1;
      if (aValue !== bValue) return aValue < bValue ? -1 : 1;
      /* Numerically equal, textually different: `001` before `1`. */
      if (a.length !== b.length) return a.length > b.length ? -1 : 1;
      continue;
    }
    const aFolded = a.toLowerCase();
    const bFolded = b.toLowerCase();
    if (aFolded !== bFolded) return aFolded < bFolded ? -1 : 1;
    if (a !== b) return a < b ? -1 : 1;
  }
  if (leftChunks.length !== rightChunks.length) {
    return leftChunks.length < rightChunks.length ? -1 : 1;
  }
  return 0;
}
