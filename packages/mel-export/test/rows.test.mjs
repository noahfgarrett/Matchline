/**
 * The row layer: the §12.1 column contract, deterministic order, and the two
 * joined columns. No workbook is involved in any of it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CANONICAL_MEL_COLUMNS,
  CANONICAL_MEL_HEADERS,
  buildCanonicalMelRows,
  canonicalMelCells,
} from '../dist/index.js';
import {
  DRAGON_AIR_HANDLING,
  DRAGON_ASSETS,
  DRAGON_EXPORT_TAG_ORDER,
} from './dist/dragon.fixture.js';

/** The §12.1 list, transcribed from the doc rather than from the code. */
const PRODUCT_12_1_HEADERS = [
  'Equipment Tag',
  'Equipment Description',
  'Equipment Type',
  'Building',
  'Native Discipline',
  'SSM Discipline',
  'System Key',
  'System Description',
  'System Label',
  'System Parent Equipment Tag',
  'Dependencies',
  'Source Model',
  'Model Object ID',
  'Inclusion Status',
  'Parent Evidence',
  'Review Status',
  'Model Revision Hash',
];

test('the columns are the PRODUCT.md §12.1 field list, in order', () => {
  assert.deepEqual([...CANONICAL_MEL_HEADERS], PRODUCT_12_1_HEADERS);
});

test('every row field is written to exactly one column', () => {
  const [row] = buildCanonicalMelRows([
    { canonicalTag: 'MAH001-10-01', inclusionStatus: 'MODEL_CONFIRMED' },
  ]);
  const fields = CANONICAL_MEL_COLUMNS.map((column) => column.field);
  assert.deepEqual([...fields].sort(), Object.keys(row).sort());
  assert.equal(new Set(fields).size, fields.length, 'no field may be written twice');
  assert.equal(canonicalMelCells(row).length, CANONICAL_MEL_HEADERS.length);
});

test('a fully populated asset renders every §12.1 field', () => {
  const [row] = buildCanonicalMelRows([
    {
      canonicalTag: 'MAH001-10-01',
      description: 'Primary air handler',
      equipmentType: 'Air Handling Unit',
      building: 'D-100',
      nativeDiscipline: 'MECH',
      ssmDiscipline: 'Mechanical',
      system: DRAGON_AIR_HANDLING,
      systemParentTag: 'AHU-PLANT-01',
      dependencyTags: ['EPB002-01-01'],
      sourceModelFile: 'Dragon-MECH.nwd',
      modelObjectIds: [4021],
      inclusionStatus: 'MODEL_CONFIRMED',
      parentEvidence: 'tag-family: MAH001-10-01 under AHU-PLANT-01',
      reviewStatus: 'ACCEPTED',
      modelRevisionSha256: 'a1b2c3',
    },
  ]);
  assert.deepEqual(row, {
    equipmentTag: 'MAH001-10-01',
    equipmentDescription: 'Primary air handler',
    equipmentType: 'Air Handling Unit',
    building: 'D-100',
    nativeDiscipline: 'MECH',
    ssmDiscipline: 'Mechanical',
    systemKey: '001',
    systemDescription: 'Air handling for the Dragon process hall',
    systemLabel: 'Dragon Air Handling',
    systemParentEquipmentTag: 'AHU-PLANT-01',
    dependencies: 'EPB002-01-01',
    sourceModel: 'Dragon-MECH.nwd',
    modelObjectId: '4021',
    inclusionStatus: 'MODEL_CONFIRMED',
    parentEvidence: 'tag-family: MAH001-10-01 under AHU-PLANT-01',
    reviewStatus: 'ACCEPTED',
    modelRevisionHash: 'a1b2c3',
  });
});

test('an absent optional value is an empty cell, never the text undefined', () => {
  const [row] = buildCanonicalMelRows([
    { canonicalTag: 'MAH001-10-01', inclusionStatus: 'MODEL_ONLY' },
  ]);
  for (const cell of canonicalMelCells(row)) {
    assert.equal(typeof cell, 'string');
    assert.notEqual(cell, 'undefined');
    assert.notEqual(cell, 'null');
  }
  assert.deepEqual(canonicalMelCells(row), [
    'MAH001-10-01',
    ...Array.from({ length: 12 }, () => ''),
    'MODEL_ONLY',
    '',
    '',
    '',
  ]);
});

test('the system fields are printed verbatim, leading zeros included', () => {
  const [row] = buildCanonicalMelRows([
    { canonicalTag: 'MAH001-10-01', system: DRAGON_AIR_HANDLING, inclusionStatus: 'MODEL_CONFIRMED' },
  ]);
  assert.equal(row.systemKey, '001');
  assert.equal(row.systemLabel, 'Dragon Air Handling');
  assert.equal(row.systemDescription, 'Air handling for the Dragon process hall');
});

