/**
 * EXTO template mode: capture a site's own sheet, then write the register onto
 * it.
 *
 * Every template in this file is invented Dragon material, written by the test
 * with the same writer the engine uses, and read back with the same reader. The
 * point being proved is that a captured layout comes out *exactly* as it went
 * in — width, wording, header row — and that a column Matchline did not
 * recognise comes out empty no matter what is in the register.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { readWorkbook, sheetAoa, writeWorkbook } from '@matchline/spreadsheet-import';

import {
  ExtoExportError,
  analyzeExtoTemplate,
  buildExtoRows,
  extoTemplateAoa,
  validateExtoTemplate,
  writeExtoWorkbook,
} from '../dist/index.js';
import {
  DRAGON_REGISTER,
  DRAGON_TEMPLATE_HEADERS,
  DRAGON_TEMPLATE_UNMATCHED,
  DRAGON_VF_VOCABULARY,
} from './dist/dragon.fixture.js';

const ROWS = buildExtoRows(DRAGON_REGISTER, { itemMasterVocabulary: DRAGON_VF_VOCABULARY });

/** A workbook whose sheet holds `rows` above the headers, then the headers. */
function templateBytes(headers, { spacerRows = 0, sheetName = 'data', dataRows = [] } = {}) {
  const aoa = [];
  for (let row = 0; row < spacerRows; row += 1) aoa.push(new Array(headers.length).fill(''));
  aoa.push([...headers]);
  for (const row of dataRows) aoa.push([...row]);
  return writeWorkbook([{ name: sheetName, aoa }]);
}

