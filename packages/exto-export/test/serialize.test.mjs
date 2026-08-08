/**
 * The item-master table persists in a Site Profile and is read back in a later
 * session, so it has to survive JSON exactly and it has to be checked on the way
 * back in. The validator is the only thing between a hand-edited profile and the
 * 0.9 gate.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { assignItemMasters, trainItemMasterTable, validateItemMasterTable } from '../dist/index.js';
import { DRAGON_LOOKUPS, DRAGON_REGISTRY, DRAGON_VF_VOCABULARY } from './dist/dragon.fixture.js';

const TABLE = trainItemMasterTable(DRAGON_REGISTRY, {
  vocabulary: DRAGON_VF_VOCABULARY,
  label: 'Dragon registry export 2026-03',
});

/** A structurally-valid table with one field replaced. */
function withEntryField(field, value) {
  const table = JSON.parse(JSON.stringify(TABLE));
  table.entries[0][field] = value;
  return table;
}

test('a trained table survives JSON unchanged', () => {
  const round = JSON.parse(JSON.stringify(TABLE));
  assert.deepEqual(round, TABLE);
  assert.ok(validateItemMasterTable(round));
});

test('a table read back from JSON assigns exactly what the original did', () => {
  const round = JSON.parse(JSON.stringify(TABLE));
  assert.deepEqual(assignItemMasters(round, DRAGON_LOOKUPS), assignItemMasters(TABLE, DRAGON_LOOKUPS));
});

test('the table holds no Maps, Sets, functions or undefined members', () => {
  /* The round trip above would not catch a `Map`, which serializes to `{}`
     rather than failing. Compare the shapes directly. */
  const walk = (value, path) => {
    if (value === undefined) assert.fail(`undefined at ${path}`);
    if (value === null || typeof value !== 'object') {
      assert.notEqual(typeof value, 'function', `function at ${path}`);
      return;
    }
    assert.ok(!(value instanceof Map), `Map at ${path}`);
    assert.ok(!(value instanceof Set), `Set at ${path}`);
    if (Array.isArray(value)) {
      value.forEach((entry, index) => walk(entry, `${path}[${index}]`));
      return;
    }
    for (const [key, entry] of Object.entries(value)) walk(entry, `${path}.${key}`);
  };
  walk(TABLE, 'table');
});

test('an empty table round-trips too', () => {
  const empty = trainItemMasterTable([]);
  assert.deepEqual(JSON.parse(JSON.stringify(empty)), empty);
  assert.ok(validateItemMasterTable(empty));
});

test('the validator rejects anything that is not a table', () => {
  for (const value of [null, undefined, 'table', 42, [], () => TABLE]) {
    assert.equal(validateItemMasterTable(value), false, `accepted ${String(value)}`);
  }
});

test('the validator rejects a table missing a required section', () => {
  for (const key of ['vocabulary', 'entries', 'audit', 'trainedFrom']) {
    const table = JSON.parse(JSON.stringify(TABLE));
    delete table[key];
    assert.equal(validateItemMasterTable(table), false, `accepted a table with no ${key}`);
  }
});

test('the validator rejects an unknown schema version', () => {
  assert.equal(validateItemMasterTable({ ...TABLE, version: 2 }), false);
  assert.equal(validateItemMasterTable({ ...TABLE, version: '1' }), false);
});

test('the validator rejects a confidence outside 0..1 — this is the gate', () => {
  /* The failure this exists to stop: a hand-edited profile whose confidence is
     12, which would clear a 0.9 gate forever. */
  assert.equal(validateItemMasterTable(withEntryField('confidence', 12)), false);
  assert.equal(validateItemMasterTable(withEntryField('confidence', -0.5)), false);
  assert.equal(validateItemMasterTable(withEntryField('confidence', Number.NaN)), false);
  assert.equal(validateItemMasterTable(withEntryField('confidence', '0.95')), false);
  assert.equal(validateItemMasterTable(withEntryField('confidence', 1)), true, '1.0 is legal');
});

test('the validator rejects an invented rung or audit reason', () => {
  assert.equal(validateItemMasterTable(withEntryField('rung', 'definitely')), false);
  const table = JSON.parse(JSON.stringify(TABLE));
  table.audit[0].reason = 'looked-wrong';
  assert.equal(validateItemMasterTable(table), false);
});

test('the validator rejects mistyped key parts and candidate lists', () => {
  assert.equal(validateItemMasterTable(withEntryField('systemKey', 1)), false, 'a UPN is a string');
  assert.equal(validateItemMasterTable(withEntryField('itemMaster', null)), false);
  assert.equal(validateItemMasterTable(withEntryField('candidates', 'VF_MECH_FAN')), false);
  assert.equal(validateItemMasterTable(withEntryField('candidates', [1, 2])), false);
  assert.equal(validateItemMasterTable(withEntryField('sampleCount', -1)), false);
});

test('the validator rejects a malformed vocabulary or trainedFrom', () => {
  assert.equal(validateItemMasterTable({ ...TABLE, vocabulary: 'VF_MECH_AHU' }), false);
  assert.equal(validateItemMasterTable({ ...TABLE, vocabulary: [null] }), false);
  assert.equal(validateItemMasterTable({ ...TABLE, trainedFrom: { rowCount: 3 } }), false);
  assert.equal(
    validateItemMasterTable({ ...TABLE, trainedFrom: { rowCount: '3', label: '' } }),
    false,
  );
});
