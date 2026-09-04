import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import test, { after } from 'node:test';

import {
  backupBeforeMigration,
  createProject,
  openProject,
  PROJECT_SCHEMA_VERSION,
  ProjectStoreError,
} from '../dist/index.js';

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
  store.upsertSourceV4({
    sourceId: 'model:dragon-coordination.nwd',
    role: 'model',
    logicalName: 'Dragon-Coordination.nwd',
    rawFileName: 'Dragon-Coordination.nwd',
    rawSha256: digest('dragoncoordination'),
    rawByteSize: 104857600,
    derivedCacheSha256: digest('dragoncoordination'),
    addedAt: '2026-01-15T09:00:00.000Z',
  });
  store.close();
  return path;
}

/**
 * A project big enough to span pages past the one `meta` sits on.
 *
 * The verification test needs somewhere to put corruption that a header read
 * will not notice; a project holding five rows fits in two pages and has
 * nowhere.
 */
function pagedProject(name) {
  const path = temp.file(name);
  const store = createProject(path, { name: 'Dragon', now: steppingClock() });
  store.saveProfile(dragonProfile(), 'initial import');
  store.withTransaction(() => {
    for (let index = 0; index < 3000; index += 1) {
      store.recordDecision({
        reviewKey: `missing-boundary:asset:${String(index).padStart(6, '0')}`,
        decision: 'accepted',
        note: 'walked it down on site',
        decidedAt: '2026-01-15T09:00:00.000Z',
      });
    }
  });
  store.close();
  return path;
}

test('the backup is named after the version it holds and copies every row', () => {
  const path = seededProject('backup-me.matchline');
  const backupPath = backupBeforeMigration(path);

  assert.equal(backupPath, `${path}.backup-${PROJECT_SCHEMA_VERSION}`);
  assert.ok(existsSync(backupPath));
  assert.deepEqual(dumpTables(backupPath), dumpTables(path));
});

test('an existing backup of different bytes is evidence, not something to overwrite', () => {
  const path = seededProject('backup-twice.matchline');
  const backupPath = backupBeforeMigration(path);

  // The project moves on; the backup no longer describes it.
  const store = openProject(path);
  store.setSystemOverride('MAH001-10-01', { systemKey: '001' });
  store.close();

  const failure = reason(() => backupBeforeMigration(path));
  assert.equal(failure.kind, 'backup-exists');
  assert.equal(failure.path, backupPath);
});

/**
 * The crash-retry case, and the reason `backup-exists` is no longer the answer
 * to every existing file.
 *
 * A migration that backed the project up and then died -- power, a full disk,
 * a killed process -- leaves the backup beside a project file that is still
 * exactly what was copied. Refusing there refuses the retry of a migration that
 * never happened: the user is told to move a file aside that is byte-for-byte
 * the file they already have, and until they do, their project will not open.
 */
test('an existing backup holding exactly the current bytes is reused, not refused', () => {
  const path = seededProject('backup-identical.matchline');
  const backupPath = backupBeforeMigration(path);
  const contents = dumpTables(backupPath);

  assert.equal(backupBeforeMigration(path), backupPath, 'the same path comes back');
  assert.deepEqual(dumpTables(backupPath), contents, 'and it was not rewritten');
});

test('a backup at that path holding different bytes is refused whatever its size', () => {
  const path = seededProject('backup-corrupt.matchline');
  const backupPath = `${path}.backup-${PROJECT_SCHEMA_VERSION}`;
  // Same size, different bytes: the case a size-only check would wave through.
  writeFileSync(backupPath, new Uint8Array(statSync(path).size).fill(0x7a));

  const failure = reason(() => backupBeforeMigration(path));
  assert.equal(failure.kind, 'backup-exists');
  assert.equal(failure.path, backupPath);
});

/**
 * A copy is not a backup until something has read it back.
 *
 * Byte-equal to the project and still unusable: the pages this corrupts are
 * past the one `meta` lives on, so the version reads fine and only
 * `PRAGMA quick_check` can tell. That is the shape of a half-written copy, and
 * the reason the copy is verified rather than assumed.
 */
test('a backup that does not pass quick_check is refused as unverified', () => {
  const path = pagedProject('backup-unverified.matchline');
  const backupPath = `${path}.backup-${PROJECT_SCHEMA_VERSION}`;

  const corrupted = readFileSync(path);
  corrupted.fill(0x5a, 4096 * 3, 4096 * 5);
  writeFileSync(path, corrupted);
  writeFileSync(backupPath, corrupted);

  const failure = reason(() => backupBeforeMigration(path));
  assert.equal(failure.kind, 'backup-unverified');
  assert.equal(failure.path, backupPath);
  assert.match(failure.detail, /quick_check/);
});

test('backing up something that is not a project is refused', () => {
  assert.equal(reason(() => backupBeforeMigration(temp.file('absent.matchline'))).kind, 'not-found');

  const notADatabase = temp.file('notes.txt');
  writeFileSync(notADatabase, 'a note, not a project');
  assert.equal(reason(() => backupBeforeMigration(notADatabase)).kind, 'cannot-open');
  assert.equal(
    existsSync(`${notADatabase}.backup-${PROJECT_SCHEMA_VERSION}`),
    false,
    'nothing was copied',
  );
});
