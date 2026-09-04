/**
 * The SSM hierarchy workbook: write → read back through
 * `@matchline/spreadsheet-import` and check that what a reviewer opens in Excel
 * is what the rows said.
 *
 * Nothing here is a checked-in binary: every workbook is written by the code
 * under test and read back with the same reader the engine uses on a real MEL.
 * The rows are built by hand from the Dragon vocabulary the other tests use —
 * the same tags, the same `001`/`002` system keys — because the flattening
 * itself belongs to the caller, and the writer has to be provable without it.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { readWorkbook, sheetAoa } from '@matchline/spreadsheet-import';

import {
  SSM_HIERARCHY_SHEET_NAME,
  SSM_LEVELS_SHEET_NAME,
  writeSsmHierarchyWorkbook,
} from '../dist/index.js';

/** The eleven columns that follow the level columns, whatever the stack is. */
const FIXED_HEADERS = [
  'Tag',
  'Description',
  'Type',
  'Native Discipline',
  'SSM Discipline',
  'System Key',
  'System Label',
  'Structural Parent Tag',
  'Dependencies',
  'Root',
  'Level Path',
];

/** Dragon's stack: two structural boundaries, then a level that only groups. */
const DRAGON_LEVELS = [
  { displayName: 'Building', attributeKey: 'building', boundary: true },
  { displayName: 'System', attributeKey: 'systemKey', boundary: true },
  { displayName: 'Discipline', attributeKey: 'ssmDiscipline', boundary: false },
];

function hierarchyRow(overrides) {
  return {
    levelValues: [],
    canonicalTag: '',
    description: '',
    equipmentType: '',
    nativeDiscipline: '',
    ssmDiscipline: '',
    systemKey: '',
    systemLabel: '',
    structuralParentTag: '',
    dependencyTags: [],
    root: false,
    levelPath: '',
    ...overrides,
  };
}

/**
 * Four Dragon assets, in an order no sort produces: a root air handler, the
 * unit under it, a panelboard in the other building, and the spare fan coil
 * whose system never resolved, so it carries a short level list.
 */
const DRAGON_ROWS = [
  hierarchyRow({
    levelValues: ['D1', '001', 'Mechanical'],
    canonicalTag: 'MAH001-10-01',
    description: 'Primary air handler',
    equipmentType: 'Air Handling Unit',
    nativeDiscipline: 'MECH',
    ssmDiscipline: 'Mechanical',
    systemKey: '001',
    systemLabel: 'Dragon Air Handling',
    dependencyTags: ['EPB002-01-01', 'CHW001-01-01'],
    root: true,
    levelPath: 'D1 › 001 › Mechanical',
  }),
  hierarchyRow({
    levelValues: ['D1', '001', 'Mechanical'],
    canonicalTag: 'MAH001-10-02',
    description: 'Secondary air handler',
    equipmentType: 'Air Handling Unit',
    nativeDiscipline: 'MECH',
    ssmDiscipline: 'Mechanical',
    systemKey: '001',
    systemLabel: 'Dragon Air Handling',
    structuralParentTag: 'MAH001-10-01',
    levelPath: 'D1 › 001 › Mechanical',
  }),
  hierarchyRow({
    levelValues: ['D2', '002', 'Electrical'],
    canonicalTag: 'EPB002-01-01',
    description: 'Annex panelboard',
    equipmentType: 'Panelboard',
    nativeDiscipline: 'ELEC',
    ssmDiscipline: 'Electrical',
    systemKey: '002',
    systemLabel: 'Dragon Power Distribution',
    structuralParentTag: 'ESB002-01',
    dependencyTags: ['ESB002-01'],
    levelPath: 'D2 › 002 › Electrical',
  }),
  hierarchyRow({
    /* The resolver never reached this one, so only the building is known. */
    levelValues: ['D1'],
    canonicalTag: 'FCU-SPARE-07',
    description: 'Spare fan coil unit',
    equipmentType: 'Fan Coil Unit',
    nativeDiscipline: 'MECH',
    ssmDiscipline: 'Mechanical',
    root: true,
    levelPath: 'D1',
  }),
];

/** One sheet of a written workbook, as an array of arrays of display text. */
function scan(bytes, sheetName) {
  return sheetAoa(readWorkbook(bytes).getSheet(sheetName)).aoa;
}

/** The column index of a fixed header, given how many levels are configured. */
function columnOf(header, levelCount) {
  return levelCount + FIXED_HEADERS.indexOf(header);
}

test('both sheets are written, named and ordered as the package exports them', () => {
  const bytes = writeSsmHierarchyWorkbook(DRAGON_ROWS, DRAGON_LEVELS);
  assert.equal(SSM_HIERARCHY_SHEET_NAME, 'SSM Hierarchy');
  assert.equal(SSM_LEVELS_SHEET_NAME, 'Levels');
  assert.deepEqual(readWorkbook(bytes).sheetNames, [
    SSM_HIERARCHY_SHEET_NAME,
    SSM_LEVELS_SHEET_NAME,
  ]);
});

test('the header row is the level display names followed by the eleven fixed headers', () => {
  const aoa = scan(writeSsmHierarchyWorkbook(DRAGON_ROWS, DRAGON_LEVELS), SSM_HIERARCHY_SHEET_NAME);
  assert.deepEqual(aoa[0], ['Building', 'System', 'Discipline', ...FIXED_HEADERS]);
});

