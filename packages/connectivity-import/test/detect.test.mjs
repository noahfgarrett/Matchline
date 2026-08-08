/**
 * Detection: the donor's logic in Matchline's vocabulary.
 *
 * The tests that matter most here are the negative ones. Anything can be made
 * to recognize a well-formed EasyPower sheet; the reason the donor grew a
 * corroboration rule is that a cable schedule's "Cable Tag" and a lone title
 * cell kept getting read as a MEL, and a wrong kind means wrong tags in front
 * of an engineer.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  detectEasyPowerColumns,
  detectMelColumns,
  detectSheetKind,
  detectWorkbook,
  normalizeHeader,
} from '../dist/index.js'

import {
  DRAGON_CABLE_AOA,
  DRAGON_EASYPOWER_AOA,
  DRAGON_MEL_AOA,
  DRAGON_NOTES_AOA,
  DRAGON_PMD_AOA,
  dragonWorkbookBytes,
} from './support.mjs'

/* ---- positives ---- */

test('an EasyPower study is found under its title banner, by headers alone', () => {
  /* The sheet name says nothing a detector knows, so this is a pure header
     match — and both endpoints hit known exact forms, so it stands on its own. */
  const detection = detectSheetKind('EasyPower', DRAGON_EASYPOWER_AOA)
  assert.equal(detection.kind, 'easypower')
  assert.equal(detection.confidence, 'exact-headers')
  assert.equal(detection.headerRow, 1)
  assert.equal(detection.mappedColumns.source, 0)
  assert.equal(detection.mappedColumns.load, 3)
  /* The donor's other EasyPower columns are reported, not required. */
  assert.equal(detection.mappedColumns.downstream1, 1)
  assert.equal(detection.mappedColumns.finalSource, 2)
  assert.equal(detection.mappedColumns.loadDescription, 4)
  assert.equal(detection.mappedColumns.circuit, 5)
})

test('a Cable Schedule is claimed by its sheet name first', () => {
  const detection = detectSheetKind('Cable Schedule', DRAGON_CABLE_AOA)
  assert.equal(detection.kind, 'cable-schedule')
  assert.equal(detection.confidence, 'name')
  assert.equal(detection.headerRow, 0)
  assert.deepEqual(
    { ...detection.mappedColumns },
    { to: 0, from: 1, cableTag: 3, circuitNumber: 2 },
  )
})

test('a PMD is claimed by the donor INSTALL PMD tab name', () => {
  assert.equal(normalizeHeader('INSTALL PMD'), 'installpmd')
  const detection = detectSheetKind('INSTALL PMD', DRAGON_PMD_AOA)
  assert.equal(detection.kind, 'pmd')
  assert.equal(detection.confidence, 'name')
  assert.equal(detection.headerRow, 0)
  assert.equal(detection.mappedColumns.panel, 0)
  assert.equal(detection.mappedColumns.instrument, 1)
  assert.equal(detection.mappedColumns.card, 2)
  assert.equal(detection.mappedColumns.pointType, 3)
  assert.equal(detection.mappedColumns.description, 4)
})

test('a PMD is still found when the tab is named nothing in particular', () => {
  const detection = detectSheetKind('Points', DRAGON_PMD_AOA)
  assert.equal(detection.kind, 'pmd')
  assert.equal(detection.confidence, 'exact-headers')
})

test('a MEL tab is classified as a MEL rather than left to look like connectivity', () => {
  const detection = detectSheetKind('Equipment_List', DRAGON_MEL_AOA)
  assert.equal(detection.kind, 'mel')
  assert.equal(detection.confidence, 'name')
  assert.equal(detection.mappedColumns.equipmentTag, 0)
  assert.equal(detection.mappedColumns.upn, 1)
  assert.equal(detection.mappedColumns.systemParent, 3)
})

/* ---- negatives ---- */

test('a sheet that is none of the families is unknown, not guessed at', () => {
  /* The donor fell back to EasyPower for anything unrecognized. Matchline has
     to be able to say "we did not recognize this", so the fallback is gone. */
  const detection = detectSheetKind('Notes', DRAGON_NOTES_AOA)
  assert.equal(detection.kind, 'unknown')
  assert.equal(detection.confidence, 'none')
  assert.equal(detection.headerRow, -1)
  assert.deepEqual({ ...detection.mappedColumns }, {})
})

