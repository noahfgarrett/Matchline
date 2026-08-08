/**
 * The System Catalog: systemKey -> description, as the MEL states it
 * (PRODUCT.md §5.7).
 *
 * The catalog is a description lookup, not an asset source. The equipment
 * universe still comes from the model (ENGINE.md semantics rule 1), so a key
 * appearing only here creates nothing.
 */
import type { ReviewItem } from '@matchline/domain';

import type {
  MelCatalogRow,
  SystemCatalog,
  SystemCatalogEntry,
  SystemCatalogResult,
} from './types.js';

interface CatalogAccumulator {
  description?: string;
  sourceRowCount: number;
  readonly aliases: string[];
  /** Every distinct nonblank description seen, first-seen order. */
  readonly descriptions: string[];
}

/**
 * Builds the catalog from pre-parsed MEL rows.
 *
 * Keys are grouped by their trimmed spelling and kept verbatim otherwise:
 * `001` never becomes `1` and `1` never becomes `001`. Only surrounding
 * whitespace is folded away, and the raw spelling that differed is kept as an
 * alias so the fold is visible. Anything beyond whitespace is a profile
 * `normalization` decision, not a catalog one.
 *
 * A key carrying more than one distinct nonblank description keeps the
 * first-seen one and raises a `system-catalog-conflict` listing all of them.
 * The compile does not stop; the ambiguity becomes an output.
 */
export function buildSystemCatalog(rows: ReadonlyArray<MelCatalogRow>): SystemCatalogResult {
  const accumulators = new Map<string, CatalogAccumulator>();

  for (const row of rows) {
    const rawKey = row.systemKey;
    if (rawKey === undefined) {
      continue;
    }
    const key = rawKey.trim();
    if (key.length === 0) {
      continue;
    }

    let accumulator = accumulators.get(key);
    if (accumulator === undefined) {
      accumulator = { sourceRowCount: 0, aliases: [], descriptions: [] };
      accumulators.set(key, accumulator);
    }
    accumulator.sourceRowCount += 1;

    if (rawKey !== key && !accumulator.aliases.includes(rawKey)) {
      accumulator.aliases.push(rawKey);
    }

    const description = row.systemDescription?.trim() ?? '';
    if (description.length === 0) {
      continue;
    }
    if (!accumulator.descriptions.includes(description)) {
      accumulator.descriptions.push(description);
    }
    if (accumulator.description === undefined) {
      accumulator.description = description;
    }
  }

  const catalog = new Map<string, SystemCatalogEntry>();
  const reviewItems: ReviewItem[] = [];

  for (const [key, accumulator] of accumulators) {
    const { description } = accumulator;
    catalog.set(key, {
      // Omitted rather than set to undefined: under exactOptionalPropertyTypes
      // "no description in the MEL" and "description: undefined" differ.
      ...(description === undefined ? {} : { description }),
      sourceRowCount: accumulator.sourceRowCount,
      aliases: accumulator.aliases,
    });

    if (accumulator.descriptions.length > 1) {
      reviewItems.push({
        kind: 'system-catalog-conflict',
        systemKey: key,
        descriptions: accumulator.descriptions,
      });
    }
  }

  return { catalog: catalog as SystemCatalog, reviewItems };
}
