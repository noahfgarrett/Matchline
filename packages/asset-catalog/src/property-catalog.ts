/**
 * The Property Catalog over a whole universe (P0-1).
 *
 * > Property Catalog aggregates across sources with per-source + overall
 * > coverage.
 *
 * A single-cache catalog (`@matchline/model-schema`) answers "does this file
 * carry Dragon Data > Tag". Once a project holds several files the question a
 * person actually asks is "does the SITE carry it, and which file is the one
 * that does not" -- a 60% overall coverage means something entirely different
 * when one source is at 100% and another at 0%. So both numbers are reported,
 * and neither is derivable from the other.
 *
 * Counting is model-schema's; only the aggregation lives here.
 */
import {
  buildSourceModelCoverage,
  comparePropertyCoverage,
  collectPropertyStatistics,
  MAX_EXAMPLE_VALUES,
  type SourceModelCoverage,
} from '@matchline/model-schema';

import { orderCatalogSources, type CatalogSource } from './sources.js';

/** How much of one source carries a property. */
export interface PropertySourceCoverage {
  readonly sourceId: string;
  /** Objects in this source carrying the property. */
  readonly objectCount: number;
  /** Objects in this source, carrying it or not. */
  readonly sourceObjectCount: number;
  /** `objectCount / sourceObjectCount`, or 0 when the source has no objects. */
  readonly objectFraction: number;
  /**
   * The same coverage per source model within this source, keyed by id
   * ascending with `null` last.
   *
   * Kept rather than flattened: a federated source really is several models,
   * and "which appended model is missing the tag" is the question a coordinator
   * has to answer before they can ask anyone to fix it.
   */
  readonly bySourceModel: ReadonlyMap<number | null, SourceModelCoverage>;
}

/** Statistics for one distinct `(category, name)` pair across the universe. */
export interface UniversePropertyCatalogEntry {
  readonly category: string;
  readonly name: string;
  /** Objects carrying the property at least once, across every source. */
  readonly objectCount: number;
  /** `objectCount` over every object in the universe, or 0 when there are none. */
  readonly objectFraction: number;
  /** Distinct non-null values across the universe. Null-valued rows excluded. */
  readonly distinctValueCount: number;
  /**
   * Up to 5 distinct values, ordered by source id and then by object id, so the
   * examples are a function of the project rather than of the array order.
   */
  readonly exampleValues: ReadonlyArray<string>;
  /** Coverage per source, keyed by source id ascending. */
  readonly bySource: ReadonlyMap<string, PropertySourceCoverage>;
}

/**
 * NUL separator: no Navisworks category or property name contains one, so two
 * distinct `(category, name)` pairs can never collide into one accumulator.
 * Written as an escape rather than a literal so an editor cannot quietly turn
 * it into a space.
 */
const PROPERTY_KEY_SEPARATOR = '\u0000';

interface UniverseAccumulator {
  readonly category: string;
  readonly name: string;
  objectCount: number;
  readonly distinctValues: Set<string>;
  readonly bySource: Map<string, PropertySourceCoverage>;
}

/**
 * The catalog for a whole universe, ordered by overall coverage descending,
 * then category and name -- the same order a single-cache catalog uses.
 *
 * @throws AssetCatalogConfigError when two sources share a `sourceId` or a
 * `sourceId` is blank.
 */
export function buildUniversePropertyCatalog(
  sources: ReadonlyArray<CatalogSource>,
): ReadonlyArray<UniversePropertyCatalogEntry> {
  const ordered = orderCatalogSources(sources);

  const accumulators = new Map<string, UniverseAccumulator>();
  let universeObjectCount = 0;

  for (const source of ordered) {
    const statistics = collectPropertyStatistics(source.cache);
    universeObjectCount += statistics.totalObjectCount;

    for (const property of statistics.properties) {
      const key = `${property.category}${PROPERTY_KEY_SEPARATOR}${property.name}`;
      let accumulator = accumulators.get(key);
      if (accumulator === undefined) {
        accumulator = {
          category: property.category,
          name: property.name,
          objectCount: 0,
          distinctValues: new Set<string>(),
          bySource: new Map<string, PropertySourceCoverage>(),
        };
        accumulators.set(key, accumulator);
      }

      accumulator.objectCount += property.objectCount;
      // Sources are walked in id order and each cache's set is already in
      // object order, so insertion order here IS "by source, then by object".
      for (const value of property.distinctValues) {
        accumulator.distinctValues.add(value);
      }
      accumulator.bySource.set(source.sourceId, {
        sourceId: source.sourceId,
        objectCount: property.objectCount,
        sourceObjectCount: statistics.totalObjectCount,
        objectFraction:
          statistics.totalObjectCount === 0
            ? 0
            : property.objectCount / statistics.totalObjectCount,
        bySourceModel: buildSourceModelCoverage(
          property.perSourceModel,
          statistics.objectsPerSourceModel,
        ),
      });
    }
  }

  const entries: UniversePropertyCatalogEntry[] = [...accumulators.values()].map(
    (accumulator) => ({
      category: accumulator.category,
      name: accumulator.name,
      objectCount: accumulator.objectCount,
      objectFraction:
        universeObjectCount === 0 ? 0 : accumulator.objectCount / universeObjectCount,
      distinctValueCount: accumulator.distinctValues.size,
      exampleValues: [...accumulator.distinctValues].slice(0, MAX_EXAMPLE_VALUES),
      bySource: accumulator.bySource,
    }),
  );

  entries.sort(comparePropertyCoverage);
  return entries;
}
