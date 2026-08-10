/**
 * The `.matchline` project file schema, version 5 (APP.md "Project file",
 * PRODUCT.md §15).
 *
 * This file is the single source of truth for the DDL: `createProject` executes
 * `PROJECT_SCHEMA_SQL` and `openProject` validates against the constants below.
 * How an older file reaches this shape lives in `migrations.ts`, which imports
 * from here and is never imported by it. The extraction cache keeps its DDL in
 * `schemas/extraction-cache.sql` because a C# worker writes it too; nothing
 * outside this package writes a project file, so the DDL lives next to the only
 * code that owns it.
 *
 * Bump `PROJECT_SCHEMA_VERSION` on ANY change and add a `MigrationStep`;
 * readers refuse versions they do not know, and refuse to guess at versions
 * they have no step for.
 *
 * ## History
 *
 * - **v1** — the original tables.
 * - **v2** — adds `config`, so a project file carries the Hierarchy Composer,
 *   the role graph, the parent ladder, the discipline projection and the
 *   parent-tag property. Before v2 those lived in the desktop app's machine-
 *   local state file keyed by project path, and moving a `.matchline` file lost
 *   them.
 * - **v3** — widens two CHECK constraints. `config` gains an `extoTemplate`
 *   section, so a project carries the registry layout its EXTO export is written
 *   on; `learned.kind` gains `'wbs'`, so it can hold the learned WBS table
 *   beside the nesting rules and the item-master table. Both are widenings —
 *   every v2 row is still legal — but a CHECK cannot be altered in place, so the
 *   step rebuilds both tables and copies every row across.
 * - **v4** — source identity (P0-1). `sources` is keyed by a `source_id` the
 *   caller supplies rather than by `(role, file_name)`, so two files with one
 *   basename coexist (hard gate 4); it separates the name a person gave a
 *   source (`logical_name`) from the file it came from (`raw_file_name`), and
 *   the hash of that file (`raw_sha256`) from the hash of the extraction cache
 *   derived from it (`derived_cache_sha256`). `compiles.input_hashes_json` is
 *   re-keyed to match.
 * - **v5** — the asset identity ledger (P0-9). One `ledger` row holds the
 *   ledger the latest compile wrote, so an asset id outlives the tag it was
 *   first derived from and every manual decision recorded against that id keeps
 *   applying. Purely additive: no existing table changes, so a v4 file reaches
 *   v5 by gaining an empty table.
 */
import type { SourceKind } from '@matchline/domain';

/** The schema version this build writes and reads. */
export const PROJECT_SCHEMA_VERSION = 5;

/**
 * The `app_version` written into a new project when the caller does not supply
 * one. The desktop app passes `app.getVersion()`; this constant tracks the
 * repository version so a project written by a test or a script still records
 * something truthful.
 */
export const DEFAULT_APP_VERSION = '0.8.1';

/** Meta keys every v1 project file declares. */
export const REQUIRED_META_KEYS = [
  'schema_version',
  'app_version',
  'project_name',
  'created_at',
  'modified_at',
] as const;

/** Tables a current file has. All must exist before it counts as a project. */
export const REQUIRED_TABLES = [
  'meta',
  'sources',
  'profile',
  'learned',
  'overrides',
  'compiles',
  'snapshots',
  'decisions',
  'migrations',
  'config',
  'ledger',
] as const;

/** What a registered input file is to the compile (PRODUCT.md §6, §12). */
export const SOURCE_ROLES = [
  'model',
  'easypower',
  'cable-schedule',
  'pmd',
  'mel',
  'p6',
  'prior-ssm',
] as const;

/** Which input a `sources` row describes. */
export type SourceRole = (typeof SOURCE_ROLES)[number];

/** Narrows arbitrary text -- an IPC payload, a stored row -- to a role. */
export function isSourceRole(value: string): value is SourceRole {
  return (SOURCE_ROLES as ReadonlyArray<string>).includes(value);
}

/**
 * The learned artefacts a project carries (PRODUCT.md §12.4, ENGINE.md E3).
 *
 * `'wbs'` joined the list in v3. It is a third table rather than a section of
 * the item-master one because it answers a different question on a different
 * key — the work-breakdown code of a *system*, not the master of a piece of
 * equipment — and because a site can honestly have one without the other.
 */
export const LEARNED_RULE_KINDS = ['nesting', 'item-master', 'wbs'] as const;

/** Which learned rule set a `learned` row holds. */
export type LearnedRuleKind = (typeof LEARNED_RULE_KINDS)[number];

/** Narrows arbitrary text to a learned rule kind. */
export function isLearnedRuleKind(value: string): value is LearnedRuleKind {
  return (LEARNED_RULE_KINDS as ReadonlyArray<string>).includes(value);
}

/** The two things a person can overrule by hand (PRODUCT.md §4.1, §5.6, §11.5). */
export const OVERRIDE_KINDS = ['system', 'relationship'] as const;

