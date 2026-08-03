import test from 'node:test'
import assert from 'node:assert/strict'
import { detectMel, profileFieldsFromHeaders } from '../src/io/detect.js'

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

test('a MEL without the new columns still detects, with the new fields absent', () => {
  const info = detectMel(['Equipment Tag', 'UPN', 'Bldg'])
  assert.ok(info)
  assert.equal(info.projectPhase, -1)
  assert.equal(info.description, -1)
  const fields = profileFieldsFromHeaders('mel', ['Equipment Tag', 'UPN', 'Bldg'])
  assert.equal(fields.projectPhase, undefined)
  assert.equal(fields.description, undefined)
})
