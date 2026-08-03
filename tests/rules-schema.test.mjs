import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RULES_SCHEMA_VERSION, emptyRuleSet, migrateProfile } from '../src/rules/schema.js'

test('a v1 profile migrates to v2 without losing its existing fields', () => {
  const v1 = {
    id: 'p1', name: 'Site A', revision: 3,
    mappings: { mel: { fields: { equipmentTag: 0 } } },
    tagRules: [{ id: 'r1', target: 'equipmentType', mode: 'contains', needle: 'GIS', value: 'GIS' }],
    hierarchy: { parentSourcePriority: ['cable', 'mel'] },
  }
  const v2 = migrateProfile(v1)
  assert.equal(v2.schemaVersion, RULES_SCHEMA_VERSION)
  assert.equal(v2.name, 'Site A')
  assert.equal(v2.revision, 3)
  assert.deepEqual(v2.mappings, v1.mappings)
  assert.deepEqual(v2.tagRules, v1.tagRules)
  assert.deepEqual(v2.hierarchy.parentSourcePriority, ['cable', 'mel'])
})

test('migration adds empty rule containers, so a migrated profile behaves as before', () => {
  const v2 = migrateProfile({ id: 'p1', name: 'Site A' })
  assert.deepEqual(v2.anatomies, [])
  assert.deepEqual(v2.rules, emptyRuleSet())
})

test('migration is idempotent', () => {
  const once = migrateProfile({ id: 'p1', name: 'Site A' })
  assert.deepEqual(migrateProfile(once), once)
})

test('the original v1 payload is retained so a profile can be rolled back', () => {
  const v1 = { id: 'p1', name: 'Site A', tagRules: [] }
  const v2 = migrateProfile(v1)
  assert.deepEqual(v2.migratedFrom, v1)
})

test('migratedFrom is captured once and never nests, however often a profile is re-migrated', () => {
  const v1 = { id: 'p1', name: 'Site A', tagRules: [] }
  let profile = migrateProfile(v1)
  for (let i = 0; i < 25; i++) profile = migrateProfile(profile)
  // Depth 1 means migratedFrom holds the v1 payload itself, not a chain of
  // previously-migrated wrappers. This nested one level per profile save
  // before the fix, growing localStorage without bound.
  let depth = 0
  for (let cursor = profile; cursor && cursor.migratedFrom; cursor = cursor.migratedFrom) depth++
  assert.equal(depth, 1, 'migratedFrom nested instead of being captured once')
  assert.deepEqual(profile.migratedFrom, v1, 'migratedFrom must stay the original pre-v2 payload')
})

test('a profile claiming to be current but missing its rule containers is still repaired', () => {
  // A hand-edited or truncated import can declare the current schemaVersion
  // while carrying none of the structure that version implies. Migration
  // repairs unconditionally rather than trusting the declared version.
  const damaged = migrateProfile({ id: 'p1', name: 'Site A', schemaVersion: RULES_SCHEMA_VERSION, rules: 'not an object' })
  assert.deepEqual(damaged.rules, emptyRuleSet())
  assert.deepEqual(damaged.anatomies, [])
  assert.equal(damaged.migratedFrom, undefined, 'a profile already at the current version has no pre-v2 payload to retain')
})