/** Which override an `overrides` row holds. */
export type OverrideKind = (typeof OVERRIDE_KINDS)[number];

/** Narrows arbitrary text to an override kind. */
export function isOverrideKind(value: string): value is OverrideKind {
  return (OVERRIDE_KINDS as ReadonlyArray<string>).includes(value);
}

/** What a reviewer can say about a review item (PRODUCT.md §10). */
export const DECISION_VALUES = ['accepted', 'rejected', 'deferred'] as const;

/** A reviewer's verdict. */
export type DecisionValue = (typeof DECISION_VALUES)[number];

/** Narrows arbitrary text to a decision. */
export function isDecisionValue(value: string): value is DecisionValue {
  return (DECISION_VALUES as ReadonlyArray<string>).includes(value);
}

/**
 * The configuration sections a project carries (six, as of v3).
 *
 * A closed list rather than free-form keys, and enforced by a CHECK constraint
 * as well as by this array: `config` is not a scratchpad. Five of the six are
 * the things `CompileProjectInput` takes that a `SiteProfile` cannot yet hold.
 * A seventh section is a schema change, which is the point — it should be.
 *
 * `extoTemplate` is the sixth, added in v3: the registry layout captured from a
 * site's own workbook, which every later EXTO export is written on. It lives
 * here rather than in a Site Profile because it belongs to *this* project's
 * deliverable, and it is the one place anything site-specific about the export's
 * shape is allowed to be — the engine's own column map stays generic.
 */
export const CONFIG_KEYS = [
  'hierarchy',
  'roleGraph',
  'ladder',
  'ssmDisciplineProjection',
  'parentTagProperty',
  'extoTemplate',
] as const;

/** Which configuration section a `config` row holds. */
export type ConfigKey = (typeof CONFIG_KEYS)[number];

/** Narrows arbitrary text to a configuration key. */
export function isConfigKey(value: string): value is ConfigKey {
  return (CONFIG_KEYS as ReadonlyArray<string>).includes(value);
}

/**
 * Every `SourceKind`, for validating claims read back out of a snapshot.
 *
 * `@matchline/domain` publishes the type but no runtime array; `satisfies` ties
 * this list to the union, so a new member there stops this file compiling.
 */
export const SOURCE_KINDS = [
  'MODEL',
  'FLOW',
  'PMD',
  'MEL',
  'MANUAL',
] as const satisfies ReadonlyArray<SourceKind>;

/**
 * The `config` table, as v3 creates it.
 *
 * Its own constant because two places need exactly these bytes: the full DDL a
 * new project is created from, and the v1 → v2 migration that adds the table to
 * a file that has none. A migration that re-typed the DDL by hand would be a
 * second, drifting definition of the same table.
 *
 * A v1 file therefore arrives at v2 with the *current* CHECK rather than the one
 * v2 shipped, and is then rebuilt again by the v3 step below. That is harmless —
 * both steps are widenings and the rebuild is a copy — and it is much safer than
 * freezing a second copy of this DDL here purely to be historically exact about
 * a constraint no v1 file has any rows under.
 */
export const CONFIG_TABLE_SQL = `
CREATE TABLE config (
  key         TEXT PRIMARY KEY CHECK (key IN (
                'hierarchy', 'roleGraph', 'ladder', 'ssmDisciplineProjection',
                'parentTagProperty', 'extoTemplate')),
  config_json TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) WITHOUT ROWID;
`;

/**
 * The `learned` table and its index, as v3 creates them.
 *
 * Extracted for the same reason `CONFIG_TABLE_SQL` is: the v3 step rebuilds this
 * table to widen its CHECK, and it must rebuild it into exactly the shape a
 * freshly created project has.
 */
export const LEARNED_TABLE_SQL = `
CREATE TABLE learned (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('nesting', 'item-master', 'wbs')),
  rules_json TEXT NOT NULL,
  saved_at   TEXT NOT NULL
);
CREATE INDEX idx_learned_kind ON learned(kind, id);
`;

/**
 * The `sources` table, as v4 creates it.
 *
 * Its own constant because two places need exactly these bytes: the full DDL a
 * new project is created from, and the v3 → v4 migration that rebuilds the
 * table around `source_id`.
 *
 * Column by column, since every one of them is a decision:
 *
 * - `source_id` is the identity, supplied by the caller and derived by
 *   `deriveSourceId` (`source-id.ts`). Not `(role, raw_file_name)`, and not
 *   UNIQUE on that pair: a site really does register four files called
 *   `Level 1.nwc`, and keying on the name loses three of them (hard gate 4).
 *   `WITHOUT ROWID` because the table is looked up by that text key -- and
 *   because in a rowid table a `TEXT PRIMARY KEY` would accept NULL, which is a
 *   SQLite quirk this table cannot afford.
 * - `logical_name` is what a person calls this source ("Dragon Mechanical").
 *   `raw_file_name` is the file it came from. They start out equal and diverge
 *   the moment someone renames a source or two sources share a basename.
 * - `raw_sha256` / `raw_byte_size` describe the file that was registered --
 *   name only, never a directory (PRODUCT.md §13.3).
 * - `derived_cache_sha256` is the extraction cache derived from that raw file:
 *   NULL until an extraction associates one, and equal to `raw_sha256` when the
 *   registered file *is* a cache (dropping a `.matchline-cache` directly, which
 *   is how every project before v4 registered a model). A source with a NULL
 *   here is registered but not yet ready to compile.
 */