test('rows come out in the order they were handed in, never re-sorted', () => {
  const aoa = scan(writeSsmHierarchyWorkbook(DRAGON_ROWS, DRAGON_LEVELS), SSM_HIERARCHY_SHEET_NAME);
  const tag = columnOf('Tag', DRAGON_LEVELS.length);
  assert.equal(aoa.length, DRAGON_ROWS.length + 1);
  assert.deepEqual(
    aoa.slice(1).map((row) => row[tag]),
    DRAGON_ROWS.map((row) => row.canonicalTag),
  );
});

test('a system key of 001 survives the sheet as the text 001, not as the number 1', () => {
  const bytes = writeSsmHierarchyWorkbook(DRAGON_ROWS, DRAGON_LEVELS);
  const aoa = scan(bytes, SSM_HIERARCHY_SHEET_NAME);
  const systemKey = columnOf('System Key', DRAGON_LEVELS.length);
  assert.deepEqual(
    aoa.slice(1).map((row) => row[systemKey]),
    ['001', '001', '002', ''],
  );

  /* And at the cell level, on both sheets: every cell is a text cell, so Excel
     itself never re-reads '001' as a number when the file is opened. */
  const workbook = readWorkbook(bytes);
  for (const sheetName of workbook.sheetNames) {
    for (const row of workbook.getSheet(sheetName)) {
      for (const cell of row ?? []) {
        if (cell === null || cell === undefined) continue;
        assert.equal(cell.t, 's', `expected a text cell, got ${cell.t} for ${String(cell.v)}`);
      }
    }
  }
});

test('dependencies are semicolon-joined and Root reads yes or no', () => {
  const aoa = scan(writeSsmHierarchyWorkbook(DRAGON_ROWS, DRAGON_LEVELS), SSM_HIERARCHY_SHEET_NAME);
  const dependencies = columnOf('Dependencies', DRAGON_LEVELS.length);
  const root = columnOf('Root', DRAGON_LEVELS.length);
  assert.deepEqual(
    aoa.slice(1).map((row) => row[dependencies]),
    ['EPB002-01-01; CHW001-01-01', '', 'ESB002-01', ''],
  );
  assert.deepEqual(
    aoa.slice(1).map((row) => row[root]),
    ['yes', 'no', 'no', 'yes'],
  );
});

test('a row with fewer level values is padded rather than shifting its later columns', () => {
  const aoa = scan(writeSsmHierarchyWorkbook(DRAGON_ROWS, DRAGON_LEVELS), SSM_HIERARCHY_SHEET_NAME);
  assert.deepEqual(aoa.at(-1), [
    'D1',
    '',
    '',
    'FCU-SPARE-07',
    'Spare fan coil unit',
    'Fan Coil Unit',
    'MECH',
    'Mechanical',
    '',
    '',
    '',
    '',
    'yes',
    'D1',
  ]);
});

test('level values beyond the configured stack are dropped, not appended', () => {
  const overfull = hierarchyRow({
    levelValues: ['D1', '001', 'Mechanical', 'Zone 4', 'Skid 9'],
    canonicalTag: 'MAH001-10-01',
    root: true,
  });
  const aoa = scan(writeSsmHierarchyWorkbook([overfull], DRAGON_LEVELS), SSM_HIERARCHY_SHEET_NAME);
  assert.equal(aoa[1].length, DRAGON_LEVELS.length + FIXED_HEADERS.length);
  assert.equal(aoa[1][columnOf('Tag', DRAGON_LEVELS.length)], 'MAH001-10-01');
});

test('the Levels sheet lists every configured level with its key and boundary flag', () => {
  const aoa = scan(writeSsmHierarchyWorkbook(DRAGON_ROWS, DRAGON_LEVELS), SSM_LEVELS_SHEET_NAME);
  assert.deepEqual(aoa, [
    ['Level', 'Attribute Key', 'Structural Boundary'],
    ['Building', 'building', 'yes'],
    ['System', 'systemKey', 'yes'],
    ['Discipline', 'ssmDiscipline', 'no'],
  ]);
});

test('writing the same hierarchy twice produces identical bytes', () => {
  const first = writeSsmHierarchyWorkbook(DRAGON_ROWS, DRAGON_LEVELS);
  const second = writeSsmHierarchyWorkbook(DRAGON_ROWS, DRAGON_LEVELS);
  assert.deepEqual(first, second);
});

test('with no levels configured the sheet is the fixed columns and Levels is header-only', () => {
  const bytes = writeSsmHierarchyWorkbook(DRAGON_ROWS, []);
  const hierarchy = scan(bytes, SSM_HIERARCHY_SHEET_NAME);
  assert.deepEqual(hierarchy[0], FIXED_HEADERS);
  assert.equal(hierarchy[1][0], 'MAH001-10-01');
  assert.deepEqual(scan(bytes, SSM_LEVELS_SHEET_NAME), [
    ['Level', 'Attribute Key', 'Structural Boundary'],
  ]);
});

test('an empty row list writes a header-only hierarchy sheet, not an unopenable file', () => {
  const bytes = writeSsmHierarchyWorkbook([], DRAGON_LEVELS);
  assert.deepEqual(scan(bytes, SSM_HIERARCHY_SHEET_NAME), [
    ['Building', 'System', 'Discipline', ...FIXED_HEADERS],
  ]);
  assert.equal(scan(bytes, SSM_LEVELS_SHEET_NAME).length, DRAGON_LEVELS.length + 1);
});
