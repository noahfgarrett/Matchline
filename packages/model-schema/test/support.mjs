import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { EXTRACTION_CACHE_DDL } from '../dist/fixtures/dragon.js';

/** A throwaway directory under the OS temp dir; callers remove it when done. */
export function makeTempDirectory(label) {
  return mkdtempSync(join(tmpdir(), `matchline-model-schema-${label}-`));
}

/**
 * A cache with the right shape and no content. Used to check that statistics
 * on an empty extraction degrade to zeroes rather than NaN.
 */
export function writeEmptyCache(path, metaOverrides = {}, ddl = EXTRACTION_CACHE_DDL) {
  const meta = {
    // Matches the DDL this writes by default. A caller that wants an older
    // cache overrides both together — a file whose declared version disagrees
    // with its own tables is a shape no writer ever produced.
    schema_version: '2',
    input_file_name: 'Dragon-Empty.nwd',
    input_sha256: '0'.repeat(64),
    input_bytes: '1024',
    extracted_at_utc: '2026-01-15T09:30:00Z',
    extractor_version: '0.1.0',
    adapter_version: 'navisworks-2025',
    navisworks_version: '25.0.1234.56',
    object_count: '0',
    ...metaOverrides,
  };
  const db = new DatabaseSync(path);
  try {
    db.exec(ddl);
    const insert = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    for (const [key, value] of Object.entries(meta)) {
      insert.run(key, value);
    }
  } finally {
    db.close();
  }
}

/** Runs statements against an existing cache file to break it on purpose. */
export function mutateCache(path, statements) {
  const db = new DatabaseSync(path);
  try {
    for (const statement of statements) {
      db.exec(statement);
    }
  } finally {
    db.close();
  }
}

/** Every row of every table, as plain data, for comparing two cache files. */
export function dumpCache(path) {
  const db = new DatabaseSync(path);
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => row.name);
    const dump = {};
    for (const table of tables) {
      // rowid ordering makes insertion order part of the comparison, which is
      // what determinism means for the properties table.
      const rows = db.prepare(`SELECT * FROM ${table}`).all();
      dump[table] = rows.map((row) => ({ ...row }));
    }
    return dump;
  } finally {
    db.close();
  }
}

/** Catalog entries as JSON-comparable data (Maps do not survive deepEqual well). */
export function serializeCatalog(catalog) {
  return catalog.map((entry) => ({
    category: entry.category,
    name: entry.name,
    objectCount: entry.objectCount,
    objectFraction: entry.objectFraction,
    distinctValueCount: entry.distinctValueCount,
    exampleValues: [...entry.exampleValues],
    bySourceModel: [...entry.bySourceModel.entries()],
  }));
}
