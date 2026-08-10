/**
 * The `.matchline` project file: create, open, read, write.
 *
 * Opening validates before returning: a handle in your hand is a project whose
 * schema version this build understands and whose meta table is complete -- the
 * same contract `openExtractionCache` offers, for the same reason. A project
 * file is the only copy of a site's decisions, so a half-understood one is
 * refused rather than read.
 *
 * Two rules run through every mutator here:
 *
 * - **Transactional.** Every mutator runs inside `BEGIN IMMEDIATE`/`COMMIT` and
 *   rolls back whole on any throw. `withTransaction` composes them, so a caller
 *   can put several mutations behind one commit and still get all-or-nothing.
 * - **No clock inside.** Timestamps come from the injected clock or from the
 *   caller's own argument, never from `Date.now()` in here. Two runs with the
 *   same clock write the same rows, which is what makes a project file
 *   diffable and a test able to assert on its contents.
 */
import { existsSync, unlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import type { ManualRelationshipOverride, SiteProfile } from '@matchline/domain';

import { backupBeforeMigration } from './backup.js';
import { ProjectStoreError } from './errors.js';
import { canonicalJson, parseStoredJson } from './json.js';
import {
  readOverridePayload,
  validateRelationshipOverride,
  validateSystemOverride,
  type ManualSystemOverride,
  type StoredOverride,
} from './overrides.js';
import { MIGRATION_STEPS, type MigrationStep } from './migrations.js';
import { validateSiteProfile } from './profile-json.js';
import { optionalText, requireInteger, requireText, type SqlRow } from './rows.js';
import {
  CONFIG_KEYS,
  DECISION_VALUES,
  DEFAULT_APP_VERSION,
  LEARNED_RULE_KINDS,
  OVERRIDE_KINDS,
  PROJECT_SCHEMA_SQL,
  PROJECT_SCHEMA_VERSION,
  REQUIRED_META_KEYS,
  REQUIRED_TABLES,
  SOURCE_ROLES,
  type ConfigKey,
  type DecisionValue,
  type LearnedRuleKind,
  type OverrideKind,
  type SourceRole,
} from './schema.js';
import { deriveSourceId } from './source-id.js';
import {
  invalidArgument,
  requireCountArgument,
  requireFilledArgument,
  requireMemberArgument,
  requireSha256Argument,
  requireTimestampArgument,
} from './validate.js';

/** Where time comes from. Injected so a compile can be replayed exactly. */
export type Clock = () => Date;

/** Options for `createProject`. */
export interface CreateProjectOptions {
  /** The project's display name, recorded in `meta.project_name`. */
  readonly name: string;
  /** Defaults to {@link DEFAULT_APP_VERSION}; the desktop app passes its own. */
  readonly appVersion?: string;
  /** Defaults to the system clock. */
  readonly now?: Clock;
}

/** Options for `openProject`. */
export interface OpenProjectOptions {
  /** Defaults to the system clock. */
  readonly now?: Clock;
  /**
   * Whether an older project file may be upgraded in place. Defaults to
   * `false`, so a caller that has not decided how to tell the user about a
   * migration gets a `migration-required` refusal instead of a rewritten file.
   *
   * When `true`, the file is backed up first (`backupBeforeMigration`), every
   * step is applied in one transaction, and the result is revalidated before
   * the handle is returned. {@link ProjectStore.migration} says what happened.
   */
  readonly migrate?: boolean;
}

/** What opening a project file had to do to it before it could be read. */
export interface MigrationReport {
  /** The schema version the file declared when it was found. */
  readonly fromVersion: number;
  /** The schema version it declares now. Always `PROJECT_SCHEMA_VERSION`. */
  readonly toVersion: number;
  /** Where the untouched original was copied to, for the user to be told. */
  readonly backupPath: string;
}

/** The `meta` table, typed and already validated. */
export interface ProjectMeta {
  readonly schemaVersion: number;
  readonly appVersion: string;
  readonly projectName: string;
  readonly createdAt: string;
  readonly modifiedAt: string;
}

/**
 * A source file registered with the project (v4).
 *
 * The last three fields are the pre-v4 names, kept as aliases so the desktop
 * app compiles against this build unchanged. They are removed together with
 * {@link ProjectStore.upsertSource} once the app is wired to source ids.
 */
export interface ProjectSource {
  /** The identity. Stable for the life of the row, whatever gets renamed. */
  readonly sourceId: string;
  readonly role: SourceRole;
  /** What a person calls this source. Starts equal to `rawFileName`. */
  readonly logicalName: string;
  /** Name only -- a project file records no directories (PRODUCT.md §13.3). */
  readonly rawFileName: string;
  readonly rawSha256: string;
  readonly rawByteSize: number;
  /**
   * The extraction cache derived from the raw file, or `null` when none has
   * been associated yet -- a source that is registered but not yet compilable.
   * Equal to `rawSha256` when the registered file is itself a cache.
   */
  readonly derivedCacheSha256: string | null;
  readonly addedAt: string;

  /** @deprecated pre-v4 alias for `rawFileName`. */
  readonly fileName: string;
  /** @deprecated pre-v4 alias for `rawSha256`. */
  readonly sha256: string;
  /** @deprecated pre-v4 alias for `rawByteSize`. */
  readonly byteSize: number;
}

/** What `upsertSourceV4` needs. Everything but the cache hash is required. */
export interface SourceInputV4 {
  readonly sourceId: string;
  readonly role: SourceRole;
  readonly logicalName: string;
  readonly rawFileName: string;
  readonly rawSha256: string;
  readonly rawByteSize: number;
  /** Omitted means "no cache associated", which is what a raw drop is. */
  readonly derivedCacheSha256?: string;
  readonly addedAt: string;
}

/**
 * What the pre-v4 `upsertSource` needs. `addedAt` defaults to the injected
 * clock.
 *
 * @deprecated use {@link SourceInputV4}.
 */
export interface SourceInput {
  readonly role: SourceRole;
  readonly fileName: string;
  readonly sha256: string;
  readonly byteSize: number;
  readonly addedAt?: string;
}

/** One stored profile revision. */
export interface ProfileRevision {
  readonly profile: SiteProfile;
  /** Monotonic within this project; unrelated to `SiteProfile.version`. */
  readonly revision: number;
}

/** A profile revision without its body, for a history list. */
export interface ProfileRevisionSummary {
  readonly revision: number;
  readonly note?: string;
  readonly savedAt: string;
}

/** The latest learned rule set of one kind. */
export interface LearnedRuleRecord {
  readonly kind: LearnedRuleKind;
  /** Whatever the caller stored, parsed. Shape is the caller's business. */
  readonly rules: unknown;
  readonly savedAt: string;
}

/** What `recordCompile` needs. */
export interface CompileInput {
  /** Source key (role, file name, whatever the caller keys by) to sha256. */
  readonly inputHashes: Readonly<Record<string, string>>;
  readonly profileRevision: number;
  /** Compile statistics, stored as canonical JSON. */
  readonly statsJson: unknown;
  readonly startedAt: string;
  readonly finishedAt: string;
}

/** One entry of the compile history. */
export interface CompileRecord {
  readonly compileId: number;
  readonly inputHashes: Readonly<Record<string, string>>;
  readonly profileRevision: number;
  readonly stats: unknown;
  readonly startedAt: string;
  readonly finishedAt: string;
  /** When the row was written, from the injected clock. */
  readonly recordedAt: string;
}

/** The stored snapshot and the compile it came from. */
export interface LatestSnapshot<T> {
  readonly compileId: number;
  readonly snapshot: T;
}

/** What `recordDecision` needs. */
export interface DecisionInput {
  /** Stable identity of the review item, e.g. `system-conflict:MAH001-10-01`. */
  readonly reviewKey: string;
  readonly decision: DecisionValue;
  readonly note?: string;
  readonly decidedAt: string;
}

/** One recorded review decision. */
export interface ReviewDecision {
  readonly reviewKey: string;
  readonly decision: DecisionValue;
  readonly note?: string;
  readonly decidedAt: string;
}

/** One stored configuration section (v2). */
export interface ConfigEntry {
  readonly key: ConfigKey;
  /** Whatever the caller stored, parsed. Shape is the caller's business. */
  readonly value: unknown;
  readonly updatedAt: string;
}

/** A validated, read-write project file. */
export interface ProjectStore {
  /** The file this handle was opened from. */
  readonly path: string;

  /**
   * What opening this file migrated, or `null` when it was already current.
   *
   * Never `null` because a migration was skipped: `openProject` either migrates
   * or refuses, so a handle in your hand is always a file this build fully
   * understands.
   */
  readonly migration: MigrationReport | null;

  /** The `meta` table, re-read each call so `modifiedAt` is current. */
  meta(): ProjectMeta;

  /**
   * Runs `fn` inside one transaction, committing on return and rolling back on
   * throw. Nested calls join the outer transaction rather than starting one.
   */
  withTransaction<T>(fn: () => T): T;

  /**
   * Adds a source, or replaces the row with the same `sourceId`.
   *
   * Replacing clears `derivedCacheSha256` unless the caller supplies one: new
   * raw bytes mean the cache derived from the old ones no longer describes this
   * source (P0-1, "replacing one source invalidates only its cache").
   *
   * Callers get an id from `deriveSourceId`; the store never invents one,
   * because an id invented in here would be a second answer to "what is this
   * source called" that no caller could predict or reproduce.
   */
  upsertSourceV4(input: SourceInputV4): void;
  /**
   * Associates an extraction cache with a source that is already registered.
   *
   * @throws ProjectStoreError `unknown-source` when no row has that id.
   */
  setSourceCache(sourceId: string, cacheSha256: string): void;
  /** One source by id, or `undefined` when nothing has that id. */
  getSource(sourceId: string): ProjectSource | undefined;
  /** Every source, ordered by source id. */
  listSources(): readonly ProjectSource[];
  /** Removes one source by id. Returns whether a row was there to remove. */
  removeSource(sourceId: string): boolean;

  /**
   * Adds a source, or replaces the one already registered for this
   * `(role, fileName)`.
   *
   * The pre-v4 signature, kept so the desktop app compiles against this build
   * unchanged; it derives a `sourceId` and reuses the existing row's id when
   * one is already registered for that role and file name. It therefore cannot
   * register two sources with the same basename -- which is the whole reason
   * v4 exists, and the reason this wrapper is temporary. `derivedCacheSha256`
   * is set to the same hash: a pre-v4 caller registers the exact bytes the
   * compiler reads.
   *
   * @deprecated use {@link ProjectStore.upsertSourceV4}.
   */
  upsertSource(input: SourceInput): void;
  /**
   * Removes the source registered for this `(role, fileName)` -- the same row
   * {@link ProjectStore.upsertSource} would have replaced, which when a v4
   * caller has registered two files of one name is the lower id of the two.
   *
   * @deprecated use `removeSource(sourceId)`.
   */
  removeSource(role: SourceRole, fileName: string): boolean;

  /** Validates and stores a profile as a new revision. Returns the revision. */
  saveProfile(profile: SiteProfile, revisionNote?: string): number;
  /** The newest revision, or `undefined` when none has been saved. */
  getProfile(): ProfileRevision | undefined;
  /** Every revision, newest first. Old revisions are never deleted. */
  listProfileRevisions(): readonly ProfileRevisionSummary[];
  /** One revision by number, or `undefined` if there is no such revision. */
  getProfileRevision(revision: number): ProfileRevision | undefined;

  /** Stores a learned rule set. Prior sets of the same kind are kept. */
  saveLearnedRules(kind: LearnedRuleKind, rules: unknown): void;
  /** The newest rule set of one kind, or `undefined`. */
  getLearnedRules(kind: LearnedRuleKind): LearnedRuleRecord | undefined;

  /** Sets the manual system override for one canonical tag. */
  setSystemOverride(assetKey: string, override: ManualSystemOverride): void;
  /** Sets the manual parent override for one canonical tag (the child). */
  setRelationshipOverride(override: ManualRelationshipOverride): void;
  /** Both kinds, ordered by kind then asset key. */
  listOverrides(): readonly StoredOverride[];
  /** Removes one override. Returns whether a row was there to remove. */
  removeOverride(kind: OverrideKind, assetKey: string): boolean;

  /** Appends to the compile history. Returns the new compile id. */
  recordCompile(input: CompileInput): number;
  /** Compile history, newest first. Omitting `limit` returns all of it. */
  listCompiles(limit?: number): readonly CompileRecord[];

  /** Stores the resolved snapshot, replacing whatever was there. */
  saveSnapshot(compileId: number, snapshot: unknown): void;
  /**
   * The stored snapshot, or `undefined` when no compile has saved one.
   *
   * The snapshot is returned as `unknown` unless `validate` is supplied --
   * `deserializeSnapshot` is the usual argument. The store keeps the caller's
   * JSON verbatim and never assumes a shape for it.
   */
  getLatestSnapshot<T = unknown>(validate?: (value: unknown) => T): LatestSnapshot<T> | undefined;

  /**
   * Stores one configuration section, replacing whatever was there.
   *
   * Replace rather than append: unlike `profile`, a config section has no
   * revision history to answer questions from, and the compiler only ever
   * reads the current one.
   */
  saveConfig(key: ConfigKey, value: unknown): void;
  /** One section, or `undefined` when it has never been written. */
  getConfig(key: ConfigKey): ConfigEntry | undefined;
  /** Every stored section, ordered by key. Empty means nothing was configured. */
  listConfig(): readonly ConfigEntry[];

  /** Appends a review decision. Earlier decisions for the key are kept. */
  recordDecision(input: DecisionInput): void;
  /** Every decision ever recorded, oldest first. */
  listDecisions(): readonly ReviewDecision[];
  /** The newest decision for one review key, or `undefined`. */
  decisionFor(reviewKey: string): ReviewDecision | undefined;

  /** Releases the SQLite handle. Safe to call more than once. */
  close(): void;
}

const SYSTEM_CLOCK: Clock = () => new Date();

/** Every `sources` column, written out so a schema change breaks the reader. */
const SOURCE_COLUMNS = `SELECT source_id, role, logical_name, raw_file_name, raw_sha256,
  raw_byte_size, derived_cache_sha256, added_at FROM sources`;

/** One `sources` row, validated, on its way into the table. */
interface StoredSourceRecord {
  readonly sourceId: string;
  readonly role: SourceRole;
  readonly logicalName: string;
  readonly rawFileName: string;
  readonly rawSha256: string;
  readonly rawByteSize: number;
  readonly derivedCacheSha256: string | null;
  readonly addedAt: string;
}

function cannotOpen(path: string, cause: unknown): ProjectStoreError {
  return new ProjectStoreError({
    kind: 'cannot-open',
    path,
    detail: cause instanceof Error ? cause.message : String(cause),
  });
}

/** SQLite counts come back as number or bigint; the schema keeps them small. */
function toCount(value: number | bigint): number {
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new ProjectStoreError({
        kind: 'malformed-row',
        table: 'sqlite',
        column: 'rowid',
        detail: `${value.toString()} exceeds safe integer range`,
      });
    }
    return Number(value);
  }
  return value;
}

