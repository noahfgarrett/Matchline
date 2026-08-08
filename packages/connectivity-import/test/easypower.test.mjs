/**
 * EasyPower rows → `POWERS` feeds.
 *
 * Counts here are hand-verified against `DRAGON_EASYPOWER_AOA` in support.mjs,
 * which documents which row is which case.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { ConnectivityImportError, importEasyPowerSheet } from '../dist/index.js'

import {
  DRAGON_EASYPOWER_AOA,
  DRAGON_EASYPOWER_HEADER_ROW,
  DRAGON_EASYPOWER_MAPPING,
  literalSource,
} from './support.mjs'

function importDragon(mapping = DRAGON_EASYPOWER_MAPPING) {
  return importEasyPowerSheet(
    DRAGON_EASYPOWER_AOA,
    mapping,
    DRAGON_EASYPOWER_HEADER_ROW,
    literalSource('EasyPower'),
  )
}

test('every data row is either an observation or a reasoned skip', () => {
  const { observations, stats, skipped } = importDragon()
  assert.equal(stats.rowCount, 7)
  assert.equal(stats.observationCount, 4)
  assert.equal(skipped.length, 3)
  assert.equal(stats.rowCount, stats.observationCount + skipped.length)
  assert.deepEqual(stats.skippedCount, { 'missing-from': 1, 'missing-to': 1, 'self-loop': 1 })
  assert.equal(observations.length, 4)
})

test('a feed is a POWERS relationship from the source column to the load column', () => {
  const [first] = importDragon().observations
  assert.deepEqual(first, {
    kind: 'feed',
    fromTag: 'DGN-GIS-01',
    toTag: 'MAH001-10-01',
    sourceKind: 'easypower',
    relationshipType: 'POWERS',
    provenance: {
      sourceFile: 'dragon-connectivity.xlsx',
      sourceRef: { kind: 'sheet-row', sheet: 'EasyPower', row: 3 },
      fromColumn: 0,
      toColumn: 3,
    },
  })
  /* No conductor is named by a power study, so there is no `via` key at all
     rather than an empty one. */
  assert.equal('via' in first, false)
})

test('each skip names the row and the reason, keeping what it read', () => {
  const { skipped } = importDragon()
  assert.deepEqual(skipped, [
    { row: 5, reason: 'missing-from', fromTag: '', toTag: 'TIT603-10-01' },
    { row: 6, reason: 'missing-to', fromTag: 'DGN-GIS-01', toTag: '' },
    { row: 7, reason: 'self-loop', fromTag: 'VFD001-10-01', toTag: 'VFD001-10-01' },
  ])
})

test('a repeated pair is kept — deduplication is a downstream decision', () => {
  const { observations } = importDragon()
  const repeated = observations.filter(
    (observation) => observation.fromTag === 'DGN-GIS-01' && observation.toTag === 'MAH001-10-01',
  )
  assert.equal(repeated.length, 2)
  /* Same fact, different rows: the provenance is what tells them apart. */
  assert.deepEqual(repeated.map((observation) => observation.provenance.sourceRef.row), [3, 8])
})

test('tags are trimmed and otherwise left exactly as the sheet wrote them', () => {
  const last = importDragon().observations.at(-1)
  assert.equal(last.fromTag, 'DGN-GIS-01')
  assert.equal(last.toTag, 'PLC001-10-01')
  assert.equal(last.provenance.sourceRef.row, 9)
})

test('distinct-tag counts are over the kept observations, without case folding', () => {
  const { stats } = importDragon()
  assert.equal(stats.distinctFromTags, 1)
  assert.equal(stats.distinctToTags, 3)

  const cased = importEasyPowerSheet(
    [
      ['Starting Source', 'ID Name'],
      ['DGN-GIS-01', 'MAH001-10-01'],
      ['dgn-gis-01', 'mah001-10-01'],
    ],
    { source: 0, load: 1 },
    0,
    literalSource('EasyPower'),
  )
  /* Two spellings of one tag are two facts until identity resolution says
     otherwise; folding them here would understate the disagreement. */
  assert.equal(cased.stats.distinctFromTags, 2)
  assert.equal(cased.stats.distinctToTags, 2)
})

test('an explicit mapping can read the load off another column', () => {
  /* The Dragon sheet has both 'ID Name' and 'Load Description'. Detection picks
     ID Name; a caller who knows the site writes loads in the description column
     says so, and the blank-ID-Name row stops being a skip. */
  const { observations, stats } = importDragon({ source: 0, load: 4 })
  assert.equal(stats.rowCount, 7)
  assert.equal(stats.observationCount, 6)
  assert.deepEqual(stats.skippedCount, { 'missing-from': 1, 'missing-to': 0, 'self-loop': 0 })
  assert.equal(stats.distinctToTags, 5)
  assert.equal(observations[0].toTag, 'Primary AHU')
})

test('a header row outside the sheet is refused, not read as an empty sheet', () => {
  assert.throws(
    () =>
      importEasyPowerSheet(DRAGON_EASYPOWER_AOA, DRAGON_EASYPOWER_MAPPING, 99, literalSource('EasyPower')),
    (error) =>
      error instanceof ConnectivityImportError &&
      error.reason.kind === 'header-row-out-of-range' &&
      error.reason.headerRow === 99 &&
      error.reason.rowCount === 9,
  )
})

test('a column index past the end of the header row is refused', () => {
  /* Silently reading undefined cells would report "every row is missing a tag",
     which looks like a real answer. */
  assert.throws(
    () =>
      importEasyPowerSheet(
        DRAGON_EASYPOWER_AOA,
        { source: 0, load: 99 },
        DRAGON_EASYPOWER_HEADER_ROW,
        literalSource('EasyPower'),
      ),
    (error) =>
      error instanceof ConnectivityImportError &&
      error.reason.kind === 'mapped-column-out-of-range' &&
      error.reason.role === 'to' &&
      error.reason.columnIndex === 99 &&
      error.reason.headerWidth === 6,
  )
})

test('a header-only sheet reads as zero rows rather than failing', () => {
  const { observations, stats, skipped } = importEasyPowerSheet(
    [['Starting Source', 'ID Name']],
    { source: 0, load: 1 },
    0,
    literalSource('EasyPower'),
  )
  assert.deepEqual(observations, [])
  assert.deepEqual(skipped, [])
  assert.equal(stats.rowCount, 0)
  assert.equal(stats.distinctFromTags, 0)
})

test('a row missing both endpoints reports one reason, not two', () => {
  const { skipped, stats } = importEasyPowerSheet(
    [['Starting Source', 'ID Name'], ['', '']],
    { source: 0, load: 1 },
    0,
    literalSource('EasyPower'),
  )
  assert.deepEqual(skipped, [{ row: 2, reason: 'missing-from', fromTag: '', toTag: '' }])
  assert.equal(stats.rowCount, stats.observationCount + skipped.length)
})

test('the same input yields byte-identical output every time', () => {
  assert.equal(JSON.stringify(importDragon()), JSON.stringify(importDragon()))
})
