/**
 * The learned WBS table: one rung, keyed on the System Key, gated at 0.9.
 *
 * The gate is checked on both sides and exactly on it, because "exactly on it
 * assigns" is a decision rather than an accident. The leading-zero cases are
 * checked in the key and in the value independently, because a code and a key
 * are both text and either one could be quietly turned into a number by a
 * careless round-trip.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WBS_MIN_CONFIDENCE,
  WBS_PROPOSAL_CANDIDATES,
  assignWbs,
  trainWbsTable,
  validateWbsTable,
} from '../dist/index.js';
import { DRAGON_WBS_REGISTRY } from './dist/dragon.fixture.js';

const TABLE = trainWbsTable(DRAGON_WBS_REGISTRY, { label: 'Dragon-Registry.xlsx' });

function entryFor(systemKey) {
  const entry = TABLE.entries.find((candidate) => candidate.systemKey === systemKey);
  assert.ok(entry, `no entry for ${systemKey}`);
  return entry;
}

/* -------------------------------------------------------------------------- */
/* Training                                                                    */
/* -------------------------------------------------------------------------- */

test('the table is keyed on the System Key and on nothing else', () => {
  assert.deepEqual(
    TABLE.entries.map((entry) => entry.systemKey),
    ['001', '002', '003', '007'],
    'one entry per system, in system-key order',
  );
  assert.deepEqual(Object.keys(entryFor('001')).sort(), [
    'candidates',
    'confidence',
    'sampleCount',
    'systemKey',
    'wbs',
  ]);
});

test('confidence is the dominant code’s share of the rows behind the key', () => {
  assert.deepEqual(
    TABLE.entries.map((entry) => [entry.systemKey, entry.wbs, entry.confidence, entry.sampleCount]),
    [
      ['001', '1810', 1, 10],
      ['002', '1811', 0.9, 10],
      ['003', '1812', 0.7, 10],
      ['007', '0110', 1, 4],
    ],
  );
});

test('a row with no key, or no code, teaches nothing rather than teaching a blank', () => {
  assert.equal(TABLE.entries.length, 4, 'the two unusable rows produced no entry');
  assert.equal(TABLE.trainedFrom.rowCount, DRAGON_WBS_REGISTRY.length, 'but they were counted');
  assert.equal(TABLE.trainedFrom.label, 'Dragon-Registry.xlsx');
  assert.ok(
    TABLE.entries.every((entry) => entry.wbs !== ''),
    'no entry answers with a blank code',
  );
});

test('an empty registry yields a table that assigns nothing and proposes nothing', () => {
  const empty = trainWbsTable([]);
  assert.deepEqual(
    { entries: empty.entries.length, rows: empty.trainedFrom.rowCount, label: empty.trainedFrom.label },
    { entries: 0, rows: 0, label: '' },
  );
  assert.deepEqual(assignWbs(empty, '001'), {
    kind: 'unmatched',
    systemKey: '001',
    reason: 'no-learned-key',
  });
});

test('candidates are ranked by count, capped, and independent of row order', () => {
  const entry = entryFor('003');
  assert.deepEqual(entry.candidates, ['1812', '1898'], 'the leading candidate comes first');
  assert.ok(entry.candidates.length <= WBS_PROPOSAL_CANDIDATES);

  const shuffled = trainWbsTable([...DRAGON_WBS_REGISTRY].reverse());
  assert.deepEqual(shuffled.entries, TABLE.entries, 'the same rows in any order train the same table');
});

/* -------------------------------------------------------------------------- */
/* The gate                                                                    */
/* -------------------------------------------------------------------------- */

test('above the gate assigns, with the reasoning that justifies the cell', () => {
  assert.deepEqual(assignWbs(TABLE, '001'), {
    kind: 'assigned',
    systemKey: '001',
    wbs: '1810',
    rule: 'learned from registry: UPN 001',
    confidence: 1,
    sampleCount: 10,
  });
});

