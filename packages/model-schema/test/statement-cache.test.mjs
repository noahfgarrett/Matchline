import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { after, before } from 'node:test';

import { openExtractionCache } from '../dist/index.js';
import { writeDragonFixture } from '../dist/fixtures/dragon.js';
import { makeTempDirectory } from './support.mjs';

/**
 * A compile calls the per-object accessors once per object, so re-preparing
 * their SQL every call is work proportional to the model. These tests spy on
 * `DatabaseSync.prototype.prepare` — the reader owns its own handle, so there
 * is no other seam — and assert the statements are prepared once per handle.
 */

let directory = '';
let path = '';

/** Every statement prepared while `run` executes, in order. */
function recordPrepares(run) {
  const original = DatabaseSync.prototype.prepare;
  const prepared = [];
  DatabaseSync.prototype.prepare = function prepareSpy(sql) {
    const statement = original.call(this, sql);
    prepared.push({ sql, statement });
    return statement;
  };
  try {
    return { result: run(), prepared };
  } finally {
    DatabaseSync.prototype.prepare = original;
  }
}

before(() => {
  directory = makeTempDirectory('statement-cache');
  path = join(directory, 'dragon.sqlite');
  writeDragonFixture(path);
});

after(() => {
  rmSync(directory, { recursive: true, force: true });
});

test('repeated per-object reads prepare nothing after the first call', () => {
  const cache = openExtractionCache(path);
  try {
    // First call of each accessor primes the map; everything after must reuse.
    cache.object(1);
    cache.propertiesOf(1);
    cache.childrenOf(1);

    const { prepared } = recordPrepares(() => {
      for (let id = 1; id <= 20; id += 1) {
        cache.object(id);
        cache.propertiesOf(id);
        cache.childrenOf(id);
      }
    });

    assert.deepEqual(
      prepared.map((entry) => entry.sql),
      [],
      'the primed accessors must not prepare again',
    );
  } finally {
    cache.close();
  }
});

test('the same statement object serves every call of an accessor', () => {
  const cache = openExtractionCache(path);
  try {
    const { prepared } = recordPrepares(() => {
      cache.propertiesOf(1);
      cache.propertiesOf(2);
      cache.propertiesOf(3);
    });
    assert.equal(prepared.length, 1, 'propertiesOf prepares exactly once');
  } finally {
    cache.close();
  }
});

test('a cached statement still answers correctly for each argument', () => {
  const cache = openExtractionCache(path);
  try {
    const first = cache.object(1);
    const second = cache.object(2);
    assert.notEqual(first, undefined);
    assert.notEqual(second, undefined);
    assert.equal(first.id, 1);
    assert.equal(second.id, 2);
    // Re-reading through the same statement must give the same answer.
    assert.deepEqual(cache.object(1), first);
    assert.deepEqual(cache.propertiesOf(1), cache.propertiesOf(1));
  } finally {
    cache.close();
  }
});

test('the streaming readers keep their own cursors, so walks can interleave', () => {
  const cache = openExtractionCache(path);
  try {
    const left = cache.allObjects();
    const right = cache.allObjects();
    const leftFirst = left.next().value;
    right.next();
    const leftSecond = left.next().value;
    assert.equal(leftFirst.id, 1);
    assert.equal(leftSecond.id, 2, 'a second iteration must not advance the first');
  } finally {
    cache.close();
  }
});

test('close drops the cached statements and the handle refuses further reads', () => {
  const cache = openExtractionCache(path);
  cache.object(1);
  cache.close();
  cache.close();
  assert.throws(() => cache.object(1), /extraction cache is closed/);
});
