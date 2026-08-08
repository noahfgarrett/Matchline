/**
 * PMD rows → `CONTROLS` relations from panel to instrument.
 *
 * Counts are hand-verified against `DRAGON_PMD_AOA` in support.mjs.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { importPmdSheet } from '../dist/index.js'
import { relationshipKindOf } from '../../domain/dist/index.js'
import { readWorkbook, sheetAoa } from '../../spreadsheet-import/dist/index.js'

import {
  DRAGON_PMD_AOA,
  DRAGON_PMD_HEADER_ROW,
  DRAGON_PMD_MAPPING,
  dragonGapWorkbookBytes,
  literalSource,
} from './support.mjs'

function importDragon() {
  return importPmdSheet(
    DRAGON_PMD_AOA,
    DRAGON_PMD_MAPPING,
    DRAGON_PMD_HEADER_ROW,
    literalSource('INSTALL PMD'),
  )
}

test('every data row is either an observation or a reasoned skip', () => {
  const { stats, skipped } = importDragon()
  assert.equal(stats.rowCount, 6)
  assert.equal(stats.observationCount, 3)
  assert.equal(skipped.length, 3)
  assert.equal(stats.rowCount, stats.observationCount + skipped.length)
  assert.deepEqual(stats.skippedCount, { 'missing-from': 1, 'missing-to': 1, 'self-loop': 1 })
  assert.equal(stats.distinctFromTags, 1)
  assert.equal(stats.distinctToTags, 2)
})

test('a PMD row is a control relation, which never nests the instrument', () => {
  const [first] = importDragon().observations
  assert.deepEqual(first, {
    kind: 'pmd-relation',
    fromTag: 'PLC001-10-01',
    toTag: 'TIT603-10-01',
    sourceKind: 'pmd',
    relationshipType: 'CONTROLS',
    provenance: {
      sourceFile: 'dragon-connectivity.xlsx',
      sourceRef: { kind: 'sheet-row', sheet: 'INSTALL PMD', row: 2 },
      fromColumn: 0,
      toColumn: 1,
    },
  })
  /* A panel does not energize its instruments, so this must stay a dependency
     no matter what the hierarchy composer is asked to do with it. */
  assert.equal(relationshipKindOf(first.relationshipType), 'dependency')
})

test('the same panel and instrument on two cards is two points, both kept', () => {
  const { observations } = importDragon()
  const repeated = observations.filter((observation) => observation.toTag === 'TIT603-10-01')
  assert.equal(repeated.length, 2)
  assert.deepEqual(repeated.map((observation) => observation.provenance.sourceRef.row), [2, 7])
})

test('each skip names the row and the reason', () => {
  assert.deepEqual(importDragon().skipped, [
    { row: 4, reason: 'missing-to', fromTag: 'PLC001-10-01', toTag: '' },
    { row: 5, reason: 'missing-from', fromTag: '', toTag: 'TIT603-10-03' },
    { row: 6, reason: 'self-loop', fromTag: 'PLC001-10-01', toTag: 'PLC001-10-01' },
  ])
})

test('provenance addresses the worksheet row, not the position in the scan', () => {
  /* `sheetAoa` drops worksheet rows that held no cells at all, so AoA index 2
     is worksheet row 3. Without `rowNums` an engineer sent to "row 3" would
     land on a blank line. */
  const workbook = readWorkbook(dragonGapWorkbookBytes())
  const scan = sheetAoa(workbook.getSheet('Points'))
  assert.deepEqual(scan.aoa, [
    ['PANEL', 'INSTRUMENT TAG'],
    ['PLC001-10-01', 'TIT603-10-01'],
    ['PLC001-10-01', 'TIT603-10-02'],
  ])
  assert.deepEqual(scan.rowNums, [0, 1, 3])

  const addressed = importPmdSheet(scan.aoa, DRAGON_PMD_MAPPING, 0, {
    sourceFile: 'dragon-points.xlsx',
    sheet: 'Points',
    rowNums: scan.rowNums,
  })
  assert.deepEqual(addressed.observations.map((observation) => observation.provenance.sourceRef.row), [2, 4])

  const unaddressed = importPmdSheet(scan.aoa, DRAGON_PMD_MAPPING, 0, {
    sourceFile: 'dragon-points.xlsx',
    sheet: 'Points',
  })
  assert.deepEqual(unaddressed.observations.map((observation) => observation.provenance.sourceRef.row), [2, 3])
})

test('the same input yields byte-identical output every time', () => {
  assert.equal(JSON.stringify(importDragon()), JSON.stringify(importDragon()))
})
