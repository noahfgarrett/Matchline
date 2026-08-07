/**
 * Property Catalog (PRODUCT.md §6.5): what property names a model actually
 * carries, how widely, and what their values look like.
 *
 * Phase 1 ships statistics only. Deciding that `Dragon Data / Tag` is *the*
 * tag property is a mapping decision an engineer makes in Phase 2 — nothing
 * here guesses roles, and nothing here is heuristic.
 */
import type { ExtractionCache } from './cache.js';

/** How much of one source model carries a property. */
export interface SourceModelCoverage {
  /** `null` for objects the cache does not attribute to a source model. */
  readonly sourceModelId: number | null;
  /** Objects in this source model carrying the property. */
  readonly objectCount: number;
  /** Objects in this source model, carrying it or not. */
  readonly sourceModelObjectCount: number;
  /** `objectCount / sourceModelObjectCount`, or 0 when that model has none. */
  readonly objectFraction: number;
}

/** Statistics for one distinct `(category, name)` pair across the cache. */
export interface PropertyCatalogEntry {
  readonly category: string;
  readonly name: string;
  /** Objects carrying the property at least once. Repeats count once. */
  readonly objectCount: number;
  /** `objectCount / cache.objectCount()`, or 0 for an empty cache. */
  readonly objectFraction: number;
  /** Distinct non-null `value_text` values. Null-valued rows are excluded. */
  readonly distinctValueCount: number;
  /** Up to 5 distinct non-null values, first-seen in object-id order. */
  readonly exampleValues: readonly string[];
  /** Coverage per source model, keyed by id ascending with `null` last. */
  readonly bySourceModel: ReadonlyMap<number | null, SourceModelCoverage>;
}

const MAX_EXAMPLE_VALUES = 5;

interface Accumulator {
  readonly category: string;
  readonly name: string;
  lastObjectId: number | null;
  objectCount: number;
  readonly perSourceModel: Map<number | null, number>;
  readonly distinctValues: Set<string>;
  readonly exampleValues: string[];
}

/**
 * Computes the catalog in two passes over the cache: objects to learn which
 * source model each belongs to, then properties in `(object_id, encounter)`
 * order so example values are the first ones seen, not whichever the query
 * planner happened to return.
 *
 * The result is ordered by object coverage descending, then category and name
 * lexicographically — same cache, same array, every run.
 */
export function buildPropertyCatalog(cache: ExtractionCache): readonly PropertyCatalogEntry[] {
  const totalObjectCount = cache.objectCount();
  const sourceModelOfObject = new Map<number, number | null>();
  const objectsPerSourceModel = new Map<number | null, number>();
  for (const object of cache.allObjects()) {
    sourceModelOfObject.set(object.id, object.sourceModelId);
    objectsPerSourceModel.set(
      object.sourceModelId,
      (objectsPerSourceModel.get(object.sourceModelId) ?? 0) + 1,
    );
  }

  const accumulators = new Map<string, Accumulator>();
  for (const property of cache.allProperties()) {
    if (!sourceModelOfObject.has(property.objectId)) {
      // A property row pointing at an object that does not exist cannot be
      // attributed to anything; counting it would let a fraction exceed 1.
      continue;
    }
    const sourceModelId = sourceModelOfObject.get(property.objectId) ?? null;
    // NUL separator: no Navisworks display name contains one, so two distinct
    // (category, name) pairs can never collide into a single accumulator.
    const key = `${property.category}\u0000${property.name}`;
    let accumulator = accumulators.get(key);
    if (accumulator === undefined) {
      accumulator = {
        category: property.category,
        name: property.name,
        lastObjectId: null,
        objectCount: 0,
        perSourceModel: new Map<number | null, number>(),
        distinctValues: new Set<string>(),
        exampleValues: [],
      };
      accumulators.set(key, accumulator);
    }

    // Properties arrive grouped by object, so the previous id is enough to
    // count objects rather than rows when an object repeats a property.
    if (accumulator.lastObjectId !== property.objectId) {
      accumulator.lastObjectId = property.objectId;
      accumulator.objectCount += 1;
      accumulator.perSourceModel.set(
        sourceModelId,
        (accumulator.perSourceModel.get(sourceModelId) ?? 0) + 1,
      );
    }

    if (property.valueText !== null) {
      if (
        !accumulator.distinctValues.has(property.valueText) &&
        accumulator.exampleValues.length < MAX_EXAMPLE_VALUES
      ) {
        accumulator.exampleValues.push(property.valueText);
      }
      accumulator.distinctValues.add(property.valueText);
    }
  }

  const entries: PropertyCatalogEntry[] = [];
  for (const accumulator of accumulators.values()) {
    entries.push({
      category: accumulator.category,
      name: accumulator.name,
      objectCount: accumulator.objectCount,
      objectFraction: totalObjectCount === 0 ? 0 : accumulator.objectCount / totalObjectCount,
      distinctValueCount: accumulator.distinctValues.size,
      exampleValues: accumulator.exampleValues,
      bySourceModel: buildCoverage(accumulator.perSourceModel, objectsPerSourceModel),
    });
  }

  entries.sort((left, right) => {
    if (left.objectCount !== right.objectCount) {
      return right.objectCount - left.objectCount;
    }
    if (left.category !== right.category) {
      return left.category < right.category ? -1 : 1;
    }
    if (left.name === right.name) {
      return 0;
    }
    return left.name < right.name ? -1 : 1;
  });
  return entries;
}

/** Keys ascend by source model id with `null` last, so iteration is stable. */
function buildCoverage(
  perSourceModel: ReadonlyMap<number | null, number>,
  objectsPerSourceModel: ReadonlyMap<number | null, number>,
): ReadonlyMap<number | null, SourceModelCoverage> {
  const ids = [...perSourceModel.keys()].sort((left, right) => {
    if (left === null) {
      return right === null ? 0 : 1;
    }
    if (right === null) {
      return -1;
    }
    return left - right;
  });

  const coverage = new Map<number | null, SourceModelCoverage>();
  for (const sourceModelId of ids) {
    const objectCount = perSourceModel.get(sourceModelId) ?? 0;
    const sourceModelObjectCount = objectsPerSourceModel.get(sourceModelId) ?? 0;
    coverage.set(sourceModelId, {
      sourceModelId,
      objectCount,
      sourceModelObjectCount,
      objectFraction: sourceModelObjectCount === 0 ? 0 : objectCount / sourceModelObjectCount,
    });
  }
  return coverage;
}
