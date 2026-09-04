import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { after, before } from 'node:test';

import {
  CURRENT_SCHEMA_VERSION,
  openExtractionCache,
  readV1MembershipResolved,
  SUPPORTED_SCHEMA_VERSIONS,
} from '../dist/index.js';
import {
  DRAGON_UNRESOLVED_SET_NAME,
  EXTRACTION_CACHE_DDL_V1,
  EXTRACTION_CACHE_DDL_V2,
  writeDragonFixture,
  writeDragonFixtureWithUnresolvedSearch,
} from '../dist/fixtures/dragon.js';
import { makeTempDirectory } from './support.mjs';

/**
 * Schema v2 added one column, `selection_sets.membership_resolved`, to record a
 * distinction v1 could not make: a set that resolved to nothing versus a set
 * nobody managed to resolve. This file is the contract for both halves of that
 * — what a v2 cache says, and what a v1 cache is taken to have meant — and for
 * the thing that has to stay true forever after: caches in both of those older
 * shapes still open. `schema-v3.test.mjs` covers what v3 added.
 */

let directory = '';

before(() => {
  directory = makeTempDirectory('schema-v2');
});

after(() => {
  rmSync(directory, { recursive: true, force: true });
});

/**
 * A cache exactly as a v1 writer left it: v1 tables, v1 meta, one folder, one
 * fixed selection with members, and one saved search recorded without any —
 * which is all a v1 writer ever did with a search.
 */
function writeV1Cache(name) {
  const path = join(directory, `${name}.sqlite`);
  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(EXTRACTION_CACHE_DDL_V1);
    const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    for (const [key, value] of [
      ['schema_version', '1'],
      ['input_file_name', 'Legacy.nwd'],
      ['input_sha256', '1'.repeat(64)],
      ['input_bytes', '2048'],
      ['extracted_at_utc', '2026-01-15T09:30:00Z'],
      ['extractor_version', '0.1.0'],
      ['adapter_version', 'navisworks-2025'],
      ['navisworks_version', '25.0.1234.56'],
      ['object_count', '1'],
    ]) {
      meta.run(key, value);
    }
    db.exec(
      "INSERT INTO objects (id, source_model_id, parent_id, path_index, depth, display_name, class_name) " +
        "VALUES (1, NULL, NULL, 0, 0, 'Legacy root', 'File')",
    );
    db.exec("INSERT INTO selection_sets (id, parent_id, name, kind) VALUES (1, NULL, 'Legacy Folder', 'folder')");
    db.exec("INSERT INTO selection_sets (id, parent_id, name, kind) VALUES (2, 1, 'Legacy Fixed', 'selection')");
    db.exec("INSERT INTO selection_sets (id, parent_id, name, kind) VALUES (3, NULL, 'Legacy Search', 'search')");
    db.exec('INSERT INTO selection_set_members (set_id, object_id) VALUES (2, 1)');
  } finally {
    db.close();
  }
  return path;
}

/** Every set in the forest, flattened, by name. */
function setsByName(roots) {
  const found = new Map();
  const stack = [...roots];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === undefined) {
      continue;
    }
    found.set(node.name, node);
    stack.push(...node.children);
  }
  return found;
}

/**
 * A cache exactly as a v2 writer left it: v2 tables and nothing v3 added.
 *
 * Written from the frozen v2 DDL rather than by labelling a v3 file, which is
 * the whole point — the reader picks its column list from the declared version,
 * and a v3 file wearing a v2 label would answer queries the real thing cannot.
 */
function writeV2Cache(name) {
  const path = join(directory, `${name}.sqlite`);
  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(EXTRACTION_CACHE_DDL_V2);
    const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    for (const [key, value] of [
      ['schema_version', '2'],
      ['input_file_name', 'Dragon-V2.nwd'],
      ['input_sha256', '2'.repeat(64)],
      ['input_bytes', '4096'],
      ['extracted_at_utc', '2026-01-15T09:30:00Z'],
      ['extractor_version', '0.1.0'],
      ['adapter_version', 'navisworks-2025'],
      ['navisworks_version', '25.0.1234.56'],
      ['object_count', '1'],
    ]) {
      meta.run(key, value);
    }
    db.exec(
      "INSERT INTO source_models (id, parent_id, file_name, display_name, guid) " +
        "VALUES (1, NULL, 'Dragon-V2.nwc', 'Dragon V2', '00000000-0000-4000-8000-000000000001')",
    );
    db.exec(
      "INSERT INTO objects (id, source_model_id, parent_id, path_index, depth, display_name, " +
        "class_name, instance_guid, authoring_id) " +
        "VALUES (1, 1, NULL, 0, 0, 'V2 root', 'File', " +
        "'00000000-0000-4000-8000-000000000002', 'id-1')",
    );
    db.exec("INSERT INTO selection_sets (id, parent_id, name, kind, membership_resolved) " +
      "VALUES (1, NULL, 'V2 Fixed', 'selection', 1)");
    db.exec('INSERT INTO selection_set_members (set_id, object_id) VALUES (1, 1)');
  } finally {
    db.close();
  }
  return path;
}

test('this reader accepts every schema version it has ever written, and writes the newest', () => {
  assert.deepEqual([...SUPPORTED_SCHEMA_VERSIONS], ['1', '2', '3']);
  assert.equal(CURRENT_SCHEMA_VERSION, '3');
});

