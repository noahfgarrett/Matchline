import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test, { after } from 'node:test';

import {
  COMPILE_ASSET_RETENTION,
  createProject,
  deriveSourceId,
  deserializeLedger,
  describeProjectStoreReason,
  openProject,
  PROJECT_SCHEMA_VERSION,
  ProjectStoreError,
} from '../dist/index.js';

import {
  dragonProfile,
  dumpTables,
  frozenClock,
  rawExec,
  steppingClock,
  tempDirectory,
  withoutColumn,
} from './support.mjs';

/**
 * The migrations, and the promise that running one is never destructive.
 *
 * ## Why each old DDL is copied out rather than imported
 *
 * A migration test that builds its "old" file from today's code proves nothing:
 * the two would drift together and the test would keep passing while real old
 * files stopped opening. Each snapshot below is the DDL as that version actually
 * shipped, frozen here on purpose. None of them may ever be edited to match a
 * later schema — a future v6 adds a v5 snapshot beside them instead.
 */

const V1_SCHEMA_SQL = `
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

/**
 * `PROJECT_SCHEMA_SQL` as **v2** shipped, frozen.
 *
 * The two tables v3 rebuilds carry their v2 CHECK constraints here — `config`
 * without `'extoTemplate'`, `learned` without `'wbs'` — which is the whole point
 * of the snapshot: a v3 step that failed to widen them would still pass against
 * a file built from today's DDL, and would fail here.
 */
const V2_SCHEMA_SQL = `
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

CREATE TABLE config (
  key         TEXT PRIMARY KEY CHECK (key IN (
                'hierarchy', 'roleGraph', 'ladder', 'ssmDisciplineProjection',
                'parentTagProperty')),
  config_json TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) WITHOUT ROWID;
`;

/**
 * `PROJECT_SCHEMA_SQL` as **v3** shipped, frozen.
 *
 * `sources` carries its v3 identity here — `PRIMARY KEY (role, file_name)`, one
 * `sha256`, and no `source_id` — which is the whole point of the snapshot: a v4
 * step that failed to rebuild the table would still pass against a file built
 * from today's DDL, and would fail here. A test below asserts the absence of
 * `source_id` in this text, so the fixture cannot be quietly modernized.
 */
const V3_SCHEMA_SQL = `
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
  kind       TEXT NOT NULL CHECK (kind IN ('nesting', 'item-master', 'wbs')),
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

CREATE TABLE config (
  key         TEXT PRIMARY KEY CHECK (key IN (
                'hierarchy', 'roleGraph', 'ladder', 'ssmDisciplineProjection',
                'parentTagProperty', 'extoTemplate')),
  config_json TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) WITHOUT ROWID;
`;

/**
 * `PROJECT_SCHEMA_SQL` as **v4** shipped, frozen.
 *
 * Copied out of `schema.ts` before v5 edited it. It has no `ledger` table, which
 * is the whole point of the snapshot: a v5 step that failed to create one would
 * still pass against a file built from today's DDL, and would fail here. A test
 * below asserts the absence of the word `ledger` in this text, so the fixture
 * cannot be quietly modernized.
 */
const V4_SCHEMA_SQL = `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

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

CREATE TABLE profile (
  revision     INTEGER PRIMARY KEY CHECK (revision > 0),
  profile_json TEXT NOT NULL,
  note         TEXT,
  saved_at     TEXT NOT NULL
);

CREATE TABLE learned (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('nesting', 'item-master', 'wbs')),
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

CREATE TABLE config (
  key         TEXT PRIMARY KEY CHECK (key IN (
                'hierarchy', 'roleGraph', 'ladder', 'ssmDisciplineProjection',
                'parentTagProperty', 'extoTemplate')),
  config_json TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) WITHOUT ROWID;
