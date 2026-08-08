/**
 * The systemKey join index (PRODUCT.md §5.3 + §5.5).
 *
 * A `mel-lookup` joining by systemKey compares a key the chain resolved against
 * the keys the MEL states. The resolved key has been through the profile's
 * `normalization`; the MEL's keys have not, because the System Catalog is
 * shared and serialized and keeping it raw-keyed is what makes `001` and `1`
 * still distinguishable in it.
 *
 * So the normalization is applied to the MEL side here instead, once per
 * compile rather than once per subject, and both sides of the join finally
 * speak the same language.
 *
 * When two raw spellings normalize onto one key the join is ambiguous. Nothing
 * is chosen: `1` and `001` may be one system written twice or two systems, and
 * only the site knows which.
 */
import type { NormalizationStep } from '@matchline/domain';

import { normalizeSystemValue } from './normalize.js';
import type { MelCatalogRow, SystemCatalog } from './types.js';

/**
 * Normalized system key -> every raw MEL spelling that reaches it, in
 * first-seen order. More than one spelling means the join is ambiguous.
 */
export type SystemJoinIndex = ReadonlyMap<string, ReadonlyArray<string>>;

/**
 * Builds the index from whichever MEL side the caller supplied.
 *
 * The catalog wins when both are present, matching `evaluateMelLookup`: the
 * catalog is the authority on what the MEL says about a key, and the rows are
 * consulted only to recover a row address for provenance.
 */
export function buildSystemJoinIndex(
  catalog: SystemCatalog | undefined,
  melRows: ReadonlyArray<MelCatalogRow> | undefined,
  normalization: ReadonlyArray<NormalizationStep>,
): SystemJoinIndex {
  const index = new Map<string, string[]>();
  const seen = new Set<string>();

  const add = (rawKey: string): void => {
    if (rawKey.length === 0 || seen.has(rawKey)) {
      return;
    }
    seen.add(rawKey);
    const normalized = normalizeSystemValue(rawKey, normalization).value;
    if (normalized.length === 0) {
      return;
    }
    const bucket = index.get(normalized);
    if (bucket === undefined) {
      index.set(normalized, [rawKey]);
    } else {
      bucket.push(rawKey);
    }
  };

  if (catalog !== undefined) {
    for (const key of catalog.keys()) {
      add(key);
    }
  } else if (melRows !== undefined) {
    for (const row of melRows) {
      add(row.systemKey?.trim() ?? '');
    }
  }

  return index;
}
