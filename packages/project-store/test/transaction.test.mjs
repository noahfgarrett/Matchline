import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { createProject, openProject } from '../dist/index.js';

import { digest, dragonProfile, dumpTables, steppingClock, tempDirectory } from './support.mjs';

/**
 * Durability: a mutator that throws mid-transaction leaves the file exactly as
 * it was, including `meta.modified_at`.
 */

const temp = tempDirectory('transaction');
after(() => {
  temp.cleanup();
});

const SHA = digest('dragoncoordination');

function seeded(name) {
  const store = createProject(temp.file(name), { name: 'Dragon', now: steppingClock() });
  store.saveProfile(dragonProfile(), 'initial import');
  store.upsertSourceV4({
    sourceId: 'model:dragon-coordination.nwd',
    role: 'model',
    logicalName: 'Dragon-Coordination.nwd',
    rawFileName: 'Dragon-Coordination.nwd',
    rawSha256: SHA,
    rawByteSize: 104857600,
    derivedCacheSha256: SHA,
    addedAt: '2026-01-15T09:00:00.000Z',
  });
  return store;
}

test('a throw partway through a transaction rolls the whole thing back', () => {
  const path = temp.file('rollback.matchline');
  const store = seeded('rollback.matchline');
  const before = dumpTables(path);

  const failure = new Error('the compile service fell over');
  assert.throws(
    () =>
      store.withTransaction(() => {
        store.upsertSourceV4({
          sourceId: 'mel:dragon-mel.xlsx',
          role: 'mel',
          logicalName: 'Dragon-MEL.xlsx',
          rawFileName: 'Dragon-MEL.xlsx',
          rawSha256: digest('dragonmel'),
          rawByteSize: 20480,
          derivedCacheSha256: digest('dragonmel'),
          addedAt: '2026-01-15T09:10:00.000Z',
        });
        store.setSystemOverride('MAH001-10-01', { systemKey: '001' });
        // The injected failing step: everything above it must be undone.
        throw failure;
      }),
    failure,
  );

  assert.deepEqual(dumpTables(path), before, 'the file is exactly as it was');
  assert.equal(store.listSources().length, 1);
  assert.deepEqual(store.listOverrides(), []);
  store.close();

  const reopened = openProject(path);
  try {
    assert.deepEqual(dumpTables(path), before, 'and still is after a reopen');
    assert.equal(reopened.listSources().length, 1);
  } finally {
    reopened.close();
  }
});

test('a transaction that returns commits every mutation inside it', () => {
  const path = temp.file('commit.matchline');
  const store = seeded('commit.matchline');
  try {
    const returned = store.withTransaction(() => {
      store.setSystemOverride('MAH001-10-01', { systemKey: '001' });
      store.setRelationshipOverride({ childAssetId: 'TIT001-10-01', parentAssetId: 'VFD001-10-01' });
      return 'done';
    });
    assert.equal(returned, 'done');
    assert.equal(store.listOverrides().length, 2);
  } finally {
    store.close();
  }
});

test('nested transactions join the outer one instead of committing early', () => {
  const path = temp.file('nested.matchline');
  const store = seeded('nested.matchline');
  const before = dumpTables(path);

  assert.throws(() =>
    store.withTransaction(() => {
      store.withTransaction(() => {
        store.setSystemOverride('MAH001-10-01', { systemKey: '001' });
      });
      // An inner block that "finished" must not survive the outer failure.
      throw new Error('outer step failed');
    }),
  );

  assert.deepEqual(dumpTables(path), before);
  assert.deepEqual(store.listOverrides(), []);

  // The handle is still usable: the failed transaction did not leave one open.
  store.setSystemOverride('MAH001-10-01', { systemKey: '002' });
  assert.equal(store.listOverrides().length, 1);
  store.close();
});

test('a rolled-back transaction leaves the modified timestamp alone', () => {
  const path = temp.file('modified.matchline');
  const store = seeded('modified.matchline');
  try {
    const before = store.meta().modifiedAt;
    assert.throws(() =>
      store.withTransaction(() => {
        store.setSystemOverride('MAH001-10-01', { systemKey: '001' });
        throw new Error('nope');
      }),
    );
    assert.equal(store.meta().modifiedAt, before);
  } finally {
    store.close();
  }
});
