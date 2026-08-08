import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import test, { after } from 'node:test';

import { backupBeforeMigration, createProject, ProjectStoreError } from '../dist/index.js';

import { digest, dragonProfile, dumpTables, steppingClock, tempDirectory } from './support.mjs';

/**
 * The pre-migration backup (PRODUCT.md §15 "Recovery"). It is named after the
 * version it holds, and it never overwrites an earlier one.
 */

const temp = tempDirectory('backup');
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

function seededProject(name) {
  const path = temp.file(name);
  const store = createProject(path, { name: 'Dragon', now: steppingClock() });
  store.saveProfile(dragonProfile(), 'initial import');
  store.upsertSource({
    role: 'model',
    fileName: 'Dragon-Coordination.nwd',
    sha256: digest('dragoncoordination'),
    byteSize: 104857600,
    addedAt: '2026-01-15T09:00:00.000Z',
  });
  store.close();
  return path;
}

test('the backup is named after the version it holds and copies every row', () => {
  const path = seededProject('backup-me.matchline');
  const backupPath = backupBeforeMigration(path);

  assert.equal(backupPath, `${path}.backup-1`);
  assert.ok(existsSync(backupPath));
  assert.deepEqual(dumpTables(backupPath), dumpTables(path));
});

test('an existing backup is evidence, not something to overwrite', () => {
  const path = seededProject('backup-twice.matchline');
  const backupPath = backupBeforeMigration(path);

  const failure = reason(() => backupBeforeMigration(path));
  assert.equal(failure.kind, 'backup-exists');
  assert.equal(failure.path, backupPath);
});

test('backing up something that is not a project is refused', () => {
  assert.equal(reason(() => backupBeforeMigration(temp.file('absent.matchline'))).kind, 'not-found');

  const notADatabase = temp.file('notes.txt');
  writeFileSync(notADatabase, 'a note, not a project');
  assert.equal(reason(() => backupBeforeMigration(notADatabase)).kind, 'cannot-open');
  assert.equal(existsSync(`${notADatabase}.backup-1`), false, 'nothing was copied');
});
