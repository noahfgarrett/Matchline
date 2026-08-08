/**
 * `readMappedTable` — records under an explicit caller-supplied mapping.
 *
 * The behaviors under test are the ones that decide whether an engineer sees
 * the right tag: which column a header binds to, whether a value is read back
 * unchanged, and what happens when the mapping does not fit the sheet.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { SpreadsheetReadError, readMappedTable } from '../dist/index.js'

const AOA = [
  ['Dragon Site — Master Equipment List', '', '', ''],
  ['Equipment Tag', 'UPN', '  system description ', 'Description'],
  ['MAH001-10-01', '001', 'Dragon Air Handling', 'Primary AHU'],
  ['  MAH001-10-02  ', '0007', 'Dragon Air Handling', ''],
  ['', '', '', ''],
  ['EPB002-01-01', '2', 'Dragon Power Distribution', 'Panelboard'],
]

const MAPPING = {
  equipmentTag: 'Equipment Tag',
  upn: 'UPN',
  systemDescription: 'System Description',
}

test('mapped fields read as records in mapping order, blank rows dropped', () => {
  const table = readMappedTable(AOA, MAPPING, { headerRow: 1 })
  assert.deepEqual(table.rows, [
    { equipmentTag: 'MAH001-10-01', upn: '001', systemDescription: 'Dragon Air Handling' },
    { equipmentTag: 'MAH001-10-02', upn: '0007', systemDescription: 'Dragon Air Handling' },
    { equipmentTag: 'EPB002-01-01', upn: '2', systemDescription: 'Dragon Power Distribution' },
  ])
  assert.equal(table.headerRow, 1)
  assert.equal(table.scannedRowCount, 4)
  assert.equal(table.blankRowCount, 1)
})

test('leading zeros in a text column survive; a numeric-looking one is not renumbered', () => {
  const { rows } = readMappedTable(AOA, MAPPING, { headerRow: 1 })
  assert.equal(rows[0].upn, '001', "'001' must never become '1'")
  assert.equal(rows[1].upn, '0007')
  assert.equal(rows[2].upn, '2')
})

test('surrounding whitespace is trimmed off values', () => {
  const { rows } = readMappedTable(AOA, MAPPING, { headerRow: 1 })
  assert.equal(rows[1].equipmentTag, 'MAH001-10-02')
})

test('each column reports whether it matched exactly or loosely', () => {
  const { columns } = readMappedTable(AOA, MAPPING, { headerRow: 1 })
  assert.deepEqual(columns, [
    {
      field: 'equipmentTag',
      header: 'Equipment Tag',
      matchedHeader: 'Equipment Tag',
      columnIndex: 0,
      match: 'exact',
    },
    { field: 'upn', header: 'UPN', matchedHeader: 'UPN', columnIndex: 1, match: 'exact' },
    {
      field: 'systemDescription',
      header: 'System Description',
      /* The sheet's header is padded and lowercased; the trimmed, case-folded
         pass matched it, and says so rather than claiming an exact match.
         Inner whitespace is NOT collapsed — 'System  Description' with a
         doubled space would be a genuine miss, and would be reported. */
      matchedHeader: '  system description ',
      columnIndex: 2,
      match: 'trimmed-case-insensitive',
    },
  ])
})

test('an exact match anywhere on the row beats a loose match to its left', () => {
  const aoa = [['equipment tag', 'Equipment Tag'], ['loose', 'exact']]
  const { columns, rows } = readMappedTable(aoa, { equipmentTag: 'Equipment Tag' }, { headerRow: 0 })
  assert.equal(columns[0].columnIndex, 1)
  assert.equal(columns[0].match, 'exact')
  assert.equal(rows[0].equipmentTag, 'exact')
})

test('a repeated header binds to the leftmost column, deterministically', () => {
  const aoa = [['UPN', 'UPN'], ['left', 'right']]
  for (let attempt = 0; attempt < 3; attempt++) {
    const { columns, rows } = readMappedTable(aoa, { upn: 'UPN' }, { headerRow: 0 })
    assert.equal(columns[0].columnIndex, 0)
    assert.equal(rows[0].upn, 'left')
  }
})

test('a mapped header that is not on the header row is an error listing the headers', () => {
  assert.throws(
    () => readMappedTable(AOA, { ...MAPPING, projectPhase: 'Phase' }, { headerRow: 1 }),
    (error) => {
      assert.ok(error instanceof SpreadsheetReadError)
      assert.equal(error.reason.kind, 'missing-columns')
      assert.deepEqual(error.reason.missing, [{ field: 'projectPhase', header: 'Phase' }])
      assert.deepEqual(error.reason.availableHeaders, [
        'Equipment Tag',
        'UPN',
        'system description',
        'Description',
      ])
      assert.match(error.message, /projectPhase → 'Phase'/)
      return true
    },
  )
})

test('every missing column is reported at once, not one per attempt', () => {
  assert.throws(
    () => readMappedTable(AOA, { building: 'Building', discipline: 'Discipline' }, { headerRow: 1 }),
    (error) =>
      error.reason.kind === 'missing-columns' &&
      error.reason.missing.length === 2 &&
      error.reason.missing[0].field === 'building' &&
      error.reason.missing[1].field === 'discipline',
  )
})

test('a header row outside the sheet is an error, not an empty table', () => {
  assert.throws(
    () => readMappedTable(AOA, MAPPING, { headerRow: 99 }),
    (error) =>
      error instanceof SpreadsheetReadError &&
      error.reason.kind === 'header-row-out-of-range' &&
      error.reason.rowCount === AOA.length,
  )
  assert.throws(
    () => readMappedTable(AOA, MAPPING, { headerRow: -1 }),
    (error) => error.reason.kind === 'header-row-out-of-range',
  )
  assert.throws(
    () => readMappedTable([], MAPPING, { headerRow: 0 }),
    (error) => error.reason.kind === 'header-row-out-of-range',
  )
})

test('a mapping naming no fields is an error', () => {
  assert.throws(
    () => readMappedTable(AOA, {}, { headerRow: 1 }),
    (error) => error instanceof SpreadsheetReadError && error.reason.kind === 'empty-mapping',
  )
})

test('a header row with no data rows below it yields no rows, not an error', () => {
  const table = readMappedTable([['UPN']], { upn: 'UPN' }, { headerRow: 0 })
  assert.deepEqual(table.rows, [])
  assert.equal(table.scannedRowCount, 0)
  assert.equal(table.blankRowCount, 0)
})

test('a row that is blank only in the mapped columns is dropped', () => {
  const aoa = [
    ['UPN', 'Unmapped'],
    ['', 'still here'],
    ['001', ''],
  ]
  const table = readMappedTable(aoa, { upn: 'UPN' }, { headerRow: 0 })
  assert.deepEqual(table.rows, [{ upn: '001' }])
  assert.equal(table.blankRowCount, 1)
})

test('a short row reads as empty in the columns it does not reach', () => {
  const aoa = [['Equipment Tag', 'UPN'], ['MAH001-10-01']]
  const mapping = { equipmentTag: 'Equipment Tag', upn: 'UPN' }
  const table = readMappedTable(aoa, mapping, { headerRow: 0 })
  assert.deepEqual(table.rows, [{ equipmentTag: 'MAH001-10-01', upn: '' }])
})
