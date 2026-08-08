/**
 * The workbook layer: write → read back through `@matchline/spreadsheet-import`
 * and check that what an engineer opens in Excel is what the rows said.
 *
 * Nothing here is a checked-in binary: every workbook is written by the code
 * under test and read back with the same reader the engine uses on a real MEL.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { SpreadsheetReadError, readMappedTable, readWorkbook, sheetAoa } from '@matchline/spreadsheet-import';

import {
  CANONICAL_MEL_COLUMNS,
  CANONICAL_MEL_HEADERS,
  DEFAULT_MEL_SHEET_NAME,
  buildCanonicalMelRows,
  canonicalMelCells,
  writeCanonicalMelWorkbook,
} from '../dist/index.js';
import { DRAGON_ASSETS, syntheticDragonAssets } from './dist/dragon.fixture.js';

/** `{ field: header }` — the mapping a reader needs for a generated MEL. */
const CANONICAL_MEL_MAPPING = Object.fromEntries(
  CANONICAL_MEL_COLUMNS.map((column) => [column.field, column.header]),
);

/** The sheet of a generated workbook, as an array of arrays of display text. */
function scan(bytes, sheetName = DEFAULT_MEL_SHEET_NAME) {
  const workbook = readWorkbook(bytes);
  assert.deepEqual(workbook.sheetNames, [sheetName]);
  return sheetAoa(workbook.getSheet(sheetName)).aoa;
}

test('the sheet is the header row followed by the rows, in column order', () => {
  const aoa = scan(writeCanonicalMelWorkbook(DRAGON_ASSETS));
  const rows = buildCanonicalMelRows(DRAGON_ASSETS);
  assert.deepEqual(aoa[0], [...CANONICAL_MEL_HEADERS]);
  assert.equal(aoa.length, rows.length + 1);
  assert.deepEqual(aoa.slice(1), rows.map((row) => [...canonicalMelCells(row)]));
});

test('a generated MEL reads back as the rows it was built from', () => {
  const bytes = writeCanonicalMelWorkbook(DRAGON_ASSETS);
  const table = readMappedTable(scan(bytes), CANONICAL_MEL_MAPPING, { headerRow: 0 });

  /* Each field must be bound to its own column, at its §12.1 position, by an
     exact header match -- a loose match would mean the header text drifted. */
  assert.deepEqual(
    table.columns.map((column) => [column.field, column.columnIndex, column.match]),
    CANONICAL_MEL_COLUMNS.map((column, index) => [column.field, index, 'exact']),
  );
  assert.deepEqual(table.rows, buildCanonicalMelRows(DRAGON_ASSETS).map((row) => ({ ...row })));
});

test('a system key of 001 survives the workbook as text, not as the number 1', () => {
  const bytes = writeCanonicalMelWorkbook(DRAGON_ASSETS);
  const table = readMappedTable(scan(bytes), CANONICAL_MEL_MAPPING, { headerRow: 0 });
  const keys = table.rows.map((row) => row.systemKey);
  assert.deepEqual(keys, ['001', '001', '001', '002', '', '']);

  /* And at the cell level: every cell in the sheet is a text cell, so Excel
     itself never re-reads '001' as a number when the file is opened. */
  const sheet = readWorkbook(bytes).getSheet(DEFAULT_MEL_SHEET_NAME);
  for (const row of sheet) {
    for (const cell of row ?? []) {
      if (cell === null || cell === undefined) continue;
      assert.equal(cell.t, 's', `expected a text cell, got ${cell.t} for ${String(cell.v)}`);
    }
  }
});

test('an empty asset list writes a header-only sheet, not an unopenable file', () => {
  const aoa = scan(writeCanonicalMelWorkbook([]));
  assert.deepEqual(aoa, [[...CANONICAL_MEL_HEADERS]]);
  assert.equal(
    readMappedTable(aoa, CANONICAL_MEL_MAPPING, { headerRow: 0 }).rows.length,
    0,
  );
});

test('the sheet name defaults to MEL and can be chosen', () => {
  assert.equal(DEFAULT_MEL_SHEET_NAME, 'MEL');
  const bytes = writeCanonicalMelWorkbook(DRAGON_ASSETS, { sheetName: 'Dragon MEL' });
  assert.deepEqual(readWorkbook(bytes).sheetNames, ['Dragon MEL']);
});

test('a sheet name Excel will not accept is refused with a typed reason', () => {
  const tooLong = 'Dragon site canonical master equipment list';
  assert.throws(
    () => writeCanonicalMelWorkbook(DRAGON_ASSETS, { sheetName: tooLong }),
    (error) =>
      error instanceof SpreadsheetReadError &&
      error.reason.kind === 'invalid-sheet-name' &&
      error.reason.name === tooLong,
  );
});

test('500 Dragon assets export and read back intact, well inside two seconds', () => {
  const assets = syntheticDragonAssets(500);
  const started = process.hrtime.bigint();
  const bytes = writeCanonicalMelWorkbook(assets);
  const table = readMappedTable(scan(bytes), CANONICAL_MEL_MAPPING, { headerRow: 0 });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(table.rows.length, 500);
  assert.deepEqual(table.rows, buildCanonicalMelRows(assets).map((row) => ({ ...row })));

  /* Ten systems of fifty, keys ascending: '001' x50, then '002' x50, ... */
  assert.deepEqual(table.rows.slice(0, 50).map((row) => row.systemKey), Array(50).fill('001'));
  assert.equal(table.rows[50].systemKey, '002');
  assert.equal(table.rows.at(-1).systemKey, '010');
  /* Object ids arrive descending per asset and must come out ascending. */
  assert.equal(table.rows[0].modelObjectId, '1; 2');

  assert.ok(elapsedMs < 2000, `write + read of 500 assets took ${elapsedMs.toFixed(0)}ms`);
});
