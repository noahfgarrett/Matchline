/**
 * How a project file older than this build reaches the current schema.
 *
 * Split from `schema.ts` at v4: a migration that has to move rows needs the
 * DDL, the source-id helper and the JSON writer, and a module that imports all
 * three cannot also be the module they import. `schema.ts` describes the shape
 * a current file has; this describes how a file gets there. The import runs one
 * way only.
 *
 * Every step here runs inside `migrateProjectFile`'s single transaction, after
 * the file has been backed up, and the result is revalidated before any handle
 * is returned.
 */
import type { DatabaseSync } from 'node:sqlite';

import { canonicalJson, isRecord } from './json.js';
import { requireInteger, requireText } from './rows.js';
import {
  CONFIG_TABLE_SQL,
  LEDGER_TABLE_SQL,
  SOURCE_ROLES,
  SOURCES_TABLE_SQL,
} from './schema.js';
import { deriveSourceId } from './source-id.js';
import { requireMemberArgument } from './validate.js';

/**
 * One step of the schema history: the version it produces, and what gets a file
 * there from the version before it.
 *
 * A discriminated union since v4. Steps that only add or rebuild tables stay
 * declarative SQL; a step that has to *read* rows, decide something about them
 * and write them back — which generating source ids and re-keying compile
 * hashes both are — is a procedure over the open database. Everything else in
 * this package switches on a `kind`, and so does this.
 */
export type MigrationStep =
  | {
      readonly kind: 'sql';
      /** The schema version a file declares once this step has run. */
      readonly to: number;
      readonly sql: string;
    }
  | {
      readonly kind: 'procedure';
      readonly to: number;
      /** Runs inside the migration transaction on the open project file. */
      readonly run: (db: DatabaseSync) => void;
    };

/**
 * v2 → v3: widen two CHECK constraints.
 *
 * SQLite cannot alter a CHECK, so each table is rebuilt: create the new shape
 * under a temporary name, copy every row, drop the old table, rename. Both
 * changes are widenings — every row that was legal under v2 is legal under v3 —
 * so the copy can never lose a row to the new constraint, and the whole step
 * runs inside `migrateProjectFile`'s transaction.
 *
 * Column lists are written out rather than `SELECT *`, so a future column added
 * to either table stops this step compiling into something that silently drops
 * it. Dropping a table drops its indexes with it, which is why the index is
 * recreated at the end rather than dropped at the start.
 *
 * Nothing references either table by foreign key, so the drop-and-rename cannot
 * strand a reference.
 */
export const WIDEN_CHECKS_SQL = `
CREATE TABLE config_v3 (
  key         TEXT PRIMARY KEY CHECK (key IN (
                'hierarchy', 'roleGraph', 'ladder', 'ssmDisciplineProjection',
                'parentTagProperty', 'extoTemplate')),
  config_json TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) WITHOUT ROWID;
INSERT INTO config_v3 (key, config_json, updated_at)
  SELECT key, config_json, updated_at FROM config;
DROP TABLE config;
ALTER TABLE config_v3 RENAME TO config;

CREATE TABLE learned_v3 (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('nesting', 'item-master', 'wbs')),
  rules_json TEXT NOT NULL,
  saved_at   TEXT NOT NULL
);
INSERT INTO learned_v3 (id, kind, rules_json, saved_at)
  SELECT id, kind, rules_json, saved_at FROM learned;
DROP TABLE learned;
ALTER TABLE learned_v3 RENAME TO learned;
CREATE INDEX idx_learned_kind ON learned(kind, id);
`;

/** One pre-v4 `sources` row, read out before the table is replaced. */
interface LegacySourceRow {
  readonly sourceId: string;
  readonly role: string;
  readonly fileName: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly addedAt: string;
}

/** The column names of one table, as SQLite reports them. */
function columnsOf(db: DatabaseSync, table: string): ReadonlySet<string> {
  return new Set(
    db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => requireText(row, 'pragma.table_info', 'name')),
  );
}

/**
 * Reads the pre-v4 `sources` table and gives every row an id.
 *
 * Ordered by `(role, file_name)` rather than by rowid: two files with the same
 * name must always land on the same id, whatever order they happened to be
 * added in, so migrating a copy of a project produces the same ids as migrating
 * the original.
 */
