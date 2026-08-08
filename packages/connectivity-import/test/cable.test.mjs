/**
 * Cable Schedule rows → `WIRED_TO` feeds, with the cable tag as `via`.
 *
 * Counts are hand-verified against `DRAGON_CABLE_AOA` in support.mjs.
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { importCableSheet } from '../dist/index.js'

import {
  DRAGON_CABLE_AOA,
  DRAGON_CABLE_HEADER_ROW,
  DRAGON_CABLE_MAPPING,
  literalSource,
} from './support.mjs'

function importDragon(mapping = DRAGON_CABLE_MAPPING) {
  return importCableSheet(
    DRAGON_CABLE_AOA,
    mapping,
    DRAGON_CABLE_HEADER_ROW,
    literalSource('Cable Schedule'),
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

test('the panel is the upstream end even though the sheet prints the load first', () => {
  const [first] = importDragon().observations
  assert.deepEqual(first, {
    kind: 'feed',
    fromTag: 'EPB002-01-01',
    toTag: 'MAH001-10-01',
    via: 'DGN-C-0001',
    sourceKind: 'cable-schedule',
    relationshipType: 'WIRED_TO',
    provenance: {
      sourceFile: 'dragon-connectivity.xlsx',
      sourceRef: { kind: 'sheet-row', sheet: 'Cable Schedule', row: 2 },
      fromColumn: 1,
      toColumn: 0,
      viaColumn: 3,
    },
  })
})

test('a parallel run is two cables, not one duplicate', () => {
  const { observations } = importDragon()
  const parallel = observations.filter((observation) => observation.toTag === 'MAH001-10-01')
  assert.equal(parallel.length, 2)
  assert.deepEqual(parallel.map((observation) => observation.via), ['DGN-C-0001', 'DGN-C-0002'])
  assert.deepEqual(parallel.map((observation) => observation.provenance.sourceRef.row), [2, 3])
})

test('a blank cable tag leaves the relationship real and the conductor unnamed', () => {
  const last = importDragon().observations.at(-1)
  assert.equal(last.toTag, 'VFD001-10-01')
  assert.equal('via' in last, false)
  assert.equal('viaColumn' in last.provenance, false)
})

test('a mapping with no cable-tag column still reads the relationships', () => {
  const { observations, stats } = importDragon({ from: 1, to: 0 })
  assert.equal(stats.observationCount, 3)
  assert.ok(observations.every((observation) => !('via' in observation)))
})

test('each skip names the row and the reason', () => {
  assert.deepEqual(importDragon().skipped, [
    { row: 4, reason: 'missing-to', fromTag: 'EPB002-01-01', toTag: '' },
    { row: 5, reason: 'missing-from', fromTag: '', toTag: 'TIT603-10-01' },
    { row: 6, reason: 'self-loop', fromTag: 'EPB002-01-01', toTag: 'EPB002-01-01' },
  ])
})

test('the same input yields byte-identical output every time', () => {
  assert.equal(JSON.stringify(importDragon()), JSON.stringify(importDragon()))
})