`;

const CREATED_AT = '2026-01-15T09:30:00.000Z';
const MIGRATED_AT = '2026-02-01T08:00:00.000Z';

const temp = tempDirectory('migration');
after(() => {
  temp.cleanup();
});

function reason(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ProjectStoreError, `expected ProjectStoreError, got ${error}`);
    return error.reason;
  }
  throw new assert.AssertionError({ message: 'expected a throw, got none' });
}

/**
 * Writes a v1 project file with real content in it, from the frozen DDL above.
 *
 * The content matters: a migration that produced a valid empty file would pass
 * a shape check and still have thrown a site's work away.
 */
function writeV1Project(name) {
  const path = temp.file(name);
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(V1_SCHEMA_SQL);

    const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    meta.run('schema_version', '1');
    meta.run('app_version', '0.6.0');
    meta.run('project_name', 'Dragon');
    meta.run('created_at', CREATED_AT);
    meta.run('modified_at', CREATED_AT);
    db.prepare('INSERT INTO migrations (version, applied_at) VALUES (?, ?)').run(1, CREATED_AT);

    db.prepare(
      'INSERT INTO sources (role, file_name, sha256, byte_size, added_at) VALUES (?, ?, ?, ?, ?)',
    ).run('model', 'Dragon-Coordination.nwd', 'a'.repeat(64), 104857600, CREATED_AT);
    db.prepare(
      'INSERT INTO decisions (review_key, decision, note, decided_at) VALUES (?, ?, ?, ?)',
    ).run('missing-boundary:tag:MAH001-10-01', 'accepted', 'walked it down on site', CREATED_AT);
  } finally {
    db.close();
  }
  return path;
}

/**
 * Writes a v2 project file with real content in it, from the frozen DDL above.
 *
 * Both tables v3 rebuilds are given rows, and the `learned` rows are given
 * non-contiguous ids: the rebuild copies ids rather than reassigning them, and a
 * table that renumbered its rows would break every reference to "the item-master
 * table saved on Tuesday".
 */
function writeV2Project(name) {
  const path = temp.file(name);
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(V2_SCHEMA_SQL);

    const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    meta.run('schema_version', '2');
    meta.run('app_version', '0.8.0');
    meta.run('project_name', 'Dragon');
    meta.run('created_at', CREATED_AT);
    meta.run('modified_at', CREATED_AT);
    const migration = db.prepare('INSERT INTO migrations (version, applied_at) VALUES (?, ?)');
    migration.run(1, CREATED_AT);
    migration.run(2, CREATED_AT);

    db.prepare(
      'INSERT INTO sources (role, file_name, sha256, byte_size, added_at) VALUES (?, ?, ?, ?, ?)',
    ).run('model', 'Dragon-Coordination.nwd', 'a'.repeat(64), 104857600, CREATED_AT);

    const learned = db.prepare(
      'INSERT INTO learned (id, kind, rules_json, saved_at) VALUES (?, ?, ?, ?)',
    );
    learned.run(3, 'nesting', JSON.stringify({ version: 1, classification: [] }), CREATED_AT);
    learned.run(9, 'item-master', JSON.stringify({ version: 1, entries: [] }), CREATED_AT);

    const config = db.prepare(
      'INSERT INTO config (key, config_json, updated_at) VALUES (?, ?, ?)',
    );
    config.run('ladder', JSON.stringify({ tiers: ['manual'] }), CREATED_AT);
    config.run('parentTagProperty', JSON.stringify(null), CREATED_AT);
  } finally {
    db.close();
  }
  return path;
}

test('a v1 project is refused, by version, until migration is asked for', () => {
  const path = writeV1Project('refused.matchline');

  const failure = reason(() => openProject(path));
  assert.equal(failure.kind, 'migration-required');
  assert.equal(failure.found, 1);
  assert.equal(failure.supported, PROJECT_SCHEMA_VERSION);

  // Not "missing table 'config'": the file is a version older, not corrupt, and
  // saying so is what sends the user to the right answer.
  assert.equal(existsSync(`${path}.backup-1`), false, 'a refusal touches nothing');
});

test('migrating a v1 project backs it up and keeps every row', () => {
  const path = writeV1Project('migrate.matchline');
  const before = dumpTables(path, [
    'meta',
    'sources',
    'profile',
    'learned',
    'overrides',
    'compiles',
    'snapshots',
    'decisions',
  ]);

  const store = openProject(path, { migrate: true, now: frozenClock(MIGRATED_AT) });
  try {
    assert.deepEqual(store.migration, {
      fromVersion: 1,
      toVersion: PROJECT_SCHEMA_VERSION,
      backupPath: `${path}.backup-1`,
    });
    assert.ok(existsSync(`${path}.backup-1`), 'the original was copied before anything ran');

    const meta = store.meta();
    assert.equal(meta.schemaVersion, PROJECT_SCHEMA_VERSION);
    assert.equal(meta.projectName, 'Dragon');
    assert.equal(meta.createdAt, CREATED_AT);

    assert.deepEqual(store.listSources(), [
      {
        sourceId: 'model:dragon-coordination.nwd',
        role: 'model',
        logicalName: 'Dragon-Coordination.nwd',
        rawFileName: 'Dragon-Coordination.nwd',
        rawSha256: 'a'.repeat(64),
        rawByteSize: 104857600,
        derivedCacheSha256: 'a'.repeat(64),
        addedAt: CREATED_AT,
      },
    ]);
    assert.equal(store.listDecisions().length, 1);
    assert.deepEqual(store.listConfig(), [], 'the new table starts empty, not defaulted');
  } finally {
    store.close();
  }

  // Every pre-existing table came through untouched -- except `sources`, which
  // v4 rebuilds around `source_id`; its data is asserted through the store
  // above, and its row count here.
  const after_ = dumpTables(path, [
    'meta',
    'sources',
    'profile',
    'learned',
    'overrides',
    'compiles',
    'snapshots',
    'decisions',
  ]);
  assert.equal(after_.sources.length, before.sources.length, 'one row in, one row out');
  assert.deepEqual(after_.decisions, before.decisions);
  assert.deepEqual(
    after_.meta.filter((row) => !row.includes('schema_version')),
    before.meta.filter((row) => !row.includes('schema_version')),
    'only the version line changed',
  );

  // Every step is recorded, so "when did this file become current" is
  // answerable — and a v1 file walks the whole ladder, one step per version.
  assert.deepEqual(dumpTables(path, ['migrations']).migrations, [
    JSON.stringify({ applied_at: CREATED_AT, version: 1 }),
    JSON.stringify({ applied_at: MIGRATED_AT, version: 2 }),
    JSON.stringify({ applied_at: MIGRATED_AT, version: 3 }),
    JSON.stringify({ applied_at: MIGRATED_AT, version: 4 }),
    JSON.stringify({ applied_at: MIGRATED_AT, version: 5 }),
    JSON.stringify({ applied_at: MIGRATED_AT, version: 6 }),
    JSON.stringify({ applied_at: MIGRATED_AT, version: 7 }),
  ]);

  // The backup is still the v1 file, which is the whole point of taking it.
  const backup = new DatabaseSync(`${path}.backup-1`, { readOnly: true });
  try {
    assert.equal(
      backup.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value,
      '1',
    );
  } finally {
    backup.close();
  }
});

test('a migrated project reopens as current, with no second backup', () => {
  const path = writeV1Project('reopen.matchline');
  openProject(path, { migrate: true, now: frozenClock(MIGRATED_AT) }).close();

  const store = openProject(path, { migrate: true });
  try {
    assert.equal(store.migration, null, 'nothing to do the second time');
    assert.equal(store.meta().schemaVersion, PROJECT_SCHEMA_VERSION);
  } finally {
    store.close();
  }
});

test('a stale backup stops the migration rather than being overwritten', () => {
  const path = writeV1Project('stale-backup.matchline');
  openProject(path, { migrate: true, now: frozenClock(MIGRATED_AT) }).close();

  // Put the file back to v1 with its backup still in place: a previous failed
  // migration's backup is evidence, and replacing it destroys what it was for.
  rawExec(path, "UPDATE meta SET value = '1' WHERE key = 'schema_version'");
  const failure = reason(() => openProject(path, { migrate: true }));
  assert.equal(failure.kind, 'backup-exists');
  assert.equal(failure.path, `${path}.backup-1`);
});

test('a version this build has no step for is refused, not guessed at', () => {
  const path = temp.file('ancient.matchline');
  createProject(path, { name: 'Dragon', now: frozenClock(CREATED_AT) }).close();
  rawExec(path, "UPDATE meta SET value = '0' WHERE key = 'schema_version'");

  const failure = reason(() => openProject(path, { migrate: true }));
  assert.equal(failure.kind, 'no-migration-path');
  assert.equal(failure.found, 0);
  assert.equal(existsSync(`${path}.backup-0`), false, 'nothing was copied for a migration that could not run');
});

test('a project written by a newer build is still refused, migrate or not', () => {
  const path = temp.file('future.matchline');
  createProject(path, { name: 'Dragon', now: frozenClock(CREATED_AT) }).close();
  rawExec(path, "UPDATE meta SET value = '99' WHERE key = 'schema_version'");

  for (const options of [{}, { migrate: true }]) {
    const failure = reason(() => openProject(path, options));
    assert.equal(failure.kind, 'unsupported-schema-version');
    assert.equal(failure.found, 99);
  }
});

/* ------------------------------------------------------- v2 → v3 */

test('a v2 project is refused, by version, until migration is asked for', () => {
  const path = writeV2Project('refused-v2.matchline');

  const failure = reason(() => openProject(path));
  assert.equal(failure.kind, 'migration-required');
  assert.equal(failure.found, 2);
  assert.equal(failure.supported, PROJECT_SCHEMA_VERSION);
  assert.equal(existsSync(`${path}.backup-2`), false, 'a refusal touches nothing');
});

test('migrating a v2 project widens both CHECKs and keeps every row', () => {
  const path = writeV2Project('migrate-v2.matchline');
  const before = dumpTables(path, ['learned', 'config', 'sources', 'meta']);

  const store = openProject(path, { migrate: true, now: frozenClock(MIGRATED_AT) });
  try {
    assert.deepEqual(store.migration, {
      fromVersion: 2,
      toVersion: PROJECT_SCHEMA_VERSION,
      backupPath: `${path}.backup-2`,
    });
    assert.equal(store.meta().schemaVersion, PROJECT_SCHEMA_VERSION);

    // The rows that were there are still there, ids and all.
    assert.deepEqual(
      store.listConfig().map((entry) => entry.key),
      ['ladder', 'parentTagProperty'],
    );
    assert.deepEqual(store.getConfig('ladder').value, { tiers: ['manual'] });

    // And the two new values the widening exists for are now accepted.
    store.saveConfig('extoTemplate', { version: 1, headers: ['UPN'], headerRowIndex: 0 });
    assert.deepEqual(store.getConfig('extoTemplate').value, {
      version: 1,
      headers: ['UPN'],
      headerRowIndex: 0,
    });

    store.saveLearnedRules('wbs', { version: 1, entries: [{ systemKey: '001', wbs: '1810' }] });
    const wbs = store.getLearnedRules('wbs');
    assert.deepEqual(wbs.rules, { version: 1, entries: [{ systemKey: '001', wbs: '1810' }] });
  } finally {
    store.close();
  }

  const after_ = dumpTables(path, ['learned', 'sources']);
  assert.equal(after_.sources.length, before.sources.length, 'the v4 rebuild kept the row');
  for (const row of before.learned) {
    assert.ok(
      after_.learned.includes(row),
      `the rebuilt table lost or rewrote a pre-existing row: ${row}`,
    );
  }
  assert.equal(after_.learned.length, before.learned.length + 1, 'and gained only the new one');
  assert.ok(
    after_.learned.some((row) => row.includes('"id":10')),
    'ids carried across, so the next one continues the sequence rather than colliding',
  );

  assert.deepEqual(dumpTables(path, ['migrations']).migrations, [
    JSON.stringify({ applied_at: CREATED_AT, version: 1 }),
    JSON.stringify({ applied_at: CREATED_AT, version: 2 }),
    JSON.stringify({ applied_at: MIGRATED_AT, version: 3 }),
    JSON.stringify({ applied_at: MIGRATED_AT, version: 4 }),
    JSON.stringify({ applied_at: MIGRATED_AT, version: 5 }),
    JSON.stringify({ applied_at: MIGRATED_AT, version: 6 }),
    JSON.stringify({ applied_at: MIGRATED_AT, version: 7 }),
  ]);

  // The backup is still the v2 file, which is the whole point of taking it.
  const backup = new DatabaseSync(`${path}.backup-2`, { readOnly: true });
  try {
    assert.equal(
      backup.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get().value,
      '2',
    );
    assert.throws(
      () =>
        backup
          .prepare('INSERT INTO learned (kind, rules_json, saved_at) VALUES (?, ?, ?)')
          .run('wbs', '{}', CREATED_AT),
      'the frozen v2 DDL really did refuse the new kind — so the widening is real',
    );
  } finally {
    backup.close();
  }
});

test('a v2 project that had never been to screens 6-7 migrates just as well', () => {
  const path = temp.file('empty-v2.matchline');
  const db = new DatabaseSync(path);
  try {
    db.exec(V2_SCHEMA_SQL);
    const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    meta.run('schema_version', '2');
    meta.run('app_version', '0.8.0');
    meta.run('project_name', 'Dragon');
    meta.run('created_at', CREATED_AT);
    meta.run('modified_at', CREATED_AT);
    db.prepare('INSERT INTO migrations (version, applied_at) VALUES (?, ?)').run(2, CREATED_AT);
  } finally {
    db.close();
  }

  const store = openProject(path, { migrate: true, now: frozenClock(MIGRATED_AT) });
  try {
    assert.equal(store.meta().schemaVersion, PROJECT_SCHEMA_VERSION);
    assert.deepEqual(store.listConfig(), [], 'an empty table rebuilds to an empty table');
    assert.equal(store.getLearnedRules('wbs'), undefined);
  } finally {
    store.close();
  }
});

test('a migrated v2 project reopens as current, with no second backup', () => {
  const path = writeV2Project('reopen-v2.matchline');
  openProject(path, { migrate: true, now: frozenClock(MIGRATED_AT) }).close();

  const store = openProject(path, { migrate: true });
  try {
    assert.equal(store.migration, null, 'nothing to do the second time');
  } finally {
    store.close();
  }
});

/* ------------------------------------------------------- v3 → v4 */

/**
 * Writes a v3 project file with something in every table, from the frozen DDL.
 *
 * Two model sources share a basename in spirit but not in fact — a v3 file
 * cannot hold two rows with one `(role, file_name)`, which is the limitation v4
 * exists to remove — so the fixture registers four sources across three roles
 * and leaves the duplicate-basename case to a post-migration insert.
 *
 * The compile rows are the interesting part: their `input_hashes_json` is keyed
 * the way the desktop app keyed it (`role/fileName`), plus one key that names a
 * source which is no longer registered. The first must come out keyed by
 * `source_id`; the second must come out kept, not dropped.
 */
function writeV3Project(name) {
  const path = temp.file(name);
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(V3_SCHEMA_SQL);

    const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    meta.run('schema_version', '3');
    meta.run('app_version', '0.8.1');
    meta.run('project_name', 'Dragon');
    meta.run('created_at', CREATED_AT);
    meta.run('modified_at', CREATED_AT);
    const migration = db.prepare('INSERT INTO migrations (version, applied_at) VALUES (?, ?)');
    migration.run(3, CREATED_AT);

    const source = db.prepare(
      'INSERT INTO sources (role, file_name, sha256, byte_size, added_at) VALUES (?, ?, ?, ?, ?)',
    );
    source.run('model', 'Dragon Coordination.nwd', 'a'.repeat(64), 104857600, CREATED_AT);
    source.run('model', 'Dragon-Controls.matchline-cache', 'b'.repeat(64), 8388608, CREATED_AT);
    // Two file names a v3 file kept apart that reduce to one id: the space and
    // the hyphen both normalize away. Distinct rows must stay distinct.
    source.run('model', 'Dragon-Coordination.nwd', 'f'.repeat(64), 104857601, CREATED_AT);
    source.run('mel', 'Dragon-MEL.xlsx', 'c'.repeat(64), 20480, CREATED_AT);
    source.run('pmd', 'Dragon-PMD.xlsx', 'd'.repeat(64), 4096, CREATED_AT);

    const profile = db.prepare(
      'INSERT INTO profile (revision, profile_json, note, saved_at) VALUES (?, ?, ?, ?)',
    );
    profile.run(1, JSON.stringify(dragonProfile()), 'initial import', CREATED_AT);
    profile.run(2, JSON.stringify(dragonProfile({ name: 'Dragon Phase 2' })), null, CREATED_AT);

    const learned = db.prepare(
      'INSERT INTO learned (id, kind, rules_json, saved_at) VALUES (?, ?, ?, ?)',
    );
    learned.run(3, 'nesting', JSON.stringify({ version: 1, classification: [] }), CREATED_AT);
    learned.run(9, 'item-master', JSON.stringify({ version: 1, entries: [] }), CREATED_AT);
    learned.run(11, 'wbs', JSON.stringify({ version: 1, entries: [] }), CREATED_AT);

    const config = db.prepare('INSERT INTO config (key, config_json, updated_at) VALUES (?, ?, ?)');
    config.run('ladder', JSON.stringify({ tiers: ['manual'] }), CREATED_AT);
    config.run('extoTemplate', JSON.stringify({ version: 1, headers: ['UPN'] }), CREATED_AT);

    db.prepare(
      'INSERT INTO overrides (kind, asset_key, payload_json, updated_at) VALUES (?, ?, ?, ?)',
    ).run('system', 'MAH001-10-01', JSON.stringify({ systemKey: '001' }), CREATED_AT);

    db.prepare(
      `INSERT INTO compiles
         (id, input_hashes_json, profile_revision, stats_json, started_at, finished_at, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      1,
      JSON.stringify({
        'model/Dragon Coordination.nwd': 'a'.repeat(64),
        'model/Dragon-Controls.matchline-cache': 'b'.repeat(64),
        'model/Dragon-Coordination.nwd': 'f'.repeat(64),
        'mel/Dragon-MEL.xlsx': 'c'.repeat(64),
        // A source that was compiled once and has since been removed. Its hash
        // is history, and history is not the migration's to throw away.
        'mel/Dragon-MEL-2025.xlsx': 'e'.repeat(64),
      }),
      2,
      JSON.stringify({ nodeCount: 34 }),
      '2026-01-15T10:00:00.000Z',
      '2026-01-15T10:00:42.000Z',
      CREATED_AT,
    );

    db.prepare(
      'INSERT INTO snapshots (slot, compile_id, snapshot_json, saved_at) VALUES (0, ?, ?, ?)',
    ).run(1, JSON.stringify({ nodes: [], reviewItems: [], stats: { nodeCount: 34 } }), CREATED_AT);

    db.prepare(
      'INSERT INTO decisions (review_key, decision, note, decided_at) VALUES (?, ?, ?, ?)',
    ).run('missing-boundary:tag:MAH001-10-01', 'accepted', 'walked it down on site', CREATED_AT);
  } finally {
    db.close();
  }
  return path;
}