test('a resolution with no description leaves that column empty, not undefined', () => {
  const [row] = buildCanonicalMelRows([
    {
      canonicalTag: 'MAH001-10-01',
      system: {
        systemKey: '001',
        systemLabel: 'Dragon Air Handling',
        systemEvidence: [],
        systemConfidenceTier: 4,
        systemConflictStatus: 'AGREED',
      },
      inclusionStatus: 'MODEL_CONFIRMED',
    },
  ]);
  assert.equal(row.systemDescription, '');
});

test('dependencies are joined in sorted order, whatever order they arrive in', () => {
  const [row] = buildCanonicalMelRows([
    {
      canonicalTag: 'MAH001-10-01',
      dependencyTags: ['EPB002-01-01', 'CHW001-01-01', 'AHU-PLANT-01'],
      inclusionStatus: 'MODEL_CONFIRMED',
    },
  ]);
  assert.equal(row.dependencies, 'AHU-PLANT-01; CHW001-01-01; EPB002-01-01');

  const [empty] = buildCanonicalMelRows([
    { canonicalTag: 'MAH001-10-02', dependencyTags: [], inclusionStatus: 'MODEL_CONFIRMED' },
  ]);
  assert.equal(empty.dependencies, '');
});

test('model object ids are joined ascending numerically, not as text', () => {
  const [row] = buildCanonicalMelRows([
    { canonicalTag: 'MAH001-10-01', modelObjectIds: [10, 9, 100, 2], inclusionStatus: 'MODEL_CONFIRMED' },
  ]);
  assert.equal(row.modelObjectId, '2; 9; 10; 100');
});

test('rows order by system key, then by tag', () => {
  const rows = buildCanonicalMelRows(DRAGON_ASSETS);
  assert.deepEqual(
    rows.map((row) => row.equipmentTag),
    [...DRAGON_EXPORT_TAG_ORDER],
  );
  assert.deepEqual(
    rows.map((row) => row.systemKey),
    ['001', '001', '001', '002', '', ''],
  );
});

test('assets with no resolved system key sort last, grouped together', () => {
  const rows = buildCanonicalMelRows(DRAGON_ASSETS);
  const keyless = rows.filter((row) => row.systemKey === '');
  assert.equal(keyless.length, 2);
  assert.deepEqual(rows.slice(-2), keyless, 'the keyless rows must be the last rows');
  /* One of them has no system at all, the other resolved a label but no key.
     They belong to the same block, and the labelled one keeps its label. */
  assert.deepEqual(
    keyless.map((row) => [row.equipmentTag, row.systemLabel]),
    [
      ['CHW001-01-01', 'Dragon Utilities (unassigned)'],
      ['FCU-SPARE-07', ''],
    ],
  );
});

test('a duplicated model tag emits both rows, in input order, every time', () => {
  const rows = buildCanonicalMelRows(DRAGON_ASSETS).filter(
    (row) => row.equipmentTag === 'MAH001-10-01',
  );
  assert.deepEqual(
    rows.map((row) => [row.modelObjectId, row.sourceModel, row.inclusionStatus]),
    [
      ['4021', 'Dragon-MECH.nwd', 'DUPLICATE_MODEL_TAG'],
      ['5150', 'Dragon-MECH-REV-B.nwd', 'DUPLICATE_MODEL_TAG'],
    ],
  );
});

test('ordering is code-unit, not locale-aware', () => {
  /* Under en-US collation 'a' sorts before 'B'; by code unit it does not.
     Two engineers on differently configured machines must get one sheet. */
  const rows = buildCanonicalMelRows(
    ['a-01', 'B-01', 'A-01'].map((canonicalTag) => ({
      canonicalTag,
      inclusionStatus: 'MODEL_CONFIRMED',
    })),
  );
  assert.deepEqual(
    rows.map((row) => row.equipmentTag),
    ['A-01', 'B-01', 'a-01'],
  );
});

test('an empty asset list yields no rows', () => {
  assert.deepEqual(buildCanonicalMelRows([]), []);
});

test('the caller’s array is never reordered in place', () => {
  const assets = [...DRAGON_ASSETS];
  const before = assets.map((asset) => asset.canonicalTag);
  buildCanonicalMelRows(assets);
  assert.deepEqual(
    assets.map((asset) => asset.canonicalTag),
    before,
  );
});

test('the same assets always build the same rows, whatever order they arrive in', () => {
  const forwards = buildCanonicalMelRows(DRAGON_ASSETS);
  /* Reversing swaps the duplicate pair, which is the one tie stable sorting
     keeps in input order -- so compare everything except that pair's order. */
  const backwards = buildCanonicalMelRows([...DRAGON_ASSETS].reverse());
  assert.deepEqual(
    backwards.map((row) => row.equipmentTag),
    forwards.map((row) => row.equipmentTag),
  );
  assert.deepEqual(
    [...backwards].map((row) => row.modelObjectId).sort(),
    [...forwards].map((row) => row.modelObjectId).sort(),
  );
});
