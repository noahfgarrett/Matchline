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
 *
 * The MEL row index below is the same idea applied to the other half of the
 * join. Once a rung knows which MEL key it matched it still has to name the
 * row that said so, and scanning the rows for it is the same per-subject sweep
 * this file exists to avoid. Both indexes are built once per compile.
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

/**
 * Every MEL-side index, built once for a whole compile and shared by every
 * subject. Passed as a group because they are always built and always consulted
 * together, and because a rung needs them to answer one `mel-lookup`.
 */
export interface MelIndexes {
  readonly join: SystemJoinIndex;
  readonly rows: MelRowIndex;
  readonly byTag: MelTagIndex;
}

/** Builds every index from whichever MEL side the caller supplied. */
export function buildMelIndexes(
  catalog: SystemCatalog | undefined,
  melRows: ReadonlyArray<MelCatalogRow> | undefined,
  normalization: ReadonlyArray<NormalizationStep>,
): MelIndexes {
  return {
    join: buildSystemJoinIndex(catalog, melRows, normalization),
    rows: buildMelRowIndex(melRows),
    byTag: buildMelTagIndex(melRows),
  };
}

/** Equipment tag -> the rows stating it, in workbook order. */
export type MelTagIndex = ReadonlyMap<string, ReadonlyArray<MelCatalogRow>>;

/**
 * Indexes the MEL rows by the equipment tag a tag join matches on.
 *
 * Keyed by the tag exactly as the workbook wrote it, because that is what the
 * scan this replaces compared: `evaluateMelLookup` tests
 * `row.equipmentTag !== subject.canonicalTag`, both sides already canonical,
 * and a tag that only matches after fuzzing is a data problem to surface rather
 * than an index to widen. What changes is the cost -- a tag join used to read
 * every row for every subject, which on 40,000 assets and a 40,000-row MEL is
 * 1.6 billion comparisons for an answer a map gives in one.
 */
export function buildMelTagIndex(
  melRows: ReadonlyArray<MelCatalogRow> | undefined,
): MelTagIndex {
  const index = new Map<string, MelCatalogRow[]>();
  if (melRows === undefined) {
    return index;
  }
  for (const row of melRows) {
    const tag = row.equipmentTag;
    if (tag === undefined) {
      continue;
    }
    const bucket = index.get(tag);
    if (bucket === undefined) {
      index.set(tag, [row]);
    } else {
      bucket.push(row);
    }
  }
  return index;
}

/** What the MEL rows state about one trimmed systemKey, in row order. */
export interface MelRowGroup {
  /** First row stating this key, whatever else it says. */
  readonly firstRow: MelCatalogRow;
  /** First nonblank trimmed description among those rows; '' when none states one. */
  readonly firstStatedDescription: string;
  /** Trimmed description -> first row of this key stating exactly it. */
  readonly rowByDescription: ReadonlyMap<string, MelCatalogRow>;
}

/** Trimmed systemKey -> the rows stating it. Keys are raw, as the MEL wrote them. */
export type MelRowIndex = ReadonlyMap<string, MelRowGroup>;

/** Mutable while building; the group is handed out read-only. */
interface MutableMelRowGroup {
  readonly firstRow: MelCatalogRow;
  firstStatedDescription: string;
  readonly rowByDescription: Map<string, MelCatalogRow>;
}

/**
 * Indexes the MEL rows by the trimmed systemKey a `mel-lookup` matches on.
 *
 * Every bucket keeps first-seen rows only, because that is what the scan this
 * replaces returned: the first row stating the key, and the first row stating
 * the key together with a given description. A blank key gets a bucket like any
 * other -- `buildSystemJoinIndex` never yields a blank key to look up, so the
 * bucket is unreachable, and dropping it would be a rule this file does not
 * need to have.
 */
export function buildMelRowIndex(melRows: ReadonlyArray<MelCatalogRow> | undefined): MelRowIndex {
  const index = new Map<string, MutableMelRowGroup>();
  if (melRows === undefined) {
    return index;
  }

  for (const row of melRows) {
    const key = row.systemKey?.trim() ?? '';
    const description = row.systemDescription?.trim() ?? '';

    let group = index.get(key);
    if (group === undefined) {
      group = { firstRow: row, firstStatedDescription: '', rowByDescription: new Map() };
      index.set(key, group);
    }
    if (group.firstStatedDescription.length === 0 && description.length > 0) {
      group.firstStatedDescription = description;
    }
    if (!group.rowByDescription.has(description)) {
      group.rowByDescription.set(description, row);
    }
  }

  return index;
}