/** The column names of one table, as SQLite reports them. */
function columnsOf(path, table) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

test('the frozen v3 fixture really is pre-v4: its sources table has no source_id', () => {
  // The guard on every assertion below. A fixture quietly rebuilt from today's
  // DDL would make the whole v3 -> v4 suite prove nothing.
  assert.equal(V3_SCHEMA_SQL.includes('source_id'), false, 'the frozen DDL names no source_id');
  const path = writeV3Project('frozen-v3.matchline');
  assert.deepEqual(columnsOf(path, 'sources'), [
    'role',
    'file_name',
    'sha256',
    'byte_size',
    'added_at',
  ]);
});

test('a v3 project is refused, by version, until migration is asked for', () => {
  const path = writeV3Project('refused-v3.matchline');

  const failure = reason(() => openProject(path));
  assert.equal(failure.kind, 'migration-required');
  assert.equal(failure.found, 3);
  assert.equal(failure.supported, PROJECT_SCHEMA_VERSION);
  assert.equal(existsSync(`${path}.backup-3`), false, 'a refusal touches nothing');
});

test('migrating a v3 project gives every source an id and keeps every row', () => {
  const path = writeV3Project('migrate-v3.matchline');
  const before = dumpTables(path, [
    'profile',
    'learned',
    'overrides',
    'snapshots',
    'decisions',
    'config',
  ]);

  const store = openProject(path, { migrate: true, now: frozenClock(MIGRATED_AT) });
  try {
    assert.deepEqual(store.migration, {
      fromVersion: 3,
      toVersion: PROJECT_SCHEMA_VERSION,
      backupPath: `${path}.backup-3`,
    });
    assert.ok(existsSync(`${path}.backup-3`), 'the original was copied before anything ran');
    assert.equal(store.meta().schemaVersion, PROJECT_SCHEMA_VERSION);

    // Every source kept its name, hash, size and date, and gained an id derived
    // from what it already was -- not a random one.
    assert.deepEqual(store.listSources(), [
      {
        sourceId: 'mel:dragon-mel.xlsx',
        role: 'mel',
        logicalName: 'Dragon-MEL.xlsx',
        rawFileName: 'Dragon-MEL.xlsx',
        rawSha256: 'c'.repeat(64),
        rawByteSize: 20480,
        derivedCacheSha256: 'c'.repeat(64),
        addedAt: CREATED_AT,
      },
      {
        sourceId: 'model:dragon-controls.matchline-cache',
        role: 'model',
        logicalName: 'Dragon-Controls.matchline-cache',
        rawFileName: 'Dragon-Controls.matchline-cache',
        rawSha256: 'b'.repeat(64),
        rawByteSize: 8388608,
        derivedCacheSha256: 'b'.repeat(64),
        addedAt: CREATED_AT,
      },
      {
        sourceId: 'model:dragon-coordination.nwd',
        role: 'model',
        logicalName: 'Dragon Coordination.nwd',
        rawFileName: 'Dragon Coordination.nwd',
        rawSha256: 'a'.repeat(64),
        rawByteSize: 104857600,
        derivedCacheSha256: 'a'.repeat(64),
        addedAt: CREATED_AT,
      },
      {
        // Same slug as the row above, and a different source: the suffix is
        // what keeps a v3 file's two rows two rows.
        sourceId: 'model:dragon-coordination.nwd-2',
        role: 'model',
        logicalName: 'Dragon-Coordination.nwd',
        rawFileName: 'Dragon-Coordination.nwd',
        rawSha256: 'f'.repeat(64),
        rawByteSize: 104857601,
        derivedCacheSha256: 'f'.repeat(64),
        addedAt: CREATED_AT,
      },
      {
        sourceId: 'pmd:dragon-pmd.xlsx',
        role: 'pmd',
        logicalName: 'Dragon-PMD.xlsx',
        rawFileName: 'Dragon-PMD.xlsx',
        rawSha256: 'd'.repeat(64),
        rawByteSize: 4096,
        derivedCacheSha256: 'd'.repeat(64),
        addedAt: CREATED_AT,
      },
    ]);

    // The compile history is re-keyed to the ids the sources now carry, and the
    // hash of a source nobody registers any more is kept under `legacy:`.
    const [compile] = store.listCompiles();
    assert.deepEqual(compile.inputHashes, {
      'mel:dragon-mel.xlsx': 'c'.repeat(64),
      'model:dragon-controls.matchline-cache': 'b'.repeat(64),
      'model:dragon-coordination.nwd': 'a'.repeat(64),
      'model:dragon-coordination.nwd-2': 'f'.repeat(64),
      'legacy:mel/Dragon-MEL-2025.xlsx': 'e'.repeat(64),
    });
    assert.equal(compile.profileRevision, 2);
    assert.deepEqual(compile.stats, { nodeCount: 34 });

    // And nothing else moved.
    assert.deepEqual(
      store.listProfileRevisions().map((entry) => entry.revision),
      [2, 1],
    );
    assert.equal(store.getProfile().profile.name, 'Dragon Phase 2');
    assert.deepEqual(store.getLearnedRules('wbs').rules, { version: 1, entries: [] });
    assert.deepEqual(
      store.listConfig().map((entry) => entry.key),
      ['extoTemplate', 'ladder'],
    );
    assert.equal(store.listOverrides().length, 1);
    assert.equal(store.listDecisions().length, 1);
    assert.equal(store.getLatestSnapshot().compileId, 1);
  } finally {
    store.close();
  }

  const after_ = dumpTables(path, [
    'profile',
    'learned',
    'overrides',
    'snapshots',
    'decisions',
    'config',
  ]);
  assert.deepEqual(after_, before, 'every table v4 does not rebuild is byte-for-byte what it was');

  assert.deepEqual(dumpTables(path, ['migrations']).migrations, [
    JSON.stringify({ applied_at: CREATED_AT, version: 3 }),
    JSON.stringify({ applied_at: MIGRATED_AT, version: 4 }),
    JSON.stringify({ applied_at: MIGRATED_AT, version: 5 }),
    JSON.stringify({ applied_at: MIGRATED_AT, version: 6 }),
    JSON.stringify({ applied_at: MIGRATED_AT, version: 7 }),
  ]);

  // The backup is still the v3 file, which is the whole point of taking it.
  assert.deepEqual(columnsOf(`${path}.backup-3`, 'sources'), [
    'role',
    'file_name',
    'sha256',
    'byte_size',
    'added_at',
  ]);
});

