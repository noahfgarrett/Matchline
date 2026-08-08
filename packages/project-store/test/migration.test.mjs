import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test, { after } from 'node:test';

import {
  createProject,
  openProject,
  PROJECT_SCHEMA_VERSION,
  ProjectStoreError,
} from '../dist/index.js';

import { dumpTables, frozenClock, rawExec, tempDirectory } from './support.mjs';

/**
 * The v1 → v2 migration: the `config` table, and the promise that getting it is
 * never destructive.
 *
 * ## Why the v1 DDL is copied out rather than imported
 *
 * A migration test that builds its "old" file from today's code proves nothing:
 * the two would drift together and the test would keep passing while real v1
 * files stopped opening. The DDL below is a snapshot of `PROJECT_SCHEMA_SQL` as
 * v1 shipped, frozen here on purpose. It must never be edited to match a later
 * schema — a future v3 adds a v2 snapshot beside it instead.
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
        role: 'model',
        fileName: 'Dragon-Coordination.nwd',
        sha256: 'a'.repeat(64),
        byteSize: 104857600,
        addedAt: CREATED_AT,
      },
    ]);
    assert.equal(store.listDecisions().length, 1);
    assert.deepEqual(store.listConfig(), [], 'the new table starts empty, not defaulted');
  } finally {
    store.close();
  }

  // Every pre-existing table came through untouched.
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
  assert.deepEqual(after_.sources, before.sources);
  assert.deepEqual(after_.decisions, before.decisions);
  assert.deepEqual(
    after_.meta.filter((row) => !row.includes('schema_version')),
    before.meta.filter((row) => !row.includes('schema_version')),
    'only the version line changed',
  );

  // The step is recorded, so "when did this file become v2" is answerable.
  assert.deepEqual(dumpTables(path, ['migrations']).migrations, [
    JSON.stringify({ applied_at: CREATED_AT, version: 1 }),
    JSON.stringify({ applied_at: MIGRATED_AT, version: 2 }),
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
