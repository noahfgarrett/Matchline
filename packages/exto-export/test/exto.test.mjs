/**
 * The Rev21 column map and the row layer.
 *
 * The column positions are the published shape of a first-class deliverable, so
 * they are pinned here literally rather than derived from the code under test: a
 * template revision that moves a column has to move it in this file too, in a
 * diff a reviewer can read.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXTO_BLANK_REGISTER_VALUE,
  EXTO_FIRST_DATA_ROW_INDEX,
  EXTO_HEADER_ROW_INDEX,
  EXTO_REV21_COLUMNS,
  EXTO_REV21_WIDTH,
  buildExtoRows,
  extoAoa,
  extoCellRow,
  extoHeaderRow,
} from '../dist/index.js';
import { DRAGON_REGISTER, DRAGON_REGISTER_ID_ORDER, DRAGON_VF_VOCABULARY } from './dist/dragon.fixture.js';

/**
 * The Rev21 header row, written out in full.
 *
 * Donor source: `packages/legacy-parity/src/export/xlsx.js`, `addExtoSheet` —
 * `upn??6, equipmentId??10, closestParent??15, milestone??24, itemMaster??26,
 * classification??35, dependencies??39`.
 */
const REV21_HEADER_ROW = [
  '', // A
  '', // B
  '', // C
  '', // D
  '', // E
  '', // F
  'UPN', // G  (6)
  '', // H
  '', // I
  '', // J
  'Equipment ID', // K  (10)
  '', // L
  '', // M
  '', // N
  '', // O
  'Closest Parent', // P  (15)
  '', // Q
  '', // R
  '', // S
  '', // T
  '', // U
  '', // V
  '', // W
  '', // X
  'Milestone', // Y  (24)
  '', // Z
  'Item Master Unique Identifier', // AA (26)
  '', // AB
  '', // AC
  '', // AD
  '', // AE
  '', // AF
  '', // AG
  '', // AH
  '', // AI
  'Equipment Classification', // AJ (35)
  '', // AK
  '', // AL
  '', // AM
  'Dependencies', // AN (39)
];

const ROWS = buildExtoRows(DRAGON_REGISTER, { itemMasterVocabulary: DRAGON_VF_VOCABULARY });

function rowFor(equipmentId) {
  const row = ROWS.find((candidate) => candidate.equipmentId === equipmentId);
  assert.ok(row, `no row for ${equipmentId}`);
  return row;
}

/* -------------------------------------------------------------------------- */
/* The column map                                                              */
/* -------------------------------------------------------------------------- */

test('the Rev21 columns are exactly these seven, at exactly these positions', () => {
  assert.deepEqual(
    EXTO_REV21_COLUMNS.map((column) => [column.field, column.header, column.columnIndex]),
    [
      ['upn', 'UPN', 6],
      ['equipmentId', 'Equipment ID', 10],
      ['closestParent', 'Closest Parent', 15],
      ['milestone', 'Milestone', 24],
      ['itemMaster', 'Item Master Unique Identifier', 26],
      ['equipmentClassification', 'Equipment Classification', 35],
      ['dependencies', 'Dependencies', 39],
    ],
  );
  assert.equal(EXTO_REV21_WIDTH, 40, 'the donor width is max(index) + 1');
  assert.deepEqual([EXTO_HEADER_ROW_INDEX, EXTO_FIRST_DATA_ROW_INDEX], [1, 2]);
});

test('the header row places every header and leaves every other column blank', () => {
  assert.deepEqual([...extoHeaderRow()], REV21_HEADER_ROW);
  assert.equal(REV21_HEADER_ROW.length, EXTO_REV21_WIDTH);
});

test('every row field is a column, exactly once', () => {
  const fields = EXTO_REV21_COLUMNS.map((column) => column.field);
  assert.equal(new Set(fields).size, fields.length, 'no field is mapped twice');
  assert.deepEqual(
    [...fields].sort(),
    Object.keys(extoCellRowFields()).sort(),
    'every cell field is mapped and nothing else is',
  );
  const indices = EXTO_REV21_COLUMNS.map((column) => column.columnIndex);
  assert.deepEqual(indices, [...indices].sort((a, b) => a - b), 'columns are in ascending position');
  assert.equal(new Set(indices).size, indices.length, 'no two columns share a position');
});

/** The cell fields a row actually carries, provenance excluded. */
function extoCellRowFields() {
  const row = rowFor('MAH001-10-02');
  const { itemMasterNormalization: _provenance, ...cells } = row;
  return cells;
}

test('provenance rides on the row but can never become a cell', () => {
  const row = rowFor('EPB002-01-01');
  assert.equal(row.itemMasterNormalization.rule, 'ca-to-vf');
  const cells = extoCellRow(row);
  assert.equal(cells.length, EXTO_REV21_WIDTH);
  assert.ok(
    cells.every((cell) => typeof cell === 'string'),
    'no object reaches a cell',
  );
});

/* -------------------------------------------------------------------------- */
/* Rows                                                                        */
/* -------------------------------------------------------------------------- */

