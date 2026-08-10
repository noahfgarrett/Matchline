import type { UniversePropertyCatalogEntry } from '@matchline/asset-catalog';

import type {
  WirePropertyCatalogRow,
  WirePropertySort,
  WirePropertySourceCoverage,
  WireSuggestedRole,
} from '../../shared/schemas.js';

/**
 * Screen 2: one window of the Property Catalog, plus the name-based hints.
 *
 * The catalog is a full scan of every extraction cache in the universe and
 * stays in main; the renderer's virtual list asks for the rows it is about to
 * draw and nothing else (APP.md "IPC contract").
 *
 * ## One catalog over many sources
 *
 * The rows are `@matchline/asset-catalog`'s `UniversePropertyCatalogEntry`, so
 * a row's coverage is coverage across the whole project and `bySource` is the
 * same fact per file (P0-1). Both are shown, because neither is derivable from
 * the other: a tag property at 60% overall is a mapping worth making when every
 * source is at 60%, and a missing export when one source is at 100% and the
 * next at 0%.
 *
 * ## What "suggested role" is, and what it is not
 *
 * PRODUCT.md §6.5 lists six signals a suggestion could rest on: name synonyms,
 * fill rate, cardinality, value shape, tag overlap with the connectivity
 * sources, and consistency by source model. This round implements the first one
 * only — a literal synonym list matched against the property name. That is
 * deliberate and it is why the UI labels these "suggestions" and never
 * pre-selects from them: a name-only hint is a starting point for a person, not
 * a decision. Nothing downstream reads this field.
 */

export interface PropertyPageRequest {
  readonly offset: number;
  readonly limit: number;
  readonly sortBy: WirePropertySort;
  readonly descending: boolean;
  readonly search: string;
}

const EXAMPLE_LIMIT = 3;

/**
 * Literal header synonyms, folded to lowercase alphanumerics.
 *
 * Exact matches only. `Tag` suggests the equipment tag; `Tag Colour` does not,
 * because a substring rule turns a hint into a guess.
 */
const ROLE_SYNONYMS: ReadonlyArray<readonly [WireSuggestedRole, ReadonlySet<string>]> = [
  [
    'equipment-tag',
    new Set([
      'tag',
      'tagno',
      'tagnumber',
      'equipmenttag',
      'equipmentid',
      'equipmentnumber',
      'assettag',
      'assetid',
      'mark',
      'itemmark',
    ]),
  ],
  ['building', new Set(['building', 'buildingname', 'buildingcode', 'bldg', 'facility'])],
  [
    'description',
    new Set([
      'description',
      'desc',
      'equipmentdescription',
      'itemdescription',
      'servicedescription',
    ]),
  ],
];

function fold(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function suggestedRoleFor(propertyName: string): WireSuggestedRole | null {
  const folded = fold(propertyName);
  for (const [role, synonyms] of ROLE_SYNONYMS) {
    if (synonyms.has(folded)) {
      return role;
    }
  }
  return null;
}

function matchesSearch(entry: UniversePropertyCatalogEntry, needle: string): boolean {
  if (needle === '') {
    return true;
  }
  const lowered = needle.toLowerCase();
  return (
    entry.name.toLowerCase().includes(lowered) || entry.category.toLowerCase().includes(lowered)
  );
}

/**
 * Compares two entries under one sort key.
 *
 * Ties always fall back to category then name so the same catalog produces the
 * same page every time — a virtual list that reshuffles equal rows between
 * fetches looks broken even when the numbers are right.
 */
function compare(
  left: UniversePropertyCatalogEntry,
  right: UniversePropertyCatalogEntry,
  sortBy: WirePropertySort,
): number {
  switch (sortBy) {
    case 'coverage': {
      if (left.objectCount !== right.objectCount) {
        return left.objectCount - right.objectCount;
      }
      break;
    }
    case 'distinct': {
      if (left.distinctValueCount !== right.distinctValueCount) {
        return left.distinctValueCount - right.distinctValueCount;
      }
      break;
    }
    case 'name': {
      const byName = left.name.localeCompare(right.name);
      if (byName !== 0) {
        return byName;
      }
      break;
    }
    default: {
      const exhaustive: never = sortBy;
      throw new Error(`Unhandled sort key: ${String(exhaustive)}`);
    }
  }
  return left.category.localeCompare(right.category) || left.name.localeCompare(right.name);
}

/**
 * @param sourceLabels short display name per source id
 * ({@link shortSourceLabels}). A source id with no label prints as itself
 * rather than as nothing.
 */
export function catalogPage(
  catalog: readonly UniversePropertyCatalogEntry[],
  sourceLabels: ReadonlyMap<string, string>,
  request: PropertyPageRequest,
): { readonly total: number; readonly rows: readonly WirePropertyCatalogRow[] } {
  const filtered = catalog.filter((entry: UniversePropertyCatalogEntry): boolean =>
    matchesSearch(entry, request.search.trim()),
  );

  const sorted = [...filtered].sort(
    (left: UniversePropertyCatalogEntry, right: UniversePropertyCatalogEntry): number => {
      const order = compare(left, right, request.sortBy);
      return request.descending ? -order : order;
    },
  );

  const rows = sorted
    .slice(request.offset, request.offset + request.limit)
    .map((entry: UniversePropertyCatalogEntry): WirePropertyCatalogRow => {
      const bySource: WirePropertySourceCoverage[] = [];
      // `bySource` is keyed by source id ascending by construction
      // (`buildUniversePropertyCatalog`), so the disclosure prints in a stable
      // order without a second sort.
      for (const [sourceId, coverage] of entry.bySource) {
        bySource.push({
          sourceId,
          label: sourceLabels.get(sourceId) ?? sourceId,
          objectCount: coverage.objectCount,
          coverage: coverage.objectFraction,
        });
      }

      return {
        category: entry.category,
        name: entry.name,
        objectCount: entry.objectCount,
        // The universe's own fraction, not a recount: a page must never
        // disagree with the catalog it is a window onto.
        coverage: entry.objectFraction,
        distinctValueCount: entry.distinctValueCount,
        examples: entry.exampleValues.slice(0, EXAMPLE_LIMIT),
        suggestedRole: suggestedRoleFor(entry.name),
        bySource,
      };
    });

  return { total: sorted.length, rows };
}