function readMetaEntries(db: DatabaseSync): Map<string, string> {
  const entries = new Map<string, string>();
  for (const row of db.prepare('SELECT key, value FROM meta').all()) {
    entries.set(requireText(row, 'meta', 'key'), requireText(row, 'meta', 'value'));
  }
  return entries;
}

function requiredEntry(entries: ReadonlyMap<string, string>, key: string): string {
  const value = entries.get(key);
  if (value === undefined) {
    throw new ProjectStoreError({ kind: 'missing-meta-key', key });
  }
  return value;
}

/** Meta numbers are decimal strings in the DDL; anything else is malformed. */
function requiredCount(entries: ReadonlyMap<string, string>, key: string): number {
  const raw = requiredEntry(entries, key);
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new ProjectStoreError({ kind: 'malformed-meta-value', key, value: raw });
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new ProjectStoreError({ kind: 'malformed-meta-value', key, value: raw });
  }
  return parsed;
}

function metaFrom(entries: ReadonlyMap<string, string>): ProjectMeta {
  return {
    schemaVersion: requiredCount(entries, 'schema_version'),
    appVersion: requiredEntry(entries, 'app_version'),
    projectName: requiredEntry(entries, 'project_name'),
    createdAt: requiredEntry(entries, 'created_at'),
    modifiedAt: requiredEntry(entries, 'modified_at'),
  };
}

