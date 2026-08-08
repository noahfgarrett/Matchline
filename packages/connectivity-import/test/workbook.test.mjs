/**
 * The Screen 1 flow: drop a workbook, be told what each tab is and what was
 * read out of it.
 *
 * The load-bearing behavior is what happens to the tabs that are *not* clean
 * connectivity — the MEL, the notes tab, and the tab whose name promises a
 * cable schedule it cannot deliver. None of them may be guessed at.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { ConnectivityImportError, importConnectivityWorkbook } from '../dist/index.js'

import { dragonWorkbookBytes, sheetBytes } from './support.mjs'

const SOURCE_FILE = 'dragon-connectivity.xlsx'

function importDragon(overrides) {
  return importConnectivityWorkbook(dragonWorkbookBytes(), SOURCE_FILE, overrides)
}

test('each tab is reported with what happened to it', () => {
  const report = importDragon()
  assert.equal(report.sourceFile, SOURCE_FILE)
  assert.deepEqual(
    report.sheets.map((sheet) => [sheet.sheet, sheet.status, sheet.reason ?? null]),
    [
      ['EasyPower', 'imported', null],
      ['Cable Schedule', 'imported', null],
      ['INSTALL PMD', 'imported', null],
      /* A MEL is recognized, and deliberately not read for connectivity. */
      ['Equipment_List', 'not-imported', 'not-connectivity'],
      ['Notes', 'not-imported', 'unknown-kind'],
    ],
  )
  assert.deepEqual(report.unknownSheets, ['Notes'])
  assert.ok(report.sheets.every((sheet) => sheet.overridden === false))
})

test('observations from every imported tab arrive in sheet order, then row order', () => {
  const report = importDragon()
  /* 4 EasyPower + 3 Cable + 3 PMD, each hand-counted in its own suite. */
  assert.equal(report.observations.length, 10)
  assert.deepEqual(
    report.observations.map((observation) => observation.sourceKind),
    [
      'easypower', 'easypower', 'easypower', 'easypower',
      'cable-schedule', 'cable-schedule', 'cable-schedule',
      'pmd', 'pmd', 'pmd',
    ],
  )
  const imported = report.sheets.filter((sheet) => sheet.status === 'imported')
  assert.equal(
    imported.reduce((total, sheet) => total + sheet.result.stats.observationCount, 0),
    report.observations.length,
  )
})

test('provenance names the file the caller supplied and the tab it was read from', () => {
  const report = importDragon()
  const sheets = new Set(report.observations.map((observation) => observation.provenance.sourceRef.sheet))
  assert.deepEqual([...sheets], ['EasyPower', 'Cable Schedule', 'INSTALL PMD'])
  assert.ok(
    report.observations.every((observation) => observation.provenance.sourceFile === SOURCE_FILE),
  )
  /* Provenance is the domain's own `sheet-row` SourceRef plus the columns; the
     assignability guard in src/types.ts pins that at compile time, this pins
     the shape that actually reaches a consumer. */
  assert.ok(
    report.observations.every((observation) => observation.provenance.sourceRef.kind === 'sheet-row'),
  )
})

test('what was applied is reported next to what was detected', () => {
  const [easyPower] = importDragon().sheets
  assert.equal(easyPower.detection.kind, 'easypower')
  assert.equal(easyPower.applied.kind, 'easypower')
  assert.equal(easyPower.applied.headerRow, easyPower.detection.headerRow)
  assert.equal(easyPower.applied.mappedColumns.load, 3)
})

test('an override replaces detection for one tab and leaves the rest alone', () => {
  const report = importDragon({
    EasyPower: { kind: 'easypower', headerRow: 1, mappedColumns: { source: 0, load: 4 } },
  })
  const [easyPower] = report.sheets
  assert.equal(easyPower.overridden, true)
  /* Detection still reports what it would have concluded, so the UI can show
     the user what they overrode. */
  assert.equal(easyPower.detection.mappedColumns.load, 3)
  assert.equal(easyPower.applied.mappedColumns.load, 4)
  assert.equal(easyPower.result.stats.observationCount, 6)
  assert.equal(report.observations.length, 12)
  assert.ok(report.sheets.slice(1).every((sheet) => sheet.overridden === false))
})

test('a tab whose name promises a kind its headers cannot deliver is listed, not guessed', () => {
  const aoa = [
    ['Dragon Site — Cable Register', ''],
    ['Feeder', 'Served'],
    ['EPB002-01-01', 'MAH001-10-01'],
    ['EPB002-01-01', 'VFD001-10-01'],
  ]
  const bytes = sheetBytes('Cable Schedule', aoa)

  const detected = importConnectivityWorkbook(bytes, 'dragon-cables.xlsx')
  const [sheet] = detected.sheets
  assert.equal(sheet.status, 'not-imported')
  assert.equal(sheet.reason, 'no-header-row')
  assert.equal(sheet.detection.kind, 'cable-schedule')
  assert.equal(sheet.detection.confidence, 'name')
  assert.equal(sheet.detection.headerRow, -1)
  assert.deepEqual(detected.observations, [])
  /* Not unknown — the name was recognized; only the layout was not. */
  assert.deepEqual(detected.unknownSheets, [])

  const mapped = importConnectivityWorkbook(bytes, 'dragon-cables.xlsx', {
    'Cable Schedule': { kind: 'cable-schedule', headerRow: 1, mappedColumns: { from: 0, to: 1 } },
  })
  assert.equal(mapped.sheets[0].status, 'imported')
  assert.equal(mapped.observations.length, 2)
  assert.deepEqual(mapped.observations[0], {
    kind: 'feed',
    fromTag: 'EPB002-01-01',
    toTag: 'MAH001-10-01',
    sourceKind: 'cable-schedule',
    relationshipType: 'WIRED_TO',
    provenance: {
      sourceFile: 'dragon-cables.xlsx',
      sourceRef: { kind: 'sheet-row', sheet: 'Cable Schedule', row: 3 },
      fromColumn: 0,
      toColumn: 1,
    },
  })
})

test('an override that names a kind without its required columns is refused', () => {
  assert.throws(
    () =>
      importDragon({
        'INSTALL PMD': { kind: 'pmd', headerRow: 0, mappedColumns: { panel: 0 } },
      }),
    (error) =>
      error instanceof ConnectivityImportError &&
      error.reason.kind === 'missing-mapped-column' &&
      error.reason.sheet === 'INSTALL PMD' &&
      error.reason.sheetKind === 'pmd' &&
      error.reason.role === 'instrument',
  )
})

test('the whole workbook flow is deterministic', () => {
  const bytes = dragonWorkbookBytes()
  const first = importConnectivityWorkbook(bytes, SOURCE_FILE)
  const second = importConnectivityWorkbook(bytes, SOURCE_FILE)
  assert.equal(JSON.stringify(first), JSON.stringify(second))
})
