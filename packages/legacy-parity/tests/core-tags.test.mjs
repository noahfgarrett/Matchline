import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cleanTag, cleanTagRaw, cleanRegisterTag, normSep, simPct } from '../src/core/tags.js'

test('cleanTag normalises separators and unicode dashes', () => {
  assert.equal(cleanTag('  B14 - LVS - 1234  '), 'B14-LVS-1234')
  assert.equal(cleanTag('B14‐LVS'), 'B14-LVS')
  assert.equal(cleanTag('B14﻿-LVS'), 'B14-LVS')
})

test('cleanTag strips the configured terminal suffixes (Stage A behavior)', () => {
  assert.equal(cleanTag('MCC-01-A'), 'MCC-01')
  assert.equal(cleanTag('PNL-2-S'), 'PNL-2')
  assert.equal(cleanTag('XFM-1-A-B-P'), 'XFM-1')
})

test('cleanRegisterTag preserves the CIM qualifier the shipped profile composes', () => {
  assert.equal(cleanRegisterTag('B14 - CIM'), 'B14 - CIM')
  assert.equal(cleanRegisterTag('B14  -  CIM'), 'B14 - CIM', 'spacing is tolerated, as it always was')
  assert.equal(cleanRegisterTag('B14-LVS-1234-A'), 'B14-LVS-1234')
})

test('the preserved qualifier comes from the profile, not from a hardcoded site term', async () => {
  // This is what let src/core/tags.js off the purity exemption list: the file
  // no longer names a site convention, it reads the literal its own Relate
  // rules compose. A site whose rule appends " - RACK" is protected identically,
  // and CIM stops being special the moment the profile stops mentioning it.
  const { setRuleProfile, invalidateRuleEngine } = await import('../src/rules/provider.js')
  const { makeExampleProfile } = await import('../src/rules/defaults.js')
  const profile = makeExampleProfile()
  profile.rules.relate = profile.rules.relate.map(rule => rule.id === 'cim-parent'
    ? { ...rule, parent: [{ kind: 'column', name: 'Building' }, { kind: 'literal', text: ' - RACK' }] }
    : rule)
  try {
    setRuleProfile(profile)
    invalidateRuleEngine()
    assert.equal(cleanRegisterTag('B14 - RACK'), 'B14 - RACK', 'the profile-declared literal is preserved')
    assert.equal(cleanRegisterTag('B14 - CIM'), 'B14-CIM', 'a term the profile no longer composes is not special')
  } finally {
    setRuleProfile(null)
    invalidateRuleEngine()
  }
})

test('normSep makes separator variants comparable', () => {
  assert.equal(normSep('ABC-1'), normSep('ABC_1'))
  assert.equal(simPct('ABC-1', 'ABC_1'), 100)
})

test('cleanTagRaw does unicode/separator normalisation only, no suffix stripping', () => {
  assert.equal(cleanTagRaw('  B14 - LVS - 1234  '), 'B14-LVS-1234')
  assert.equal(cleanTagRaw('B14‐LVS'), 'B14-LVS')
  assert.equal(cleanTagRaw('MCC-01-A'), 'MCC-01-A')
  assert.equal(cleanTagRaw('B14-LVS-5004_CPS'), 'B14-LVS-5004_CPS')
})

test('cleanTag leaves the power variant untouched — that is stripPowerVariant\'s job, not cleanTag\'s', () => {
  // This is the exact regression the staged-normalize design exists to prevent:
  // an earlier attempt routed cleanTag through every Normalize rule (including
  // the power-variant strip) and broke two golden parity scenarios because a
  // real tag in easy-power-rules.xlsx, B14-LVS-5004_CPS, has no panel side to
  // strip but does carry a power variant.
  assert.equal(cleanTag('B14-LVS-5004_CPS'), 'B14-LVS-5004_CPS')
})
