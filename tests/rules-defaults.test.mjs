import assert from 'node:assert/strict'
import { test } from 'node:test'
import { makeExampleProfile } from '../src/rules/defaults.js'
import { createEngine } from '../src/rules/engine.js'
import { RULES_SCHEMA_VERSION } from '../src/rules/schema.js'

test('the example profile is at the current schema and carries all three rule families', () => {
  const p = makeExampleProfile()
  assert.equal(p.schemaVersion, RULES_SCHEMA_VERSION)
  assert.ok(p.rules.normalize.length > 0)
  assert.ok(p.rules.classify.length > 0)
  assert.ok(p.rules.relate.length > 0)
})

test('every rule has a unique id', () => {
  const p = makeExampleProfile()
  const ids = [...p.rules.normalize, ...p.rules.classify, ...p.rules.relate].map(r => r.id)
  assert.equal(new Set(ids).size, ids.length)
})

test('the five MEL-dependent conventions are encoded in the order the code applies them', () => {
  const p = makeExampleProfile()
  const ids = p.rules.relate.map(r => r.id)
  assert.deepEqual(ids, ['scr-scc-parent', 'cim-parent', 'mah-parent', 'transformer-match', 'gis-system-root'])
  // melSyntheticParent tries SCR/SCC before CIM (src/hierarchy/build.js:131).
  assert.ok(ids.indexOf('scr-scc-parent') < ids.indexOf('cim-parent'))
  // The GIS root only applies when nothing else placed the tag, so it must be last.
  assert.equal(ids[ids.length - 1], 'gis-system-root')
})

test('role detection preserves GIS-before-XFM-before-LVS precedence', () => {
  const engine = createEngine(makeExampleProfile())
  assert.equal(engine.resolve('B14-GIS-01').attributes.equipmentType, 'GIS')
  assert.equal(engine.resolve('B14-XFM-1234').attributes.equipmentType, 'XFM')
  assert.equal(engine.resolve('B14-LVS-1234').attributes.equipmentType, 'LVS')
  // a tag matching both GIS and LV must resolve GIS, as legacyEquipmentRole does
  assert.equal(engine.resolve('GIS-LV-1').attributes.equipmentType, 'GIS')
})

test('normalisation reproduces the terminal-suffix and power-variant behavior', () => {
  const engine = createEngine(makeExampleProfile())
  assert.equal(engine.resolve('MCC-01-A').canonical, 'MCC-01')
  assert.equal(engine.resolve('XFM-1-A-B-P').canonical, 'XFM-1')
  assert.equal(engine.resolve('PNL-1_CPS').canonical, 'PNL-1')
})

test('normalisation strips a terminal side before a power variant that only becomes visible after the strip', () => {
  // stripPowerVariant(x) in src/hierarchy/build.js = cleanTag(x).replace(variant regex):
  // cleanTag strips terminal sides first (as part of cleanTag itself), then the
  // variant is stripped from what's left. The Normalize rule order must match
  // that composition (sides before variant) or 'PNL-1_CPS-A' stops at 'PNL-1_CPS'
  // instead of reaching 'PNL-1'.
  const engine = createEngine(makeExampleProfile())
  assert.equal(engine.resolve('PNL-1_CPS-A').canonical, 'PNL-1')
})

test('placeholders classify spares, spaces, and notes', () => {
  const engine = createEngine(makeExampleProfile())
  assert.equal(engine.resolve('SP-1').attributes.placeholder, 'spare')
  assert.equal(engine.resolve('SPARE 2').attributes.placeholder, 'spare')
  assert.equal(engine.resolve('SPACE-3').attributes.placeholder, 'space')
  assert.equal(engine.resolve('NOTE 4').attributes.placeholder, 'note')
  assert.equal(engine.resolve('B14-LVS-1').attributes.placeholder, undefined)
})
