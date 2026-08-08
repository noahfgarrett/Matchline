/**
 * The `.matchline` project file schema, version 1 (APP.md "Project file",
 * PRODUCT.md §15).
 *
 * This file is the single source of truth for the DDL: `createProject` executes
 * `PROJECT_SCHEMA_SQL` and `openProject` validates against the constants below.
 * The extraction cache keeps its DDL in `schemas/extraction-cache.sql` because a
 * C# worker writes it too; nothing outside this package writes a project file,
 * so the DDL lives next to the only code that owns it.
 *
 * Bump `PROJECT_SCHEMA_VERSION` on ANY change and add a migration; readers
 * refuse versions they do not know.
 */
import type { SourceKind } from '@matchline/domain';

/** The schema version this build writes and reads. */
export const PROJECT_SCHEMA_VERSION = 1;

/**
 * The `app_version` written into a new project when the caller does not supply
 * one. The desktop app passes `app.getVersion()`; this constant tracks the
 * repository version so a project written by a test or a script still records
 * something truthful.
 */
export const DEFAULT_APP_VERSION = '0.5.0';

/** Meta keys every v1 project file declares. */
export const REQUIRED_META_KEYS = [
  'schema_version',
  'app_version',
  'project_name',
  'created_at',
  'modified_at',
] as const;

/** Tables v1 creates. All must exist before a file counts as a project. */
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

/** The two learned artefacts a project carries (PRODUCT.md §12.4, ENGINE.md E3). */
export const LEARNED_RULE_KINDS = ['nesting', 'item-master'] as const;

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
 * The v1 DDL.
 *
 * Notes on the shapes that are not obvious:
 * - `sources` is keyed by `(role, file_name)`, not by hash: re-picking an edited
 *   spreadsheet must *replace* the row so its old hash cannot linger and make a
 *   stale compile look current.
 * - `profile`, `learned` and `decisions` are append-only histories. Nothing is
 *   ever updated in place, because "what did this project believe last Tuesday"
 *   is a question a reviewer really asks (PRODUCT.md §13.3).
 * - `overrides` is keyed by `(kind, asset_key)` where `asset_key` is the
 *   canonical tag. Tags are the human identity that survives a recompile.
 * - `snapshots.slot` is pinned to 0, so "latest snapshot" is structural rather
 *   than a convention a future writer could break.
 */
export const PROJECT_SCHEMA_SQL = `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE sources (
  role      TEXT NOT NULL CHECK (role IN (
              'model', 'easypower', 'cable-schedule', 'pmd', 'mel', 'p6', 'prior-ssm')),
  file_name TEXT NOT NULL,
  sha256    TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  added_at  TEXT NOT NULL,
  PRIMARY KEY (role, file_name)
);

CREATE TABLE profile (
  revision     INTEGER PRIMARY KEY CHECK (revision > 0),
  profile_json TEXT NOT NULL,
  note         TEXT,
  saved_at     TEXT NOT NULL
);

CREATE TABLE learned (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('nesting', 'item-master')),
  rules_json TEXT NOT NULL,
  saved_at   TEXT NOT NULL
);
CREATE INDEX idx_learned_kind ON learned(kind, id);

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
`;
