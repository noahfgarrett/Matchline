/**
 * The shapes in `schemas/extraction-cache.sql`, expressed as TypeScript.
 *
 * This file is the reading half of that DDL's contract: the C# worker writes
 * the tables, this package reads them, and both sides move together when
 * `meta.schema_version` is bumped.
 */

/**
 * Cache schema versions this reader accepts, oldest first.
 *
 * A reader that understands more than one version is the price of not making
 * every cache on disk unreadable when the writer moves. v1 caches are still
 * read — see `readV1MembershipResolved` for the one thing v1 cannot say for
 * itself.
 */
export const SUPPORTED_SCHEMA_VERSIONS = ['1', '2'] as const;

export type SupportedSchemaVersion = (typeof SUPPORTED_SCHEMA_VERSIONS)[number];

/** The version a cache written today declares. The C# writer agrees (`CacheMetaKeys`). */
export const CURRENT_SCHEMA_VERSION: SupportedSchemaVersion = '2';

/** Type guard for `meta.schema_version`, applied before anything else is read. */
export function isSupportedSchemaVersion(value: string): value is SupportedSchemaVersion {
  return (SUPPORTED_SCHEMA_VERSIONS as readonly string[]).includes(value);
}

/**
 * What a v1 row means, now that v2 can say it explicitly.
 *
 * v1 has no `membership_resolved` column because a v1 writer never resolved a
 * saved search: it recorded the set and moved on, leaving the members table
 * empty for it. So the honest reading of a v1 row is exactly the writer's
 * behaviour — folders and fixed selections know their membership, saved
 * searches do not. Reading a v1 search set as resolved-and-empty would invent
 * an answer the writer never gave.
 */
export function readV1MembershipResolved(kind: SelectionSetKind): boolean {
  return kind !== 'search';
}

/**
 * Meta keys the DDL declares required. `schema_version` is checked first and
 * separately: a cache from a future writer must be refused by version, not by
 * complaining about keys that version never promised.
 */
export const REQUIRED_META_KEYS = [
  'schema_version',
  'input_file_name',
  'input_sha256',
  'input_bytes',
  'extracted_at_utc',
  'extractor_version',
  'adapter_version',
  'navisworks_version',
  'object_count',
] as const;

/** Tables the DDL creates. All must exist before a file counts as a cache. */
export const REQUIRED_TABLES = [
  'meta',
  'source_models',
  'objects',
  'properties',
  'selection_sets',
  'selection_set_members',
  'warnings',
] as const;

/** The `meta` table, typed. Numeric keys are parsed from their decimal strings. */
export interface ExtractionCacheMeta {
  readonly schemaVersion: string;
  /** Original NWD filename, name only — the DDL stores no directories. */
  readonly inputFileName: string;
  /** Lowercase hex digest of the NWD bytes; also the cache filename stem. */
  readonly inputSha256: string;
  readonly inputBytes: number;
  readonly extractedAtUtc: string;
  readonly extractorVersion: string;
  readonly adapterVersion: string;
  readonly navisworksVersion: string;
  /** Validated at open time against `COUNT(*)` of the objects table. */
  readonly objectCount: number;
}

/** One row of `source_models`. */
export interface SourceModel {
  readonly id: number;
  readonly parentId: number | null;
  readonly fileName: string | null;
  readonly displayName: string | null;
  readonly guid: string | null;
}

/** A source model with its nested appended models, children in id order. */
export interface SourceModelNode extends SourceModel {
  readonly children: readonly SourceModelNode[];
}

/** Optional per-object bounds. Present only when all six columns are set. */
export interface BoundingBox {
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly maxZ: number;
}

/** One row of `objects`. */
export interface ModelObject {
  readonly id: number;
  readonly sourceModelId: number | null;
  readonly parentId: number | null;
  /** Sibling position; `(parentId, pathIndex)` is unique across the cache. */
  readonly pathIndex: number;
  readonly depth: number;
  readonly displayName: string | null;
  readonly className: string | null;
  readonly instanceGuid: string | null;
  readonly authoringId: string | null;
  readonly bbox: BoundingBox | null;
}

/** One row of `properties`, minus the object id the caller already holds. */
export interface ObjectProperty {
  readonly category: string;
  readonly categoryInternal: string | null;
  readonly name: string;
  readonly nameInternal: string | null;
  readonly valueText: string | null;
  /** Navisworks `VariantDataType` name, e.g. `DisplayString`. */
  readonly valueType: string;
}

/** A property carrying the object it belongs to, for whole-cache scans. */
export interface ObjectPropertyRow extends ObjectProperty {
  readonly objectId: number;
}

/** `selection_sets.kind`, constrained by a CHECK in the DDL. */
export type SelectionSetKind = 'folder' | 'selection' | 'search';

/** One row of `selection_sets` with its members, member ids ascending. */
export interface SelectionSet {
  readonly id: number;
  readonly parentId: number | null;
  readonly name: string;
  readonly kind: SelectionSetKind;
  /**
   * Whether `memberObjectIds` is an answer.
   *
   * `false` means the extractor could not work this set's membership out — a
   * saved search that would not run — and `memberObjectIds` is then empty
   * because nothing is known, not because the set holds nothing. The two are
   * different facts and a caller must not collapse them: filtering a project by
   * an unresolved set has to refuse, never return zero assets
   * (docs/RELEASE-1.0-PLAN.md P0-3). A resolved set with no members is a set
   * that genuinely matched nothing.
   *
   * v1 caches carry no such column; they are read as resolved for folders and
   * fixed selections and unresolved for saved searches, which is what a v1
   * writer meant. See `readV1MembershipResolved`.
   */
  readonly membershipResolved: boolean;
  readonly memberObjectIds: readonly number[];
}

/** A selection set with its folder children, children in id order. */
export interface SelectionSetNode extends SelectionSet {
  readonly children: readonly SelectionSetNode[];
}

/** `warnings.severity`, constrained by a CHECK in the DDL. */
export type WarningSeverity = 'info' | 'warning' | 'error';

/** One row of `warnings`. */
export interface CacheWarning {
  readonly id: number;
  readonly severity: WarningSeverity;
  /** Stable machine code, e.g. `PROPERTY_READ_FAILED`. */
  readonly code: string;
  readonly message: string;
  readonly objectId: number | null;
}

/** Type guard for the `kind` CHECK constraint, applied when reading rows. */
export function isSelectionSetKind(value: string): value is SelectionSetKind {
  return value === 'folder' || value === 'selection' || value === 'search';
}

/** Type guard for the `severity` CHECK constraint, applied when reading rows. */
export function isWarningSeverity(value: string): value is WarningSeverity {
  return value === 'info' || value === 'warning' || value === 'error';
}
