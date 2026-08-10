import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import test, { after } from 'node:test';

import {
  createProject,
  openProject,
  ProjectStoreError,
  PROJECT_SCHEMA_VERSION,
} from '../dist/index.js';

import { dumpTables, frozenClock, rawExec, steppingClock, tempDirectory } from './support.mjs';

/**
 * Creating, reopening and refusing project files: the gate every other test
 * assumes has already passed.
 */

const temp = tempDirectory('project');
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

test('a new project records its meta from the injected clock', () => {
  const path = temp.file('new.matchline');
  const store = createProject(path, {
    name: 'Dragon',
    appVersion: '0.5.0-test',
    now: frozenClock('2026-01-15T09:30:00.000Z'),
  });
  try {
    const meta = store.meta();
    assert.equal(meta.schemaVersion, PROJECT_SCHEMA_VERSION);
    assert.equal(meta.appVersion, '0.5.0-test');
    assert.equal(meta.projectName, 'Dragon');
    assert.equal(meta.createdAt, '2026-01-15T09:30:00.000Z');
    assert.equal(meta.modifiedAt, '2026-01-15T09:30:00.000Z');
  } finally {
    store.close();
  }

  // A new file records the version it was written at, so "when did this file
  // become v2" has an answer whether it was created there or migrated there.
  const dump = dumpTables(path);
  assert.deepEqual(dump.migrations, [
    JSON.stringify({ applied_at: '2026-01-15T09:30:00.000Z', version: PROJECT_SCHEMA_VERSION }),
  ]);
  assert.deepEqual(dump.config, [], 'a new project configures nothing until asked to');
});

test('a project survives a close and reopen', () => {
  const path = temp.file('roundtrip.matchline');
  const clock = steppingClock();
  const created = createProject(path, { name: 'Dragon', now: clock });
  created.upsertSource({
    role: 'model',
    fileName: 'Dragon-Coordination.nwd',
    sha256: 'a'.repeat(64),
    byteSize: 104857600,
  });
  const createdMeta = created.meta();
  created.close();

  const reopened = openProject(path, { now: steppingClock() });
  try {
    assert.equal(reopened.meta().projectName, 'Dragon');
    assert.equal(reopened.meta().createdAt, createdMeta.createdAt);
    assert.deepEqual(reopened.listSources(), [
      {
        sourceId: 'model:dragon-coordination.nwd',
        role: 'model',
        logicalName: 'Dragon-Coordination.nwd',
        rawFileName: 'Dragon-Coordination.nwd',
        rawSha256: 'a'.repeat(64),
        rawByteSize: 104857600,
        derivedCacheSha256: 'a'.repeat(64),
        addedAt: '2026-01-15T09:30:01.000Z',
        fileName: 'Dragon-Coordination.nwd',
        sha256: 'a'.repeat(64),
        byteSize: 104857600,
      },
    ]);
  } finally {
    reopened.close();
  }
});

test('a closed handle refuses further calls instead of crashing', () => {
  const path = temp.file('closed.matchline');
  const store = createProject(path, { name: 'Dragon', now: frozenClock() });
  store.close();
  store.close(); // idempotent
  assert.equal(reason(() => store.meta()).kind, 'closed');
});

test('createProject refuses to overwrite an existing file', () => {
  const path = temp.file('existing.matchline');
  createProject(path, { name: 'Dragon', now: frozenClock() }).close();
  const failure = reason(() => createProject(path, { name: 'Dragon Again' }));
  assert.equal(failure.kind, 'already-exists');
  assert.equal(failure.path, path);
});

test('createProject refuses a blank project name', () => {
  const failure = reason(() => createProject(temp.file('blank.matchline'), { name: '   ' }));
  assert.equal(failure.kind, 'invalid-argument');
  assert.equal(failure.parameter, 'name');
});

test('openProject reports a missing file rather than creating one', () => {
  const failure = reason(() => openProject(temp.file('absent.matchline')));
  assert.equal(failure.kind, 'not-found');
});

test('openProject refuses a file that is not a database', () => {
  const path = temp.file('corrupt.matchline');
  writeFileSync(path, 'this is not a SQLite file, it is a note to self');
  assert.equal(reason(() => openProject(path)).kind, 'cannot-open');
});

test('openProject refuses a project written by a newer build', () => {
  const path = temp.file('future.matchline');
  createProject(path, { name: 'Dragon', now: frozenClock() }).close();
  rawExec(path, `UPDATE meta SET value = '${PROJECT_SCHEMA_VERSION + 1}' WHERE key = 'schema_version'`);

  const failure = reason(() => openProject(path));
  assert.equal(failure.kind, 'unsupported-schema-version');
  assert.equal(failure.found, PROJECT_SCHEMA_VERSION + 1);
  assert.equal(failure.supported, PROJECT_SCHEMA_VERSION);
});

test('openProject asks for a migration when the project predates this build', () => {
  const path = temp.file('past.matchline');
  createProject(path, { name: 'Dragon', now: frozenClock() }).close();
  rawExec(path, "UPDATE meta SET value = '0' WHERE key = 'schema_version'");

  // Default is to refuse: rewriting the only copy of a site's decisions is not
  // something a caller does by accident. `migration.test.mjs` covers the
  // opt-in.
  const failure = reason(() => openProject(path));
  assert.equal(failure.kind, 'migration-required');
  assert.equal(failure.found, 0);
});

test('openProject refuses a non-numeric schema version', () => {
  const path = temp.file('nan-version.matchline');
  createProject(path, { name: 'Dragon', now: frozenClock() }).close();
  rawExec(path, "UPDATE meta SET value = 'one' WHERE key = 'schema_version'");

  const failure = reason(() => openProject(path));
  assert.equal(failure.kind, 'malformed-meta-value');
  assert.equal(failure.key, 'schema_version');
});

test('openProject refuses a project missing a table', () => {
  const path = temp.file('no-decisions.matchline');
  createProject(path, { name: 'Dragon', now: frozenClock() }).close();
  rawExec(path, 'DROP TABLE decisions');

  const failure = reason(() => openProject(path));
  assert.equal(failure.kind, 'missing-table');
  assert.equal(failure.table, 'decisions');
});

test('openProject refuses a project missing a meta key', () => {
  const path = temp.file('no-app-version.matchline');
  createProject(path, { name: 'Dragon', now: frozenClock() }).close();
  rawExec(path, "DELETE FROM meta WHERE key = 'app_version'");

  const failure = reason(() => openProject(path));
  assert.equal(failure.kind, 'missing-meta-key');
  assert.equal(failure.key, 'app_version');
});
