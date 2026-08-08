/**
 * Write → read → scan. The write path exists so later packages (mel-export)
 * can emit .xlsx, and so tests can build workbooks without checked-in binaries;
 * both uses depend on a value surviving the trip unchanged.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { SpreadsheetReadError, readWorkbook, sheetAoa, writeWorkbook } from '../dist/index.js'

const ROUND_TRIP_AOA = [
  ['Equipment Tag', 'UPN', 'Count', 'Note'],
  ['MAH001-10-01', '001', 12, 'primary'],
  ['MAH001-10-02', '0007', 0, ''],
  ['EPB002-01-01', '2', -3.5, 'spare'],
]

test('an AoA survives write → read → scan as its display text', () => {
  const bytes = writeWorkbook([{ name: 'Dragon', aoa: ROUND_TRIP_AOA }])
  assert.ok(bytes instanceof Uint8Array, 'writeWorkbook must return bytes we own')

  const workbook = readWorkbook(bytes)
  assert.deepEqual(workbook.sheetNames, ['Dragon'])

  const { aoa, rowNums } = sheetAoa(workbook.getSheet('Dragon'))
  assert.deepEqual(rowNums, [0, 1, 2, 3])
  assert.deepEqual(aoa, ROUND_TRIP_AOA.map((row) => row.map((cell) => String(cell))))
})

test('text cells keep their leading zeros; numeric cells never gain any', () => {
  const bytes = writeWorkbook([
    { name: 'Dragon', aoa: [['Text', 'Number'], ['001', 1], ['0007', 7]] },
  ])
  const { aoa } = sheetAoa(readWorkbook(bytes).getSheet('Dragon'))
  assert.deepEqual(aoa, [
    ['Text', 'Number'],
    ['001', '1'],
    ['0007', '7'],
  ])
})

test('every sheet in a multi-sheet workbook round-trips independently', () => {
  const bytes = writeWorkbook([
    { name: 'MEL', aoa: [['Equipment Tag'], ['MAH001-10-01']] },
    { name: 'Legend', aoa: [['Code', 'Meaning'], ['MAH', 'Air Handler']] },
  ])
  const workbook = readWorkbook(bytes)
  assert.deepEqual(workbook.sheetNames, ['MEL', 'Legend'])
  assert.deepEqual(sheetAoa(workbook.getSheet('MEL')).aoa, [['Equipment Tag'], ['MAH001-10-01']])
  assert.deepEqual(sheetAoa(workbook.getSheet('Legend')).aoa, [
    ['Code', 'Meaning'],
    ['MAH', 'Air Handler'],
  ])
  assert.equal(workbook.getSheet('Absent'), undefined)
})

test('the same AoA always writes the same bytes for the same input', () => {
  const first = writeWorkbook([{ name: 'Dragon', aoa: ROUND_TRIP_AOA }])
  const second = writeWorkbook([{ name: 'Dragon', aoa: ROUND_TRIP_AOA }])
  const firstScan = sheetAoa(readWorkbook(first).getSheet('Dragon'))
  const secondScan = sheetAoa(readWorkbook(second).getSheet('Dragon'))
  assert.equal(JSON.stringify(firstScan), JSON.stringify(secondScan))
})

test('writing no sheets is refused rather than producing an unopenable file', () => {
  assert.throws(
    () => writeWorkbook([]),
    (error) => error instanceof SpreadsheetReadError && error.reason.kind === 'no-sheets-to-write',
  )
})

test('a sheet name Excel will not accept is refused with a typed reason', () => {
  const tooLong = 'Dragon site master equipment list export'
  assert.throws(
    () => writeWorkbook([{ name: tooLong, aoa: [['x']] }]),
    (error) =>
      error instanceof SpreadsheetReadError &&
      error.reason.kind === 'invalid-sheet-name' &&
      error.reason.name === tooLong,
  )
  assert.throws(
    () => writeWorkbook([{ name: 'MEL', aoa: [['x']] }, { name: 'MEL', aoa: [['y']] }]),
    (error) => error.reason.kind === 'invalid-sheet-name',
  )
})

test('a corrupt workbook is refused with a typed reason', () => {
  /* Claims to be a zip (the .xlsx container) and then is not. */
  const truncatedZip = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0, 9, 9, 9, 9])
  assert.throws(
    () => readWorkbook(truncatedZip),
    (error) => error instanceof SpreadsheetReadError && error.reason.kind === 'not-a-workbook',
  )
})

test('unrecognized bytes parse as a one-cell text sheet rather than throwing', () => {
  /* Documented, not endorsed: SheetJS sniffs formats and falls back to plain
     text, so arbitrary bytes yield a workbook instead of an error. Callers who
     need "is this really a MEL?" must ask by name — readMelTable throws
     sheet-not-found — because this layer will not tell them. The donor behaves
     the same way; asserting it here means a vendor bump cannot change it
     silently. */
  const junk = [1, 2, 3, 4, 5]
  const workbook = readWorkbook(Uint8Array.from(junk))
  assert.deepEqual(workbook.sheetNames, ['Sheet1'])
  assert.deepEqual(sheetAoa(workbook.getSheet('Sheet1')).aoa, [
    [String.fromCharCode(...junk)],
  ])
})
