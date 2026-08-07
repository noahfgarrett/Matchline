import assert from 'node:assert/strict'
import { test } from 'node:test'
import { segmentTag, selectAnatomy, canonicalFromAnatomy } from '../src/rules/anatomy.js'

const ANATOMY = {
  id: 'a1', name: 'Standard', delimiter: '-', pattern: '^B\\d+-',
  segments: [
    { name: 'building', index: 0, identity: true },
    { name: 'type', index: 1, identity: true },
    { name: 'unit', index: 2, identity: true },
    { name: 'side', index: 3, identity: false },
  ],
}

test('segmentTag maps delimited parts onto named segments', () => {
  assert.deepEqual(segmentTag('B14-LVS-1234-A', ANATOMY),
    { building: 'B14', type: 'LVS', unit: '1234', side: 'A' })
})

test('segments beyond the tag length are absent rather than empty', () => {
  assert.deepEqual(segmentTag('B14-LVS-1234', ANATOMY),
    { building: 'B14', type: 'LVS', unit: '1234' })
})

test('selectAnatomy picks the first whose pattern matches the raw tag', () => {
  const other = { id: 'a2', name: 'Other', delimiter: '-', pattern: '^X', segments: [] }
  assert.equal(selectAnatomy('B14-LVS-1234', [ANATOMY, other]).id, 'a1')
  assert.equal(selectAnatomy('X9-1', [ANATOMY, other]).id, 'a2')
  assert.equal(selectAnatomy('ZZ-1', [ANATOMY, other]), null)
})

test('a malformed pattern is skipped rather than throwing', () => {
  const bad = { id: 'bad', name: 'Bad', delimiter: '-', pattern: '([', segments: [] }
  assert.equal(selectAnatomy('B14-LVS-1234', [bad, ANATOMY]).id, 'a1')
})

test('canonicalFromAnatomy drops non-identity segments', () => {
  assert.equal(canonicalFromAnatomy('B14-LVS-1234-A', ANATOMY), 'B14-LVS-1234')
  assert.equal(canonicalFromAnatomy('B14-LVS-1234', ANATOMY), 'B14-LVS-1234')
})

test('canonicalFromAnatomy returns the tag unchanged when no anatomy matches', () => {
  assert.equal(canonicalFromAnatomy('B14-LVS-1234-A', null), 'B14-LVS-1234-A')
})