test('two sources with the same basename coexist once a project is v4', () => {
  // Hard gate 4, at the storage layer: the thing a v3 file structurally could
  // not do. Both rows survive, and neither overwrites the other's hash.
  const path = writeV3Project('duplicate-basename.matchline');
  const store = openProject(path, { migrate: true, now: frozenClock(MIGRATED_AT) });
  try {
    const shared = 'Level 1.nwc';
    const first = deriveSourceId(
      'model',
      shared,
      store.listSources().map((source) => source.sourceId),
    );
    store.upsertSourceV4({
      sourceId: first,
      role: 'model',
      logicalName: 'Level 1 (Mechanical)',
      rawFileName: shared,
      rawSha256: '1'.repeat(64),
      rawByteSize: 512,
      addedAt: MIGRATED_AT,
    });
    const second = deriveSourceId(
      'model',
      shared,
      store.listSources().map((source) => source.sourceId),
    );
    store.upsertSourceV4({
      sourceId: second,
      role: 'model',
      logicalName: 'Level 1 (Controls)',
      rawFileName: shared,
      rawSha256: '2'.repeat(64),
      rawByteSize: 1024,
      addedAt: MIGRATED_AT,
    });

    assert.equal(first, 'model:level-1.nwc');
    assert.equal(second, 'model:level-1.nwc-2', 'the second one is suffixed, not refused');

    const shared_ = store.listSources().filter((source) => source.rawFileName === shared);
    assert.equal(shared_.length, 2, 'both are registered');
    assert.deepEqual(
      shared_.map((source) => source.rawSha256),
      ['1'.repeat(64), '2'.repeat(64)],
      'and each keeps its own hash',
    );
    assert.deepEqual(
      shared_.map((source) => source.logicalName),
      ['Level 1 (Mechanical)', 'Level 1 (Controls)'],
    );
  } finally {
    store.close();
  }
});

test('a migrated v3 project reopens as current, with no second backup', () => {
  const path = writeV3Project('reopen-v3.matchline');
  openProject(path, { migrate: true, now: frozenClock(MIGRATED_AT) }).close();

  const store = openProject(path, { migrate: true });
  try {
    assert.equal(store.migration, null, 'nothing to do the second time');
    assert.equal(store.listSources().length, 5, 'and the second open re-derived nothing');
  } finally {
    store.close();
  }
});

test('a v3 project with no sources and no compiles migrates just as well', () => {
  const path = temp.file('empty-v3.matchline');
  const db = new DatabaseSync(path);
  try {
    db.exec(V3_SCHEMA_SQL);
    const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    meta.run('schema_version', '3');
    meta.run('app_version', '0.8.1');
    meta.run('project_name', 'Dragon');
    meta.run('created_at', CREATED_AT);
    meta.run('modified_at', CREATED_AT);
    db.prepare('INSERT INTO migrations (version, applied_at) VALUES (?, ?)').run(3, CREATED_AT);
  } finally {
    db.close();
  }

  const store = openProject(path, { migrate: true, now: frozenClock(MIGRATED_AT) });
  try {
    assert.equal(store.meta().schemaVersion, PROJECT_SCHEMA_VERSION);
    assert.deepEqual(store.listSources(), [], 'an empty table rebuilds to an empty table');
    assert.deepEqual(store.listCompiles(), []);
  } finally {
    store.close();
  }
});

test('a project created today is already current and needs no migration', () => {
  const path = temp.file('fresh-current.matchline');
  const store = createProject(path, { name: 'Dragon', now: frozenClock(CREATED_AT) });
  try {
    assert.equal(store.meta().schemaVersion, PROJECT_SCHEMA_VERSION);
    assert.equal(store.getLedger(), undefined, 'and its ledger table starts empty');
    store.upsertSourceV4({
      sourceId: 'model:dragon.nwd',
      role: 'model',
      logicalName: 'Dragon',
      rawFileName: 'Dragon.nwd',
      rawSha256: 'a'.repeat(64),
      rawByteSize: 1,
      addedAt: CREATED_AT,
    });
    assert.equal(store.getSource('model:dragon.nwd').derivedCacheSha256, null);
    store.saveConfig('extoTemplate', { version: 1 });
    store.saveLearnedRules('wbs', { version: 1 });
    assert.deepEqual(store.getConfig('extoTemplate').value, { version: 1 });
    assert.deepEqual(store.getLearnedRules('wbs').rules, { version: 1 });
    // The two sections v6 widened the CHECK for (P0-7, P0-8).
    store.saveConfig('derivedAttributes', [{ attributeId: 'area', resolverChain: [] }]);
    store.saveConfig('sourceAssignmentRules', [{ scope: 'source-model', match: 'A.nwc' }]);
    assert.deepEqual(store.getConfig('derivedAttributes').value, [
      { attributeId: 'area', resolverChain: [] },
    ]);
    assert.deepEqual(store.getConfig('sourceAssignmentRules').value, [
      { scope: 'source-model', match: 'A.nwc' },
    ]);
  } finally {
    store.close();
  }
  assert.deepEqual(columnsOf(path, 'sources'), [
    'source_id',
    'role',
    'logical_name',
    'raw_file_name',
    'raw_sha256',
    'raw_byte_size',
    'derived_cache_sha256',
    'added_at',
  ]);
  assert.equal(openProject(path).migration, null);
});

/* ------------------------------------------------------- v4 → v5 */

/**
 * Writes a v4 project file with something in every table, from the frozen DDL.
 *
 * The overrides are the point of this fixture. They are keyed the way every
 * pre-v5 project keyed them — by canonical tag — because that is what the ledger
 * has to keep working once asset ids stop being derived from tags (P0-9,
 * "migrate tag-keyed overrides").
 */
