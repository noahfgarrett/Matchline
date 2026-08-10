import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test, { after, beforeEach } from 'node:test';

import {
  createProject,
  deserializeLedger,
  openProject,
  ProjectStoreError,
} from '../dist/index.js';

import { dragonProfile, steppingClock, tempDirectory } from './support.mjs';

/**
 * The asset identity ledger in the project file (P0-9, schema v5).
 *
 * The ledger is the one stored value that decides *which asset* a stored
 * decision belongs to, so this file is about two promises: what goes in comes
 * back out unchanged across a close and reopen, and something that is not a
 * ledger is refused rather than half-read.
 */

const temp = tempDirectory('ledger');
after(() => {
  temp.cleanup();
});

let counter = 0;
let store = null;
let storePath = '';

beforeEach(() => {
  store?.close();
  counter += 1;
  storePath = temp.file(`ledger-${counter}.matchline`);
  store = createProject(storePath, { name: 'Dragon', now: steppingClock() });
});

after(() => {
  store?.close();
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

/** A compile to hang a ledger on. Every ledger row references one. */
function recordCompile(startedAt = '2026-01-15T10:00:00.000Z') {
  const revision = store.getProfile()?.revision ?? store.saveProfile(dragonProfile());
  return store.recordCompile({
    inputHashes: {},
    profileRevision: revision,
    statsJson: {},
    startedAt,
    finishedAt: startedAt,
  });
}

function ledger(overrides = {}) {
  return {
    formatVersion: 1,
    entries: [
      {
        assetId: 'asset-1',
        currentCanonicalTag: 'MAH001-10-01',
        aliases: ['MAH001-10-1'],
        modelIdentities: [
          {
            logicalSourceId: 'model:dragon-coordination.nwd',
            stableObjectKey: 'guid/00000000-0000-4000-8000-000000000017',
            tier: 'instance-guid',
          },
          {
            logicalSourceId: 'model:dragon-coordination.nwd',
            stableObjectKey: 'struct/dragon#0.3.1#Equipment',
            tier: 'structural',
          },
        ],
        status: 'present',
      },
      {
        assetId: 'asset-2',
        // An untagged asset really does carry `''`, and it is a stated answer.
        currentCanonicalTag: '',
        aliases: [],
        modelIdentities: [],
        status: 'disappeared',
      },
    ],
    nextOrdinal: 3,
    ...overrides,
  };
}

test('a project with no compile has no ledger, which is what a first compile reads', () => {
  assert.equal(store.getLedger(), undefined);
  assert.equal(store.getLedger(deserializeLedger), undefined);
});

test('a saved ledger round-trips through a close and reopen, entry for entry', () => {
  const compileId = recordCompile();
  store.saveLedger(compileId, ledger());
  store.close();

  const reopened = openProject(storePath);
  try {
    const stored = reopened.getLedger(deserializeLedger);
    assert.equal(stored.compileId, compileId);
    assert.deepEqual(stored.ledger, ledger(), 'nothing was normalized away on the way through');
  } finally {
    reopened.close();
  }
  store = null;
});

test('only the latest ledger is kept: it is project state, not compile history', () => {
  const first = recordCompile('2026-01-15T10:00:00.000Z');
  store.saveLedger(first, ledger());

  const second = recordCompile('2026-01-16T10:00:00.000Z');
  store.saveLedger(second, ledger({ nextOrdinal: 9 }));

  const stored = store.getLedger(deserializeLedger);
  assert.equal(stored.compileId, second);
  assert.equal(stored.ledger.nextOrdinal, 9);

  const db = new DatabaseSync(storePath, { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS rows FROM ledger').get().rows, 1);
    assert.equal(db.prepare('SELECT slot FROM ledger').get().slot, 0);
  } finally {
    db.close();
  }
});

test('a ledger must belong to a compile the project actually recorded', () => {
  const failure = reason(() => store.saveLedger(99, ledger()));
  assert.equal(failure.kind, 'unknown-compile');
  assert.equal(failure.compileId, 99);
  assert.equal(store.getLedger(), undefined, 'and nothing was written');
});

test('the compile_id is a real foreign key, enforced by the file itself', () => {
  const compileId = recordCompile();
  store.saveLedger(compileId, ledger());
  store.close();
  store = null;

  const db = new DatabaseSync(storePath);
  try {
    db.exec('PRAGMA foreign_keys = ON');
    assert.throws(
      () => {
        db.prepare('UPDATE ledger SET compile_id = 404 WHERE slot = 0').run();
      },
      /FOREIGN KEY/,
      'a ledger pointing at a compile that does not exist cannot be written',
    );
    assert.throws(
      () => {
        db.prepare('DELETE FROM compiles WHERE id = ?').run(compileId);
      },
      /FOREIGN KEY/,
      'and the compile it points at cannot be deleted out from under it',
    );
  } finally {
    db.close();
  }
});

test('a ledger holding a Map is refused rather than stored as {}', () => {
  const compileId = recordCompile();
  const failure = reason(() =>
    store.saveLedger(compileId, { formatVersion: 1, entries: new Map(), nextOrdinal: 1 }),
  );
  assert.equal(failure.kind, 'not-json-serializable');
  assert.equal(store.getLedger(), undefined);
});

/* ------------------------------------------------------------- validation */

/** Stores `value` as the ledger without validating it, the way a bad write would. */
function storeRaw(value) {
  const compileId = recordCompile();
  store.saveLedger(compileId, value);
}

test('every field of a stored ledger is checked on the way back out', () => {
  const cases = [
    [{ formatVersion: 2, entries: [], nextOrdinal: 1 }, 'ledger.formatVersion'],
    [{ formatVersion: 1, entries: {}, nextOrdinal: 1 }, 'ledger.entries'],
    [{ formatVersion: 1, entries: [], nextOrdinal: 0 }, 'ledger.nextOrdinal'],
    [
      { formatVersion: 1, entries: [{ ...ledger().entries[0], assetId: '' }], nextOrdinal: 1 },
      'ledger.entries[0].assetId',
    ],
    [
      { formatVersion: 1, entries: [{ ...ledger().entries[0], status: 'gone' }], nextOrdinal: 1 },
      'ledger.entries[0].status',
    ],
    [
      { formatVersion: 1, entries: [{ ...ledger().entries[0], aliases: [7] }], nextOrdinal: 1 },
      'ledger.entries[0].aliases[0]',
    ],
    [
      {
        formatVersion: 1,
        entries: [
          {
            ...ledger().entries[0],
            modelIdentities: [{ logicalSourceId: 'model:a', stableObjectKey: 'k', tier: 'vibes' }],
          },
        ],
        nextOrdinal: 1,
      },
      'ledger.entries[0].modelIdentities[0].tier',
    ],
  ];

  for (const [value, field] of cases) {
    counter += 1;
    store.close();
    storePath = temp.file(`ledger-invalid-${counter}.matchline`);
    store = createProject(storePath, { name: 'Dragon', now: steppingClock() });
    storeRaw(value);

    const failure = reason(() => store.getLedger(deserializeLedger));
    assert.equal(failure.kind, 'invalid-ledger');
    assert.equal(failure.field, field);
  }
});

test('two entries claiming one asset id are refused, not silently deduped', () => {
  // The one integrity rule that is not a shape check: a duplicate id would make
  // every decision resolved through the ledger answer with whichever entry was
  // indexed last, which is how somebody's manual parent lands on the wrong unit.
  storeRaw({
    formatVersion: 1,
    entries: [ledger().entries[0], { ...ledger().entries[0], currentCanonicalTag: 'OTHER' }],
    nextOrdinal: 2,
  });

  const failure = reason(() => store.getLedger(deserializeLedger));
  assert.equal(failure.kind, 'invalid-ledger');
  assert.equal(failure.field, 'ledger.entries');
  assert.match(failure.detail, /appears twice/);
});

test('without a validate hook the caller gets the JSON back verbatim', () => {
  const compileId = recordCompile();
  store.saveLedger(compileId, ledger());
  assert.deepEqual(store.getLedger().ledger, ledger());
});
