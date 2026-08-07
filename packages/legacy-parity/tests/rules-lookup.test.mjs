import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMemoryLookup } from '../src/rules/lookup.js'

const ROWS = [
  { tag: 'B14-XFM-1234', columns: { UPN: 'UPN-1', Building: 'B14' }, attributes: { equipmentType: 'XFM', matchKey: '1234' } },
  { tag: 'B14-XFM-5678', columns: { UPN: 'UPN-2', Building: 'B14' }, attributes: { equipmentType: 'XFM', matchKey: '5678' } },
  { tag: 'B14-SCR-2201', columns: { UPN: 'UPN-3', Building: 'B14' }, attributes: {} },
  { tag: 'B99-XFM-5678', columns: { UPN: 'UPN-4', Building: 'B99' }, attributes: { equipmentType: 'XFM', matchKey: '5678' } },
]

test('exact match is case- and separator-insensitive on the tag', () => {
  const lookup = createMemoryLookup(ROWS)
  assert.equal(lookup.find('B14-XFM-1234', 'exact').tag, 'B14-XFM-1234')
  assert.equal(lookup.find('b14_xfm_1234', 'exact').tag, 'B14-XFM-1234')
  assert.equal(lookup.find('NOPE', 'exact'), null)
})

test('containing match prefers an exact or suffix hit over a substring hit', () => {
  const lookup = createMemoryLookup(ROWS)
  assert.equal(lookup.find('SCR-2201', 'containing').tag, 'B14-SCR-2201')
  assert.equal(lookup.find('B14-SCR-2201', 'containing').tag, 'B14-SCR-2201')
  assert.equal(lookup.find('ZZZZ', 'containing'), null)
})

test('findAll by attribute returns every record sharing the value', () => {
  const lookup = createMemoryLookup(ROWS)
  const hits = lookup.findAll({ equipmentType: 'XFM', matchKey: '5678' })
  assert.deepEqual(hits.map(r => r.tag).sort(), ['B14-XFM-5678', 'B99-XFM-5678'])
  assert.deepEqual(lookup.findAll({ equipmentType: 'XFM', matchKey: '0000' }), [])
})

test('an empty value never matches', () => {
  const lookup = createMemoryLookup(ROWS)
  assert.equal(lookup.find('', 'exact'), null)
  assert.equal(lookup.find('   ', 'containing'), null)
})

test('an empty source is safe', () => {
  const lookup = createMemoryLookup([])
  assert.equal(lookup.find('B14-XFM-1234', 'exact'), null)
  assert.deepEqual(lookup.findAll({ equipmentType: 'XFM' }), [])
})