function writeV4Project(name) {
  const path = temp.file(name);
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(V4_SCHEMA_SQL);

    const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    meta.run('schema_version', '4');
    meta.run('app_version', '0.8.1');
    meta.run('project_name', 'Dragon');
    meta.run('created_at', CREATED_AT);
    meta.run('modified_at', CREATED_AT);
    db.prepare('INSERT INTO migrations (version, applied_at) VALUES (?, ?)').run(4, CREATED_AT);

    db.prepare(
      `INSERT INTO sources
         (source_id, role, logical_name, raw_file_name, raw_sha256, raw_byte_size,
          derived_cache_sha256, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'model:dragon-coordination.nwd',
      'model',
      'Dragon Coordination',
      'Dragon-Coordination.nwd',
      'a'.repeat(64),
      104857600,
      'a'.repeat(64),
      CREATED_AT,
    );

    db.prepare(
      'INSERT INTO profile (revision, profile_json, note, saved_at) VALUES (?, ?, ?, ?)',
    ).run(1, JSON.stringify(dragonProfile()), 'initial import', CREATED_AT);

    db.prepare(
      'INSERT INTO learned (id, kind, rules_json, saved_at) VALUES (?, ?, ?, ?)',
    ).run(3, 'nesting', JSON.stringify({ version: 1, classification: [] }), CREATED_AT);

    db.prepare('INSERT INTO config (key, config_json, updated_at) VALUES (?, ?, ?)').run(
      'ladder',
      JSON.stringify({ tiers: ['manual'] }),
      CREATED_AT,
    );

    const override = db.prepare(
      'INSERT INTO overrides (kind, asset_key, payload_json, updated_at) VALUES (?, ?, ?, ?)',
    );
    override.run('system', 'MAH001-10-01', JSON.stringify({ systemKey: '001' }), CREATED_AT);
    override.run(
      'relationship',
      'tag:TIT001-10-01',
      JSON.stringify({ childAssetId: 'tag:TIT001-10-01', parentAssetId: 'tag:MAH001-10-01' }),
      CREATED_AT,
    );

    db.prepare(
      `INSERT INTO compiles
         (id, input_hashes_json, profile_revision, stats_json, started_at, finished_at, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      1,
      JSON.stringify({ 'model:dragon-coordination.nwd': 'a'.repeat(64) }),
      1,
      JSON.stringify({ nodeCount: 34 }),
      '2026-01-15T10:00:00.000Z',
      '2026-01-15T10:00:42.000Z',
      CREATED_AT,
    );

    db.prepare(
      'INSERT INTO snapshots (slot, compile_id, snapshot_json, saved_at) VALUES (0, ?, ?, ?)',
    ).run(1, JSON.stringify({ nodes: [], reviewItems: [], stats: { nodeCount: 34 } }), CREATED_AT);

    db.prepare(
      'INSERT INTO decisions (review_key, decision, note, decided_at) VALUES (?, ?, ?, ?)',
    ).run('missing-boundary:tag:MAH001-10-01', 'accepted', 'walked it down on site', CREATED_AT);
  } finally {
    db.close();
  }
  return path;
}

/** Every table name in a project file, as SQLite reports them. */
function tablesOf(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);
  } finally {
    db.close();
  }
}

test('the frozen v4 fixture really is pre-v5: it has no ledger table', () => {
  // The guard on every assertion below, as the v3 fixture's is on its own.
  assert.equal(V4_SCHEMA_SQL.includes('ledger'), false, 'the frozen DDL names no ledger');
  const path = writeV4Project('frozen-v4.matchline');
  assert.equal(tablesOf(path).includes('ledger'), false);
});

test('a v4 project is refused, by version, until migration is asked for', () => {
  const path = writeV4Project('refused-v4.matchline');

  const failure = reason(() => openProject(path));
  assert.equal(failure.kind, 'migration-required');
  assert.equal(failure.found, 4);
  assert.equal(failure.supported, PROJECT_SCHEMA_VERSION);
  assert.equal(existsSync(`${path}.backup-4`), false, 'a refusal touches nothing');
});

test('migrating a v4 project adds an empty ledger and moves nothing else', () => {
  const path = writeV4Project('migrate-v4.matchline');
  const before = dumpTables(path, [
    'sources',
    'profile',
    'learned',
    'overrides',
    'compiles',
    'snapshots',
    'decisions',
    'config',
  ]);

  const store = openProject(path, { migrate: true, now: frozenClock(MIGRATED_AT) });
  try {
    assert.deepEqual(store.migration, {
      fromVersion: 4,
      toVersion: PROJECT_SCHEMA_VERSION,
      backupPath: `${path}.backup-4`,
    });
    assert.ok(existsSync(`${path}.backup-4`), 'the original was copied before anything ran');
    assert.equal(store.meta().schemaVersion, PROJECT_SCHEMA_VERSION);

    // The ledger is empty rather than invented: identities come from model
    // evidence, and the migration reads no model. The next compile mints them.
    assert.equal(store.getLedger(), undefined);

    // And the decisions that ledger will have to re-address are all still here,
    // spelled exactly as the v4 file spelled them.
    assert.deepEqual(
      store.listOverrides().map((stored) => [stored.kind, stored.assetKey]),
      [
        ['relationship', 'tag:TIT001-10-01'],
        ['system', 'MAH001-10-01'],
      ],
    );
    assert.equal(store.listDecisions().length, 1);
    assert.equal(store.getLatestSnapshot().compileId, 1);
    assert.equal(store.listCompiles().length, 1);
  } finally {
    store.close();
  }

  const after_ = dumpTables(path, [
    'sources',
    'profile',
    'learned',
    'overrides',
    'compiles',
    'snapshots',
    'decisions',
    'config',
  ]);
  assert.deepEqual(
    { ...after_, compiles: withoutColumn(after_.compiles, 'asset_count') },
    before,
    'v5 rebuilds nothing, and v7 only adds `asset_count` to `compiles`',
  );
  assert.deepEqual(dumpTables(path, ['ledger']).ledger, []);

  assert.deepEqual(dumpTables(path, ['migrations']).migrations, [
    JSON.stringify({ applied_at: CREATED_AT, version: 4 }),
    JSON.stringify({ applied_at: MIGRATED_AT, version: 5 }),
    JSON.stringify({ applied_at: MIGRATED_AT, version: 6 }),
    JSON.stringify({ applied_at: MIGRATED_AT, version: 7 }),
  ]);

  // The backup is still the v4 file, which is the whole point of taking it.
  assert.equal(tablesOf(`${path}.backup-4`).includes('ledger'), false);
});

test('a migrated v4 project can store and reload a ledger', () => {
  const path = writeV4Project('ledger-after-v4.matchline');
  const store = openProject(path, { migrate: true, now: frozenClock(MIGRATED_AT) });
  try {
    store.saveLedger(1, {
      formatVersion: 1,
      entries: [
        {
          assetId: 'asset-1',
          currentCanonicalTag: 'MAH001-10-01',
          aliases: ['MAH001-10-1'],
          modelIdentities: [
            {
              logicalSourceId: 'model:dragon-coordination.nwd',
              stableObjectKey: 'guid/abc',
              tier: 'instance-guid',
            },
          ],
          status: 'present',
        },
      ],
      nextOrdinal: 2,
    });
    const stored = store.getLedger(deserializeLedger);
    assert.equal(stored.compileId, 1);
    assert.deepEqual(stored.ledger.entries[0].aliases, ['MAH001-10-1']);
  } finally {
    store.close();
  }
});

test('a migrated v4 project reopens as current, with no second backup', () => {
  const path = writeV4Project('reopen-v4.matchline');
  openProject(path, { migrate: true, now: frozenClock(MIGRATED_AT) }).close();

  const store = openProject(path, { migrate: true });
  try {
    assert.equal(store.migration, null, 'nothing to do the second time');
  } finally {
    store.close();
  }
});

test('a current file whose version was walked back migrates without a second ledger', () => {
  // The shape the desktop app's own migration test builds: a file that already
  // has every v5 table but declares an older version. Creating the table again
  // would throw; the step is a no-op instead.
  const path = temp.file('walked-back.matchline');
  createProject(path, { name: 'Dragon', now: frozenClock(CREATED_AT) }).close();
  rawExec(
    path,
    "DELETE FROM migrations WHERE version > 4;" +
      "UPDATE meta SET value = '4' WHERE key = 'schema_version'",
  );

  const store = openProject(path, { migrate: true, now: frozenClock(MIGRATED_AT) });
  try {
    assert.equal(store.meta().schemaVersion, PROJECT_SCHEMA_VERSION);
    assert.equal(store.getLedger(), undefined);
  } finally {
    store.close();
  }
  assert.equal(
    tablesOf(path).filter((table) => table === 'ledger').length,
    1,
    'one ledger table, not two',
  );
});

/* ------------------------------------------------------- v5 → v6 */

/**
 * `PROJECT_SCHEMA_SQL` as **v5** shipped, frozen.
 *
 * Copied out of `schema.ts` before v6 edited it. Its `config` CHECK lists the
 * six sections v3 left it with and NOT `derivedAttributes` or
 * `sourceAssignmentRules`, which is the whole point of the snapshot: a v6 step
 * that failed to widen the CHECK would still pass against a file built from
 * today's DDL, and fails here. A test below asserts the absence of both words in
 * this text, so the fixture cannot be quietly modernized.
 */
const V5_SCHEMA_SQL = `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

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

CREATE TABLE profile (
  revision     INTEGER PRIMARY KEY CHECK (revision > 0),
  profile_json TEXT NOT NULL,
  note         TEXT,
  saved_at     TEXT NOT NULL
);

CREATE TABLE learned (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('nesting', 'item-master', 'wbs')),
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

CREATE TABLE config (
  key         TEXT PRIMARY KEY CHECK (key IN (
                'hierarchy', 'roleGraph', 'ladder', 'ssmDisciplineProjection',
                'parentTagProperty', 'extoTemplate')),
  config_json TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE ledger (
  slot        INTEGER PRIMARY KEY CHECK (slot = 0),
  compile_id  INTEGER NOT NULL REFERENCES compiles(id),
  ledger_json TEXT NOT NULL,
  saved_at    TEXT NOT NULL
);
`;

