import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyClassify } from '../src/rules/classify.js'

const ROLE_RULES = [
  { id: 'gis', kind: 'pattern', target: 'equipmentType', pattern: '(?:^|[-_])GIS', value: 'GIS', enabled: true },
  { id: 'xfm', kind: 'pattern', target: 'equipmentType', pattern: '(?:^|[-_])XFM', value: 'XFM', enabled: true },
  { id: 'lvs', kind: 'pattern', target: 'equipmentType', pattern: '(?:^|[-_])LV[A-Z0-9]*', value: 'LVS', enabled: true },
]

test('the first matching rule wins for an attribute', () => {
  assert.equal(applyClassify('B14-GIS-01', 'B14-GIS-01', ROLE_RULES, {}).equipmentType, 'GIS')
  assert.equal(applyClassify('B14-XFM-1234', 'B14-XFM-1234', ROLE_RULES, {}).equipmentType, 'XFM')
  assert.equal(applyClassify('B14-LVS-1234', 'B14-LVS-1234', ROLE_RULES, {}).equipmentType, 'LVS')
})

test('a later rule cannot override an earlier match on the same attribute', () => {
  const rules = [
    { id: 'a', kind: 'pattern', target: 'equipmentType', pattern: 'LV', value: 'LVS', enabled: true },
    { id: 'b', kind: 'pattern', target: 'equipmentType', pattern: 'B14', value: 'WRONG', enabled: true },
  ]
  assert.equal(applyClassify('B14-LVS-1', 'B14-LVS-1', rules, {}).equipmentType, 'LVS')
})

test('an unmatched attribute is absent rather than empty', () => {
  assert.equal('equipmentType' in applyClassify('PNL-1', 'PNL-1', ROLE_RULES, {}), false)
})

test('segment rules read a named anatomy segment', () => {
  const rules = [{ id: 's', kind: 'segment', target: 'building', segment: 'building', enabled: true }]
  assert.equal(applyClassify('B14-LVS-1', 'B14-LVS-1', rules, { building: 'B14' }).building, 'B14')
})

test('slice rules take a character range, supporting negative offsets', () => {
  const rules = [{ id: 'last4', kind: 'slice', target: 'matchKey', start: -4, enabled: true }]
  assert.equal(applyClassify('B14-LVS-1234', 'B14-LVS-1234', rules, {}).matchKey, '1234')
})

test('a malformed pattern is skipped rather than throwing', () => {
  const rules = [{ id: 'bad', kind: 'pattern', target: 'x', pattern: '([', value: 'v', enabled: true }, ...ROLE_RULES]
  assert.equal(applyClassify('B14-GIS-01', 'B14-GIS-01', rules, {}).equipmentType, 'GIS')
})

test('disabled rules are skipped', () => {
  const rules = ROLE_RULES.map(r => ({ ...r, enabled: false }))
  assert.deepEqual(applyClassify('B14-GIS-01', 'B14-GIS-01', rules, {}), {})
})

test('a rule without source: "raw" reads the canonical tag by default', () => {
  const rules = [{ id: 'note', kind: 'pattern', target: 'placeholder', pattern: '^note$', value: 'note', enabled: true }]
  // canonical has already had '-A' stripped by Normalize; default source sees that.
  assert.equal(applyClassify('NOTE-A', 'NOTE', rules, {}).placeholder, 'note')
})

test('source: "raw" reads the tag before normalisation, so a stripped suffix is still visible', () => {
  const rules = [{ id: 'note', kind: 'pattern', target: 'placeholder', pattern: '^note\\s*\\d*$', value: 'note', source: 'raw', enabled: true }]
  // 'NOTE-A' is not a bare note once the trailing '-A' is considered, even though
  // Normalize would strip it down to 'NOTE' — matches isNote('NOTE-A') === false.
  assert.equal(applyClassify('NOTE-A', 'NOTE', rules, {}).placeholder, undefined)
  assert.equal(applyClassify('NOTE', 'NOTE', rules, {}).placeholder, 'note')
})

test('slice minLength suppresses a result for a tag shorter than the guard, mirroring equipmentSuffix', () => {
  const rules = [{ id: 'last4', kind: 'slice', target: 'matchKey', start: -4, minLength: 4, enabled: true }]
  assert.equal(applyClassify('ABC', 'ABC', rules, {}).matchKey, undefined)
  assert.equal(applyClassify('ABCD', 'ABCD', rules, {}).matchKey, 'ABCD')
})

test('slice lowercase folds the sliced value, mirroring equipmentSuffix', () => {
  const rules = [{ id: 'last4', kind: 'slice', target: 'matchKey', start: -4, lowercase: true, enabled: true }]
  assert.equal(applyClassify('B14-LVS-1234', 'B14-LVS-1234', rules, {}).matchKey, '1234')
  assert.equal(applyClassify('B14-XFM-ABCD', 'B14-XFM-ABCD', rules, {}).matchKey, 'abcd')
})

test('slice does not trim the sliced substring, so an internal space at the boundary survives', () => {
  const rules = [{ id: 'last4', kind: 'slice', target: 'matchKey', start: -4, enabled: true }]
  // equipmentSuffix never trims after slicing; clean()-ing the substring would drop this leading space.
  assert.equal(applyClassify('SOME MEL', 'SOME MEL', rules, {}).matchKey, ' MEL')
})