function readLegacySources(db: DatabaseSync): readonly LegacySourceRow[] {
  const taken = new Set<string>();
  return db
    .prepare('SELECT role, file_name, sha256, byte_size, added_at FROM sources ORDER BY role, file_name')
    .all()
    .map((row): LegacySourceRow => {
      const role = requireMemberArgument(
        requireText(row, 'sources', 'role'),
        SOURCE_ROLES,
        'sources.role',
      );
      const fileName = requireText(row, 'sources', 'file_name');
      const sourceId = deriveSourceId(role, fileName, taken);
      taken.add(sourceId);
      return {
        sourceId,
        role,
        fileName,
        sha256: requireText(row, 'sources', 'sha256'),
        byteSize: requireInteger(row, 'sources', 'byte_size'),
        addedAt: requireText(row, 'sources', 'added_at'),
      };
    });
}

/**
 * Re-keys one stored `input_hashes_json` object, or returns `null` to leave it
 * exactly as it was found.
 *
 * Pre-v4 the desktop app keyed compile inputs by `role/fileName`. Those keys
 * become the `source_id` the same file now carries. A key nothing maps to --
 * a source that has since been removed, or a key some other caller invented --
 * is kept verbatim behind a `legacy:` prefix. Compile history is evidence that
 * a hash was once seen; the migration re-labels it and never drops it.
 *
 * `null` means "not something this step understands": a column that is not a
 * JSON object of strings, or a re-keying that would land two old keys on one
 * new key. Rewriting either would risk losing a hash, and a project must not
 * fail to migrate over one odd history row.
 */
function remapInputHashes(text: string, byLegacyKey: ReadonlyMap<string, string>): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }

  const remapped: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      return null;
    }
    const migrated = byLegacyKey.get(key) ?? `legacy:${key}`;
    if (Object.hasOwn(remapped, migrated)) {
      return null;
    }
    remapped[migrated] = value;
  }
  return canonicalJson(remapped, 'compiles.input_hashes_json');
}

/**
 * v3 → v4: give every source an id, and re-key the compile history to match.
 *
 * The transformation happens in JavaScript rather than in SQL, so the table is
 * read whole, dropped and recreated from `SOURCES_TABLE_SQL` -- one definition
 * of the v4 shape, rather than a temp-table copy that would be a second one.
 * Nothing references `sources` by foreign key, so the drop strands nothing, and
 * the whole step is inside the migration's transaction.
 *
 * What each old column becomes:
 *
 * - `file_name` → `logical_name` *and* `raw_file_name`. Before v4 a source had
 *   exactly one name, and it was the file's; the two only diverge once someone
 *   renames a source or registers two files with one basename.
 * - `sha256` → `raw_sha256` *and* `derived_cache_sha256`. A pre-v4 project
 *   registered the exact bytes the compiler reads: for a `model` row that file
 *   *is* the extraction cache (the app had no extraction service yet, so a
 *   `.matchline-cache` was dropped in directly), and for a spreadsheet role
 *   there is nothing further to derive. So the file's own hash is also the
 *   hash of what was derived from it, and the equivalence is recorded rather
 *   than a NULL that would read as "this source has never been extracted".
 * - `byte_size` → `raw_byte_size`, `added_at` → `added_at`. Nothing is dropped.
 *
 * A file whose `sources` table already carries `source_id` has nothing to
 * convert: that happens when a test walks a current file's `schema_version`
 * backwards to exercise the opt-in, and rebuilding then would re-key compile
 * hashes that are already ids. The step is a no-op there rather than a
 * corruption.
 */
