import assert from 'node:assert/strict';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { buildPropertyCatalog, openExtractionCache } from '../dist/index.js';
import { EXTRACTION_CACHE_DDL, writeDragonFixture } from '../dist/fixtures/dragon.js';
import { dumpCache, makeTempDirectory, serializeCatalog } from './support.mjs';

/**
 * The fixture has to be reproducible: same generator, same content, every run
 * and every machine. Table contents are compared rather than file bytes,
 * because SQLite is free to lay out pages differently without changing a
 * single row.
 */

let directory = '';
let first = '';
let second = '';

before(() => {
  directory = makeTempDirectory('determinism');
  first = join(directory, 'dragon-a.sqlite');
  second = join(directory, 'dragon-b.sqlite');
  writeDragonFixture(first);
  writeDragonFixture(second);
});

after(() => {
  rmSync(directory, { recursive: true, force: true });
});

test('two generated fixtures hold identical rows in identical order', () => {
  assert.deepEqual(dumpCache(first), dumpCache(second));
});

test('the generator carries no clock and no host paths', () => {
  const cache = openExtractionCache(first);
  try {
    const meta = cache.meta();
    assert.equal(meta.extractedAtUtc, '2026-01-15T09:30:00Z');
    // The DDL stores file names only, never directories (privacy).
    assert.ok(!meta.inputFileName.includes('/'));
    assert.ok(!meta.inputFileName.includes('\\'));
    for (const model of cache.sourceModels()) {
      assert.ok(!model.fileName.includes('/'));
    }
  } finally {
    cache.close();
  }
});

test('rewriting over an existing fixture reproduces it exactly', () => {
  const before = dumpCache(first);
  writeDragonFixture(first);
  assert.deepEqual(dumpCache(first), before);
});

test('the catalog of two separately generated fixtures is identical', () => {
  const cacheA = openExtractionCache(first);
  const cacheB = openExtractionCache(second);
  try {
    const catalogA = serializeCatalog(buildPropertyCatalog(cacheA));
    const catalogB = serializeCatalog(buildPropertyCatalog(cacheB));
    assert.deepEqual(catalogA, catalogB);
    assert.equal(catalogA.length, 11);
  } finally {
    cacheA.close();
    cacheB.close();
  }
});

test('the catalog of one cache is stable across repeated calls', () => {
  const cache = openExtractionCache(first);
  try {
    assert.deepEqual(
      serializeCatalog(buildPropertyCatalog(cache)),
      serializeCatalog(buildPropertyCatalog(cache)),
    );
  } finally {
    cache.close();
  }
});

test('the fixture DDL matches the canonical schema file', () => {
  // The generator embeds the DDL so it needs no file at runtime; this keeps
  // the copy honest against schemas/extraction-cache.sql.
  const canonical = readFileSync(
    new URL('../../../schemas/extraction-cache.sql', import.meta.url),
    'utf8',
  );
  assert.deepEqual(statementsOf(EXTRACTION_CACHE_DDL), statementsOf(canonical));
});

/** SQL statements with comments and incidental whitespace removed. */
function statementsOf(sql) {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((statement) => statement.replace(/\s+/g, ' ').trim())
    .filter((statement) => statement.length > 0);
}
