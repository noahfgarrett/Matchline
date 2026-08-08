/**
 * The workbook layer: write → read back through `@matchline/spreadsheet-import`
 * and check that what an engineer opens in Excel is what the rows said, then
 * check that two runs produce the same file.
 *
 * Nothing here is a checked-in binary: every workbook is written by the code
 * under test and read back with the same reader the engine uses on a real
 * upload sheet.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  SpreadsheetReadError,
  readMappedTable,
  readWorkbook,
  sheetAoa,
} from '@matchline/spreadsheet-import';

import {
  DEFAULT_EXTO_SHEET_NAME,
  EXTO_HEADER_ROW_INDEX,
  EXTO_REV21_COLUMNS,
  EXTO_REV21_WIDTH,
  buildExtoRows,
  extoAoa,
  extoCellRow,
  writeExtoWorkbook,
} from '../dist/index.js';
import {
  DRAGON_REGISTER,
  DRAGON_REGISTER_ID_ORDER,
  DRAGON_VF_VOCABULARY,
  syntheticDragonRegister,
} from './dist/dragon.fixture.js';

/** `{ field: header }` — the mapping a reader needs for an EXTO upload sheet. */
const EXTO_MAPPING = Object.fromEntries(
  EXTO_REV21_COLUMNS.map((column) => [column.field, column.header]),
);

const ROWS = buildExtoRows(DRAGON_REGISTER, { itemMasterVocabulary: DRAGON_VF_VOCABULARY });