function tableNames(db: DatabaseSync): ReadonlySet<string> {
  return new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => requireText(row, 'sqlite_master', 'name')),
  );
}

/**
 * Refuses anything that is not a current project file.
 *
 * Version first, like the extraction cache, and load-bearing now that a table
 * has been added: a v1 file is missing `config`, and answering "missing table
 * 'config'" when the honest answer is "this file is a version older than you"
 * would send the user looking for corruption that is not there. Only `meta` is
 * checked ahead of the version, because the version is read out of it.
 */
function validateProject(db: DatabaseSync): void {
  const tables = tableNames(db);
  if (!tables.has('meta')) {
    throw new ProjectStoreError({ kind: 'missing-table', table: 'meta' });
  }

  const entries = readMetaEntries(db);
  const found = requiredCount(entries, 'schema_version');
  if (found > PROJECT_SCHEMA_VERSION) {
    throw new ProjectStoreError({
      kind: 'unsupported-schema-version',
      found,
      supported: PROJECT_SCHEMA_VERSION,
    });
  }
  if (found < PROJECT_SCHEMA_VERSION) {
    throw new ProjectStoreError({
      kind: 'migration-required',
      found,
      supported: PROJECT_SCHEMA_VERSION,
    });
  }

  for (const table of REQUIRED_TABLES) {
    if (!tables.has(table)) {
      throw new ProjectStoreError({ kind: 'missing-table', table });
    }
  }

  for (const key of REQUIRED_META_KEYS) {
    if (!entries.has(key)) {
      throw new ProjectStoreError({ kind: 'missing-meta-key', key });
    }
  }
}

