/**
 * Read-only access to an extraction cache written by the Matchline worker.
 *
 * Opening validates before returning: a handle in your hand is a cache whose
 * version this reader understands and whose object table is complete. See
 * `schemas/extraction-cache.sql` for the contract and `docs/EXTRACTION.md` for
 * why the integrity check exists (a killed worker must never leave a
 * valid-looking cache).
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';

import { CacheValidationError } from './errors.js';
import {
  optionalInteger,
  optionalReal,
  optionalText,
  requireInteger,
  requireText,
  type SqlRow,
} from './rows.js';
import {
  hasV3Columns,
  isAuthoringIdKind,
  isSelectionSetKind,
  isSupportedSchemaVersion,
  isWarningSeverity,
  readV1MembershipResolved,
  REQUIRED_META_KEYS,
  REQUIRED_TABLES,
  SUPPORTED_SCHEMA_VERSIONS,
  type AuthoringIdKind,
  type BoundingBox,
  type CacheWarning,
  type ExtractionCacheMeta,
  type ModelObject,
  type ObjectFlags,
  type ObjectProperty,
  type ObjectPropertyRow,
  type SelectionSetNode,
  type SourceModel,
  type SourceModelNode,
} from './schema.js';

/**
 * Column lists are chosen by declared schema version, never by probing.
 *
 * A v1/v2 cache does not have the v3 columns at all, so asking for them would
 * fail the query rather than answer `null`; a file that declares v3 without
 * them is corrupt and should say so. The same rule already governs
 * `selection_sets.membership_resolved`.
 */
const OBJECT_COLUMNS_BASE =
  'id, source_model_id, parent_id, path_index, depth, display_name, class_name, instance_guid, authoring_id, ' +
  'bbox_min_x, bbox_min_y, bbox_min_z, bbox_max_x, bbox_max_y, bbox_max_z';

const OBJECT_COLUMNS_V3 = `${OBJECT_COLUMNS_BASE}, authoring_id_kind, structural_key, flags`;

const SOURCE_MODEL_COLUMNS_BASE = 'id, parent_id, file_name, display_name, guid';

const SOURCE_MODEL_COLUMNS_V3 = `${SOURCE_MODEL_COLUMNS_BASE}, source_file_name, source_guid`;

const PROPERTY_COLUMNS =
  'object_id, category, category_internal, name, name_internal, value_text, value_type';

/** `objects.flags` bit positions. Mirrors `ObjectFlags` in the C# records. */
const FLAG_HIDDEN = 1;
const FLAG_LAYER = 2;
const FLAG_INSERT = 4;
const FLAG_COMPOSITE = 8;
const FLAG_COLLECTION = 16;
const FLAG_HAS_MODEL = 32;

/** A validated, read-only extraction cache. */
export interface ExtractionCache {
  /** The file this handle was opened from. */
  readonly path: string;

  /** The `meta` table, typed and already validated. */
  meta(): ExtractionCacheMeta;

  /** Source models as a forest; nested appended models are children. */
  sourceModels(): readonly SourceModelNode[];

  /** `meta.object_count`, which open time proved equal to `COUNT(*)`. */
  objectCount(): number;

  /** One object by extraction ordinal, or `undefined` if there is no such id. */
  object(id: number): ModelObject | undefined;

  /** Objects with no parent, in `path_index` order. */
  rootObjects(): readonly ModelObject[];

  /** Direct children of an object, in `path_index` order. */
  childrenOf(objectId: number): readonly ModelObject[];

  /** Every object depth-first from the roots, children in `path_index` order. */
  walk(): IterableIterator<ModelObject>;

  /** Every object in extraction-ordinal order, streamed. */
  allObjects(): IterableIterator<ModelObject>;

  /** Properties of one object, in the order the extractor encountered them. */
  propertiesOf(objectId: number): readonly ObjectProperty[];

  /** Every property in `(object_id, encounter)` order, streamed. */
  allProperties(): IterableIterator<ObjectPropertyRow>;

  /** Selection sets as a forest; folder nesting becomes children. */
  selectionSets(): readonly SelectionSetNode[];