/**
 * Writes a v5 project file with something in every table, from the frozen DDL.
 *
 * The config rows are the point of this fixture: v6 rebuilds that table to widen
 * its CHECK, and a rebuild that dropped a row would take a site's hierarchy with
 * it.
 */
function writeV5Project(name) {
  const path = temp.file(name);
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(V5_SCHEMA_SQL);

    const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    meta.run('schema_version', '5');
    meta.run('app_version', '0.8.1');
    meta.run('project_name', 'Dragon');
    meta.run('created_at', CREATED_AT);
    meta.run('modified_at', CREATED_AT);
    db.prepare('INSERT INTO migrations (version, applied_at) VALUES (?, ?)').run(5, CREATED_AT);

    db.prepare(
      `INSERT INTO sources
         (source_id, role, logical_name, raw_file_name, raw_sha256, raw_byte_size,
          derived_cache_sha256, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'model:dragon-coordination.nwd',
      'model',
      'Dragon Coordination',
      'Dragon-Coordination.nwd',
      'a'.repeat(64),
      104857600,
      'a'.repeat(64),
      CREATED_AT,
    );

    db.prepare(
      'INSERT INTO profile (revision, profile_json, note, saved_at) VALUES (?, ?, ?, ?)',
    ).run(1, JSON.stringify(dragonProfile()), 'initial import', CREATED_AT);

    db.prepare('INSERT INTO learned (id, kind, rules_json, saved_at) VALUES (?, ?, ?, ?)').run(
      3,
      'nesting',
      JSON.stringify({ version: 1, classification: [] }),
      CREATED_AT,
    );

    const config = db.prepare(
      'INSERT INTO config (key, config_json, updated_at) VALUES (?, ?, ?)',
    );
    config.run('ladder', JSON.stringify({ tiers: ['manual'] }), CREATED_AT);
    config.run(
      'hierarchy',
      JSON.stringify({ levels: [{ levelId: 'building', attributeKey: 'building' }] }),
      CREATED_AT,
    );
    config.run('extoTemplate', JSON.stringify({ version: 1, headers: ['UPN'] }), CREATED_AT);

    db.prepare(
      'INSERT INTO overrides (kind, asset_key, payload_json, updated_at) VALUES (?, ?, ?, ?)',
    ).run('system', 'MAH001-10-01', JSON.stringify({ systemKey: '001' }), CREATED_AT);

    db.prepare(
      `INSERT INTO compiles
         (id, input_hashes_json, profile_revision, stats_json, started_at, finished_at, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      1,
      JSON.stringify({ 'model:dragon-coordination.nwd': 'a'.repeat(64) }),
      1,
      JSON.stringify({ nodeCount: 34 }),
      '2026-01-15T10:00:00.000Z',
      '2026-01-15T10:00:42.000Z',
      CREATED_AT,
    );

    db.prepare(
      'INSERT INTO snapshots (slot, compile_id, snapshot_json, saved_at) VALUES (0, ?, ?, ?)',
    ).run(1, JSON.stringify({ nodes: [], reviewItems: [], stats: { nodeCount: 34 } }), CREATED_AT);

    db.prepare(
      'INSERT INTO ledger (slot, compile_id, ledger_json, saved_at) VALUES (0, ?, ?, ?)',
    ).run(1, JSON.stringify({ formatVersion: 1, entries: [], nextOrdinal: 1 }), CREATED_AT);

    db.prepare(
      'INSERT INTO decisions (review_key, decision, note, decided_at) VALUES (?, ?, ?, ?)',
    ).run('missing-boundary:tag:MAH001-10-01', 'accepted', 'walked it down on site', CREATED_AT);
  } finally {
    db.close();
  }
  return path;
}

test('the frozen v5 fixture really is pre-v6: its config CHECK names neither new key', () => {
  // The guard on every assertion below, as the v3 and v4 fixtures have their own.
  assert.equal(V5_SCHEMA_SQL.includes('derivedAttributes'), false);
  assert.equal(V5_SCHEMA_SQL.includes('sourceAssignmentRules'), false);

  const path = writeV5Project('frozen-v5.matchline');
  assert.throws(
    () =>
      rawExec(
        path,
        "INSERT INTO config (key, config_json, updated_at) VALUES ('derivedAttributes', '[]', '')",
      ),
    'a v5 file refuses the section outright — that is what v6 has to widen',
  );
});

test('a v5 project is refused, by version, until migration is asked for', () => {
  const path = writeV5Project('refused-v5.matchline');

  const failure = reason(() => openProject(path));
  assert.equal(failure.kind, 'migration-required');
  assert.equal(failure.found, 5);
  assert.equal(failure.supported, PROJECT_SCHEMA_VERSION);
  assert.equal(existsSync(`${path}.backup-5`), false, 'a refusal touches nothing');
});

test('migrating a v5 project widens the config CHECK and keeps every row', () => {
  const path = writeV5Project('migrate-v5.matchline');
  const before = dumpTables(path, [
    'sources',
    'profile',
    'learned',
    'overrides',
    'compiles',
    'snapshots',
    'decisions',
    'ledger',
    'config',
  ]);

  const store = openProject(path, { migrate: true, now: frozenClock(MIGRATED_AT) });
  try {
    assert.deepEqual(store.migration, {
      fromVersion: 5,
      toVersion: PROJECT_SCHEMA_VERSION,
      backupPath: `${path}.backup-5`,
    });
    assert.ok(existsSync(`${path}.backup-5`), 'the original was copied before anything ran');
    assert.equal(store.meta().schemaVersion, PROJECT_SCHEMA_VERSION);

    // The three sections the v5 file carried are still there, unchanged.
    assert.deepEqual(store.getConfig('ladder').value, { tiers: ['manual'] });
    assert.deepEqual(store.getConfig('extoTemplate').value, { version: 1, headers: ['UPN'] });
    assert.deepEqual(
      store.listConfig().map((entry) => entry.key),
      ['extoTemplate', 'hierarchy', 'ladder'],
      'and nothing was invented: the two new sections have no row until one is written',
    );

    // Which is the whole point of the widening (P0-7, P0-8).
    store.saveConfig('derivedAttributes', [
      { attributeId: 'area', displayName: 'Area', resolverChain: [] },
    ]);
    store.saveConfig('sourceAssignmentRules', [
      { scope: 'filename-pattern', match: 'Dragon-*.nwc', assign: { nativeDiscipline: '$1' } },
    ]);
    assert.deepEqual(store.getConfig('derivedAttributes').value, [
      { attributeId: 'area', displayName: 'Area', resolverChain: [] },
    ]);
    assert.deepEqual(store.getConfig('sourceAssignmentRules').value, [
      { scope: 'filename-pattern', match: 'Dragon-*.nwc', assign: { nativeDiscipline: '$1' } },
    ]);
  } finally {
    store.close();
  }

  const after_ = dumpTables(path, [
    'sources',
    'profile',
    'learned',
    'overrides',
    'compiles',
    'snapshots',
    'decisions',
    'ledger',
  ]);
  assert.deepEqual(
    { ...after_, compiles: withoutColumn(after_.compiles, 'asset_count') },
    {
      sources: before.sources,
      profile: before.profile,
      learned: before.learned,
      overrides: before.overrides,
      compiles: before.compiles,
      snapshots: before.snapshots,
      decisions: before.decisions,
      ledger: before.ledger,
    },
    'v6 rebuilds only `config`, and v7 only adds `asset_count` to `compiles`',
  );

  assert.deepEqual(dumpTables(path, ['migrations']).migrations, [
    JSON.stringify({ applied_at: CREATED_AT, version: 5 }),
    JSON.stringify({ applied_at: MIGRATED_AT, version: 6 }),
    JSON.stringify({ applied_at: MIGRATED_AT, version: 7 }),
  ]);
});

test('a migrated v5 project reopens as current, with no second backup', () => {
  const path = writeV5Project('reopen-v5.matchline');
  openProject(path, { migrate: true, now: frozenClock(MIGRATED_AT) }).close();

  const store = openProject(path, { migrate: true });
  try {
    assert.equal(store.migration, null, 'nothing to do the second time');
  } finally {
    store.close();
  }
});

/* ----------------------------------------------------------- v6 -> v7 */

/**
 * `PROJECT_SCHEMA_SQL` as **v6** shipped, frozen.
 *
 * No `profile_draft`, no `compile_assets`, and a `compiles` table with no
 * `asset_count` -- which is the whole point of the snapshot: a v7 step that
 * failed to add any of the three would still pass against a file built from
 * today's DDL, and would fail here.
 */