test('a real v2 cache still opens, and says nothing it was never asked', () => {
  const cache = openExtractionCache(writeV2Cache('v2-opens'));
  try {
    assert.equal(cache.meta().schemaVersion, '2');
    assert.equal(cache.objectCount(), 1);

    // The v2 columns answer as they always did.
    const [object] = cache.rootObjects();
    assert.equal(object.displayName, 'V2 root');
    assert.equal(object.authoringId, 'id-1');
    assert.equal(object.instanceGuid, '00000000-0000-4000-8000-000000000002');

    // The v3 columns are absent from the file, so they read as null rather than
    // as a failed query — and `flags` is null rather than "nothing is set",
    // because a v2 writer never looked.
    assert.equal(object.authoringIdKind, null);
    assert.equal(object.structuralKey, null);
    assert.equal(object.flags, null);

    const [model] = cache.sourceModels();
    assert.equal(model.fileName, 'Dragon-V2.nwc');
    assert.equal(model.sourceFileName, null);
    assert.equal(model.sourceGuid, null);

    const [set] = cache.selectionSets();
    assert.equal(set.membershipResolved, true);
    assert.deepEqual([...set.memberObjectIds], [1]);
    assert.equal(set.guid, null);

    assert.equal(cache.meta().units, null);
    assert.equal(cache.meta().uiLanguage, null);
  } finally {
    cache.close();
  }
});

test('a v1 cache still opens', () => {
  const cache = openExtractionCache(writeV1Cache('opens'));
  try {
    assert.equal(cache.meta().schemaVersion, '1');
    assert.equal(cache.objectCount(), 1);

    const [object] = cache.rootObjects();
    assert.equal(object.structuralKey, null);
    assert.equal(object.flags, null);
  } finally {
    cache.close();
  }
});

test('a v1 search set reads as unresolved, and a v1 fixed selection as resolved', () => {
  const cache = openExtractionCache(writeV1Cache('v1-membership'));
  try {
    const sets = setsByName(cache.selectionSets());

    // The honest reading of v1: a v1 writer recorded searches without ever
    // running them, so "no members" there means nobody asked, not nothing
    // matched. Folders and fixed selections did know their own membership.
    assert.equal(sets.get('Legacy Search')?.membershipResolved, false);
    assert.equal(sets.get('Legacy Search')?.memberObjectIds.length, 0);
    assert.equal(sets.get('Legacy Fixed')?.membershipResolved, true);
    assert.deepEqual([...(sets.get('Legacy Fixed')?.memberObjectIds ?? [])], [1]);
    assert.equal(sets.get('Legacy Folder')?.membershipResolved, true);
  } finally {
    cache.close();
  }
});

test('the v1 interpretation is stated once and applies to every kind', () => {
  assert.equal(readV1MembershipResolved('folder'), true);
  assert.equal(readV1MembershipResolved('selection'), true);
  assert.equal(readV1MembershipResolved('search'), false);
});

test('a v2 search set that resolved is resolved, members or not', () => {
  const path = join(directory, 'v2-resolved.sqlite');
  writeDragonFixture(path);
  const cache = openExtractionCache(path);
  try {
    const sets = setsByName(cache.selectionSets());

    // Dragon's PLC Panels is a saved search WITH members — a shape v1 could not
    // express, because there members-absent and membership-unknown were the
    // same row.
    const plc = sets.get('PLC Panels');
    assert.equal(plc?.kind, 'search');
    assert.equal(plc?.membershipResolved, true);
    assert.ok((plc?.memberObjectIds.length ?? 0) > 0);
  } finally {
    cache.close();
  }
});

test('an unresolved v2 set is empty AND flagged, which is not the same as empty', () => {
  const path = join(directory, 'v2-unresolved.sqlite');
  writeDragonFixtureWithUnresolvedSearch(path);
  const cache = openExtractionCache(path);
  try {
    const sets = setsByName(cache.selectionSets());
    const unresolved = sets.get(DRAGON_UNRESOLVED_SET_NAME);
    assert.equal(unresolved?.kind, 'search');
    assert.equal(unresolved?.membershipResolved, false);
    assert.equal(unresolved?.memberObjectIds.length, 0);

    // Absent membership is reported, not merely omitted.
    const warning = cache
      .warnings()
      .find((candidate) => candidate.code === 'SEARCH_SET_UNRESOLVED');
    assert.ok(warning, 'an unresolved set must be named by a warning');
    assert.match(warning.message, new RegExp(DRAGON_UNRESOLVED_SET_NAME));

    // And the distinction is legible from the reader alone: same member count,
    // different answer to "do we know".
    const resolved = sets.get('Air Handling');
    assert.equal(resolved?.membershipResolved, true);
  } finally {
    cache.close();
  }
});

test('membership_resolved outside 0/1 is refused rather than coerced', () => {
  const path = join(directory, 'bad-membership.sqlite');
  writeDragonFixture(path);
  const db = new DatabaseSync(path);
  try {
    // The DDL's CHECK forbids this, so it takes a write around the schema —
    // which is exactly the case the reader must not shrug at.
    db.exec('PRAGMA writable_schema = ON');
    db.exec(
      "UPDATE sqlite_schema SET sql = replace(sql, 'CHECK (membership_resolved IN (0, 1))', '') " +
        "WHERE name = 'selection_sets'",
    );
    db.exec('PRAGMA writable_schema = OFF');
  } finally {
    db.close();
  }
  const second = new DatabaseSync(path);
  try {
    second.exec('UPDATE selection_sets SET membership_resolved = 7');
  } finally {
    second.close();
  }

  const cache = openExtractionCache(path);
  try {
    assert.throws(
      () => cache.selectionSets(),
      (error) => {
        assert.equal(error.name, 'CacheValidationError');
        assert.equal(error.reason.kind, 'malformed-row');
        assert.equal(error.reason.table, 'selection_sets');
        assert.equal(error.reason.column, 'membership_resolved');
        return true;
      },
    );
  } finally {
    cache.close();
  }
});