/** The sheet of a generated workbook, as an array of arrays of display text. */
function scan(bytes, sheetName = DEFAULT_EXTO_SHEET_NAME) {
  const workbook = readWorkbook(bytes);
  assert.deepEqual(workbook.sheetNames, [sheetName]);
  return sheetAoa(workbook.getSheet(sheetName)).aoa;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('the sheet is a blank spacer row, the Rev21 header row, then the rows', () => {
  const aoa = scan(writeExtoWorkbook(ROWS));
  assert.deepEqual(aoa, extoAoa(ROWS).map((row) => [...row]));
  assert.equal(aoa.length, ROWS.length + 2);
  assert.deepEqual(aoa[0], new Array(EXTO_REV21_WIDTH).fill(''));
  assert.deepEqual(aoa.slice(2), ROWS.map((row) => [...extoCellRow(row)]));
});

test('the blank spacer row survives the workbook, so the header stays on row 2', () => {
  /* The reader drops rows that hold no cells at all. If the writer ever stopped
     emitting the spacer's empty cells, every mapped column would shift up a row
     and a Rev21 reader would bind to the wrong row entirely. */
  const { aoa, rowNums } = sheetAoa(
    readWorkbook(writeExtoWorkbook(ROWS)).getSheet(DEFAULT_EXTO_SHEET_NAME),
  );
  assert.deepEqual(rowNums.slice(0, 3), [0, 1, 2]);
  assert.ok(aoa.every((row) => row.length === EXTO_REV21_WIDTH), 'every row is full width');
});

test('an EXTO workbook reads back as the rows it was built from', () => {
  const table = readMappedTable(scan(writeExtoWorkbook(ROWS)), EXTO_MAPPING, {
    headerRow: EXTO_HEADER_ROW_INDEX,
  });

  /* Each field must be bound to its own column, at its Rev21 position, by an
     exact header match — a loose match would mean the header text drifted. */
  assert.deepEqual(
    table.columns.map((column) => [column.field, column.columnIndex, column.match]),
    EXTO_REV21_COLUMNS.map((column) => [column.field, column.columnIndex, 'exact']),
  );
  assert.deepEqual(
    table.rows,
    ROWS.map(({ itemMasterNormalization: _provenance, ...cells }) => cells),
  );
  assert.deepEqual(table.rows.map((row) => row.equipmentId), DRAGON_REGISTER_ID_ORDER);
});

test('a UPN of 001 survives the workbook as text, not as the number 1', () => {
  const bytes = writeExtoWorkbook(ROWS);
  const table = readMappedTable(scan(bytes), EXTO_MAPPING, { headerRow: EXTO_HEADER_ROW_INDEX });
  assert.deepEqual(table.rows.map((row) => row.upn), ['001', '001', '001', '001', '002', '010', '']);

  /* And at the cell level: every cell in the sheet is a text cell, so Excel
     itself never re-reads '001' as a number when the file is opened. */
  const sheet = readWorkbook(bytes).getSheet(DEFAULT_EXTO_SHEET_NAME);
  for (const row of sheet) {
    for (const cell of row ?? []) {
      if (cell === null || cell === undefined) continue;
      assert.equal(cell.t, 's', `expected a text cell, got ${cell.t} for ${String(cell.v)}`);
    }
  }
});

test('an empty register writes a header-only sheet, not an unopenable file', () => {
  const aoa = scan(writeExtoWorkbook([]));
  assert.equal(aoa.length, 2);
  assert.equal(
    readMappedTable(aoa, EXTO_MAPPING, { headerRow: EXTO_HEADER_ROW_INDEX }).rows.length,
    0,
  );
});

test('the sheet name defaults to the donor name and can be chosen', () => {
  assert.equal(DEFAULT_EXTO_SHEET_NAME, 'Exto SSM');
  const bytes = writeExtoWorkbook(ROWS, { sheetName: 'Dragon EXTO' });
  assert.deepEqual(readWorkbook(bytes).sheetNames, ['Dragon EXTO']);
});

test('a sheet name Excel will not accept is refused with a typed reason', () => {
  const tooLong = 'Dragon site standardized upload template Rev21';
  assert.throws(
    () => writeExtoWorkbook(ROWS, { sheetName: tooLong }),
    (error) =>
      error instanceof SpreadsheetReadError &&
      error.reason.kind === 'invalid-sheet-name' &&
      error.reason.name === tooLong,
  );
});

/* -------------------------------------------------------------------------- */
/* Byte stability (docs/ENGINE.md rule 3)                                      */
/* -------------------------------------------------------------------------- */

test('the same rows always write the same bytes', () => {
  const first = writeExtoWorkbook(ROWS);
  const second = writeExtoWorkbook(ROWS);
  assert.equal(sha256(first), sha256(second));
  assert.equal(first.length, second.length);
});

test('input order does not change the bytes — only the assets do', () => {
  /* The duplicate-tag pair is the one tie whose order is the caller's, so it is
     held fixed here; everything else is shuffled. */
  const [power, spare, secondary, dupA, dupB, chilled, tank] = DRAGON_REGISTER;
  const shuffled = [tank, chilled, secondary, dupA, dupB, spare, power];
  const write = (assets) =>
    sha256(writeExtoWorkbook(buildExtoRows(assets, { itemMasterVocabulary: DRAGON_VF_VOCABULARY })));
  assert.equal(write(shuffled), write(DRAGON_REGISTER));
});

test('a different register writes different bytes', () => {
  /* The negative half of the claim: identical bytes must mean identical data,
     not a writer that ignores its input. */
  const changed = [...DRAGON_REGISTER.slice(1), { ...DRAGON_REGISTER[0], milestoneLabel: 'L2-M2' }];
  assert.notEqual(
    sha256(writeExtoWorkbook(buildExtoRows(changed, { itemMasterVocabulary: DRAGON_VF_VOCABULARY }))),
    sha256(writeExtoWorkbook(ROWS)),
  );
});

test('500 Dragon assets export and read back intact, well inside two seconds', () => {
  const assets = syntheticDragonRegister(500);
  const started = process.hrtime.bigint();
  const rows = buildExtoRows(assets, { itemMasterVocabulary: DRAGON_VF_VOCABULARY });
  const bytes = writeExtoWorkbook(rows);
  const table = readMappedTable(scan(bytes), EXTO_MAPPING, { headerRow: EXTO_HEADER_ROW_INDEX });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

  assert.equal(table.rows.length, 500);
  assert.deepEqual(
    table.rows,
    rows.map(({ itemMasterNormalization: _provenance, ...cells }) => cells),
  );
  /* Ten systems of fifty, UPNs ascending: '001' x50, then '002' x50, ... */
  assert.deepEqual(table.rows.slice(0, 50).map((row) => row.upn), new Array(50).fill('001'));
  assert.equal(table.rows[50].upn, '002');
  assert.equal(table.rows.at(-1).upn, '010');

  assert.equal(
    sha256(bytes),
    sha256(writeExtoWorkbook(buildExtoRows(syntheticDragonRegister(500), { itemMasterVocabulary: DRAGON_VF_VOCABULARY }))),
    'byte stability holds at 500 assets too',
  );
  assert.ok(elapsedMs < 2000, `write + read of 500 assets took ${elapsedMs.toFixed(0)}ms`);
});