const V6_SCHEMA_SQL = `
CREATE TABLE meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) WITHOUT ROWID;

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

CREATE TABLE profile (
  revision     INTEGER PRIMARY KEY CHECK (revision > 0),
  profile_json TEXT NOT NULL,
  note         TEXT,
  saved_at     TEXT NOT NULL
);

CREATE TABLE learned (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('nesting', 'item-master', 'wbs')),
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

CREATE TABLE config (
  key         TEXT PRIMARY KEY CHECK (key IN (
                'hierarchy', 'roleGraph', 'ladder', 'ssmDisciplineProjection',
                'parentTagProperty', 'extoTemplate', 'derivedAttributes',
                'sourceAssignmentRules')),
  config_json TEXT NOT NULL,
  updated_at  TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE ledger (
  slot        INTEGER PRIMARY KEY CHECK (slot = 0),
  compile_id  INTEGER NOT NULL REFERENCES compiles(id),
  ledger_json TEXT NOT NULL,
  saved_at    TEXT NOT NULL
);
`;

/** One generated-MEL asset, in the shape the desktop app stored (§12.1). */
function melAsset(index) {
  return {
    canonicalTag: `MAH${String(index).padStart(3, '0')}-10-01`,
    inclusionStatus: 'included',
    description: 'Air handling unit',
  };
}

/**
 * Writes a v6 project with `compileCount` compiles, each carrying its assets
 * inside `stats_json` the way the pre-v7 desktop app wrote them.
 *
 * That shape is the thing v7 exists to undo, so the fixture has to produce it
 * verbatim rather than through today's store.
 */