/**
 * The steps that carry `found` all the way to the current version, or none.
 *
 * All-or-nothing on purpose: a partial walk would leave a file at a version
 * between two the build understands, which is a state nothing else in this
 * package knows how to describe.
 */
function migrationStepsFrom(found: number): readonly MigrationStep[] {
  const steps = MIGRATION_STEPS.filter((step: MigrationStep): boolean => step.to > found);
  const first = steps[0];
  const last = steps[steps.length - 1];
  if (first === undefined || last === undefined) {
    return [];
  }
  return first.to === found + 1 && last.to === PROJECT_SCHEMA_VERSION ? steps : [];
}

/** Runs one step against the open file. Exhaustive: a new kind will not compile. */
function applyStep(db: DatabaseSync, step: MigrationStep): void {
  switch (step.kind) {
    case 'sql':
      db.exec(step.sql);
      return;
    case 'procedure':
      step.run(db);
      return;
    default: {
      const exhaustive: never = step;
      throw new Error(`unhandled MigrationStep: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Upgrades a project file in place, after copying it.
 *
 * The file must be closed when this is called: `backupBeforeMigration` copies
 * bytes, and a copy taken with a transaction open would copy a database whose
 * rollback journal lives in another file.
 *
 * Everything after the backup runs in one transaction — the new tables, the
 * `migrations` rows and the `meta.schema_version` bump together — so a failure
 * anywhere leaves a file that still declares the version it really is.
 */
function migrateProjectFile(path: string, found: number, clock: Clock): MigrationReport {
  const steps = migrationStepsFrom(found);
  if (steps.length === 0) {
    throw new ProjectStoreError({
      kind: 'no-migration-path',
      found,
      supported: PROJECT_SCHEMA_VERSION,
    });
  }

  const backupPath = backupBeforeMigration(path);

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path);
  } catch (cause) {
    throw cannotOpen(path, cause);
  }

  try {
    db.exec('PRAGMA foreign_keys = ON');
    const appliedAt = isoNow(clock);
    db.exec('BEGIN IMMEDIATE');
    try {
      const record = db.prepare('INSERT INTO migrations (version, applied_at) VALUES (?, ?)');
      for (const step of steps) {
        applyStep(db, step);
        record.run(step.to, appliedAt);
      }
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(
        String(PROJECT_SCHEMA_VERSION),
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    throw error instanceof ProjectStoreError ? error : cannotOpen(path, error);
  } finally {
    db.close();
  }

  return { fromVersion: found, toVersion: PROJECT_SCHEMA_VERSION, backupPath };
}

/** Opens a file and validates it, closing the handle on any refusal. */
function openValidated(path: string): DatabaseSync {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path);
  } catch (cause) {
    throw cannotOpen(path, cause);
  }

  try {
    db.exec('PRAGMA foreign_keys = ON');
    validateProject(db);
  } catch (error) {
    db.close();
    if (error instanceof ProjectStoreError) {
      throw error;
    }
    // SQLite defers reading the file header, so a file that is not a database
    // at all fails here rather than at construction. Callers still get one
    // error type, not a raw driver error.
    throw cannotOpen(path, error);
  }
  return db;
}

/**
 * Creates a new project file.
 *
 * @throws ProjectStoreError `already-exists` rather than overwriting anything,
 * `cannot-open` if the path cannot be written.
 */
export function createProject(path: string, options: CreateProjectOptions): ProjectStore {
  const name = requireFilledArgument(options.name, 'name');
  const appVersion = requireFilledArgument(
    options.appVersion ?? DEFAULT_APP_VERSION,
    'appVersion',
  );
  const clock = options.now ?? SYSTEM_CLOCK;

  if (existsSync(path)) {
    throw new ProjectStoreError({ kind: 'already-exists', path });
  }

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path);
  } catch (cause) {
    throw cannotOpen(path, cause);
  }

  try {
    db.exec('PRAGMA foreign_keys = ON');
    const createdAt = isoNow(clock);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(PROJECT_SCHEMA_SQL);
      const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
      meta.run('schema_version', String(PROJECT_SCHEMA_VERSION));
      meta.run('app_version', appVersion);
      meta.run('project_name', name);
      meta.run('created_at', createdAt);
      meta.run('modified_at', createdAt);
      db.prepare('INSERT INTO migrations (version, applied_at) VALUES (?, ?)').run(
        PROJECT_SCHEMA_VERSION,
        createdAt,
      );
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } catch (error) {
    db.close();
    // The file was ours to create, so it is ours to take back: leaving an empty
    // SQLite file behind would make the next `createProject` refuse the path.
    try {
      unlinkSync(path);
    } catch {
      // Nothing useful to do; the original failure is the one that matters.
    }
    throw error instanceof ProjectStoreError ? error : cannotOpen(path, error);
  }

  return new SqliteProjectStore(db, path, clock);
}

/**
 * Opens an existing project file, migrating it first when asked to.
 *
 * @throws ProjectStoreError `not-found`, `cannot-open` (not a database),
 * `missing-table`, `missing-meta-key`, `malformed-meta-value`,
 * `unsupported-schema-version` (written by a newer build), `migration-required`
 * (written by an older one, and `migrate` was not set), `no-migration-path`
 * (written by an older one this build cannot reach) or `backup-exists` (a
 * previous migration's backup is still sitting there).
 */
export function openProject(path: string, options: OpenProjectOptions = {}): ProjectStore {
  if (!existsSync(path)) {
    throw new ProjectStoreError({ kind: 'not-found', path });
  }
  const clock = options.now ?? SYSTEM_CLOCK;

  let migration: MigrationReport | null = null;
  let db: DatabaseSync;
  try {
    db = openValidated(path);
  } catch (error) {
    if (
      options.migrate !== true ||
      !(error instanceof ProjectStoreError) ||
      error.reason.kind !== 'migration-required'
    ) {
      throw error;
    }
    migration = migrateProjectFile(path, error.reason.found, clock);
    // Revalidated rather than assumed: a migration that produced a file this
    // build cannot read is a failure, not a success with a warning. The backup
    // is on disk either way, which is what it is for.
    db = openValidated(path);
  }

  return new SqliteProjectStore(db, path, clock, migration);
}

function isoNow(clock: Clock): string {
  const value = clock();
  const time = value.getTime();
  if (!Number.isFinite(time)) {
    invalidArgument('now', 'clock returned an invalid Date');
  }
  return value.toISOString();
}

class SqliteProjectStore implements ProjectStore {
  readonly path: string;
  readonly migration: MigrationReport | null;

  #db: DatabaseSync | null;
  readonly #clock: Clock;
  #depth = 0;

  constructor(
    db: DatabaseSync,
    path: string,
    clock: Clock,
    migration: MigrationReport | null = null,
  ) {
    this.#db = db;
    this.path = path;
    this.#clock = clock;
    this.migration = migration;
  }

  #open(): DatabaseSync {
    if (this.#db === null) {
      throw new ProjectStoreError({ kind: 'closed', path: this.path });
    }
    return this.#db;
  }

  #now(): string {
    return isoNow(this.#clock);
  }

  #touch(at: string): void {
    this.#open().prepare("UPDATE meta SET value = ? WHERE key = 'modified_at'").run(at);
  }

  /**
   * Runs `fn` in a transaction and stamps `modified_at` on success.
   *
   * The clock is read once per mutation and handed to `fn`, so the row a
   * mutator writes and the `modified_at` it stamps carry the same instant
   * rather than two readings a few microseconds apart.
   */
  #mutate<T>(fn: (at: string) => T): T {
    return this.withTransaction(() => {
      const at = this.#now();
      const result = fn(at);
      this.#touch(at);
      return result;
    });
  }

  meta(): ProjectMeta {
    return metaFrom(readMetaEntries(this.#open()));
  }

  withTransaction<T>(fn: () => T): T {
    const db = this.#open();
    if (this.#depth > 0) {
      // Already inside a transaction: join it. SQLite has no nested BEGIN, and
      // a savepoint here would let an inner failure commit an outer partial
      // write -- which is exactly the guarantee this method exists to give.
      this.#depth += 1;
      try {
        return fn();
      } finally {
        this.#depth -= 1;
      }
    }

    db.exec('BEGIN IMMEDIATE');
    this.#depth = 1;
    let result: T;
    try {
      result = fn();
    } catch (error) {
      this.#depth = 0;
      db.exec('ROLLBACK');
      throw error;
    }
    this.#depth = 0;
    db.exec('COMMIT');
    return result;
  }

  upsertSourceV4(input: SourceInputV4): void {
    const record: StoredSourceRecord = {
      sourceId: requireFilledArgument(input.sourceId, 'sourceId'),
      role: requireMemberArgument(input.role, SOURCE_ROLES, 'role'),
      logicalName: requireFilledArgument(input.logicalName, 'logicalName'),
      rawFileName: requireFilledArgument(input.rawFileName, 'rawFileName'),
      rawSha256: requireSha256Argument(input.rawSha256, 'rawSha256'),
      rawByteSize: requireCountArgument(input.rawByteSize, 'rawByteSize'),
      derivedCacheSha256:
        input.derivedCacheSha256 === undefined
          ? null
          : requireSha256Argument(input.derivedCacheSha256, 'derivedCacheSha256'),
      addedAt: requireTimestampArgument(input.addedAt, 'addedAt'),
    };
    this.#mutate(() => {
      this.#putSource(record);
    });
  }

  setSourceCache(sourceId: string, cacheSha256: string): void {
    const id = requireFilledArgument(sourceId, 'sourceId');
    const digest = requireSha256Argument(cacheSha256, 'cacheSha256');
    this.#mutate(() => {
      const changes = toCount(
        this.#open()
          .prepare('UPDATE sources SET derived_cache_sha256 = ? WHERE source_id = ?')
          .run(digest, id).changes,
      );
      if (changes === 0) {
        throw new ProjectStoreError({ kind: 'unknown-source', sourceId: id });
      }
    });
  }

  /** The one INSERT both the v4 mutator and the legacy wrapper go through. */
  #putSource(record: StoredSourceRecord): void {
    this.#open()
      .prepare(
        `INSERT INTO sources
           (source_id, role, logical_name, raw_file_name, raw_sha256, raw_byte_size,
            derived_cache_sha256, added_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (source_id) DO UPDATE SET
           role = excluded.role,
           logical_name = excluded.logical_name,
           raw_file_name = excluded.raw_file_name,
           raw_sha256 = excluded.raw_sha256,
           raw_byte_size = excluded.raw_byte_size,
           derived_cache_sha256 = excluded.derived_cache_sha256,
           added_at = excluded.added_at`,
      )
      .run(
        record.sourceId,
        record.role,
        record.logicalName,
        record.rawFileName,
        record.rawSha256,
        record.rawByteSize,
        record.derivedCacheSha256,
        record.addedAt,
      );
  }

  getSource(sourceId: string): ProjectSource | undefined {
    const id = requireFilledArgument(sourceId, 'sourceId');
    const row = this.#open().prepare(`${SOURCE_COLUMNS} WHERE source_id = ?`).get(id);
    return row === undefined ? undefined : this.#readSource(row);
  }

  listSources(): readonly ProjectSource[] {
    return this.#open()
      .prepare(`${SOURCE_COLUMNS} ORDER BY source_id`)
      .all()
      .map((row) => this.#readSource(row));
  }

  #readSource(row: SqlRow): ProjectSource {
    const rawFileName = requireText(row, 'sources', 'raw_file_name');
    const rawSha256 = requireText(row, 'sources', 'raw_sha256');
    const rawByteSize = requireInteger(row, 'sources', 'raw_byte_size');
    return {
      sourceId: requireText(row, 'sources', 'source_id'),
      role: requireMemberArgument(
        requireText(row, 'sources', 'role'),
        SOURCE_ROLES,
        'sources.role',
      ),
      logicalName: requireText(row, 'sources', 'logical_name'),
      rawFileName,
      rawSha256,
      rawByteSize,
      derivedCacheSha256: optionalText(row, 'sources', 'derived_cache_sha256'),
      addedAt: requireText(row, 'sources', 'added_at'),
      fileName: rawFileName,
      sha256: rawSha256,
      byteSize: rawByteSize,
    };
  }

  upsertSource(input: SourceInput): void {
    const role = requireMemberArgument(input.role, SOURCE_ROLES, 'role');
    const fileName = requireFilledArgument(input.fileName, 'fileName');
    const sha256 = requireSha256Argument(input.sha256, 'sha256');
    const byteSize = requireCountArgument(input.byteSize, 'byteSize');
    const suppliedAt =
      input.addedAt === undefined ? undefined : requireTimestampArgument(input.addedAt, 'addedAt');

    this.#mutate((at) => {
      this.#putSource({
        sourceId: this.#legacySourceId(role, fileName),
        role,
        logicalName: fileName,
        rawFileName: fileName,
        rawSha256: sha256,
        rawByteSize: byteSize,
        // A pre-v4 caller registers the exact bytes the compiler reads -- for a
        // `model` row, a `.matchline-cache` -- so the file's own hash is also
        // the hash of what was derived from it. Same equivalence the v3 -> v4
        // migration records.
        derivedCacheSha256: sha256,
        addedAt: suppliedAt ?? at,
      });
    });
  }

  /**
   * The id the pre-v4 accessors act on: the row already registered for this
   * `(role, fileName)`, or a fresh derived one.
   *
   * Lowest id wins when a v4 caller has registered two files of one name, so
   * the legacy pair of calls stays coherent -- what `upsertSource` replaces is
   * what `removeSource(role, fileName)` removes.
   */
  #legacySourceId(role: SourceRole, fileName: string): string {
    const existing = this.#legacyRowId(role, fileName);
    if (existing !== undefined) {
      return existing;
    }
    // Every id, not just this name's: a derived id must dodge whatever else is
    // registered, including ids a v4 caller chose freely.
    const taken = this.#open()
      .prepare('SELECT source_id FROM sources')
      .all()
      .map((row) => requireText(row, 'sources', 'source_id'));
    return deriveSourceId(role, fileName, taken);
  }

  removeSource(sourceId: string): boolean;
  removeSource(role: SourceRole, fileName: string): boolean;
  removeSource(sourceIdOrRole: string, fileName?: string): boolean {
    // One argument is the v4 form; two is the pre-v4 one. Arity, not a type
    // check, because a `SourceRole` is a string and would be ambiguous.
    const id =
      fileName === undefined
        ? requireFilledArgument(sourceIdOrRole, 'sourceId')
        : this.#legacyRowId(
            requireMemberArgument(sourceIdOrRole, SOURCE_ROLES, 'role'),
            requireFilledArgument(fileName, 'fileName'),
          );
    if (id === undefined) {
      return false;
    }
    return this.withTransaction(() => {
      const changes = toCount(
        this.#open().prepare('DELETE FROM sources WHERE source_id = ?').run(id).changes,
      );
      if (changes > 0) {
        this.#touch(this.#now());
      }
      return changes > 0;
    });
  }

  /** The registered row for a `(role, fileName)`, or `undefined` if none is. */
  #legacyRowId(role: SourceRole, fileName: string): string | undefined {
    const row = this.#open()
      .prepare(
        'SELECT source_id FROM sources WHERE role = ? AND raw_file_name = ? ORDER BY source_id LIMIT 1',
      )
      .get(role, fileName);
    return row === undefined ? undefined : requireText(row, 'sources', 'source_id');
  }

  saveProfile(profile: SiteProfile, revisionNote?: string): number {
    // §13.3: every save validates before publication. A profile that cannot be
    // read back is never written.
    const validated = validateSiteProfile(profile);
    const json = canonicalJson(validated, 'profile');
    const note =
      revisionNote === undefined ? null : requireFilledArgument(revisionNote, 'revisionNote');

    return this.#mutate((savedAt) => {
      const db = this.#open();
      const row = db.prepare('SELECT COALESCE(MAX(revision), 0) + 1 AS next FROM profile').get();
      if (row === undefined) {
        throw new ProjectStoreError({
          kind: 'malformed-row',
          table: 'profile',
          column: 'next',
          detail: 'MAX(revision) returned no row',
        });
      }
      const revision = requireInteger(row, 'profile', 'next');
      db.prepare(
        'INSERT INTO profile (revision, profile_json, note, saved_at) VALUES (?, ?, ?, ?)',
      ).run(revision, json, note, savedAt);
      return revision;
    });
  }

  getProfile(): ProfileRevision | undefined {
    const row = this.#open()
      .prepare('SELECT revision, profile_json FROM profile ORDER BY revision DESC LIMIT 1')
      .get();
    return row === undefined ? undefined : this.#readProfileRow(row);
  }

  getProfileRevision(revision: number): ProfileRevision | undefined {
    const checked = requireCountArgument(revision, 'revision');
    const row = this.#open()
      .prepare('SELECT revision, profile_json FROM profile WHERE revision = ?')
      .get(checked);
    return row === undefined ? undefined : this.#readProfileRow(row);
  }

  #readProfileRow(row: SqlRow): ProfileRevision {
    return {
      profile: validateSiteProfile(
        parseStoredJson(requireText(row, 'profile', 'profile_json'), 'profile'),
      ),
      revision: requireInteger(row, 'profile', 'revision'),
    };
  }

  listProfileRevisions(): readonly ProfileRevisionSummary[] {
    return this.#open()
      .prepare('SELECT revision, note, saved_at FROM profile ORDER BY revision DESC')
      .all()
      .map((row) => {
        const note = optionalText(row, 'profile', 'note');
        const summary: { revision: number; savedAt: string; note?: string } = {
          revision: requireInteger(row, 'profile', 'revision'),
          savedAt: requireText(row, 'profile', 'saved_at'),
        };
        if (note !== null) {
          summary.note = note;
        }
        return summary;
      });
  }

  saveLearnedRules(kind: LearnedRuleKind, rules: unknown): void {
    const checkedKind = requireMemberArgument(kind, LEARNED_RULE_KINDS, 'kind');
    const json = canonicalJson(rules, `learned.${checkedKind}`);
    this.#mutate((savedAt) => {
      this.#open()
        .prepare('INSERT INTO learned (kind, rules_json, saved_at) VALUES (?, ?, ?)')
        .run(checkedKind, json, savedAt);
    });
  }

  getLearnedRules(kind: LearnedRuleKind): LearnedRuleRecord | undefined {
    const checkedKind = requireMemberArgument(kind, LEARNED_RULE_KINDS, 'kind');
    const row = this.#open()
      .prepare('SELECT rules_json, saved_at FROM learned WHERE kind = ? ORDER BY id DESC LIMIT 1')
      .get(checkedKind);
    if (row === undefined) {
      return undefined;
    }
    return {
      kind: checkedKind,
      rules: parseStoredJson(requireText(row, 'learned', 'rules_json'), 'learned'),
      savedAt: requireText(row, 'learned', 'saved_at'),
    };
  }

  setSystemOverride(assetKey: string, override: ManualSystemOverride): void {
    const key = requireFilledArgument(assetKey, 'assetKey');
    this.#putOverride('system', key, validateSystemOverride(override));
  }

  setRelationshipOverride(override: ManualRelationshipOverride): void {
    const validated = validateRelationshipOverride(override);
    this.#putOverride('relationship', validated.childAssetId, validated);
  }

  #putOverride(kind: OverrideKind, assetKey: string, payload: unknown): void {
    const json = canonicalJson(payload, `override.${kind}`);
    this.#mutate((updatedAt) => {
      this.#open()
        .prepare(
          `INSERT INTO overrides (kind, asset_key, payload_json, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (kind, asset_key) DO UPDATE SET
             payload_json = excluded.payload_json,
             updated_at = excluded.updated_at`,
        )
        .run(kind, assetKey, json, updatedAt);
    });
  }

  listOverrides(): readonly StoredOverride[] {
    return this.#open()
      .prepare(
        'SELECT kind, asset_key, payload_json, updated_at FROM overrides ORDER BY kind, asset_key',
      )
      .all()
      .map((row) =>
        readOverridePayload(
          requireMemberArgument(
            requireText(row, 'overrides', 'kind'),
            OVERRIDE_KINDS,
            'overrides.kind',
          ),
          requireText(row, 'overrides', 'asset_key'),
          parseStoredJson(requireText(row, 'overrides', 'payload_json'), 'overrides'),
          requireText(row, 'overrides', 'updated_at'),
        ),
      );
  }

  removeOverride(kind: OverrideKind, assetKey: string): boolean {
    const checkedKind = requireMemberArgument(kind, OVERRIDE_KINDS, 'kind');
    const key = requireFilledArgument(assetKey, 'assetKey');
    return this.withTransaction(() => {
      const changes = toCount(
        this.#open()
          .prepare('DELETE FROM overrides WHERE kind = ? AND asset_key = ?')
          .run(checkedKind, key).changes,
      );
      if (changes > 0) {
        this.#touch(this.#now());
      }
      return changes > 0;
    });
  }

  recordCompile(input: CompileInput): number {
    const hashes: Record<string, string> = {};
    for (const key of Object.keys(input.inputHashes).sort()) {
      const value = input.inputHashes[key];
      if (value === undefined) {
        continue;
      }
      hashes[requireFilledArgument(key, 'inputHashes key')] = requireSha256Argument(
        value,
        `inputHashes.${key}`,
      );
    }
    const profileRevision = requireCountArgument(input.profileRevision, 'profileRevision');
    const startedAt = requireTimestampArgument(input.startedAt, 'startedAt');
    const finishedAt = requireTimestampArgument(input.finishedAt, 'finishedAt');
    if (Date.parse(finishedAt) < Date.parse(startedAt)) {
      invalidArgument('finishedAt', `${finishedAt} is before startedAt ${startedAt}`);
    }
    const statsJson = canonicalJson(input.statsJson, 'statsJson');

    return this.#mutate((recordedAt) => {
      const db = this.#open();
      const profileRow = db
        .prepare('SELECT revision FROM profile WHERE revision = ?')
        .get(profileRevision);
      if (profileRow === undefined) {
        throw new ProjectStoreError({
          kind: 'unknown-profile-revision',
          revision: profileRevision,
        });
      }
      const result = db
        .prepare(
          `INSERT INTO compiles
             (input_hashes_json, profile_revision, stats_json, started_at, finished_at, recorded_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          canonicalJson(hashes, 'inputHashes'),
          profileRevision,
          statsJson,
          startedAt,
          finishedAt,
          recordedAt,
        );
      return toCount(result.lastInsertRowid);
    });
  }

  listCompiles(limit?: number): readonly CompileRecord[] {
    let bound = -1;
    if (limit !== undefined) {
      bound = requireCountArgument(limit, 'limit');
      if (bound === 0) {
        return [];
      }
    }
    return this.#open()
      .prepare(
        `SELECT id, input_hashes_json, profile_revision, stats_json, started_at, finished_at, recorded_at
         FROM compiles ORDER BY id DESC LIMIT ?`,
      )
      .all(bound)
      .map((row) => this.#readCompile(row));
  }

  #readCompile(row: SqlRow): CompileRecord {
    const hashes = parseStoredJson(requireText(row, 'compiles', 'input_hashes_json'), 'compiles');
    const inputHashes: Record<string, string> = {};
    if (typeof hashes !== 'object' || hashes === null || Array.isArray(hashes)) {
      throw new ProjectStoreError({
        kind: 'malformed-json',
        table: 'compiles',
        detail: 'input_hashes_json is not an object',
      });
    }
    for (const [key, value] of Object.entries(hashes)) {
      if (typeof value !== 'string') {
        throw new ProjectStoreError({
          kind: 'malformed-json',
          table: 'compiles',
          detail: `input hash '${key}' is not a string`,
        });
      }
      inputHashes[key] = value;
    }

    return {
      compileId: requireInteger(row, 'compiles', 'id'),
      inputHashes,
      profileRevision: requireInteger(row, 'compiles', 'profile_revision'),
      stats: parseStoredJson(requireText(row, 'compiles', 'stats_json'), 'compiles'),
      startedAt: requireText(row, 'compiles', 'started_at'),
      finishedAt: requireText(row, 'compiles', 'finished_at'),
      recordedAt: requireText(row, 'compiles', 'recorded_at'),
    };
  }

  saveSnapshot(compileId: number, snapshot: unknown): void {
    const checkedId = requireCountArgument(compileId, 'compileId');
    const json = canonicalJson(snapshot, 'snapshot');
    this.#mutate((savedAt) => {
      const db = this.#open();
      const compile = db.prepare('SELECT id FROM compiles WHERE id = ?').get(checkedId);
      if (compile === undefined) {
        throw new ProjectStoreError({ kind: 'unknown-compile', compileId: checkedId });
      }
      // One snapshot at a time: `slot` is pinned to 0 by the DDL, so replacing
      // the latest is structural rather than a convention.
      db.exec('DELETE FROM snapshots');
      db.prepare(
        'INSERT INTO snapshots (slot, compile_id, snapshot_json, saved_at) VALUES (0, ?, ?, ?)',
      ).run(checkedId, json, savedAt);
    });
  }

  getLatestSnapshot<T = unknown>(
    validate?: (value: unknown) => T,
  ): LatestSnapshot<T> | undefined {
    const row = this.#open()
      .prepare('SELECT compile_id, snapshot_json FROM snapshots WHERE slot = 0')
      .get();
    if (row === undefined) {
      return undefined;
    }
    const parsed = parseStoredJson(requireText(row, 'snapshots', 'snapshot_json'), 'snapshots');
    // Without a validate hook the caller asked for `unknown`, which is what
    // `T` defaults to; the assertion cannot widen anything they can misuse.
    const snapshot = validate === undefined ? (parsed as T) : validate(parsed);
    return { compileId: requireInteger(row, 'snapshots', 'compile_id'), snapshot };
  }

  saveConfig(key: ConfigKey, value: unknown): void {
    const checkedKey = requireMemberArgument(key, CONFIG_KEYS, 'key');
    const json = canonicalJson(value, `config.${checkedKey}`);
    this.#mutate((updatedAt) => {
      this.#open()
        .prepare(
          `INSERT INTO config (key, config_json, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET
             config_json = excluded.config_json,
             updated_at = excluded.updated_at`,
        )
        .run(checkedKey, json, updatedAt);
    });
  }

  getConfig(key: ConfigKey): ConfigEntry | undefined {
    const checkedKey = requireMemberArgument(key, CONFIG_KEYS, 'key');
    const row = this.#open()
      .prepare('SELECT key, config_json, updated_at FROM config WHERE key = ?')
      .get(checkedKey);
    return row === undefined ? undefined : this.#readConfig(row);
  }

  listConfig(): readonly ConfigEntry[] {
    return this.#open()
      .prepare('SELECT key, config_json, updated_at FROM config ORDER BY key')
      .all()
      .map((row) => this.#readConfig(row));
  }

  #readConfig(row: SqlRow): ConfigEntry {
    return {
      key: requireMemberArgument(requireText(row, 'config', 'key'), CONFIG_KEYS, 'config.key'),
      value: parseStoredJson(requireText(row, 'config', 'config_json'), 'config'),
      updatedAt: requireText(row, 'config', 'updated_at'),
    };
  }

  recordDecision(input: DecisionInput): void {
    const reviewKey = requireFilledArgument(input.reviewKey, 'reviewKey');
    const decision = requireMemberArgument(input.decision, DECISION_VALUES, 'decision');
    const note = input.note === undefined ? null : requireFilledArgument(input.note, 'note');
    const decidedAt = requireTimestampArgument(input.decidedAt, 'decidedAt');
    this.#mutate(() => {
      this.#open()
        .prepare(
          'INSERT INTO decisions (review_key, decision, note, decided_at) VALUES (?, ?, ?, ?)',
        )
        .run(reviewKey, decision, note, decidedAt);
    });
  }

  listDecisions(): readonly ReviewDecision[] {
    return this.#open()
      .prepare('SELECT review_key, decision, note, decided_at FROM decisions ORDER BY id')
      .all()
      .map((row) => this.#readDecision(row));
  }

  decisionFor(reviewKey: string): ReviewDecision | undefined {
    const key = requireFilledArgument(reviewKey, 'reviewKey');
    const row = this.#open()
      .prepare(
        `SELECT review_key, decision, note, decided_at FROM decisions
         WHERE review_key = ? ORDER BY id DESC LIMIT 1`,
      )
      .get(key);
    return row === undefined ? undefined : this.#readDecision(row);
  }

  #readDecision(row: SqlRow): ReviewDecision {
    const note = optionalText(row, 'decisions', 'note');
    const decision: {
      reviewKey: string;
      decision: DecisionValue;
      decidedAt: string;
      note?: string;
    } = {
      reviewKey: requireText(row, 'decisions', 'review_key'),
      decision: requireMemberArgument(
        requireText(row, 'decisions', 'decision'),
        DECISION_VALUES,
        'decisions.decision',
      ),
      decidedAt: requireText(row, 'decisions', 'decided_at'),
    };
    if (note !== null) {
      decision.note = note;
    }
    return decision;
  }

  close(): void {
    if (this.#db !== null) {
      this.#db.close();
      this.#db = null;
    }
  }
}