  /** Extraction warnings in the order the worker recorded them. */
  warnings(): readonly CacheWarning[];

  /** Releases the SQLite handle. Safe to call more than once. */
  close(): void;
}

/**
 * Opens and validates a cache file.
 *
 * @throws CacheValidationError if the file cannot be opened, is not a cache,
 * declares a schema version this reader does not support, is missing a
 * required meta key, or declares an object count the objects table does not
 * match (a partial or corrupt cache).
 */
export function openExtractionCache(path: string): ExtractionCache {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch (cause) {
    throw new CacheValidationError({
      kind: 'cannot-open',
      path,
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }

  try {
    const meta = validate(db);
    return new SqliteExtractionCache(db, path, meta);
  } catch (error) {
    db.close();
    if (error instanceof CacheValidationError) {
      throw error;
    }
    // SQLite defers reading the file header, so a file that is not a database
    // at all fails here rather than at construction. Callers still get one
    // error type, not a raw driver error.
    throw new CacheValidationError({
      kind: 'cannot-open',
      path,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
}

function validate(db: DatabaseSync): ExtractionCacheMeta {
  const tables = new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => requireText(row, 'sqlite_master', 'name')),
  );
  for (const table of REQUIRED_TABLES) {
    if (!tables.has(table)) {
      throw new CacheValidationError({ kind: 'missing-table', table });
    }
  }

  const entries = new Map<string, string>();
  for (const row of db.prepare('SELECT key, value FROM meta').all()) {
    entries.set(requireText(row, 'meta', 'key'), requireText(row, 'meta', 'value'));
  }

  // Version first: a cache from a future writer is refused by version rather
  // than by complaining about keys that version never promised.
  const schemaVersion = entries.get('schema_version');
  if (schemaVersion === undefined) {
    throw new CacheValidationError({ kind: 'missing-meta-key', key: 'schema_version' });
  }
  if (!isSupportedSchemaVersion(schemaVersion)) {
    throw new CacheValidationError({
      kind: 'unsupported-schema-version',
      found: schemaVersion,
      supported: SUPPORTED_SCHEMA_VERSIONS,
    });
  }

  for (const key of REQUIRED_META_KEYS) {
    if (!entries.has(key)) {
      throw new CacheValidationError({ kind: 'missing-meta-key', key });
    }
  }

  const meta: ExtractionCacheMeta = {
    schemaVersion,
    inputFileName: requiredEntry(entries, 'input_file_name'),
    inputSha256: requiredEntry(entries, 'input_sha256'),
    inputBytes: requiredCount(entries, 'input_bytes'),
    extractedAtUtc: requiredEntry(entries, 'extracted_at_utc'),
    extractorVersion: requiredEntry(entries, 'extractor_version'),
    adapterVersion: requiredEntry(entries, 'adapter_version'),
    navisworksVersion: requiredEntry(entries, 'navisworks_version'),
    objectCount: requiredCount(entries, 'object_count'),
    // Optional keys: absent from every cache written before schema v3, and
    // therefore never required — refusing an older cache over them would turn
    // an addition into a breaking change.
    units: entries.get('units') ?? null,
    uiLanguage: entries.get('ui_language') ?? null,
  };

  const countRow = db.prepare('SELECT COUNT(*) AS n FROM objects').get();
  if (countRow === undefined) {
    throw new CacheValidationError({
      kind: 'malformed-row',
      table: 'objects',
      column: 'n',
      detail: 'COUNT(*) returned no row',
    });
  }
  const actual = requireInteger(countRow, 'objects', 'n');
  if (actual !== meta.objectCount) {
    throw new CacheValidationError({
      kind: 'object-count-mismatch',
      declared: meta.objectCount,
      actual,
    });
  }

  return meta;
}

function requiredEntry(entries: ReadonlyMap<string, string>, key: string): string {
  const value = entries.get(key);
  if (value === undefined) {
    throw new CacheValidationError({ kind: 'missing-meta-key', key });
  }
  return value;
}

/** Meta numbers are decimal strings in the DDL; anything else is malformed. */
function requiredCount(entries: ReadonlyMap<string, string>, key: string): number {
  const raw = requiredEntry(entries, key);
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new CacheValidationError({ kind: 'malformed-meta-value', key, value: raw });
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new CacheValidationError({ kind: 'malformed-meta-value', key, value: raw });
  }
  return parsed;
}

function readSourceModel(row: SqlRow, withV3: boolean): SourceModel {
  return {
    id: requireInteger(row, 'source_models', 'id'),
    parentId: optionalInteger(row, 'source_models', 'parent_id'),
    fileName: optionalText(row, 'source_models', 'file_name'),
    displayName: optionalText(row, 'source_models', 'display_name'),
    guid: optionalText(row, 'source_models', 'guid'),
    sourceFileName: withV3 ? optionalText(row, 'source_models', 'source_file_name') : null,
    sourceGuid: withV3 ? optionalText(row, 'source_models', 'source_guid') : null,
  };
}

/**
 * `objects.authoring_id_kind`, refused rather than coerced when it is a spelling
 * this build does not know.
 *
 * Guessing would be worse than failing: the kind is what stops a Revit element
 * id and an AutoCAD handle with the same digits from matching each other, so a
 * value read as "some other kind" would silently widen identity.
 */
function readAuthoringIdKind(row: SqlRow): AuthoringIdKind | null {
  const value = optionalText(row, 'objects', 'authoring_id_kind');
  if (value === null) {
    return null;
  }
  if (!isAuthoringIdKind(value)) {
    throw new CacheValidationError({
      kind: 'malformed-row',
      table: 'objects',
      column: 'authoring_id_kind',
      detail: `'${value}' is not an authoring id kind this reader knows`,
    });
  }
  return value;
}

/**
 * `objects.flags`, unpacked into named booleans.
 *
 * Bits this build does not know are ignored rather than refused: the DDL
 * declares the field append-only, so an unknown bit is a newer writer rather
 * than a corrupt row.
 */
function readFlags(row: SqlRow): ObjectFlags {
  const bits = requireInteger(row, 'objects', 'flags');
  if (bits < 0) {
    throw new CacheValidationError({
      kind: 'malformed-row',
      table: 'objects',
      column: 'flags',
      detail: `${String(bits)} is not a bitfield`,
    });
  }
  return {
    isHidden: (bits & FLAG_HIDDEN) !== 0,
    isLayer: (bits & FLAG_LAYER) !== 0,
    isInsert: (bits & FLAG_INSERT) !== 0,
    isComposite: (bits & FLAG_COMPOSITE) !== 0,
    isCollection: (bits & FLAG_COLLECTION) !== 0,
    hasModel: (bits & FLAG_HAS_MODEL) !== 0,
  };
}

/**
 * Bounds are all-or-none per the DDL: six values or none. A partially filled
 * row is corruption, not a box we can guess the rest of.
 */
function readBoundingBox(row: SqlRow): BoundingBox | null {
  const minX = optionalReal(row, 'objects', 'bbox_min_x');
  const minY = optionalReal(row, 'objects', 'bbox_min_y');
  const minZ = optionalReal(row, 'objects', 'bbox_min_z');
  const maxX = optionalReal(row, 'objects', 'bbox_max_x');
  const maxY = optionalReal(row, 'objects', 'bbox_max_y');
  const maxZ = optionalReal(row, 'objects', 'bbox_max_z');
  const values = [minX, minY, minZ, maxX, maxY, maxZ];
  const present = values.filter((value) => value !== null).length;
  if (present === 0) {
    return null;
  }
  if (
    present !== values.length ||
    minX === null ||
    minY === null ||
    minZ === null ||
    maxX === null ||
    maxY === null ||
    maxZ === null
  ) {
    throw new CacheValidationError({
      kind: 'malformed-row',
      table: 'objects',
      column: 'bbox_*',
      detail: `bounding box is all-or-none but ${present} of 6 values are set`,
    });
  }
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

function readObject(row: SqlRow, withV3: boolean): ModelObject {
  return {
    id: requireInteger(row, 'objects', 'id'),
    sourceModelId: optionalInteger(row, 'objects', 'source_model_id'),
    parentId: optionalInteger(row, 'objects', 'parent_id'),
    pathIndex: requireInteger(row, 'objects', 'path_index'),
    depth: requireInteger(row, 'objects', 'depth'),
    displayName: optionalText(row, 'objects', 'display_name'),
    className: optionalText(row, 'objects', 'class_name'),
    instanceGuid: optionalText(row, 'objects', 'instance_guid'),
    authoringId: optionalText(row, 'objects', 'authoring_id'),
    authoringIdKind: withV3 ? readAuthoringIdKind(row) : null,
    structuralKey: withV3 ? optionalText(row, 'objects', 'structural_key') : null,
    flags: withV3 ? readFlags(row) : null,
    bbox: readBoundingBox(row),
  };
}

function readObjectProperty(row: SqlRow): ObjectProperty {
  return {
    category: requireText(row, 'properties', 'category'),
    categoryInternal: optionalText(row, 'properties', 'category_internal'),
    name: requireText(row, 'properties', 'name'),
    nameInternal: optionalText(row, 'properties', 'name_internal'),
    valueText: optionalText(row, 'properties', 'value_text'),
    valueType: requireText(row, 'properties', 'value_type'),
  };
}

function readPropertyRow(row: SqlRow): ObjectPropertyRow {
  return {
    objectId: requireInteger(row, 'properties', 'object_id'),
    ...readObjectProperty(row),
  };
}

/** Tree nodes are assembled mutably, then handed out under readonly types. */
interface MutableSourceModelNode extends SourceModel {
  readonly children: SourceModelNode[];
}

interface SelectionSetRow {
  readonly id: number;
  readonly parentId: number | null;
  readonly name: string;
  readonly kind: SelectionSetNode['kind'];
  readonly membershipResolved: boolean;
  readonly guid: string | null;
}

interface MutableSelectionSetNode extends SelectionSetRow {
  readonly memberObjectIds: readonly number[];
  readonly children: SelectionSetNode[];
}

/**
 * One `selection_sets` row.
 *
 * `hasMembershipColumn` is false for a v1 cache, which has no such column: the
 * value is then derived from the kind, which is what the v1 writer meant by it.
 */
function readSelectionSet(
  row: SqlRow,
  hasMembershipColumn: boolean,
  withV3: boolean,
): SelectionSetRow {
  const kind = requireText(row, 'selection_sets', 'kind');
  if (!isSelectionSetKind(kind)) {
    throw new CacheValidationError({
      kind: 'malformed-row',
      table: 'selection_sets',
      column: 'kind',
      detail: `'${kind}' is not one of folder, selection, search`,
    });
  }
  return {
    id: requireInteger(row, 'selection_sets', 'id'),
    parentId: optionalInteger(row, 'selection_sets', 'parent_id'),
    name: requireText(row, 'selection_sets', 'name'),
    kind,
    membershipResolved: hasMembershipColumn
      ? readMembershipResolved(row)
      : readV1MembershipResolved(kind),
    guid: withV3 ? optionalText(row, 'selection_sets', 'guid') : null,
  };
}

/**
 * `membership_resolved`, which the DDL constrains to 0 or 1.
 *
 * Anything else is refused rather than coerced: this flag decides whether a
 * caller may filter on the set at all, and guessing at a third value would
 * quietly turn "unknown" into "empty".
 */
function readMembershipResolved(row: SqlRow): boolean {
  const value = requireInteger(row, 'selection_sets', 'membership_resolved');
  if (value !== 0 && value !== 1) {
    throw new CacheValidationError({
      kind: 'malformed-row',
      table: 'selection_sets',
      column: 'membership_resolved',
      detail: `${String(value)} is not 0 or 1`,
    });
  }
  return value === 1;
}

function readWarning(row: SqlRow): CacheWarning {
  const severity = requireText(row, 'warnings', 'severity');
  if (!isWarningSeverity(severity)) {
    throw new CacheValidationError({
      kind: 'malformed-row',
      table: 'warnings',
      column: 'severity',
      detail: `'${severity}' is not one of info, warning, error`,
    });
  }
  return {
    id: requireInteger(row, 'warnings', 'id'),
    severity,
    code: requireText(row, 'warnings', 'code'),
    message: requireText(row, 'warnings', 'message'),
    objectId: optionalInteger(row, 'warnings', 'object_id'),
  };
}

class SqliteExtractionCache implements ExtractionCache {
  readonly path: string;

  #db: DatabaseSync | null;
  readonly #meta: ExtractionCacheMeta;

  /** Whether this file carries the v3 columns. Decided once, at open time. */
  readonly #withV3: boolean;
  readonly #objectColumns: string;
  readonly #sourceModelColumns: string;

  /**
   * Prepared statements, keyed by SQL and owned by this handle.
   *
   * A compile calls `object()` and `propertiesOf()` once per object — tens of
   * thousands of times on a real model — and re-preparing the same SQL each
   * time is pure overhead. `close()` drops the map; SQLite finalizes the
   * statements themselves when the database handle closes.
   */
  readonly #statements = new Map<string, StatementSync>();

  constructor(db: DatabaseSync, path: string, meta: ExtractionCacheMeta) {
    this.#db = db;
    this.path = path;
    this.#meta = meta;
    this.#withV3 = hasV3Columns(meta.schemaVersion);
    this.#objectColumns = this.#withV3 ? OBJECT_COLUMNS_V3 : OBJECT_COLUMNS_BASE;
    this.#sourceModelColumns = this.#withV3 ? SOURCE_MODEL_COLUMNS_V3 : SOURCE_MODEL_COLUMNS_BASE;
  }

  #open(): DatabaseSync {
    if (this.#db === null) {
      throw new Error(`extraction cache is closed: ${this.path}`);
    }
    return this.#db;
  }

  /**
   * The statement for `sql`, prepared once per open handle.
   *
   * Only for statements consumed eagerly (`get`/`all`): a cached statement is a
   * single cursor, so the streaming `iterate()` readers prepare their own and
   * two concurrent walks cannot tread on each other.
   */
  #statement(sql: string): StatementSync {
    const db = this.#open();
    const existing = this.#statements.get(sql);
    if (existing !== undefined) {
      return existing;
    }
    const prepared = db.prepare(sql);
    this.#statements.set(sql, prepared);
    return prepared;
  }

  meta(): ExtractionCacheMeta {
    return this.#meta;
  }

  objectCount(): number {
    return this.#meta.objectCount;
  }

  sourceModels(): readonly SourceModelNode[] {
    const rows = this.#statement(
      `SELECT ${this.#sourceModelColumns} FROM source_models ORDER BY id`,
    )
      .all()
      .map((row) => readSourceModel(row, this.#withV3));

    const nodes = new Map<number, MutableSourceModelNode>();
    for (const row of rows) {
      nodes.set(row.id, { ...row, children: [] });
    }

    const roots: MutableSourceModelNode[] = [];
    for (const row of rows) {
      const node = nodes.get(row.id);
      if (node === undefined) {
        continue;
      }
      // A parent id pointing at a missing row would otherwise hide the model
      // entirely; surface it at the root instead of dropping it.
      const parent =
        row.parentId === null || row.parentId === row.id
          ? undefined
          : nodes.get(row.parentId);
      if (parent === undefined) {
        roots.push(node);
      } else {
        parent.children.push(node);
      }
    }
    return roots;
  }

  object(id: number): ModelObject | undefined {
    const row = this.#statement(`SELECT ${this.#objectColumns} FROM objects WHERE id = ?`).get(
      id,
    );
    return row === undefined ? undefined : readObject(row, this.#withV3);
  }

  rootObjects(): readonly ModelObject[] {
    return this.#statement(
      `SELECT ${this.#objectColumns} FROM objects WHERE parent_id IS NULL ORDER BY path_index, id`,
    )
      .all()
      .map((row) => readObject(row, this.#withV3));
  }

  childrenOf(objectId: number): readonly ModelObject[] {
    return this.#statement(
      `SELECT ${this.#objectColumns} FROM objects WHERE parent_id = ? ORDER BY path_index, id`,
    )
      .all(objectId)
      .map((row) => readObject(row, this.#withV3));
  }

  *walk(): IterableIterator<ModelObject> {
    // Explicit stack rather than recursion: model trees are deep and a stack
    // overflow on a real 131k-object model is not an acceptable failure mode.
    const stack: ModelObject[] = [...this.rootObjects()].reverse();
    const seen = new Set<number>();
    while (stack.length > 0) {
      const next = stack.pop();
      if (next === undefined) {
        break;
      }
      if (seen.has(next.id)) {
        // Only reachable if parentage cycles, which extraction ordinals rule
        // out; refusing to revisit keeps a corrupt cache from hanging a caller.
        continue;
      }
      seen.add(next.id);
      yield next;
      const children = this.childrenOf(next.id);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child !== undefined) {
          stack.push(child);
        }
      }
    }
  }

  *allObjects(): IterableIterator<ModelObject> {
    const statement = this.#open().prepare(`SELECT ${this.#objectColumns} FROM objects ORDER BY id`);
    for (const row of statement.iterate()) {
      yield readObject(row, this.#withV3);
    }
  }

  propertiesOf(objectId: number): readonly ObjectProperty[] {
    return this.#statement(
      `SELECT ${PROPERTY_COLUMNS} FROM properties WHERE object_id = ? ORDER BY rowid`,
    )
      .all(objectId)
      .map(readObjectProperty);
  }

  *allProperties(): IterableIterator<ObjectPropertyRow> {
    const statement = this.#open().prepare(
      `SELECT ${PROPERTY_COLUMNS} FROM properties ORDER BY object_id, rowid`,
    );
    for (const row of statement.iterate()) {
      yield readPropertyRow(row);
    }
  }

  selectionSets(): readonly SelectionSetNode[] {
    const db = this.#open();
    // The column list is chosen by declared version rather than by probing the
    // table: a v1 cache would fail the query outright, and a file that declares
    // v2 without the column is corrupt and should say so.
    const hasMembershipColumn = this.#meta.schemaVersion !== '1';
    let columns = hasMembershipColumn
      ? 'id, parent_id, name, kind, membership_resolved'
      : 'id, parent_id, name, kind';
    if (this.#withV3) {
      columns += ', guid';
    }
    const rows = this.#statement(`SELECT ${columns} FROM selection_sets ORDER BY id`)
      .all()
      .map((row) => readSelectionSet(row, hasMembershipColumn, this.#withV3));

    const members = new Map<number, number[]>();
    for (const row of this.#statement(
      'SELECT set_id, object_id FROM selection_set_members ORDER BY set_id, object_id',
    ).all()) {
      const setId = requireInteger(row, 'selection_set_members', 'set_id');
      const objectId = requireInteger(row, 'selection_set_members', 'object_id');
      const bucket = members.get(setId);
      if (bucket === undefined) {
        members.set(setId, [objectId]);
      } else {
        bucket.push(objectId);
      }
    }

    const nodes = new Map<number, MutableSelectionSetNode>();
    for (const row of rows) {
      nodes.set(row.id, {
        ...row,
        memberObjectIds: members.get(row.id) ?? [],
        children: [],
      });
    }

    const roots: MutableSelectionSetNode[] = [];
    for (const row of rows) {
      const node = nodes.get(row.id);
      if (node === undefined) {
        continue;
      }
      const parent =
        row.parentId === null || row.parentId === row.id
          ? undefined
          : nodes.get(row.parentId);
      if (parent === undefined) {
        roots.push(node);
      } else {
        parent.children.push(node);
      }
    }
    return roots;
  }

  warnings(): readonly CacheWarning[] {
    return this.#statement(
      'SELECT id, severity, code, message, object_id FROM warnings ORDER BY id',
    )
      .all()
      .map(readWarning);
  }

  close(): void {
    if (this.#db !== null) {
      // Closing the database finalizes every statement prepared on it, so the
      // map only has to stop holding the finalized handles.
      this.#statements.clear();
      this.#db.close();
      this.#db = null;
    }
  }
}
