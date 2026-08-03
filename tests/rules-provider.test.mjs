import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setRuleProfile, ruleEngine, invalidateRuleEngine } from '../src/rules/provider.js'
import { makeExampleProfile } from '../src/rules/defaults.js'
import { createEngine } from '../src/rules/engine.js'
import { makeDefaultProfile, normalizeProfile } from '../src/profile/schema.js'
import { RULES_SCHEMA_VERSION } from '../src/rules/schema.js'
import { loadApp } from './support/harness.mjs'

test('the provider returns a usable engine even before a profile is set', () => {
  invalidateRuleEngine()
  assert.equal(typeof ruleEngine().resolve, 'function')
  assert.equal(ruleEngine().resolve('B14-LVS-1234-A').canonical, 'B14-LVS-1234')
})

test('the same engine instance is returned until invalidated', () => {
  invalidateRuleEngine()
  assert.equal(ruleEngine(), ruleEngine())
  invalidateRuleEngine()
  assert.notEqual(ruleEngine(), ruleEngine.__last)
})

test('setRuleProfile swaps the rules in effect', () => {
  const stripNothing = { schemaVersion: 2, anatomies: [], rules: { normalize: [], classify: [], relate: [] } }
  setRuleProfile(stripNothing)
  assert.equal(ruleEngine().resolve('B14-LVS-1234-A').canonical, 'B14-LVS-1234-A')
  setRuleProfile(makeExampleProfile())
  assert.equal(ruleEngine().resolve('B14-LVS-1234-A').canonical, 'B14-LVS-1234')
})

test('setting an incomplete profile never inherits Eagle invisibly', () => {
  setRuleProfile({ name: 'bare' })
  const resolved=ruleEngine().resolve('B14-LVS-1234-A')
  assert.equal(resolved.canonical, 'B14-LVS-1234-A')
  assert.equal(resolved.attributes.equipmentType, undefined)
})

/**
 * Regression test for a bug that went undetected through Tasks 1-2: the test
 * harness had no `navigator` stub, so `initProfiles()` threw
 * `ReferenceError: navigator is not defined` (it calls
 * `navigator.storage.persist()`) and no test could exercise the real profile
 * lifecycle — seed localStorage, load the app, call initProfiles(), see what
 * comes out. This is that missing exercise: a realistic v1 profile (the shape
 * every real user's browser has stored) must migrate to v2 on load, keep its
 * authored data, and the rule engine bound to it must still resolve tags.
 */
test('a default profile still gets the example rules after being saved and reloaded', () => {
  // Regression: normalizeProfile runs migrateProfile, which adds an empty rules
  // container. Once that container exists, effectiveProfile can no longer tell
  // "never configured" from "configured with nothing" -- so a default profile
  // that had been saved and reloaded came back with no panel-side stripping and
  // no equipment types. Nothing covered the save/reload path, so it went unseen.
  const paths = {
    'fresh default': makeDefaultProfile('Site'),
    'default, saved and reloaded': normalizeProfile(makeDefaultProfile('Site')),
    'imported with no schemaVersion': normalizeProfile({ name: 'Imported' }),
    'stored v1': normalizeProfile({ name: 'Old', schemaVersion: 1, tagRules: [] }),
  }
  for (const [label, profile] of Object.entries(paths)) {
    invalidateRuleEngine()
    setRuleProfile(profile)
    const resolved = ruleEngine().resolve('B14-LVS-1234-A')
    assert.equal(resolved.canonical, 'B14-LVS-1234', `${label}: panel side must still be stripped`)
    assert.equal(resolved.attributes.equipmentType, 'LVS', `${label}: equipment type must still resolve`)
  }
})

test('a profile that deliberately authors an empty ruleset is not given the example rules', () => {
  // The other half of the same signal: an empty rules container the engineer
  // wrote themselves must be honoured, or authoring "strip nothing" is impossible.
  invalidateRuleEngine()
  setRuleProfile(normalizeProfile({ name: 'Authored', rules: { normalize: [], classify: [], relate: [] } }))
  assert.equal(ruleEngine().resolve('B14-LVS-1234-A').canonical, 'B14-LVS-1234-A',
    'an explicitly empty ruleset must strip nothing')
})

test('rules authored on a profile are used, not overwritten by the example set', () => {
  // The example ruleset is a fallback for a profile nobody has configured. Once
  // a rule has actually been authored, substituting the examples throws that
  // work away -- which blocks rule authoring outright, since every profile a
  // user can create today traces back to an origin with no rules container.
  const authored = JSON.parse(JSON.stringify(
    makeExampleProfile().rules.normalize.find(rule => rule.id === 'norm-panel-sides')))
  authored.id = 'authored-zz'
  authored.suffixes = ['ZZ']

  // Control: the rule shape is valid, proven against an engine built directly.
  assert.equal(createEngine({ ...makeExampleProfile(), rules: { ...makeExampleProfile().rules, normalize: [...makeExampleProfile().rules.normalize, authored] } })
    .resolve('PNL-1-ZZ').canonical, 'PNL-1', 'control: the authored rule must be well-formed')

  for (const [label, base] of [
    ['migrated from v1', normalizeProfile({ name: 'Old', schemaVersion: 1, tagRules: [] })],
    ['fresh default', normalizeProfile(makeDefaultProfile('New'))],
  ]) {
    const profile = JSON.parse(JSON.stringify(base))
    profile.rules.normalize.push(JSON.parse(JSON.stringify(authored)))
    invalidateRuleEngine()
    setRuleProfile(profile)
    assert.equal(ruleEngine().resolve('PNL-1-ZZ').canonical, 'PNL-1',
      `${label}: an authored rule must take effect`)
  }
  invalidateRuleEngine()
  setRuleProfile(null)
})

test('a stored v1 profile migrates through initProfiles and the engine keeps resolving', async () => {
  const app = await loadApp()

  const v1Profile = {
    schemaVersion: 1,
    id: 'profile-v1-test',
    name: 'Legacy Site',
    revision: 5,
    mappings: { mel: { fields: { equipmentTag: 0, upn: 1 } } },
    tagRules: [{
      id: 'r1', name: 'GIS role', target: 'equipmentType', mode: 'contains', needle: 'GIS',
      start: 0, end: 0, segmentIndex: 0, value: 'GIS', sourceKind: '', enabled: true, strict: true,
      example: '', exclusions: [],
    }],
    hierarchy: { parentSourcePriority: ['mel', 'cable'] },
  }
  const stored = { schemaVersion: 1, activeId: v1Profile.id, profiles: [v1Profile] }

  app.eval(`localStorage.setItem(PROFILE_STORAGE_KEY, ${JSON.stringify(JSON.stringify(stored))})`)
  app.eval('initProfiles()')

  const active = JSON.parse(app.eval('JSON.stringify(activeProfile())'))
  assert.equal(active.schemaVersion, RULES_SCHEMA_VERSION, 'active profile must report the current rules schema after migration')
  assert.deepEqual(active.mappings, v1Profile.mappings, 'mappings must survive the round trip')
  assert.deepEqual(active.tagRules, v1Profile.tagRules, 'tagRules must survive the round trip')

  const lvs = JSON.parse(app.eval(`JSON.stringify(ruleEngine().resolve(cleanTag('B14-LVS-1234-A')))`))
  assert.equal(lvs.canonical, 'B14-LVS-1234')
  assert.equal(lvs.attributes.equipmentType, 'LVS')

  const spare = JSON.parse(app.eval(`JSON.stringify(ruleEngine().resolve(cleanTag('SP-1')))`))
  assert.equal(spare.attributes.placeholder, 'spare')
})
