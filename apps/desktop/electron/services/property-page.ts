import type { PropertyCatalogEntry } from '@matchline/model-schema';

import type {
  WirePropertyCatalogRow,
  WirePropertySort,
  WireSuggestedRole,
} from '../../shared/schemas.js';

/**
 * Screen 2: one window of the Property Catalog, plus the name-based hints.
 *
 * The catalog itself is a full scan of the extraction cache and stays in main;
 * the renderer's virtual list asks for the rows it is about to draw and nothing
 * else (APP.md "IPC contract").
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

function matchesSearch(entry: PropertyCatalogEntry, needle: string): boolean {
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
  left: PropertyCatalogEntry,
  right: PropertyCatalogEntry,
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

export function catalogPage(
  catalog: readonly PropertyCatalogEntry[],
  totalObjects: number,
  request: PropertyPageRequest,
): { readonly total: number; readonly rows: readonly WirePropertyCatalogRow[] } {
  const filtered = catalog.filter((entry: PropertyCatalogEntry): boolean =>
    matchesSearch(entry, request.search.trim()),
  );

  const sorted = [...filtered].sort(
    (left: PropertyCatalogEntry, right: PropertyCatalogEntry): number => {
      const order = compare(left, right, request.sortBy);
      return request.descending ? -order : order;
    },
  );

  const rows = sorted
    .slice(request.offset, request.offset + request.limit)
    .map((entry: PropertyCatalogEntry): WirePropertyCatalogRow => {
      return {
        category: entry.category,
        name: entry.name,
        objectCount: entry.objectCount,
        coverage: totalObjects === 0 ? 0 : entry.objectCount / totalObjects,
        distinctValueCount: entry.distinctValueCount,
        examples: entry.exampleValues.slice(0, EXAMPLE_LIMIT),
        suggestedRole: suggestedRoleFor(entry.name),
      };
    });

  return { total: sorted.length, rows };
}