function writeV6Project(name, compileCount = 1, assetsPerCompile = 2) {
  const path = temp.file(name);
  const db = new DatabaseSync(path);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(V6_SCHEMA_SQL);

    const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    meta.run('schema_version', '6');
    meta.run('app_version', '0.9.0');
    meta.run('project_name', 'Dragon');
    meta.run('created_at', CREATED_AT);
    meta.run('modified_at', CREATED_AT);
    db.prepare('INSERT INTO migrations (version, applied_at) VALUES (?, ?)').run(6, CREATED_AT);

    db.prepare(
      'INSERT INTO profile (revision, profile_json, note, saved_at) VALUES (?, ?, ?, ?)',
    ).run(1, JSON.stringify(dragonProfile()), 'initial import', CREATED_AT);

    db.prepare(
      'INSERT INTO overrides (kind, asset_key, payload_json, updated_at) VALUES (?, ?, ?, ?)',
    ).run('system', 'MAH001-10-01', JSON.stringify({ systemKey: '001' }), CREATED_AT);

    db.prepare(
      'INSERT INTO config (key, config_json, updated_at) VALUES (?, ?, ?)',
    ).run('extoTemplate', JSON.stringify({ version: 1, headers: ['UPN'] }), CREATED_AT);

    const compile = db.prepare(
      `INSERT INTO compiles
         (id, input_hashes_json, profile_revision, stats_json, started_at, finished_at, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let id = 1; id <= compileCount; id += 1) {
      compile.run(
        id,
        JSON.stringify({ 'model:dragon-coordination.nwd': 'a'.repeat(64) }),
        1,
        JSON.stringify({
          summary: { nodeCount: 34, compile: id },
          generatedMelAssets: Array.from({ length: assetsPerCompile }, (_, index) =>
            melAsset(id * 100 + index),
          ),
        }),
        '2026-01-15T10:00:00.000Z',
        '2026-01-15T10:00:42.000Z',
        CREATED_AT,
      );
    }

    db.prepare(
      'INSERT INTO snapshots (slot, compile_id, snapshot_json, saved_at) VALUES (0, ?, ?, ?)',
    ).run(compileCount, JSON.stringify({ nodes: [], reviewItems: [], stats: {} }), CREATED_AT);

    db.prepare(
      'INSERT INTO decisions (review_key, decision, note, decided_at) VALUES (?, ?, ?, ?)',
    ).run('missing-boundary:tag:MAH001-10-01', 'accepted', 'walked it down', CREATED_AT);
  } finally {
    db.close();
  }
  return path;
}

test('the frozen v6 fixture really is pre-v7: no draft slot, no asset table, no count', () => {
  // The guard on every assertion below, as the other fixtures have their own.
  assert.equal(V6_SCHEMA_SQL.includes('profile_draft'), false);
  assert.equal(V6_SCHEMA_SQL.includes('compile_assets'), false);
  assert.equal(V6_SCHEMA_SQL.includes('asset_count'), false);

  const path = writeV6Project('frozen-v6.matchline');
  assert.throws(
    () => rawExec(path, 'SELECT slot FROM profile_draft'),
    'a v6 file has nowhere to keep a draft -- that is what v7 adds',
  );
});

test('a v6 project is refused, by version, until migration is asked for', () => {
  const path = writeV6Project('refused-v6.matchline');

  const failure = reason(() => openProject(path));
  assert.equal(failure.kind, 'migration-required');
  assert.equal(failure.found, 6);
  assert.equal(failure.supported, PROJECT_SCHEMA_VERSION);
  assert.equal(existsSync(`${path}.backup-6`), false, 'a refusal touches nothing');
});

test('migrating a v6 project keeps every row and lifts the assets out of stats_json', () => {
  const path = writeV6Project('migrate-v6.matchline');
  const before = dumpTables(path, [
    'sources',
    'profile',
    'learned',
    'overrides',
    'snapshots',
    'decisions',
    'config',
  ]);

  const store = openProject(path, { migrate: true, now: frozenClock(MIGRATED_AT) });
  try {
    assert.deepEqual(store.migration, {
      fromVersion: 6,
      toVersion: PROJECT_SCHEMA_VERSION,
      backupPath: `${path}.backup-6`,
    });
    assert.ok(existsSync(`${path}.backup-6`), 'the original was copied before anything ran');
    assert.equal(store.meta().schemaVersion, PROJECT_SCHEMA_VERSION);

    const [compile] = store.listCompiles();
    // The summary is what is left in the column, and the assets are not in it.
    assert.deepEqual(compile.stats, { summary: { nodeCount: 34, compile: 1 } });
    assert.equal(compile.assetCount, 2);
    assert.deepEqual(store.getCompileAssets(1), [melAsset(100), melAsset(101)]);

    // The new slot starts empty rather than seeded from the newest revision: a
    // project with no draft in flight has no unsaved answers to restore.
    assert.equal(store.getDraft(), undefined);
  } finally {
    store.close();
  }

  const after_ = dumpTables(path, [
    'sources',
    'profile',
    'learned',
    'overrides',
    'snapshots',
    'decisions',
    'config',
  ]);
  assert.deepEqual(after_, before, 'v7 touches `compiles` and nothing else');

  assert.deepEqual(dumpTables(path, ['migrations']).migrations, [
    JSON.stringify({ applied_at: CREATED_AT, version: 6 }),
    JSON.stringify({ applied_at: MIGRATED_AT, version: 7 }),
  ]);
});

test('a v6 project keeps the assets of its newest compiles and drops the rest', () => {
  const path = writeV6Project('retention-v6.matchline', COMPILE_ASSET_RETENTION + 5, 3);

  const store = openProject(path, { migrate: true, now: frozenClock(MIGRATED_AT) });
  try {
    const compiles = store.listCompiles();
    assert.equal(compiles.length, COMPILE_ASSET_RETENTION + 5);
    // Every compile still says what it produced, whether or not it still holds
    // it: the count is evidence and the array is a convenience.
    assert.ok(compiles.every((record) => record.assetCount === 3));

    const kept = compiles.filter((record) => store.getCompileAssets(record.compileId) !== undefined);
    assert.deepEqual(
      kept.map((record) => record.compileId),
      compiles.slice(0, COMPILE_ASSET_RETENTION).map((record) => record.compileId),
      'the newest twenty keep their assets and the older rows keep only their count',
    );
  } finally {
    store.close();
  }
});

test('a v6 compile row whose stats this build did not write is left exactly as it was', () => {
  const path = writeV6Project('foreign-stats-v6.matchline');
  rawExec(path, `UPDATE compiles SET stats_json = '{"nodeCount":34}' WHERE id = 1`);

  const store = openProject(path, { migrate: true, now: frozenClock(MIGRATED_AT) });
  try {
    const [compile] = store.listCompiles();
    assert.deepEqual(compile.stats, { nodeCount: 34 }, 'not rewritten, not guessed at');
    assert.equal(compile.assetCount, 0);
    assert.equal(store.getCompileAssets(1), undefined);
  } finally {
    store.close();
  }
});

test('a migrated v6 project reopens as current, with no second backup', () => {
  const path = writeV6Project('reopen-v6.matchline');
  openProject(path, { migrate: true, now: frozenClock(MIGRATED_AT) }).close();

  const store = openProject(path, { migrate: true });
  try {
    assert.equal(store.migration, null, 'nothing to do the second time');
  } finally {
    store.close();
  }
});

/* ------------------------------------------------------ the draft slot (v7) */

test('a draft survives close and reopen, and a saved revision clears it', () => {
  const path = temp.file('draft.matchline');
  const store = createProject(path, { name: 'Dragon', now: frozenClock(CREATED_AT) });
  try {
    assert.equal(store.getDraft(), undefined, 'a new project has no draft in flight');
    // Half-finished on purpose: the slot exists precisely for a draft that is
    // not publishable yet, so it does no profile validation.
    store.saveDraft({ name: 'Dragon', propertyMappings: {} });
    assert.deepEqual(store.getDraft(), {
      draft: { name: 'Dragon', propertyMappings: {} },
      updatedAt: CREATED_AT,
    });
    store.saveDraft({ name: 'Dragon', propertyMappings: { equipmentTag: 'Item > Name' } });
  } finally {
    store.close();
  }

  const reopened = openProject(path);
  try {
    assert.deepEqual(reopened.getDraft().draft, {
      name: 'Dragon',
      propertyMappings: { equipmentTag: 'Item > Name' },
    });
    assert.equal(reopened.clearDraft(), true);
    assert.equal(reopened.getDraft(), undefined);
    assert.equal(reopened.clearDraft(), false, 'and clearing an empty slot says so');
  } finally {
    reopened.close();
  }
});

/* -------------------------------------------------- compile assets (v7) */

test('listing the compile history reads no asset arrays', () => {
  const path = temp.file('assets.matchline');
  const store = createProject(path, { name: 'Dragon', now: steppingClock(CREATED_AT) });
  try {
    store.saveProfile(dragonProfile(), 'initial import');
    const assets = Array.from({ length: 500 }, (_, index) => ({
      canonicalTag: `MAH${String(index).padStart(3, '0')}-10-01`,
      inclusionStatus: 'included',
    }));

    const compileId = store.withTransaction(() => {
      const id = store.recordCompile({
        inputHashes: {},
        profileRevision: 1,
        statsJson: { nodeCount: 34 },
        startedAt: '2026-01-15T10:00:00.000Z',
        finishedAt: '2026-01-15T10:00:42.000Z',
      });
      store.saveCompileAssets(id, assets);
      return id;
    });

    const [record] = store.listCompiles();
    assert.equal(record.compileId, compileId);
    assert.equal(record.assetCount, 500);
    assert.deepEqual(record.stats, { nodeCount: 34 }, 'the assets are not in the stats column');
    assert.equal(store.getCompileAssets(compileId).length, 500);
    assert.equal(
      reason(() => store.saveCompileAssets(compileId + 99, [])).kind,
      'unknown-compile',
    );
  } finally {
    store.close();
  }
});

test('a new compile prunes the assets of everything past the retention window', () => {
  const path = temp.file('prune.matchline');
  const store = createProject(path, { name: 'Dragon', now: steppingClock(CREATED_AT) });
  try {
    store.saveProfile(dragonProfile(), 'initial import');
    const ids = [];
    for (let run = 0; run < COMPILE_ASSET_RETENTION + 3; run += 1) {
      ids.push(
        store.withTransaction(() => {
          const id = store.recordCompile({
            inputHashes: {},
            profileRevision: 1,
            statsJson: { run },
            startedAt: '2026-01-15T10:00:00.000Z',
            finishedAt: '2026-01-15T10:00:42.000Z',
          });
          store.saveCompileAssets(id, [{ canonicalTag: `MAH${String(run)}-10-01` }]);
          return id;
        }),
      );
    }

    const kept = ids.filter((id) => store.getCompileAssets(id) !== undefined);
    assert.deepEqual(kept, ids.slice(-COMPILE_ASSET_RETENTION));
    assert.equal(
      store.listCompiles().length,
      ids.length,
      'the compile rows themselves are evidence and are never pruned',
    );
    assert.ok(
      store.listCompiles().every((record) => record.assetCount === 1),
      'and every one of them still says what it produced',
    );
  } finally {
    store.close();
  }
});

/**
 * Incremental vacuuming is a property of the file, set when it is created.
 *
 * A migrated file deliberately does NOT get it: switching a database to
 * incremental vacuuming needs a full `VACUUM`, which rewrites it whole -- and
 * doing that inside a migration would turn "upgrade this project" into minutes
 * of I/O and a second copy of the file on disk.
 */
test('a new project vacuums incrementally; a migrated one is not rewritten to', () => {
  const fresh = temp.file('vacuum-new.matchline');
  createProject(fresh, { name: 'Dragon', now: frozenClock(CREATED_AT) }).close();
  assert.equal(autoVacuumOf(fresh), 2, 'INCREMENTAL');

  const migrated = writeV6Project('vacuum-old.matchline');
  assert.equal(autoVacuumOf(migrated), 0, 'the fixture was written with the default');
  openProject(migrated, { migrate: true, now: frozenClock(MIGRATED_AT) }).close();
  assert.equal(autoVacuumOf(migrated), 0, 'and the migration left it alone');
});

function autoVacuumOf(path) {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return db.prepare('PRAGMA auto_vacuum').get().auto_vacuum;
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------- the config table */

test('a fresh v2 project round-trips every configuration section', () => {
  const path = temp.file('config.matchline');
  const store = createProject(path, { name: 'Dragon', now: frozenClock(CREATED_AT) });
  try {
    assert.deepEqual(store.listConfig(), []);
    assert.equal(store.getConfig('ladder'), undefined);

    store.saveConfig('hierarchy', { levels: [{ levelId: 'building', boundary: true }] });
    store.saveConfig('roleGraph', { rules: [{ parentRole: 'PNL', childRole: 'RIO' }] });
    store.saveConfig('ladder', { tiers: ['manual', 'flow-family'] });
    store.saveConfig('ssmDisciplineProjection', [{ from: 'I&C', to: 'Electrical' }]);
    store.saveConfig('parentTagProperty', null);

    assert.deepEqual(store.getConfig('ladder'), {
      key: 'ladder',
      value: { tiers: ['manual', 'flow-family'] },
      updatedAt: CREATED_AT,
    });
    assert.deepEqual(store.getConfig('parentTagProperty').value, null, 'null is a stored answer');

    assert.deepEqual(
      store.listConfig().map((entry) => entry.key),
      ['hierarchy', 'ladder', 'parentTagProperty', 'roleGraph', 'ssmDisciplineProjection'],
      'ordered by key, so two reads never disagree',
    );

    // Replace, not append: the compiler only ever reads the current section.
    store.saveConfig('ladder', { tiers: ['manual'] });
    assert.deepEqual(store.getConfig('ladder').value, { tiers: ['manual'] });
    assert.equal(store.listConfig().length, 5);
  } finally {
    store.close();
  }

  const reopened = openProject(path);
  try {
    assert.deepEqual(reopened.getConfig('roleGraph').value, {
      rules: [{ parentRole: 'PNL', childRole: 'RIO' }],
    });
  } finally {
    reopened.close();
  }
});

test('a section name the schema does not know is refused by the argument check', () => {
  const path = temp.file('bad-key.matchline');
  const store = createProject(path, { name: 'Dragon', now: frozenClock(CREATED_AT) });
  try {
    assert.equal(reason(() => store.saveConfig('nonsense', {})).parameter, 'key');
    assert.equal(reason(() => store.getConfig('')).parameter, 'key');
  } finally {
    store.close();
  }
});

/**
 * Two Matchlines, one project file on a share.
 *
 * The version that chooses the step list is read before the file is closed and
 * copied, so by the time the migration actually holds a write lock that reading
 * is a claim about the past. If another process upgraded the file in between,
 * these steps are the wrong steps -- a v1 walk applied to a file that is
 * already v2 creates a table it has and counts a row twice.
 *
 * The race is staged rather than waited for: `BEGIN IMMEDIATE` is the exact
 * moment the guard reads again, so a second connection commits the upgrade just
 * before that statement runs. Nothing about the store is stubbed except when
 * the other writer gets its turn.
 */
test('a project somebody else migrated first is refused, not migrated twice', () => {
  const path = writeV1Project('raced.matchline');

  const originalExec = DatabaseSync.prototype.exec;
  let raced = false;
  DatabaseSync.prototype.exec = function execSpy(sql) {
    // Before the lock is taken, so the other writer can actually get in.
    if (sql === 'BEGIN IMMEDIATE' && !raced) {
      raced = true;
      const other = new DatabaseSync(path);
      try {
        other.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(
          String(PROJECT_SCHEMA_VERSION),
        );
      } finally {
        other.close();
      }
    }
    return originalExec.call(this, sql);
  };

  let failure;
  try {
    failure = reason(() => openProject(path, { migrate: true, now: frozenClock(MIGRATED_AT) }));
  } finally {
    DatabaseSync.prototype.exec = originalExec;
  }

  assert.ok(raced, 'the other writer took its turn');
  assert.equal(failure.kind, 'migration-raced');
  assert.equal(failure.expected, 1, 'the version the step list was chosen for');
  assert.equal(failure.found, PROJECT_SCHEMA_VERSION, 'and the version the lock revealed');
  assert.match(
    describeProjectStoreReason(failure),
    /another program upgraded it first/,
    'the message says what happened rather than naming a table',
  );

  // Nothing was applied: the version the other writer set is the only change,
  // and no migration row was recorded by this process.
  assert.deepEqual(dumpTables(path, ['migrations']).migrations, [
    JSON.stringify({ applied_at: CREATED_AT, version: 1 }),
  ]);
});