test('a cable schedule cannot masquerade as a MEL or a power study', () => {
  /* The donor's guard: 'Cable Tag' does not satisfy MEL_LOOSE_TAG, which is
     anchored to an empty/equipment/equip/asset prefix. */
  const headers = DRAGON_CABLE_AOA[0]
  assert.equal(detectMelColumns(headers), null)
  assert.equal(detectEasyPowerColumns(headers), null)

  const detection = detectSheetKind('Sheet1', DRAGON_CABLE_AOA)
  assert.equal(detection.kind, 'cable-schedule')
  assert.equal(detection.confidence, 'exact-headers')
})

test('a loose equipment-tag header needs two corroborators, one of them UPN or System Parent', () => {
  const corroborated = detectMelColumns(['Tag No.', 'UPN', 'Bldg', 'Discipline'])
  assert.notEqual(corroborated, null)
  assert.equal(corroborated.strength, 'corroborated')
  assert.equal(corroborated.columns.equipmentTag, 0)

  /* Fewer than two corroborating columns. */
  assert.equal(detectMelColumns(['Tag No.', 'Cable Tag', 'Raceway']), null)
  /* Two corroborators, but neither is UPN nor System Parent. */
  assert.equal(detectMelColumns(['Tag No.', 'Bldg', 'Discipline']), null)
})

test('a bare Tag column is not an instrument tag, so panel+tag is not a PMD', () => {
  /* Accepting bare 'tag' for PMD would reopen the door the MEL rule closes. */
  const detection = detectSheetKind('Sheet1', [
    ['Panel', 'Tag'],
    ['PLC001-10-01', 'TIT603-10-01'],
  ])
  assert.equal(detection.kind, 'unknown')
})

test('two loose endpoints need a third column of their own family', () => {
  const bare = detectSheetKind('Sheet1', [['From', 'To'], ['EPB002-01-01', 'MAH001-10-01']])
  assert.equal(bare.kind, 'unknown')

  const corroborated = detectSheetKind('Sheet1', [
    ['From', 'To', 'Cable Tag'],
    ['EPB002-01-01', 'MAH001-10-01', 'DGN-C-0001'],
  ])
  assert.equal(corroborated.kind, 'cable-schedule')
  assert.equal(corroborated.confidence, 'corroborated')

  const loosePower = detectSheetKind('Sheet1', [['Source', 'Load'], ['DGN-GIS-01', 'MAH001-10-01']])
  assert.equal(loosePower.kind, 'unknown')

  const corroboratedPower = detectSheetKind('Sheet1', [
    ['Source', 'Load', 'Downstream1'],
    ['DGN-GIS-01', 'MAH001-10-01', 'EPB002-01-01'],
  ])
  assert.equal(corroboratedPower.kind, 'easypower')
  assert.equal(corroboratedPower.confidence, 'corroborated')
})

test('headers below row 4 are out of the identification pass', () => {
  const buried = [
    ['Dragon Site', ''],
    ['', ''],
    ['', ''],
    ['', ''],
    ['', ''],
    ['PANEL', 'INSTRUMENT TAG'],
    ['PLC001-10-01', 'TIT603-10-01'],
  ]
  assert.equal(detectSheetKind('Points', buried).kind, 'unknown')
})

test('a name-claimed sheet with unreadable headers keeps the kind and reports no layout', () => {
  const detection = detectSheetKind('Cable Schedule', DRAGON_NOTES_AOA)
  assert.equal(detection.kind, 'cable-schedule')
  assert.equal(detection.confidence, 'name')
  assert.equal(detection.headerRow, -1)
  assert.deepEqual({ ...detection.mappedColumns }, {})
})

/* ---- whole workbook ---- */

test('every tab of the Dragon workbook is placed, in workbook order', () => {
  const results = detectWorkbook(dragonWorkbookBytes())
  assert.deepEqual(
    results.map((entry) => [entry.sheet, entry.detection.kind, entry.detection.confidence]),
    [
      ['EasyPower', 'easypower', 'exact-headers'],
      ['Cable Schedule', 'cable-schedule', 'name'],
      ['INSTALL PMD', 'pmd', 'name'],
      ['Equipment_List', 'mel', 'name'],
      ['Notes', 'unknown', 'none'],
    ],
  )
})

test('detection is deterministic across runs', () => {
  const bytes = dragonWorkbookBytes()
  assert.equal(JSON.stringify(detectWorkbook(bytes)), JSON.stringify(detectWorkbook(bytes)))
})
