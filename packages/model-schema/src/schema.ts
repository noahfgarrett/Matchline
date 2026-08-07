/**
 * The shapes in `schemas/extraction-cache.sql`, expressed as TypeScript.
 *
 * This file is the reading half of that DDL's contract: the C# worker writes
 * the tables, this package reads them, and both sides move together when
 * `meta.schema_version` is bumped.
 */

/** The only cache schema version this reader accepts. */
export const SUPPORTED_SCHEMA_VERSION = '1';

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
