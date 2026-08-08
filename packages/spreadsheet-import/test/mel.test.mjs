/**
 * `readMelTable` — bytes in, MEL records plus a stats object out.
 *
 * The stats exist so the import wizard can say "1,204 rows, 3 with no tag"
 * before anyone commits to the file. A tagless row is kept, not dropped: it is
 * evidence about the MEL, and the reader's job is a faithful read.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { MEL_FIELDS, SpreadsheetReadError, readMelTable, writeWorkbook } from '../dist/index.js'
import { DRAGON_MEL_HEADER_ROW, DRAGON_MEL_MAPPING, dragonMelBytes } from './support.mjs'

test('a MEL sheet reads as records with per-read stats', () => {
  const table = readMelTable(
    dragonMelBytes(),
    'MEL',
    DRAGON_MEL_MAPPING,
    DRAGON_MEL_HEADER_ROW,
  )

  assert.deepEqual(table.rows, [
    {
      equipmentTag: 'MAH001-10-01',
      upn: '001',
      systemDescription: 'Dragon Air Handling',
      building: 'D-100',
      discipline: 'MECH',
      description: 'Primary AHU',
    },
    {
      equipmentTag: 'MAH001-10-02',
      upn: '001',
      systemDescription: 'Dragon Air Handling',
      building: 'D-100',
      discipline: 'MECH',
      description: 'Secondary AHU',
    },
    {
      equipmentTag: 'EPB002-01-01',
      upn: '002',
      systemDescription: 'Dragon Power Distribution',
      building: 'D-200',
      discipline: 'ELEC',
      description: 'Panelboard',
    },
    {
      equipmentTag: '',
      upn: '002',
      systemDescription: 'Dragon Power Distribution',
      building: 'D-200',
      discipline: 'ELEC',
      description: 'Tagless spare',
    },
  ])

  /* Five data rows below the header, one of them entirely blank and dropped,
     one of the four survivors carrying no equipment tag. */
  assert.deepEqual(table.stats, { rowCount: 5, blankTagCount: 1, blankRowCount: 1 })
})

test("UPN '001' is read as text, not renumbered to 1", () => {
  const table = readMelTable(dragonMelBytes(), 'MEL', DRAGON_MEL_MAPPING, DRAGON_MEL_HEADER_ROW)
  assert.equal(table.rows[0].upn, '001')
})

test('only the mapped fields appear on a row', () => {
  const table = readMelTable(
    dragonMelBytes(),
    'MEL',
    { equipmentTag: 'Equipment Tag', upn: 'UPN' },
    DRAGON_MEL_HEADER_ROW,
  )
  assert.deepEqual(Object.keys(table.rows[0]), ['equipmentTag', 'upn'])
  assert.deepEqual(
    table.columns.map((column) => column.field),
    ['equipmentTag', 'upn'],
  )
})

test('naming a sheet the workbook does not have lists the sheets it does', () => {
  assert.throws(
    () =>
      readMelTable(
        dragonMelBytes('Equipment'),
        'MEL',
        DRAGON_MEL_MAPPING,
        DRAGON_MEL_HEADER_ROW,
      ),
    (error) => {
      assert.ok(error instanceof SpreadsheetReadError)
      assert.equal(error.reason.kind, 'sheet-not-found')
      assert.deepEqual(error.reason.availableSheets, ['Equipment'])
      return true
    },
  )
})

test('a mapped MEL header missing from the sheet is refused, not silently skipped', () => {
  assert.throws(
    () =>
      readMelTable(
        dragonMelBytes(),
        'MEL',
        { equipmentTag: 'Equipment Tag', projectPhase: 'Project Phase' },
        DRAGON_MEL_HEADER_ROW,
      ),
    (error) =>
      error.reason.kind === 'missing-columns' &&
      error.reason.missing[0].field === 'projectPhase',
  )
})

test('a mapping key that is not a MEL field is refused, not read as a column', () => {
  /* TypeScript performs no excess-property check against a generic constraint,
     so this has to be caught at run time or the key would become a real column
     under a name the row type does not admit. */
  assert.throws(
    () =>
      readMelTable(
        dragonMelBytes(),
        'MEL',
        { equipmentTag: 'Equipment Tag', vendor: 'UPN' },
        DRAGON_MEL_HEADER_ROW,
      ),
    (error) => {
      assert.ok(error instanceof SpreadsheetReadError)
      assert.equal(error.reason.kind, 'unknown-mel-fields')
      assert.deepEqual(error.reason.fields, ['vendor'])
      assert.deepEqual(error.reason.knownFields, [...MEL_FIELDS])
      return true
    },
  )
})

test('pointing at the wrong header row is refused rather than read as data', () => {
  assert.throws(
    () => readMelTable(dragonMelBytes(), 'MEL', DRAGON_MEL_MAPPING, 0),
    (error) => error.reason.kind === 'missing-columns',
  )
})

test('every MEL field can be mapped and read', () => {
  const headers = {
    equipmentTag: 'Equipment Tag',
    upn: 'UPN',
    systemDescription: 'System Description',
    systemParent: 'System Parent',
    building: 'Building',
    discipline: 'Discipline',
    description: 'Description',
    projectPhase: 'Project Phase',
  }
  assert.deepEqual(Object.keys(headers), [...MEL_FIELDS])

  const headerRow = MEL_FIELDS.map((field) => headers[field])
  const dataRow = MEL_FIELDS.map((field) => `${field}-value`)
  const bytes = writeWorkbook([{ name: 'MEL', aoa: [headerRow, dataRow] }])

  const table = readMelTable(bytes, 'MEL', headers, 0)
  assert.deepEqual(
    table.rows[0],
    Object.fromEntries(MEL_FIELDS.map((field) => [field, `${field}-value`])),
  )
  assert.deepEqual(table.stats, { rowCount: 1, blankTagCount: 0, blankRowCount: 0 })
})

test('reading the same bytes twice gives identical results', () => {
  const bytes = dragonMelBytes()
  const first = readMelTable(bytes, 'MEL', DRAGON_MEL_MAPPING, DRAGON_MEL_HEADER_ROW)
  const second = readMelTable(bytes, 'MEL', DRAGON_MEL_MAPPING, DRAGON_MEL_HEADER_ROW)
  assert.equal(JSON.stringify(first), JSON.stringify(second))
})