test('rows sort by UPN then Equipment ID, with a blank UPN last', () => {
  assert.deepEqual(
    ROWS.map((row) => row.equipmentId),
    DRAGON_REGISTER_ID_ORDER,
  );
  assert.deepEqual(ROWS.map((row) => row.upn), ['001', '001', '001', '001', '002', '010', '']);
});

test('a duplicated tag emits both rows, in input order, never merged', () => {
  const duplicates = ROWS.filter((row) => row.equipmentId === 'MAH001-10-01');
  assert.equal(duplicates.length, 2);
  assert.deepEqual(
    duplicates.map((row) => row.itemMaster),
    ['VF_MECH_AHU', ''],
    'the fuller object stays first',
  );
});

test("a root's Closest Parent is its own System Name (Rev21), and 'N/A' without one", () => {
  assert.equal(rowFor('MAH001-10-02').closestParent, '001 Dragon Air Handling');
  assert.equal(rowFor('TK010-01-01').closestParent, EXTO_BLANK_REGISTER_VALUE, 'no System Name');
  assert.equal(rowFor('FCU-SPARE-07').closestParent, EXTO_BLANK_REGISTER_VALUE);
  assert.equal(rowFor('EPB002-01-01').closestParent, 'SWG002-01', 'a real parent wins');
});

test('the legacy Eagle convention keeps N/A for every root', () => {
  const legacy = buildExtoRows(DRAGON_REGISTER, { rootsAttachToSystem: false });
  const row = legacy.find((candidate) => candidate.equipmentId === 'MAH001-10-02');
  assert.equal(row.closestParent, EXTO_BLANK_REGISTER_VALUE);
  assert.equal(
    legacy.find((candidate) => candidate.equipmentId === 'EPB002-01-01').closestParent,
    'SWG002-01',
    'a real parent is unaffected',
  );
});

test("Dependencies is 'N/A' when empty and sorted when not", () => {
  assert.equal(rowFor('MAH001-10-02').dependencies, 'CHW001-01-01; EPB002-01-01');
  assert.equal(rowFor('TK010-01-01').dependencies, EXTO_BLANK_REGISTER_VALUE);
  const blanks = buildExtoRows([{ canonicalTag: 'X-1', systemKey: '001', dependencyTags: ['', '  '] }]);
  assert.equal(blanks[0].dependencies, EXTO_BLANK_REGISTER_VALUE, 'blank tags are not dependencies');
});

test("Milestone, Item Master and Classification stay genuinely blank — not 'N/A'", () => {
  const bare = rowFor('TK010-01-01');
  assert.deepEqual(
    { milestone: bare.milestone, itemMaster: bare.itemMaster, classification: bare.equipmentClassification },
    { milestone: '', itemMaster: '', classification: 'TK' },
  );
  const bareDuplicate = ROWS.filter((row) => row.equipmentId === 'MAH001-10-01')[1];
  assert.deepEqual(
    {
      milestone: bareDuplicate.milestone,
      itemMaster: bareDuplicate.itemMaster,
      classification: bareDuplicate.equipmentClassification,
    },
    { milestone: '', itemMaster: '', classification: '' },
    'an asset with nothing stated prints blanks, never the text undefined',
  );
});

test('a legacy CA_ master is normalized onto the vocabulary before it is printed', () => {
  assert.equal(rowFor('EPB002-01-01').itemMaster, 'VF_EL_MV_GEAR');
  const unnormalized = buildExtoRows(DRAGON_REGISTER);
  assert.equal(
    unnormalized.find((row) => row.equipmentId === 'EPB002-01-01').itemMaster,
    'CA_NB_EL_MV_GEAR',
    'no vocabulary means the master is printed as stated',
  );
});

test('the printed values are otherwise verbatim', () => {
  const row = rowFor('EPB002-01-01');
  assert.deepEqual(
    { upn: row.upn, milestone: row.milestone, classification: row.equipmentClassification },
    {
      upn: '002',
      milestone: 'L2-M1-0602 - UPN 002 MV Energization',
      classification: 'EPB',
    },
  );
});

test('an empty register builds no rows, and still an openable sheet', () => {
  assert.deepEqual(buildExtoRows([]), []);
  const aoa = extoAoa([]);
  assert.equal(aoa.length, 2, 'spacer row and header row');
  assert.deepEqual([...aoa[0]], new Array(EXTO_REV21_WIDTH).fill(''));
  assert.deepEqual([...aoa[1]], REV21_HEADER_ROW);
});

test('rows are a pure function of the assets, not of their order', () => {
  const shuffled = [...DRAGON_REGISTER].reverse();
  /* The duplicate-tag pair is the one tie whose order is the caller's, so it is
     compared by tag rather than by position. */
  const byTag = (rows) => rows.map((row) => [row.upn, row.equipmentId, row.closestParent]);
  assert.deepEqual(
    byTag(buildExtoRows(shuffled, { itemMasterVocabulary: DRAGON_VF_VOCABULARY })).sort(),
    byTag(ROWS).sort(),
  );
  assert.deepEqual(buildExtoRows(DRAGON_REGISTER, { itemMasterVocabulary: DRAGON_VF_VOCABULARY }), ROWS);
});
