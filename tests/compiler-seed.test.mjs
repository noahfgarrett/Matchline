import test from 'node:test'
import assert from 'node:assert/strict'
import { detectMel, profileFieldsFromHeaders } from '../src/io/detect.js'
import { buildProjectApp, canonicalRecordOf } from './support/compiler-harness.mjs'


/* Compiler fork: the MEL is the seed universe (spec §4), so its detector must
   carry the columns the seeding and register logic read — Project Phase gates
   register inclusion, Equipment Description feeds provenance and review. */

const HEADERS = ['Equipment Tag', 'Equipment Description', 'Bldg', 'Discipline', 'UPN',
  'System Description', 'System Parent Equipment Tag(s)', 'Project Phase']

test('detectMel captures Project Phase and Equipment Description columns', () => {
  const info = detectMel(HEADERS)
  assert.ok(info, 'headers must be recognized as a MEL')
  assert.equal(info.projectPhase, 7)
  assert.equal(info.description, 1)
})

test('MEL auto-mapping enumerates the new columns so saved mappings keep them', () => {
  const fields = profileFieldsFromHeaders('mel', HEADERS)
  assert.equal(fields.projectPhase, 7, 'Project Phase must be auto-mapped, not left for hand-mapping')
  assert.equal(fields.description, 1, 'Equipment Description must be auto-mapped')
  assert.equal(fields.equipmentTag, 0, 'pre-existing fields keep working')
})

test('MEL rows seed canonical records even when absent from every other source', async () => {
  const app = await buildProjectApp(['easy-power.xlsx', 'compiler-cable.xlsx', 'compiler-mel.xlsx'])
  const ahu = canonicalRecordOf(app, 'B14-AHU-7001')
  assert.ok(ahu, 'MEL-only tag must exist in the canonical model')
  assert.equal(ahu.sourceKind, 'mel')
  assert.equal(ahu.includeInRegister, true, 'seeded rows belong in the register')
  const future = canonicalRecordOf(app, 'B14-AHU-7002')
  assert.ok(future, 'excluded-phase rows are still records so edges can attach')
  assert.equal(future.phaseExcluded, true)
  assert.equal(future.includeInRegister, false, 'Future-phase rows stay out of the register')
})

test('seeded MEL-only rows land in the exported register exactly once', async () => {
  const app = await buildProjectApp(['easy-power.xlsx', 'compiler-cable.xlsx', 'compiler-mel.xlsx'])
  const rows = JSON.parse(app.eval(`
    JSON.stringify(S.ssmCombined.filter(row => tagKey(row[0]) === tagKey('B14-AHU-7001')))
  `))
  assert.equal(rows.length, 1, 'exactly one register row for a seeded MEL-only tag')
})

test('a MEL without the new columns still detects, with the new fields absent', () => {
  const info = detectMel(['Equipment Tag', 'UPN', 'Bldg'])
  assert.ok(info)
  assert.equal(info.projectPhase, -1)
  assert.equal(info.description, -1)
  const fields = profileFieldsFromHeaders('mel', ['Equipment Tag', 'UPN', 'Bldg'])
  assert.equal(fields.projectPhase, undefined)
  assert.equal(fields.description, undefined)
})