export const SOURCES_TABLE_SQL = `
CREATE TABLE sources (
  source_id            TEXT PRIMARY KEY,
  role                 TEXT NOT NULL CHECK (role IN (
                         'model', 'easypower', 'cable-schedule', 'pmd', 'mel', 'p6', 'prior-ssm')),
  logical_name         TEXT NOT NULL,
  raw_file_name        TEXT NOT NULL,
  raw_sha256           TEXT NOT NULL,
  raw_byte_size        INTEGER NOT NULL CHECK (raw_byte_size >= 0),
  derived_cache_sha256 TEXT,
  added_at             TEXT NOT NULL
) WITHOUT ROWID;
`;

/**
 * The `ledger` table, as v5 creates it.
 *
 * Its own constant because two places need exactly these bytes: the full DDL a
 * new project is created from, and the v4 → v5 migration that adds the table to
 * a file that has none.
 *
 * Shaped like `snapshots`, and for the same reason. The ledger is CUMULATIVE
 * project state, not a per-compile artefact: it carries every asset this project
 * has ever seen, including the ones that have since disappeared, and each
 * compile rewrites it whole. So there is one row -- `slot` pinned to 0 by the
 * DDL, exactly as `snapshots` pins it -- rather than a row per compile that
 * would store the same growing document over and over.
 *
 * `compile_id` says which compile wrote the row that is there. It is a foreign
 * key into `compiles` because a ledger whose compile has no history row is a
 * ledger nobody can date; and it is what makes a per-compile history derivable
 * if one is ever wanted, without paying for it now.
 */
export const LEDGER_TABLE_SQL = `
CREATE TABLE ledger (
  slot        INTEGER PRIMARY KEY CHECK (slot = 0),
  compile_id  INTEGER NOT NULL REFERENCES compiles(id),
  ledger_json TEXT NOT NULL,
  saved_at    TEXT NOT NULL
);
`;

/**
 * The v5 DDL.
 *
 * Notes on the shapes that are not obvious:
 * - `sources` is keyed by `source_id` (see {@link SOURCES_TABLE_SQL}).
 * - `profile`, `learned` and `decisions` are append-only histories. Nothing is
 *   ever updated in place, because "what did this project believe last Tuesday"
 *   is a question a reviewer really asks (PRODUCT.md §13.3).
 * - `overrides` is keyed by `(kind, asset_key)` where `asset_key` is the
 *   canonical tag. Tags are the human identity that survives a recompile.
 * - `snapshots.slot` and `ledger.slot` are pinned to 0, so "the latest one" is
 *   structural rather than a convention a future writer could break.
 * - `config` is keyed by section, one row each, so writing the hierarchy cannot
 *   disturb the ladder and a section nobody has set is simply absent.
 */
export const PROJECT_SCHEMA_SQL = `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

${SOURCES_TABLE_SQL}
CREATE TABLE profile (
  revision     INTEGER PRIMARY KEY CHECK (revision > 0),
  profile_json TEXT NOT NULL,
  note         TEXT,
  saved_at     TEXT NOT NULL
);

${LEARNED_TABLE_SQL}
CREATE TABLE overrides (
  kind         TEXT NOT NULL CHECK (kind IN ('system', 'relationship')),
  asset_key    TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (kind, asset_key)
) WITHOUT ROWID;

CREATE TABLE compiles (
  id                INTEGER PRIMARY KEY,
  input_hashes_json TEXT NOT NULL,
  profile_revision  INTEGER NOT NULL REFERENCES profile(revision),
  stats_json        TEXT NOT NULL,
  started_at        TEXT NOT NULL,
  finished_at       TEXT NOT NULL,
  recorded_at       TEXT NOT NULL
);

CREATE TABLE snapshots (
  slot          INTEGER PRIMARY KEY CHECK (slot = 0),
  compile_id    INTEGER NOT NULL REFERENCES compiles(id),
  snapshot_json TEXT NOT NULL,
  saved_at      TEXT NOT NULL
);

CREATE TABLE decisions (
  id         INTEGER PRIMARY KEY,
  review_key TEXT NOT NULL,
  decision   TEXT NOT NULL CHECK (decision IN ('accepted', 'rejected', 'deferred')),
  note       TEXT,
  decided_at TEXT NOT NULL
);
CREATE INDEX idx_decisions_key ON decisions(review_key, id);

CREATE TABLE migrations (
  version    INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
${CONFIG_TABLE_SQL}${LEDGER_TABLE_SQL}`;