export function migrateSourcesToV4(db: DatabaseSync): void {
  if (columnsOf(db, 'sources').has('source_id')) {
    return;
  }

  const legacy = readLegacySources(db);
  db.exec('DROP TABLE sources');
  db.exec(SOURCES_TABLE_SQL);

  const insert = db.prepare(
    `INSERT INTO sources
       (source_id, role, logical_name, raw_file_name, raw_sha256, raw_byte_size,
        derived_cache_sha256, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const byLegacyKey = new Map<string, string>();
  for (const row of legacy) {
    insert.run(
      row.sourceId,
      row.role,
      row.fileName,
      row.fileName,
      row.sha256,
      row.byteSize,
      row.sha256,
      row.addedAt,
    );
    byLegacyKey.set(`${row.role}/${row.fileName}`, row.sourceId);
  }

  const update = db.prepare('UPDATE compiles SET input_hashes_json = ? WHERE id = ?');
  for (const row of db.prepare('SELECT id, input_hashes_json FROM compiles ORDER BY id').all()) {
    const id = requireInteger(row, 'compiles', 'id');
    const stored = requireText(row, 'compiles', 'input_hashes_json');
    const remapped = remapInputHashes(stored, byLegacyKey);
    if (remapped !== null && remapped !== stored) {
      update.run(remapped, id);
    }
  }
}

/** Whether the open file already has a table of this name. */
function hasTable(db: DatabaseSync, table: string): boolean {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
    undefined
  );
}

/**
 * v4 → v5: give the project somewhere to keep its asset identity ledger.
 *
 * Additive and empty. Nothing back-fills the table, and nothing could: a ledger
 * is what a compile writes, and the identities in it come from model evidence
 * this step cannot read. A migrated project's first compile therefore mints an
 * id per asset and reports every one as `new-asset` -- the truthful account of a
 * project that has just learned to remember what it contains. Nothing is lost by
 * that: `decisionResolverOf` resolves the tag-keyed references older projects
 * stored (`tag:<tag>` and the bare tag) against that first ledger, so decisions
 * recorded before v5 keep applying (P0-9, "never dropped").
 *
 * A procedure rather than plain SQL for one reason: a file that already has the
 * table. That happens when a test walks a current file's `schema_version`
 * backwards to exercise the migration opt-in, and `CREATE TABLE` would fail
 * where the honest answer is "there is nothing to do".
 */
export function addLedgerTableV5(db: DatabaseSync): void {
  if (hasTable(db, 'ledger')) {
    return;
  }
  db.exec(LEDGER_TABLE_SQL);
}

/**
 * v5 → v6: widen the `config` CHECK by two sections.
 *
 * `derivedAttributes` (P0-7) and `sourceAssignmentRules` (P0-8). SQLite cannot
 * alter a CHECK, so the table is rebuilt: create the new shape under a
 * temporary name, copy every row, drop the old table, rename. A widening —
 * every row legal under v5 is legal under v6 — so the copy can never lose a row
 * to the new constraint, and the whole step runs inside `migrateProjectFile`'s
 * transaction.
 *
 * Column names are written out rather than `SELECT *`, for the same reason the
 * v3 step writes them out: a future column added to `config` should stop this
 * step compiling into something that silently drops it.
 *
 * Nothing back-fills the two new keys. A project that has configured neither has
 * no row for them, which is exactly what "not configured" has always looked like
 * in this table — and inventing an empty registry would be a claim the migration
 * has no evidence for.
 */
export const WIDEN_CONFIG_KEYS_SQL = `
CREATE TABLE config_v6 (
  key         TEXT PRIMARY KEY CHECK (key IN (
                'hierarchy', 'roleGraph', 'ladder', 'ssmDisciplineProjection',
                'parentTagProperty', 'extoTemplate', 'derivedAttributes',
                'sourceAssignmentRules')),
  config_json TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) WITHOUT ROWID;
INSERT INTO config_v6 (key, config_json, updated_at)
  SELECT key, config_json, updated_at FROM config;
DROP TABLE config;
ALTER TABLE config_v6 RENAME TO config;
`;

/**
 * Every migration this build can run, in order, each one version apart.
 *
 * `openProject` walks from the version a file declares to
 * `PROJECT_SCHEMA_VERSION`. A gap here is not a slow migration, it is a
 * refusal: a file this list cannot reach is left exactly as it was found.
 */
export const MIGRATION_STEPS: readonly MigrationStep[] = [
  { kind: 'sql', to: 2, sql: CONFIG_TABLE_SQL },
  { kind: 'sql', to: 3, sql: WIDEN_CHECKS_SQL },
  { kind: 'procedure', to: 4, run: migrateSourcesToV4 },
  { kind: 'procedure', to: 5, run: addLedgerTableV5 },
  { kind: 'sql', to: 6, sql: WIDEN_CONFIG_KEYS_SQL },
];
