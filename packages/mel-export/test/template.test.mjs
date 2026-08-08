/**
 * Site-template MEL (PRODUCT.md §12.2): reading an uploaded template's columns,
 * suggesting a mapping for them, and filling the template.
 *
 * The "uploaded template" in every test here is written by
 * `@matchline/spreadsheet-import` and read back through the code under test, so
 * nothing is a checked-in binary and the round trip is real.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  SpreadsheetReadError,
  readWorkbook,
  sheetAoa,
  writeWorkbook,
} from '@matchline/spreadsheet-import';

import {
  MelExportError,
  TEMPLATE_HEADER_SYNONYMS,
  analyzeTemplate,
  buildCanonicalMelRows,
  writeTemplateMel,
} from '../dist/index.js';
import { DRAGON_ASSETS, DRAGON_EXPORT_TAG_ORDER } from './dist/dragon.fixture.js';

/** The Dragon site's own MEL layout: its column names, its column order. */
const DRAGON_TEMPLATE_HEADERS = [
  'Equipment No.',
  'System Description',
  'UPN',
  'Site',
  'Description',
  'Contract',
];

/** A template workbook with a title row above the headers, as real ones have. */
function dragonTemplate(headers = DRAGON_TEMPLATE_HEADERS, sheetName = 'Site MEL') {
  return writeWorkbook([
    {
      name: sheetName,
      aoa: [
        ['Dragon site master equipment list'],
        [],
        headers,
        headers.map(() => ''),
      ],
    },
  ]);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The sheet of a written workbook as arrays of display text. */
function scan(bytes) {
  const workbook = readWorkbook(bytes);
  const [name] = workbook.sheetNames;
  return sheetAoa(workbook.getSheet(name)).aoa;
}

/* ---- analysis ---- */

test('a template is read as its columns, in template order, below any title rows', () => {
  const analysis = analyzeTemplate(dragonTemplate());
  assert.equal(analysis.sheetName, 'Site MEL');
  assert.deepEqual([...analysis.sheetNames], ['Site MEL']);
  assert.equal(analysis.headerRow, 1, 'the blank row is not scanned; the title row is row 0');
  assert.deepEqual(
    analysis.columns.map((column) => [column.index, column.header]),
    DRAGON_TEMPLATE_HEADERS.map((header, index) => [index, header]),
  );
});

test('headers are suggested by exact match, by case-insensitive match, and by synonym', () => {
  const analysis = analyzeTemplate(
    dragonTemplate(['System Description', 'equipment  tag', 'system key', 'UPN', 'Widgets']),
  );
  assert.deepEqual(
    analysis.columns.map((column) => [
      column.header,
      column.suggestion?.field,
      column.suggestion?.match,
    ]),
    [
      ['System Description', 'systemDescription', 'exact'],
      /* Two internal spaces: folding trims and lower-cases, it does not respace. */
      ['equipment  tag', undefined, undefined],
      ['system key', 'systemKey', 'trimmed-case-insensitive'],
      /* systemKey is already claimed by the column before it. */
      ['UPN', undefined, undefined],
      ['Widgets', undefined, undefined],
    ],
  );
});

test('the documented synonyms are the ones that fire', () => {
  const headers = TEMPLATE_HEADER_SYNONYMS.map((synonym) => synonym.header);
  /* One template per synonym, so no two of them contest the same field. */
  for (const synonym of TEMPLATE_HEADER_SYNONYMS) {
    const [column] = analyzeTemplate(dragonTemplate([synonym.header, 'Notes'])).columns;
    assert.deepEqual(column.suggestion, { field: synonym.field, match: 'synonym' });
  }
  assert.deepEqual(headers, ['UPN', 'System', 'Tag', 'Equipment No.', 'Equipment No', 'Description']);
});

test('a synonym matches case-insensitively and with surrounding space', () => {
  const [column] = analyzeTemplate(dragonTemplate(['  upn  ', 'Notes'])).columns;
  assert.deepEqual(column.suggestion, { field: 'systemKey', match: 'synonym' });
});

test('a one-cell title row above the headers is not mistaken for the headers', () => {
  /* The default rule, and the escape hatch when a template defeats it. */
  const bytes = writeWorkbook([
    { name: 'Site MEL', aoa: [['Dragon site MEL'], ['Rev C'], ['Tag', 'UPN']] },
  ]);
  assert.equal(analyzeTemplate(bytes).headerRow, 2);
  assert.deepEqual(
    analyzeTemplate(bytes, { headerRow: 1 }).columns.map((column) => column.header),
    ['Rev C'],
  );
  assert.throws(
    () => analyzeTemplate(bytes, { headerRow: 9 }),
    (error) =>
      error instanceof SpreadsheetReadError &&
      error.reason.kind === 'header-row-out-of-range' &&
      error.reason.headerRow === 9,
  );
});

test('a field is suggested for at most one column — the first that asks', () => {
  const analysis = analyzeTemplate(dragonTemplate(['Tag', 'Equipment No.', 'Equipment Tag']));
  assert.deepEqual(
    analysis.columns.map((column) => column.suggestion?.field),
    ['equipmentTag', undefined, undefined],
  );
});

test('the suggested mapping is one entry per column, unsuggested ones blank', () => {
  const analysis = analyzeTemplate(dragonTemplate());
  assert.deepEqual([...analysis.suggestedMapping], [
    { templateColumn: 'Equipment No.', field: 'equipmentTag' },
    { templateColumn: 'System Description', field: 'systemDescription' },
    { templateColumn: 'UPN', field: 'systemKey' },
    { templateColumn: 'Site', field: { kind: 'blank' } },
    { templateColumn: 'Description', field: 'equipmentDescription' },
    { templateColumn: 'Contract', field: { kind: 'blank' } },
  ]);
});

test('a gap between named columns is kept; trailing unnamed columns are dropped', () => {
  const analysis = analyzeTemplate(dragonTemplate(['Tag', '', 'UPN', '', '']));
  assert.deepEqual(
    analysis.columns.map((column) => column.header),
    ['Tag', '', 'UPN'],
  );
  assert.equal(analysis.columns[1].suggestion, undefined);
});

test('a named sheet can be chosen, and an absent one is refused with its options', () => {
  const bytes = writeWorkbook([
    { name: 'Cover', aoa: [['Read me']] },
    { name: 'MEL', aoa: [['Tag', 'UPN']] },
  ]);
  assert.equal(analyzeTemplate(bytes).sheetName, 'Cover', 'the first sheet is the default');
  assert.equal(analyzeTemplate(bytes, { sheetName: 'MEL' }).sheetName, 'MEL');
  assert.throws(
    () => analyzeTemplate(bytes, { sheetName: 'Assets' }),
    (error) =>
      error instanceof SpreadsheetReadError &&
      error.reason.kind === 'sheet-not-found' &&
      error.reason.sheetName === 'Assets' &&
      error.reason.availableSheets.join() === 'Cover,MEL',
  );
});

test('a sheet with no non-empty row is refused rather than read as no columns', () => {
  const bytes = writeWorkbook([{ name: 'Empty', aoa: [['']] }]);
  assert.throws(
    () => analyzeTemplate(bytes),
    (error) =>
      error instanceof MelExportError &&
      error.reason.kind === 'template-has-no-header-row' &&
      error.reason.sheetName === 'Empty',
  );
});

/* ---- writing ---- */

test('the filled template keeps the template’s headers and column order exactly', () => {
  const mapping = analyzeTemplate(dragonTemplate()).suggestedMapping;
  const aoa = scan(writeTemplateMel(DRAGON_ASSETS, mapping));
  assert.deepEqual(aoa[0], DRAGON_TEMPLATE_HEADERS);
  assert.equal(aoa.length, DRAGON_ASSETS.length + 1);
});

test('rows come out in canonical order, one per asset', () => {
  const mapping = analyzeTemplate(dragonTemplate()).suggestedMapping;
  const aoa = scan(writeTemplateMel(DRAGON_ASSETS, mapping));
  assert.deepEqual(
    aoa.slice(1).map((row) => row[0]),
    [...DRAGON_EXPORT_TAG_ORDER],
  );
});

test('mapped columns carry the canonical values; unmapped columns are blank', () => {
  const mapping = analyzeTemplate(dragonTemplate()).suggestedMapping;
  const aoa = scan(writeTemplateMel(DRAGON_ASSETS, mapping));
  const rows = buildCanonicalMelRows(DRAGON_ASSETS);
  assert.deepEqual(aoa[1], [
    rows[0].equipmentTag,
    rows[0].systemDescription,
    rows[0].systemKey,
    '',
    rows[0].equipmentDescription,
    '',
  ]);
  /* A leading-zero System Key still has to be a leading-zero System Key. */
  assert.equal(aoa[1][2], '001');
  for (const row of aoa.slice(1)) {
    assert.equal(row[3], '');
    assert.equal(row[5], '');
  }
});

test('a literal fills every row with the same value', () => {
  const bytes = writeTemplateMel(DRAGON_ASSETS, [
    { templateColumn: 'Equipment No.', field: 'equipmentTag' },
    { templateColumn: 'Contract', field: { kind: 'literal', value: 'C-2026-014' } },
    { templateColumn: 'Site', field: { kind: 'blank' } },
  ]);
  const aoa = scan(bytes);
  assert.deepEqual(aoa[0], ['Equipment No.', 'Contract', 'Site']);
  for (const row of aoa.slice(1)) {
    assert.equal(row[1], 'C-2026-014');
    assert.equal(row[2], '');
  }
});

test('one field may fill two template columns', () => {
  const aoa = scan(
    writeTemplateMel(DRAGON_ASSETS, [
      { templateColumn: 'Tag', field: 'equipmentTag' },
      { templateColumn: 'Asset ID', field: 'equipmentTag' },
    ]),
  );
  for (const row of aoa.slice(1)) assert.equal(row[0], row[1]);
});

test('an empty asset list writes the template’s header row and nothing else', () => {
  const mapping = analyzeTemplate(dragonTemplate()).suggestedMapping;
  assert.deepEqual(scan(writeTemplateMel([], mapping)), [DRAGON_TEMPLATE_HEADERS]);
});

test('every cell of a filled template is a text cell', () => {
  const mapping = analyzeTemplate(dragonTemplate()).suggestedMapping;
  const sheet = readWorkbook(writeTemplateMel(DRAGON_ASSETS, mapping)).getSheet('MEL');
  for (const row of sheet) {
    for (const cell of row ?? []) {
      if (cell === null || cell === undefined) continue;
      assert.equal(cell.t, 's', `expected a text cell, got ${cell.t} for ${String(cell.v)}`);
    }
  }
});

test('the sheet name defaults to MEL and can be chosen', () => {
  const mapping = [{ templateColumn: 'Tag', field: 'equipmentTag' }];
  assert.deepEqual(readWorkbook(writeTemplateMel([], mapping)).sheetNames, ['MEL']);
  assert.deepEqual(
    readWorkbook(writeTemplateMel([], mapping, { sheetName: 'Site MEL' })).sheetNames,
    ['Site MEL'],
  );
});

test('a mapping naming something that is not a §12.1 field is refused, all offenders at once', () => {
  assert.throws(
    () =>
      writeTemplateMel(DRAGON_ASSETS, [
        { templateColumn: 'Tag', field: 'equipmentTag' },
        { templateColumn: 'Cost', field: 'costCode' },
        { templateColumn: 'Zone', field: 'Building' },
      ]),
    (error) =>
      error instanceof MelExportError &&
      error.reason.kind === 'unknown-canonical-field' &&
      error.reason.fields.join() === 'costCode,Building' &&
      error.reason.knownFields.includes('building'),
  );
});

test('an empty mapping is refused rather than writing a sheet with no columns', () => {
  assert.throws(
    () => writeTemplateMel(DRAGON_ASSETS, []),
    (error) => error instanceof MelExportError && error.reason.kind === 'empty-template-mapping',
  );
});

test('a filled template round-trips: analyze it, and the columns come back', () => {
  const mapping = analyzeTemplate(dragonTemplate()).suggestedMapping;
  const filled = writeTemplateMel(DRAGON_ASSETS, mapping);
  const again = analyzeTemplate(filled);
  assert.deepEqual(
    again.columns.map((column) => column.header),
    DRAGON_TEMPLATE_HEADERS,
  );
  assert.equal(again.headerRow, 0);
  /* And filling the re-read template again produces the same file. */
  assert.equal(
    sha256(writeTemplateMel(DRAGON_ASSETS, again.suggestedMapping)),
    sha256(filled),
  );
});

test('the same assets and mapping always write the same bytes', () => {
  const mapping = analyzeTemplate(dragonTemplate()).suggestedMapping;
  assert.equal(
    sha256(writeTemplateMel(DRAGON_ASSETS, mapping)),
    sha256(writeTemplateMel([...DRAGON_ASSETS], mapping)),
  );
  /* The negative half: identical bytes must mean identical data. */
  assert.notEqual(
    sha256(writeTemplateMel(DRAGON_ASSETS, mapping)),
    sha256(
      writeTemplateMel(DRAGON_ASSETS, [
        ...mapping.slice(0, 3),
        { templateColumn: 'Site', field: 'building' },
        ...mapping.slice(4),
      ]),
    ),
  );
});
