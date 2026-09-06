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

import type { ManualRelationshipOverride, SiteProfileV2 } from '@matchline/domain';

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
import { validateSiteProfileV2 } from './profile-json.js';
import { optionalText, requireInteger, requireText, type SqlRow } from './rows.js';
import {
  COMPILE_ASSET_RETENTION,
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
  VACUUM_FREELIST_THRESHOLD,
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
 * Identified by `sourceId` and never by name: a project may hold two files
 * called `Level 1.nwc` and both are real equipment (P0-1, hard gate 4).
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

/** One stored profile revision. */
export interface ProfileRevision {
  readonly profile: SiteProfileV2;
  /** Monotonic within this project; unrelated to `SiteProfileV2.version`. */
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
  /**
   * How many generated-MEL assets this compile produced (v7).
   *
   * A number on the history row rather than the assets themselves, so listing
   * the history costs the history and not the model. Whether the assets are
   * still stored is a separate question -- see `getCompileAssets` -- because
   * only the newest {@link COMPILE_ASSET_RETENTION} compiles keep them.
   */
  readonly assetCount: number;
}

/** The wizard draft as it currently stands, and when it was last written (v7). */
export interface StoredDraft<T> {
  readonly draft: T;
  readonly updatedAt: string;
}

/** The stored snapshot and the compile it came from. */
export interface LatestSnapshot<T> {
  readonly compileId: number;
  readonly snapshot: T;
}

/**
 * The stored asset identity ledger and the compile that wrote it (v5).
 *
 * `compileId` is provenance rather than a key: there is only ever one ledger,
 * and this says which compile last moved it forward.
 */
export interface StoredLedger<T> {
  readonly compileId: number;
  readonly ledger: T;
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

  /** Validates and stores a profile as a new revision. Returns the revision. */
  saveProfile(profile: SiteProfileV2, revisionNote?: string): number;
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
  /**
   * Rewrites override rows onto the asset ids they resolve to, and collapses
   * the duplicates that produces.
   *
   * `resolved` maps a stored reference -- an `asset_key`, or a
   * `parentAssetId` inside a relationship payload -- to the ledger asset id it
   * names in the caller's current compile. A reference the map has no entry for
   * is left exactly as it was found: a decision whose asset is not in this
   * compile is still that decision, and rewriting it to a guess would be worse
   * than leaving a row a later compile can still resolve.
   *
   * The collapse is why this exists. Schema v5's asset ids arrived beside years
   * of rows keyed by bare canonical tag, so one asset could end up with a
   * `MAH001-10-01` row AND a `tag:MAH001-10-01` row. Both resolve, both are
   * applied, and the claims assembly sees two manual parents for one child --
   * an `ambiguous-parent` review item about a disagreement the person never
   * had. One row per `(kind, asset)` survives: the one already keyed by the
   * resolved id if there is one, otherwise the most recently updated, with the
   * greater key breaking a tie so two machines collapse the same way.
   *
   * @returns how many rows were removed as duplicates.
   */
  rekeyOverrides(resolved: ReadonlyMap<string, string>): number;
  /** Removes one override. Returns whether a row was there to remove. */
  removeOverride(kind: OverrideKind, assetKey: string): boolean;

  /** Appends to the compile history. Returns the new compile id. */
  recordCompile(input: CompileInput): number;
  /**
   * Compile history, newest first. Omitting `limit` returns all of it.
   *
   * Reads no asset arrays. Before v7 the generated MEL lived inside
   * `stats_json`, so drawing a fifty-row history parsed fifty whole generated
   * MELs to print fifty dates; the assets live in their own table now and
   * `CompileRecord.assetCount` is what a list needs.
   */
  listCompiles(limit?: number): readonly CompileRecord[];

  /**
   * Stores the generated-MEL assets one compile produced (v7).
   *
   * Call it in the SAME transaction as the `recordCompile` it belongs to, for
   * the reason `saveLedger` says: a compile whose assets landed without it is a
   * row nothing can date.
   *
   * Writing also prunes: only the newest {@link COMPILE_ASSET_RETENTION}
   * compiles keep their assets, and the older rows lose the array while keeping
   * their compile row and its `asset_count`. The pruning is here rather than on
   * a timer because this is the only moment the set of recent compiles changes.
   *
   * @throws ProjectStoreError `unknown-compile` when no such compile exists.
   */
  saveCompileAssets(compileId: number, assets: readonly unknown[]): void;
  /**
   * The stored assets of one compile, or `undefined`.
   *
   * `undefined` covers three honest cases a caller treats alike: no such
   * compile, a compile whose assets have been pruned, and a compile recorded by
   * a build older than v7. All three mean "there is nothing here to diff
   * against"; `CompileRecord.assetCount` still says what the compile produced.
   */
  getCompileAssets<T = unknown>(
    compileId: number,
    validate?: (value: unknown) => T,
  ): T | undefined;
  /**
   * The compile ids that still hold their assets.
   *
   * One query for a whole history list. A caller drawing "diffable" against
   * fifty compiles would otherwise call `getCompileAssets` fifty times and
   * parse fifty generated MELs to answer a yes/no.
   */
  listCompilesWithAssets(): ReadonlySet<number>;

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
   * Stores the asset identity ledger this compile wrote, replacing the previous
   * one (P0-9, schema v5).
   *
   * Replace rather than append, because the ledger is cumulative project state
   * and not a per-compile artefact: it already carries every asset the project
   * has ever seen, including the ones that have disappeared. Keeping a row per
   * compile would store the same growing document over and over to answer a
   * question -- "what did the ledger look like in June" -- that `compiles` and
   * this row's `compile_id` can answer between them if it is ever asked.
   *
   * Call it in the SAME transaction as the `recordCompile` and `saveSnapshot`
   * of the compile it belongs to. A ledger saved without its compile, or a
   * compile recorded without its ledger, is a project that has minted asset ids
   * nothing will hand back to the next compile.
   *
   * @throws ProjectStoreError `unknown-compile` when no such compile exists.
   */
  saveLedger(compileId: number, ledger: unknown): void;
  /**
   * The stored ledger, or `undefined` when no compile has saved one.
   *
   * `undefined` is what a project that has never been compiled, and a project
   * last compiled by a build older than v5, both look like -- and both mean the
   * same thing to a caller: this compile mints the ids.
   *
   * Returned as `unknown` unless `validate` is supplied; `deserializeLedger` is
   * the usual argument, exactly as `deserializeSnapshot` is for the snapshot.
   */
  getLedger<T = unknown>(validate?: (value: unknown) => T): StoredLedger<T> | undefined;

  /**
   * Stores one configuration section, replacing whatever was there.
   *
   * Replace rather than append: unlike `profile`, a config section has no
   * revision history to answer questions from, and the compiler only ever
   * reads the current one.
   */
  saveConfig(key: ConfigKey, value: unknown): void;
  /** Removes one section. `true` when a row was there to remove. */
  deleteConfig(key: ConfigKey): boolean;
  /** One section, or `undefined` when it has never been written. */
  getConfig(key: ConfigKey): ConfigEntry | undefined;
  /** Every stored section, ordered by key. Empty means nothing was configured. */
  listConfig(): readonly ConfigEntry[];

  /**
   * Stores the wizard draft, replacing whatever was there (v7).
   *
   * One slot, written on every draft patch. A draft is not a revision -- see
   * `PROFILE_DRAFT_TABLE_SQL` -- and this deliberately does no profile
   * validation: a half-finished draft is exactly what this table is for, and a
   * store that only accepted publishable drafts would be a store that saved
   * nothing until the wizard was already finished.
   */
  saveDraft(draft: unknown): void;
  /** The stored draft, or `undefined` when none has been written. */
  getDraft<T = unknown>(validate?: (value: unknown) => T): StoredDraft<T> | undefined;
  /**
   * Removes the stored draft. `true` when a row was there to remove.
   *
   * Called when a revision is published FROM the draft: the revision is now the
   * answer to "what does this project believe", and a leftover draft row would
   * reopen the project onto an unsaved-looking copy of what was just saved.
   */
  clearDraft(): boolean;

  /** Appends a review decision. Earlier decisions for the key are kept. */
  recordDecision(input: DecisionInput): void;
  /** Every decision ever recorded, oldest first. */
  listDecisions(): readonly ReviewDecision[];
  /** The newest decision for one review key, or `undefined`. */
  decisionFor(reviewKey: string): ReviewDecision | undefined;
  /**
   * Removes every decision recorded under one review key. `true` when there was
   * one to remove.
   *
   * The one deliberate exception to "decisions are appended, never replaced".
   * A review key is content-addressed, so a decision whose key no longer names
   * anything in the latest compile answers a question that is no longer asked —
   * it cannot be applied, cannot be re-decided, and would otherwise sit in the
   * queue for the life of the project. Dismissing one is a person saying "that
   * question is gone"; keeping a tombstone of it would be keeping the noise
   * this removes. Every decision the current compile can still apply is
   * unreachable from here, because the queue only offers this on the stale
   * list.
   */
  removeDecision(reviewKey: string): boolean;

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

/**
 * The `tag:` prefix `@matchline/asset-catalog` mints an id from an unduplicated
 * canonical tag with. Known here because the two spellings of one tag are what
 * `#putOverride` and `rekeyOverrides` collapse.
 */
const TAG_ID_PREFIX = 'tag:';

/**
 * The OTHER spelling of the same asset, or `null` when there is not one.
 *
 * `tag:MAH001-10-01` and `MAH001-10-01` name one piece of equipment. Every
 * build before schema v5 filed overrides under the bare tag; the catalog mints
 * the prefixed form. A project that has been through both holds two rows for
 * one asset unless something retires one.
 *
 * A ledger id -- `asset:000042` -- has no sibling: it is not derived from a tag
 * and nothing else spells it.
 */
function siblingSpelling(assetKey: string): string | null {
  if (assetKey.startsWith(TAG_ID_PREFIX)) {
    const tag = assetKey.slice(TAG_ID_PREFIX.length);
    return tag === '' ? null : tag;
  }
  return assetKey.includes(':') ? null : `${TAG_ID_PREFIX}${assetKey}`;
}

/** One override row on its way to its resolved key. See `rekeyOverrides`. */
interface RekeyedOverride {
  readonly kind: OverrideKind;
  readonly assetKey: string;
  readonly payload: unknown;
  /** Whether the row was already filed under the key it resolves to. */
  readonly exact: boolean;
  readonly previousKey: string;
  readonly updatedAt: string;
}

/**
 * Which of two rows for one asset survives.
 *
 * A row already keyed by the resolved id first -- it is the one this build
 * wrote, and the other is a leftover from before the ledger. Then the most
 * recently updated, because that is the decision the person made last. Then the
 * greater key, purely so two machines collapsing the same file collapse it the
 * same way.
 */
function beatsHeldOverride(candidate: RekeyedOverride, held: RekeyedOverride): boolean {
  if (candidate.exact !== held.exact) {
    return candidate.exact;
  }
  if (candidate.updatedAt !== held.updatedAt) {
    return candidate.updatedAt > held.updatedAt;
  }
  return candidate.previousKey > held.previousKey;
}

/** `overrides` order: kind, then key, matching `listOverrides`. */
function compareRekeyed(left: RekeyedOverride, right: RekeyedOverride): number {
  if (left.kind !== right.kind) {
    return left.kind < right.kind ? -1 : 1;
  }
  return left.assetKey < right.assetKey ? -1 : left.assetKey > right.assetKey ? 1 : 0;
}

/**
 * A relationship override re-stated on the ids it now names.
 *
 * Both ends, because both are stored references. The child is forced to the key
 * the row is filed under -- they are the same fact, and a payload that
 * disagreed with its key would be a second answer to "whose parent is this".
 */
function rekeyRelationship(
  override: ManualRelationshipOverride,
  childAssetId: string,
  resolved: ReadonlyMap<string, string>,
): ManualRelationshipOverride {
  const parent = override.parentAssetId;
  return {
    childAssetId,
    parentAssetId: parent === null ? null : (resolved.get(parent) ?? parent),
    ...(override.note === undefined ? {} : { note: override.note }),
  };
}

function cannotOpen(path: string, cause: unknown): ProjectStoreError {
  return new ProjectStoreError({
    kind: 'cannot-open',
    path,
    detail: cause instanceof Error ? cause.message : String(cause),
  });
}

/**
 * How long a write waits for another program's lock before giving up.
 *
 * Zero -- SQLite's default, and what this package used to run on -- means the
 * first byte of contention is a hard failure. A project file lives in a user's
 * documents folder, which on a real machine is also a Dropbox/OneDrive folder
 * and a backup agent's working set, so a moment's SHARED lock from something
 * else on the box would fail a compile save outright. Five seconds is long
 * enough to outlast any of that and short enough that a genuinely stuck file is
 * reported rather than hung on.
 */
export const BUSY_TIMEOUT_MS = 5000;

/** Opens a handle that waits {@link BUSY_TIMEOUT_MS} rather than failing at once. */
function openDatabase(path: string): DatabaseSync {
  return new DatabaseSync(path, { timeout: BUSY_TIMEOUT_MS });
}

/* SQLite result codes this package acts on rather than reports verbatim. */
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_READONLY = 8;

/** The SQLite result code on a driver error, or `null` for anything else. */
function sqliteErrcode(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) {
    return null;
  }
  const code: unknown = (error as { errcode?: unknown }).errcode;
  return typeof code === 'number' ? code : null;
}

/**
 * A failed write, as one of this package's own reasons.
 *
 * The three cases are separated because the fix differs: `locked` is another
 * program, `read-only` is the file or the folder, and `write-failed` is the
 * disk. A caller that only wants a sentence still gets one from
 * `describeProjectStoreReason`.
 */
function writeFailure(path: string, cause: unknown): ProjectStoreError {
  if (cause instanceof ProjectStoreError) {
    return cause;
  }
  const detail = cause instanceof Error ? cause.message : String(cause);
  const errcode = sqliteErrcode(cause);
  if (errcode === SQLITE_BUSY || errcode === SQLITE_LOCKED) {
    return new ProjectStoreError({ kind: 'locked', path, detail });
  }
  if (errcode === SQLITE_READONLY) {
    return new ProjectStoreError({ kind: 'read-only', path, detail });
  }
  return new ProjectStoreError({ kind: 'write-failed', path, detail });
}

/**
 * Rolls back, and says nothing if there is nothing to roll back.
 *
 * SQLite rolls a transaction back by itself on `SQLITE_FULL` and `SQLITE_IOERR`,
 * and a `ROLLBACK` issued after that throws "cannot rollback - no transaction is
 * active". So does a `ROLLBACK` after a statement that failed on a read-only
 * file. The failure that got us here is the one worth reporting; this one would
 * only mask it.
 */
function rollbackQuietly(db: DatabaseSync): void {
  try {
    db.exec('ROLLBACK');
  } catch {
    // Deliberately silent. See above.
  }
}

/**
 * Proves the file can actually be written, before a handle is handed out.
 *
 * `BEGIN IMMEDIATE` alone is not the proof it looks like: SQLite takes a
 * RESERVED lock without touching a page, so a file on read-only media begins a
 * transaction happily and only fails at the first real write. So the probe makes
 * one -- a self-assignment on a row that already exists -- and rolls it back.
 * Nothing is left behind and `modified_at` is untouched, but the answer is the
 * true one: a project opened read-only used to look fine right up until the user
 * had configured it and pressed Save.
 */
function probeWritable(db: DatabaseSync, path: string): void {
  try {
    db.exec('BEGIN IMMEDIATE');
    db.exec("UPDATE meta SET value = value WHERE key = 'schema_version'");
    db.exec('ROLLBACK');
  } catch (cause) {
    rollbackQuietly(db);
    throw writeFailure(path, cause);
  }
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
 *
 * The version is read a second time inside that transaction, because the first
 * read happened before the file was closed and copied: `BEGIN IMMEDIATE` is
 * what makes this process the only writer, and everything learned before it is
 * a claim about the past. A file somebody else upgraded in between is refused
 * (`migration-raced`) rather than migrated twice.
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
    db = openDatabase(path);
  } catch (cause) {
    throw cannotOpen(path, cause);
  }

  try {
    db.exec('PRAGMA foreign_keys = ON');
    const appliedAt = isoNow(clock);
    db.exec('BEGIN IMMEDIATE');
    try {
      // Re-read under the write lock, which is the first moment this process
      // can be sure nobody else is mid-upgrade. `found` was read before the
      // backup was taken and the step list was chosen for it; if another
      // program has moved the file on since -- a second Matchline window, a
      // file on a share -- these steps are the wrong steps, and applying a v1
      // migration to a file that is already v2 is how a project gets a table it
      // already has or a row counted twice.
      //
      // The backup is left where it is. It is a copy of a real earlier state of
      // this project, and deleting a user's only copy of it on an error path
      // would be the worse of the two mistakes.
      const current = requiredCount(readMetaEntries(db), 'schema_version');
      if (current !== found) {
        throw new ProjectStoreError({
          kind: 'migration-raced',
          path,
          expected: found,
          found: current,
        });
      }
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

/**
 * Opens a file, validates it and proves it can be written, closing the handle
 * on any refusal.
 */
function openValidated(path: string): DatabaseSync {
  let db: DatabaseSync;
  try {
    db = openDatabase(path);
  } catch (cause) {
    throw cannotOpen(path, cause);
  }

  try {
    db.exec('PRAGMA foreign_keys = ON');
    validateProject(db);
    probeWritable(db, path);
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
    db = openDatabase(path);
  } catch (cause) {
    throw cannotOpen(path, cause);
  }

  try {
    db.exec('PRAGMA foreign_keys = ON');
    // Before the first table and outside the transaction, which is the only
    // moment this can be set: `auto_vacuum` on a database that already has a
    // page is a no-op, and changing it later needs a full `VACUUM`. It is what
    // lets `close` hand pruned asset pages back to the filesystem instead of
    // leaving a project file at its high-water mark forever.
    db.exec('PRAGMA auto_vacuum = INCREMENTAL');
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

    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (cause) {
      // Nothing was opened, so there is nothing to roll back and `#depth` is
      // still 0. A lock held by another program lands here after the busy
      // timeout has already been waited out.
      throw writeFailure(this.path, cause);
    }

    this.#depth = 1;
    // `COMMIT` is INSIDE the guard, and this is the whole point of the shape.
    // It is the statement most likely to fail -- it is where SQLite finally
    // needs the EXCLUSIVE lock and where the pages actually reach the disk --
    // and a COMMIT that threw used to leave the transaction open with `#depth`
    // already zeroed, so every later mutation in the session failed on
    // "cannot start a transaction within a transaction". One bad moment from a
    // sync client wedged the store until the app was restarted.
    let committing = false;
    try {
      const result = fn();
      committing = true;
      db.exec('COMMIT');
      return result;
    } catch (error) {
      rollbackQuietly(db);
      // A throw from `fn` that is the CALLER's own -- a compile service falling
      // over mid-transaction, a validation refusal -- is rethrown exactly as it
      // is, so composing mutations does not rewrite the reason one of them
      // failed. A throw that carries a SQLite result code is not the caller's:
      // it is this file failing to write, and the package's contract is that a
      // caller never sees a raw driver error.
      throw committing || sqliteErrcode(error) !== null
        ? writeFailure(this.path, error)
        : error;
    } finally {
      // In `finally`, so the depth is right whichever way the block left --
      // including the return, where it used to be reset before the commit.
      this.#depth = 0;
    }
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
    return {
      sourceId: requireText(row, 'sources', 'source_id'),
      role: requireMemberArgument(
        requireText(row, 'sources', 'role'),
        SOURCE_ROLES,
        'sources.role',
      ),
      logicalName: requireText(row, 'sources', 'logical_name'),
      rawFileName: requireText(row, 'sources', 'raw_file_name'),
      rawSha256: requireText(row, 'sources', 'raw_sha256'),
      rawByteSize: requireInteger(row, 'sources', 'raw_byte_size'),
      derivedCacheSha256: optionalText(row, 'sources', 'derived_cache_sha256'),
      addedAt: requireText(row, 'sources', 'added_at'),
    };
  }

  removeSource(sourceId: string): boolean {
    const id = requireFilledArgument(sourceId, 'sourceId');
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

  saveProfile(profile: SiteProfileV2, revisionNote?: string): number {
    // §13.3: every save validates before publication. A profile that cannot be
    // read back is never written.
    const validated = validateSiteProfileV2(profile);
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
      // A revision written before the consolidation carries no `formatVersion`
      // and is lifted here rather than refused: every profile a project has ever
      // stored stays readable, and nothing is rewritten on upgrade.
      profile: validateSiteProfileV2(
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
      const db = this.#open();
      db.prepare(
        `INSERT INTO overrides (kind, asset_key, payload_json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (kind, asset_key) DO UPDATE SET
           payload_json = excluded.payload_json,
           updated_at = excluded.updated_at`,
      ).run(kind, assetKey, json, updatedAt);
      // One row per asset. `tag:MAH001-10-01` and `MAH001-10-01` are two
      // spellings of one thing -- the second is what every build before schema
      // v5 wrote, the first is what `@matchline/asset-catalog` mints for an
      // unduplicated tag -- and a project holding both hands the claims
      // assembly two manual parents for one child, which surfaces as an
      // `ambiguous-parent` about a disagreement the person never had. Writing
      // one spelling retires the other, here, where the decision is made.
      const sibling = siblingSpelling(assetKey);
      if (sibling !== null) {
        db.prepare('DELETE FROM overrides WHERE kind = ? AND asset_key = ?').run(kind, sibling);
      }
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

  rekeyOverrides(resolved: ReadonlyMap<string, string>): number {
    // `withTransaction` rather than `#mutate`, because the overwhelmingly
    // common call is the one that finds nothing to do -- a project whose rows
    // are already ledger ids -- and that call must not stamp `modified_at`. A
    // file that reports itself modified by every compile is a file a sync
    // client copies after every compile.
    return this.withTransaction(() => {
      const db = this.#open();
      /** `kind` -> resolved key -> the row that should survive under it. */
      const winners = new Map<string, RekeyedOverride>();
      let removed = 0;

      for (const stored of this.listOverrides()) {
        const target = resolved.get(stored.assetKey) ?? stored.assetKey;
        const candidate: RekeyedOverride = {
          kind: stored.kind,
          assetKey: target,
          // `payload` is rebuilt rather than carried, because a relationship
          // override states its own child id and it must not disagree with the
          // key it is filed under -- and its PARENT is a stored reference too,
          // re-addressed by the same map for the same reason.
          payload:
            stored.kind === 'relationship'
              ? rekeyRelationship(stored.override, target, resolved)
              : stored.override,
          // Whether this row was ALREADY correctly keyed. It wins over a row
          // that had to be moved: it is the one this build wrote.
          exact: stored.assetKey === target,
          previousKey: stored.assetKey,
          updatedAt: stored.updatedAt,
        };
        const slot = `${stored.kind}\u241F${target}`;
        const held = winners.get(slot);
        if (held === undefined) {
          winners.set(slot, candidate);
          continue;
        }
        removed += 1;
        if (beatsHeldOverride(candidate, held)) {
          winners.set(slot, candidate);
        }
      }

      if (removed === 0 && [...winners.values()].every((row) => row.exact)) {
        // Nothing to do, and nothing written: the overwhelmingly common case
        // is a project whose rows are already keyed by ledger id, and it should
        // not pay a rewrite (or a `modified_at` bump) on every compile.
        return 0;
      }

      db.exec('DELETE FROM overrides');
      const insert = db.prepare(
        `INSERT INTO overrides (kind, asset_key, payload_json, updated_at)
         VALUES (?, ?, ?, ?)`,
      );

      for (const row of [...winners.values()].sort(compareRekeyed)) {
        insert.run(
          row.kind,
          row.assetKey,
          canonicalJson(row.payload, `override.${row.kind}`),
          // The row is the same decision, moved. Re-stamping it would claim the
          // person decided it today, and `updated_at` is what the overrides
          // screen prints.
          row.updatedAt,
        );
      }
      // One stamp for the rewrite itself, which IS a change to the file.
      this.#touch(this.#now());
      return removed;
    });
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
        `SELECT id, input_hashes_json, profile_revision, stats_json, started_at, finished_at,
                recorded_at, asset_count
         FROM compiles ORDER BY id DESC LIMIT ?`,
      )
      .all(bound)
      .map((row) => this.#readCompile(row));
  }

  saveCompileAssets(compileId: number, assets: readonly unknown[]): void {
    const checkedId = requireCountArgument(compileId, 'compileId');
    if (!Array.isArray(assets)) {
      invalidArgument('assets', 'expected an array');
    }
    const json = canonicalJson(assets, 'compileAssets');
    this.#mutate(() => {
      const db = this.#open();
      const compile = db.prepare('SELECT id FROM compiles WHERE id = ?').get(checkedId);
      if (compile === undefined) {
        throw new ProjectStoreError({ kind: 'unknown-compile', compileId: checkedId });
      }
      db.prepare('UPDATE compiles SET asset_count = ? WHERE id = ?').run(assets.length, checkedId);
      db.prepare(
        `INSERT INTO compile_assets (compile_id, assets_json) VALUES (?, ?)
         ON CONFLICT (compile_id) DO UPDATE SET assets_json = excluded.assets_json`,
      ).run(checkedId, json);
      // The prune. Bounded by a subquery over `compiles` rather than by a
      // remembered id, so a project migrated in with a hundred asset rows is
      // trimmed by its first compile rather than staying big forever.
      db.prepare(
        `DELETE FROM compile_assets
         WHERE compile_id NOT IN (SELECT id FROM compiles ORDER BY id DESC LIMIT ?)`,
      ).run(COMPILE_ASSET_RETENTION);
    });
  }

  listCompilesWithAssets(): ReadonlySet<number> {
    return new Set(
      this.#open()
        .prepare('SELECT compile_id FROM compile_assets')
        .all()
        .map((row) => requireInteger(row, 'compile_assets', 'compile_id')),
    );
  }

  getCompileAssets<T = unknown>(
    compileId: number,
    validate?: (value: unknown) => T,
  ): T | undefined {
    const checkedId = requireCountArgument(compileId, 'compileId');
    const row = this.#open()
      .prepare('SELECT assets_json FROM compile_assets WHERE compile_id = ?')
      .get(checkedId);
    if (row === undefined) {
      return undefined;
    }
    const parsed = parseStoredJson(
      requireText(row, 'compile_assets', 'assets_json'),
      'compile_assets',
    );
    // As in `getLatestSnapshot`: without a validate hook the caller asked for
    // `unknown`, which is what `T` defaults to.
    return validate === undefined ? (parsed as T) : validate(parsed);
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
      assetCount: requireInteger(row, 'compiles', 'asset_count'),
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

  saveLedger(compileId: number, ledger: unknown): void {
    const checkedId = requireCountArgument(compileId, 'compileId');
    const json = canonicalJson(ledger, 'ledger');
    this.#mutate((savedAt) => {
      const db = this.#open();
      const compile = db.prepare('SELECT id FROM compiles WHERE id = ?').get(checkedId);
      if (compile === undefined) {
        throw new ProjectStoreError({ kind: 'unknown-compile', compileId: checkedId });
      }
      // One ledger at a time: `slot` is pinned to 0 by the DDL, so replacing the
      // current one is structural rather than a convention.
      db.exec('DELETE FROM ledger');
      db.prepare(
        'INSERT INTO ledger (slot, compile_id, ledger_json, saved_at) VALUES (0, ?, ?, ?)',
      ).run(checkedId, json, savedAt);
    });
  }

  getLedger<T = unknown>(validate?: (value: unknown) => T): StoredLedger<T> | undefined {
    const row = this.#open()
      .prepare('SELECT compile_id, ledger_json FROM ledger WHERE slot = 0')
      .get();
    if (row === undefined) {
      return undefined;
    }
    const parsed = parseStoredJson(requireText(row, 'ledger', 'ledger_json'), 'ledger');
    // As in `getLatestSnapshot`: without a validate hook the caller asked for
    // `unknown`, which is what `T` defaults to.
    const ledger = validate === undefined ? (parsed as T) : validate(parsed);
    return { compileId: requireInteger(row, 'ledger', 'compile_id'), ledger };
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

  /**
   * Removes one configuration row.
   *
   * Returns whether a row was there, so a caller migrating a section OUT of this
   * table can report what it actually moved rather than what it attempted.
   */
  deleteConfig(key: ConfigKey): boolean {
    const checkedKey = requireMemberArgument(key, CONFIG_KEYS, 'key');
    return this.#mutate(() => {
      const { changes } = this.#open()
        .prepare('DELETE FROM config WHERE key = ?')
        .run(checkedKey);
      return Number(changes) > 0;
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

  saveDraft(draft: unknown): void {
    const json = canonicalJson(draft, 'draft');
    this.#mutate((updatedAt) => {
      this.#open()
        .prepare(
          `INSERT INTO profile_draft (slot, draft_json, updated_at) VALUES (0, ?, ?)
           ON CONFLICT (slot) DO UPDATE SET
             draft_json = excluded.draft_json,
             updated_at = excluded.updated_at`,
        )
        .run(json, updatedAt);
    });
  }

  getDraft<T = unknown>(validate?: (value: unknown) => T): StoredDraft<T> | undefined {
    const row = this.#open()
      .prepare('SELECT draft_json, updated_at FROM profile_draft WHERE slot = 0')
      .get();
    if (row === undefined) {
      return undefined;
    }
    const parsed = parseStoredJson(
      requireText(row, 'profile_draft', 'draft_json'),
      'profile_draft',
    );
    return {
      draft: validate === undefined ? (parsed as T) : validate(parsed),
      updatedAt: requireText(row, 'profile_draft', 'updated_at'),
    };
  }

  clearDraft(): boolean {
    return this.#mutate(() => {
      const { changes } = this.#open().prepare('DELETE FROM profile_draft').run();
      return Number(changes) > 0;
    });
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

  removeDecision(reviewKey: string): boolean {
    const key = requireFilledArgument(reviewKey, 'reviewKey');
    return this.#mutate((): boolean => {
      const { changes } = this.#open()
        .prepare('DELETE FROM decisions WHERE review_key = ?')
        .run(key);
      return Number(changes) > 0;
    });
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

  /**
   * Releases the handle, giving freed pages back first when there are enough.
   *
   * `incremental_vacuum` only does anything on a file created
   * `auto_vacuum = INCREMENTAL`, which is every project created by this build
   * and no project created before it. An existing file is deliberately left on
   * whatever it was created with: switching a database to incremental vacuuming
   * requires a full `VACUUM`, which rewrites it whole -- minutes of I/O and a
   * second copy of the file on disk, at the moment a user pressed Close.
   *
   * Best-effort throughout. A close that failed to reclaim disk is not a close
   * that failed, and the handle must be released either way.
   */
  close(): void {
    const db = this.#db;
    if (db === null) {
      return;
    }
    try {
      this.#reclaim(db);
    } catch {
      // Nothing to tell the user. The pages stay in the freelist and the next
      // close tries again.
    } finally {
      db.close();
      this.#db = null;
    }
  }

  #reclaim(db: DatabaseSync): void {
    const mode = db.prepare('PRAGMA auto_vacuum').get();
    // 2 is INCREMENTAL. 0 (NONE) and 1 (FULL) are both files this build did not
    // create, and running the pragma on them is a no-op rather than a mistake --
    // but reading the freelist on a large one is not free, so it is skipped.
    if (mode === undefined || requireInteger(mode, 'pragma.auto_vacuum', 'auto_vacuum') !== 2) {
      return;
    }
    const free = db.prepare('PRAGMA freelist_count').get();
    if (
      free !== undefined &&
      requireInteger(free, 'pragma.freelist_count', 'freelist_count') >=
        VACUUM_FREELIST_THRESHOLD
    ) {
      db.exec('PRAGMA incremental_vacuum');
    }
  }
}