function scan(bytes) {
  const workbook = readWorkbook(bytes);
  return {
    sheetNames: workbook.sheetNames,
    aoa: sheetAoa(workbook.getSheet(workbook.sheetNames[0])).aoa,
  };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/* -------------------------------------------------------------------------- */
/* Capture                                                                     */
/* -------------------------------------------------------------------------- */

test('a header row on worksheet row 0 is captured verbatim, at row 0', () => {
  const template = analyzeExtoTemplate(templateBytes(DRAGON_TEMPLATE_HEADERS), {
    label: 'Dragon-Registry.xlsx',
  });

  assert.equal(template.version, 1);
  assert.equal(template.sheetName, 'data');
  assert.equal(template.headerRowIndex, 0, 'no spacer was invented above the headers');
  assert.deepEqual([...template.headers], [...DRAGON_TEMPLATE_HEADERS]);
  assert.equal(template.headers.length, 14, 'the site’s own width, not the generic 40');
  assert.deepEqual(template.capturedFrom, { label: 'Dragon-Registry.xlsx' });
});

test('a header row on worksheet row 1 is captured at row 1, spacer and all', () => {
  const template = analyzeExtoTemplate(templateBytes(DRAGON_TEMPLATE_HEADERS, { spacerRows: 1 }));
  assert.equal(template.headerRowIndex, 1);
  assert.deepEqual([...template.headers], [...DRAGON_TEMPLATE_HEADERS]);
});

test('a one-cell title above the headers is not mistaken for a header row', () => {
  const bytes = writeWorkbook([
    { name: 'data', aoa: [['Dragon Cx Registry'], [...DRAGON_TEMPLATE_HEADERS]] },
  ]);
  const template = analyzeExtoTemplate(bytes);
  assert.equal(template.headerRowIndex, 1, 'a row of one cell is a title, not a header list');
  assert.deepEqual([...template.headers], [...DRAGON_TEMPLATE_HEADERS]);
});

test('headers are bound exactly, or after trimming and folding case, and no other way', () => {
  const template = analyzeExtoTemplate(templateBytes(DRAGON_TEMPLATE_HEADERS));
  assert.deepEqual(
    template.matched.map((binding) => [binding.field, binding.columnIndex, binding.match]),
    [
      ['building', 1, 'exact'],
      ['upn', 2, 'exact'],
      ['wbs', 3, 'trimmed-case-insensitive'],
      ['systemName', 4, 'exact'],
      ['equipmentId', 5, 'exact'],
      ['closestParent', 7, 'exact'],
      ['discipline', 8, 'trimmed-case-insensitive'],
      ['itemMaster', 9, 'exact'],
      ['equipmentClassification', 11, 'exact'],
      ['dependencies', 12, 'exact'],
    ],
  );

  const bound = new Set(template.matched.map((binding) => binding.columnIndex));
  for (const header of DRAGON_TEMPLATE_UNMATCHED) {
    const index = DRAGON_TEMPLATE_HEADERS.indexOf(header);
    assert.ok(index >= 0);
    assert.equal(bound.has(index), false, `${header} must never be bound to a field`);
  }
});

test('a repeated header binds once — the first column wins the field', () => {
  const template = analyzeExtoTemplate(templateBytes(['UPN', 'Equipment ID', 'upn']));
  assert.deepEqual(
    template.matched.map((binding) => [binding.field, binding.columnIndex]),
    [
      ['upn', 0],
      ['equipmentId', 1],
    ],
    'the second spelling is left unmatched rather than written to twice',
  );
});

test('trailing blank headers are dropped and a gap in the middle is kept', () => {
  const template = analyzeExtoTemplate(templateBytes(['UPN', '', 'Equipment ID', '', '']));
  assert.deepEqual([...template.headers], ['UPN', '', 'Equipment ID']);
  assert.deepEqual(
    template.matched.map((binding) => binding.columnIndex),
    [0, 2],
    'dropping the gap would have shifted the site’s own column',
  );
});

test('a sheet with nothing on it is refused, rather than captured as empty', () => {
  const bytes = writeWorkbook([{ name: 'data', aoa: [[''], ['', '']] }]);
  assert.throws(
    () => analyzeExtoTemplate(bytes),
    (error) => {
      assert.ok(error instanceof ExtoExportError);
      assert.equal(error.reason.kind, 'template-has-no-header-row');
      assert.equal(error.reason.sheetName, 'data');
      return true;
    },
  );
});

test('an explicit header row is honoured, and one off the end is refused', () => {
  const bytes = templateBytes(DRAGON_TEMPLATE_HEADERS, { spacerRows: 2 });
  assert.equal(analyzeExtoTemplate(bytes, { headerRowIndex: 2 }).headerRowIndex, 2);
  assert.throws(() => analyzeExtoTemplate(bytes, { headerRowIndex: 99 }), {
    name: 'SpreadsheetReadError',
  });
});

/* -------------------------------------------------------------------------- */
/* Writing                                                                     */
/* -------------------------------------------------------------------------- */

test('the export comes out on the template’s headers, at the template’s row', () => {
  const template = analyzeExtoTemplate(templateBytes(DRAGON_TEMPLATE_HEADERS));
  const { sheetNames, aoa } = scan(writeExtoWorkbook(ROWS, { template }));

  assert.deepEqual(sheetNames, ['data'], 'the site’s own sheet name');
  assert.deepEqual(aoa[0], [...DRAGON_TEMPLATE_HEADERS], 'headers on row 0, byte for byte');
  assert.equal(aoa.length, ROWS.length + 1, 'no spacer row was added');
  assert.ok(
    aoa.every((row) => row.length === DRAGON_TEMPLATE_HEADERS.length),
    'every row is the template’s own width',
  );
});

test('a template that carried a spacer keeps its spacer, and only its spacer', () => {
  const template = analyzeExtoTemplate(templateBytes(DRAGON_TEMPLATE_HEADERS, { spacerRows: 1 }));
  const { aoa } = scan(writeExtoWorkbook(ROWS, { template }));

  assert.deepEqual(aoa[0], new Array(DRAGON_TEMPLATE_HEADERS.length).fill(''));
  assert.deepEqual(aoa[1], [...DRAGON_TEMPLATE_HEADERS]);
  assert.equal(aoa.length, ROWS.length + 2);
});

test('an unmatched column is blank in every row, whatever the register says', () => {
  const template = analyzeExtoTemplate(templateBytes(DRAGON_TEMPLATE_HEADERS));
  const { aoa } = scan(writeExtoWorkbook(ROWS, { template }));
  const dataRows = aoa.slice(1);
  assert.ok(dataRows.length > 0);

  for (const header of DRAGON_TEMPLATE_UNMATCHED) {
    const index = DRAGON_TEMPLATE_HEADERS.indexOf(header);
    assert.deepEqual(
      [...new Set(dataRows.map((row) => row[index]))],
      [''],
      `${header} must stay empty — Matchline writes only what a header named`,
    );
  }
});

test('the matched columns carry the register’s own values, under the site’s wording', () => {
  const template = analyzeExtoTemplate(templateBytes(DRAGON_TEMPLATE_HEADERS));
  const { aoa } = scan(writeExtoWorkbook(ROWS, { template }));
  const columnOf = (header) => DRAGON_TEMPLATE_HEADERS.indexOf(header);
  const rowFor = (equipmentId) => {
    const row = aoa.slice(1).find((candidate) => candidate[columnOf('Equipment ID')] === equipmentId);
    assert.ok(row, `no row for ${equipmentId}`);
    return row;
  };

  const panel = rowFor('EPB002-01-01');
  assert.equal(panel[columnOf('UPN')], '002');
  assert.equal(panel[columnOf('wbs')], '1811', 'a folded header still receives its value');
  assert.equal(panel[columnOf('  Discipline  ')], 'Electrical');
  assert.equal(panel[columnOf('System Name')], '002  Dragon Power Distribution');
  assert.equal(panel[columnOf('Closest Parent')], 'SWG002-01');
  assert.equal(panel[columnOf('Item Master Unique Identifier')], 'VF_EL_MV_GEAR');

  const bare = rowFor('TK010-01-01');
  assert.equal(bare[columnOf('Closest Parent')], '', 'a root with no System Name stays blank');
  assert.equal(bare[columnOf('Dependencies')], '');
});

test('a template narrower than the register still only writes columns it named', () => {
  const template = analyzeExtoTemplate(templateBytes(['UPN', 'Equipment ID']));
  const { aoa } = scan(writeExtoWorkbook(ROWS, { template }));
  assert.deepEqual(aoa[0], ['UPN', 'Equipment ID']);
  assert.ok(aoa.every((row) => row.length === 2));
  assert.equal(aoa.length, ROWS.length + 1);
});

test('a template’s own data rows are never carried into the export', () => {
  const template = analyzeExtoTemplate(
    templateBytes(DRAGON_TEMPLATE_HEADERS, {
      dataRows: [new Array(DRAGON_TEMPLATE_HEADERS.length).fill('SITE-DATA')],
    }),
  );
  assert.equal(JSON.stringify(template).includes('SITE-DATA'), false, 'a layout is not a data set');
  const { aoa } = scan(writeExtoWorkbook(ROWS, { template }));
  assert.equal(aoa.flat().includes('SITE-DATA'), false);
});

test('the sheet name can still be overridden without disturbing the layout', () => {
  const template = analyzeExtoTemplate(templateBytes(DRAGON_TEMPLATE_HEADERS));
  const { sheetNames, aoa } = scan(writeExtoWorkbook(ROWS, { template, sheetName: 'Exto SSM' }));
  assert.deepEqual(sheetNames, ['Exto SSM']);
  assert.deepEqual(aoa[0], [...DRAGON_TEMPLATE_HEADERS]);
});

/* -------------------------------------------------------------------------- */
/* Stability                                                                   */
/* -------------------------------------------------------------------------- */

test('two runs over the same rows and template produce the same bytes', () => {
  const template = analyzeExtoTemplate(templateBytes(DRAGON_TEMPLATE_HEADERS));
  const first = writeExtoWorkbook(ROWS, { template });
  const second = writeExtoWorkbook(ROWS, { template });
  assert.equal(sha256(first), sha256(second));

  /* And across a round-trip of the stored template, which is how it actually
     reaches an export: captured in one session, read back in another. */
  const restored = JSON.parse(JSON.stringify(template));
  assert.ok(validateExtoTemplate(restored));
  assert.equal(sha256(writeExtoWorkbook(ROWS, { template: restored })), sha256(first));
});

test('the captured template is JSON by construction', () => {
  const template = analyzeExtoTemplate(templateBytes(DRAGON_TEMPLATE_HEADERS));
  const json = JSON.stringify(template);
  assert.deepEqual(JSON.parse(json), template);
  assert.equal(JSON.stringify(JSON.parse(json)), json);
});

test('the aoa builder and the workbook writer agree', () => {
  const template = analyzeExtoTemplate(templateBytes(DRAGON_TEMPLATE_HEADERS, { spacerRows: 1 }));
  const { aoa } = scan(writeExtoWorkbook(ROWS, { template }));
  assert.deepEqual(
    aoa,
    extoTemplateAoa(ROWS, template).map((row) => [...row]),
  );
});

test('an empty register writes the site’s headers and nothing under them', () => {
  const template = analyzeExtoTemplate(templateBytes(DRAGON_TEMPLATE_HEADERS));
  const { aoa } = scan(writeExtoWorkbook([], { template }));
  assert.deepEqual(aoa, [[...DRAGON_TEMPLATE_HEADERS]]);
});

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

test('the validator refuses a stored template that would write into the wrong column', () => {
  const captured = analyzeExtoTemplate(templateBytes(DRAGON_TEMPLATE_HEADERS));
  const clone = () => JSON.parse(JSON.stringify(captured));
  assert.ok(validateExtoTemplate(clone()));

  for (const [what, mutate] of [
    ['a version this build does not write', (t) => { t.version = 2; }],
    ['a binding past the end of the headers', (t) => { t.matched[0].columnIndex = 99; }],
    ['a negative column index', (t) => { t.matched[0].columnIndex = -1; }],
    ['a fractional column index', (t) => { t.matched[0].columnIndex = 1.5; }],
    ['a field this build cannot fill', (t) => { t.matched[0].field = 'hoardValuation'; }],
    ['the same field bound twice', (t) => { t.matched[1].field = t.matched[0].field; }],
    ['a match kind that is not one', (t) => { t.matched[0].match = 'guessed'; }],
    ['a negative header row', (t) => { t.headerRowIndex = -1; }],
    ['a fractional header row', (t) => { t.headerRowIndex = 0.5; }],
    ['headers that are not text', (t) => { t.headers = [1, 2]; }],
    ['a missing provenance', (t) => { delete t.capturedFrom; }],
  ]) {
    const template = clone();
    mutate(template);
    assert.equal(validateExtoTemplate(template), false, what);
  }

  for (const notATemplate of [null, undefined, 42, 'template', [], [captured]]) {
    assert.equal(validateExtoTemplate(notATemplate), false);
  }
});