test('exactly on the gate assigns — 0.9 is admitted, not merely approached', () => {
  const outcome = assignWbs(TABLE, '002');
  assert.equal(outcome.kind, 'assigned');
  assert.equal(outcome.confidence, WBS_MIN_CONFIDENCE);
  assert.equal(outcome.wbs, '1811');
});

test('below the gate proposes and never guesses', () => {
  const outcome = assignWbs(TABLE, '003');
  assert.equal(outcome.kind, 'proposal');
  assert.equal(outcome.confidence, 0.7);
  assert.deepEqual(outcome.candidates, ['1812', '1898']);
  assert.ok(!('wbs' in outcome), 'a proposal carries no answer at all');
});

test('the two ways of having no answer are told apart', () => {
  assert.deepEqual(assignWbs(TABLE, '999'), {
    kind: 'unmatched',
    systemKey: '999',
    reason: 'no-learned-key',
  });
  for (const missing of ['', '   ', undefined]) {
    assert.deepEqual(assignWbs(TABLE, missing), {
      kind: 'unmatched',
      systemKey: '',
      reason: 'no-system-key',
    });
  }
});

/* -------------------------------------------------------------------------- */
/* Leading zeros                                                               */
/* -------------------------------------------------------------------------- */

test('a leading zero survives in the key and in the code', () => {
  const outcome = assignWbs(TABLE, '007');
  assert.equal(outcome.kind, 'assigned');
  assert.equal(outcome.wbs, '0110', 'the code is text — 0110 is not 110');
  assert.equal(entryFor('007').systemKey, '007', 'the key is text — 007 is not 7');
  assert.equal(assignWbs(TABLE, '7').kind, 'unmatched', '7 and 007 are different systems');
});

test('a key is matched after trimming, and never after re-spelling', () => {
  assert.equal(assignWbs(TABLE, '  001  ').wbs, '1810');
  assert.equal(assignWbs(TABLE, '01').kind, 'unmatched');
});

/* -------------------------------------------------------------------------- */
/* Round-trip                                                                  */
/* -------------------------------------------------------------------------- */

test('the table is JSON by construction and survives a round-trip unchanged', () => {
  const json = JSON.stringify(TABLE);
  const restored = JSON.parse(json);
  assert.deepEqual(restored, TABLE, 'no Maps, no Sets, no undefined fields');
  assert.equal(JSON.stringify(restored), json, 'and re-serializing is byte-identical');

  assert.ok(validateWbsTable(restored));
  assert.deepEqual(assignWbs(restored, '007'), assignWbs(TABLE, '007'), 'a restored table answers the same');
  assert.deepEqual(assignWbs(restored, '003'), assignWbs(TABLE, '003'));
});

test('the validator refuses a table that would corrupt the gate', () => {
  const clone = () => JSON.parse(JSON.stringify(TABLE));
  assert.ok(validateWbsTable(clone()));

  for (const [what, mutate] of [
    ['a version this build does not write', (t) => { t.version = 2; }],
    ['a confidence above 1', (t) => { t.entries[0].confidence = 12; }],
    ['a negative confidence', (t) => { t.entries[0].confidence = -1; }],
    ['a non-finite confidence', (t) => { t.entries[0].confidence = null; }],
    ['a negative sample count', (t) => { t.entries[0].sampleCount = -3; }],
    ['a code that is not text', (t) => { t.entries[0].wbs = 1810; }],
    ['a key that is not text', (t) => { t.entries[0].systemKey = 1; }],
    ['candidates that are not text', (t) => { t.entries[0].candidates = [1810]; }],
    ['entries that are not a list', (t) => { t.entries = {}; }],
    ['a missing provenance', (t) => { delete t.trainedFrom; }],
  ]) {
    const table = clone();
    mutate(table);
    assert.equal(validateWbsTable(table), false, what);
  }

  for (const notATable of [null, undefined, 42, 'table', [], [TABLE]]) {
    assert.equal(validateWbsTable(notATable), false);
  }
});
