import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test, { after } from 'node:test';

import {
  createProject,
  deriveSourceId,
  deserializeLedger,
  openProject,
  PROJECT_SCHEMA_VERSION,
  ProjectStoreError,
} from '../dist/index.js';

import { dragonProfile, dumpTables, frozenClock, rawExec, tempDirectory } from './support.mjs';

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

test('a project created today is already v5 and needs no migration', () => {
  const path = temp.file('fresh-v5.matchline');
  const store = createProject(path, { name: 'Dragon', now: frozenClock(CREATED_AT) });
  try {
    assert.equal(store.meta().schemaVersion, 5);
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
  assert.deepEqual(after_, before, 'v5 rebuilds nothing, so every table is what it was');
  assert.deepEqual(dumpTables(path, ['ledger']).ledger, []);

  assert.deepEqual(dumpTables(path, ['migrations']).migrations, [
    JSON.stringify({ applied_at: CREATED_AT, version: 4 }),
    JSON.stringify({ applied_at: MIGRATED_AT, version: 5 }),
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
