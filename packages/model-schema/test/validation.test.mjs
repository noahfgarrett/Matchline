import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { after, before } from 'node:test';

import { CacheValidationError, openExtractionCache } from '../dist/index.js';
import { EXTRACTION_CACHE_DDL, writeDragonFixture } from '../dist/fixtures/dragon.js';
import { makeTempDirectory, mutateCache, writeEmptyCache } from './support.mjs';

/**
 * A cache that fails any check is refused outright. Reading half of a cache
 * that a killed worker left behind would put invented numbers in front of an
 * engineer, which is exactly what docs/EXTRACTION.md forbids.
 */

let directory = '';

before(() => {
  directory = makeTempDirectory('validation');
});

after(() => {
  rmSync(directory, { recursive: true, force: true });
});

/** A Dragon cache broken on purpose by the given statements. */
function brokenCache(name, statements) {
  const path = join(directory, `${name}.sqlite`);
  writeDragonFixture(path);
  mutateCache(path, statements);
  return path;
}

function refuses(path, expected) {
  assert.throws(
    () => openExtractionCache(path),
    (error) => {
      assert.ok(error instanceof CacheValidationError, `expected CacheValidationError, got ${error}`);
      assert.equal(error.name, 'CacheValidationError');
      assert.deepEqual(error.reason, expected);
      return true;
    },
  );
}

test('a cache from an unknown schema version is refused by version', () => {
  const path = brokenCache('future-version', [
    "UPDATE meta SET value = '3' WHERE key = 'schema_version'",
  ]);
  refuses(path, { kind: 'unsupported-schema-version', found: '3', supported: ['1', '2'] });

  // The message has to name every version involved: whoever reads the log needs
  // to know which writer produced the file and what this reader can do about it.
  assert.throws(() => openExtractionCache(path), /schema_version '3'.*supports '1', '2'/s);
});

test('a missing schema_version is refused before anything else is inspected', () => {
  const path = brokenCache('no-version', ["DELETE FROM meta WHERE key = 'schema_version'"]);
  refuses(path, { kind: 'missing-meta-key', key: 'schema_version' });
});

test('every required meta key is required', () => {
  for (const key of [
    'input_file_name',
    'input_sha256',
    'input_bytes',
    'extracted_at_utc',
    'extractor_version',
    'adapter_version',
    'navisworks_version',
    'object_count',
  ]) {
    const path = brokenCache(`no-${key}`, [`DELETE FROM meta WHERE key = '${key}'`]);
    refuses(path, { kind: 'missing-meta-key', key });
  }
});

test('a cache whose object count disagrees with its objects is refused', () => {
  // What a killed worker leaves behind: the last object never made it in.
  const path = brokenCache('truncated', [
    'DELETE FROM properties WHERE object_id = 76',
    'DELETE FROM objects WHERE id = 76',
  ]);
  refuses(path, { kind: 'object-count-mismatch', declared: 76, actual: 75 });
  assert.throws(() => openExtractionCache(path), /incomplete.*76.*75/s);
});

test('an over-declared object count is refused the same way', () => {
  const path = brokenCache('over-declared', [
    "UPDATE meta SET value = '1000' WHERE key = 'object_count'",
  ]);
  refuses(path, { kind: 'object-count-mismatch', declared: 1000, actual: 76 });
});

test('a non-numeric count is malformed rather than silently zero', () => {
  const path = brokenCache('bad-count', [
    "UPDATE meta SET value = 'many' WHERE key = 'object_count'",
  ]);
  refuses(path, { kind: 'malformed-meta-value', key: 'object_count', value: 'many' });

  const negative = brokenCache('negative-bytes', [
    "UPDATE meta SET value = '-1' WHERE key = 'input_bytes'",
  ]);
  refuses(negative, { kind: 'malformed-meta-value', key: 'input_bytes', value: '-1' });
});

test('a database missing a cache table is not a cache', () => {
  const path = brokenCache('no-warnings-table', ['DROP TABLE warnings']);
  refuses(path, { kind: 'missing-table', table: 'warnings' });
});

test('an unrelated SQLite database is refused, not half-read', () => {
  const path = join(directory, 'stranger.sqlite');
  const db = new DatabaseSync(path);
  db.exec('CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)');
  db.close();
  refuses(path, { kind: 'missing-table', table: 'meta' });
});

test('a file that is not SQLite at all reports why it could not be opened', () => {
  const path = join(directory, 'not-sqlite.txt');
  writeFileSync(path, 'this is not a database');
  assert.throws(
    () => openExtractionCache(path),
    (error) => {
      assert.ok(error instanceof CacheValidationError);
      assert.equal(error.reason.kind, 'cannot-open');
      assert.equal(error.reason.path, path);
      assert.ok(error.reason.detail.length > 0);
      return true;
    },
  );
});

test('a missing file is refused with the path that was asked for', () => {
  const path = join(directory, 'absent.sqlite');
  assert.throws(
    () => openExtractionCache(path),
    (error) => {
      assert.ok(error instanceof CacheValidationError);
      assert.equal(error.reason.kind, 'cannot-open');
      assert.equal(error.reason.path, path);
      return true;
    },
  );
});

test('a half-written bounding box is corruption, not a box', () => {
  const path = brokenCache('partial-bbox', ['UPDATE objects SET bbox_max_z = NULL WHERE id = 3']);
  const cache = openExtractionCache(path);
  try {
    assert.throws(
      () => cache.object(3),
      (error) => {
        assert.ok(error instanceof CacheValidationError);
        assert.deepEqual(error.reason, {
          kind: 'malformed-row',
          table: 'objects',
          column: 'bbox_*',
          detail: 'bounding box is all-or-none but 5 of 6 values are set',
        });
        return true;
      },
    );
  } finally {
    cache.close();
  }
});

test('a selection set kind outside the DDL vocabulary is refused', () => {
  // The DDL has a CHECK for this, so such a row can only exist if something
  // wrote around the schema; the reader still refuses to invent a kind rather
  // than passing an unknown string through as if it were valid.
  const path = join(directory, 'bad-kind.sqlite');
  writeEmptyCache(
    path,
    {},
    EXTRACTION_CACHE_DDL.replace("CHECK (kind IN ('folder', 'selection', 'search'))", ''),
  );
  mutateCache(path, ["INSERT INTO selection_sets (id, name, kind) VALUES (1, 'Lassoed', 'lasso')"]);
  const cache = openExtractionCache(path);
  try {
    assert.throws(
      () => cache.selectionSets(),
      (error) => {
        assert.ok(error instanceof CacheValidationError);
        assert.equal(error.reason.kind, 'malformed-row');
        assert.equal(error.reason.table, 'selection_sets');
        assert.equal(error.reason.column, 'kind');
        return true;
      },
    );
  } finally {
    cache.close();
  }
});

test('an empty but well-formed cache is accepted', () => {
  const path = join(directory, 'empty.sqlite');
  writeEmptyCache(path);
  const cache = openExtractionCache(path);
  try {
    assert.equal(cache.meta().objectCount, 0);
  } finally {
    cache.close();
  }
});

test('an empty cache that claims objects is refused', () => {
  const path = join(directory, 'empty-lying.sqlite');
  writeEmptyCache(path, { object_count: '5' });
  refuses(path, { kind: 'object-count-mismatch', declared: 5, actual: 0 });
});
