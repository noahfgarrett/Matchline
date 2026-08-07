import test from 'node:test'
import assert from 'node:assert/strict'
import { detectMel, isMelSheet, profileFieldsFromHeaders } from '../src/io/detect.js'
import { KEYSEP } from '../src/core/text.js'
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

test('evidence tags unify with MEL tags by suffix — one record, MEL spelling wins', async () => {
  // The cable schedule writes "DDC-7301"; the MEL writes "B14-DDC-7301". They
  // are the same asset, matched on the back end of the tag (spec §5 identity
  // tiers). One record, cable evidence attached, no duplicate register row.
  const app = await buildProjectApp(['easy-power.xlsx', 'compiler-cable.xlsx', 'compiler-mel.xlsx'])
  const ddc = canonicalRecordOf(app, 'B14-DDC-7301')
  assert.ok(ddc, 'the MEL spelling is the canonical record')
  assert.equal(ddc.ssmParentTag, '', 'cross-partition cable feed cannot be a parent')
  assert.ok(ddc.dependencies.some(d => /LVS-1234/.test(d)),
    `the cable claim from the suffix variant must attach here, got deps: ${ddc.dependencies}`)
  const counts = JSON.parse(app.eval(`
    JSON.stringify({
      bare: !!S.canonicalModel.get(tagKey('DDC-7301')) && S.canonicalModel.get(tagKey('DDC-7301')) !== S.canonicalModel.get(tagKey('B14-DDC-7301')),
      registerRows: S.ssmCombined.filter(row => /DDC-7301/i.test(String(row[0]))).length,
    })
  `))
  assert.equal(counts.bare, false, 'no separate record for the bare cable spelling')
  assert.equal(counts.registerRows, 1, 'exactly one register row for the asset')
})

test('a MEL-only compile still builds the register (no electrical sources at all)', async () => {
  const app = await buildProjectApp(['compiler-mel.xlsx'])
  const ahu = canonicalRecordOf(app, 'B14-AHU-7001')
  assert.ok(ahu, 'MEL-only build produces canonical records')
  assert.equal(ahu.includeInRegister, true)
  const fcu = canonicalRecordOf(app, 'B14-FCU-7101')
  assert.equal(fcu.ssmParentTag, 'B14-AHU-7001', 'MEL System Parent assertions still nest')
  const registerRows = JSON.parse(app.eval(`JSON.stringify(S.ssmCombined.length)`))
  assert.ok(registerRows >= 10, `register populated from the MEL alone, got ${registerRows}`)
})

test('a MEL with preamble rows (headers in row 3) still compiles alone', async () => {
  const app = await buildProjectApp(['compiler-mel-row3.xlsx'])
  const chiller = canonicalRecordOf(app, 'B31-CH-101-01')
  assert.ok(chiller, 'row-3 headers detected; MEL-only build produced records')
  assert.equal(chiller.system, '101 Chilled Water')
  const pump = canonicalRecordOf(app, 'B31-PMP-101-01')
  assert.equal(pump.ssmParentTag, 'B31-CH-101-01', 'System Parent assertion nests without any electrical source')
})

test('real-world tag headers detect: "Equipment Tag Number" with corroborating columns', () => {
  const info = detectMel(['Equipment Tag Number', 'Equipment Description', 'Bldg', 'Discipline', 'UPN', 'System Description'])
  assert.ok(info, 'the suffixed tag header must be recognized when the row is plainly a MEL')
  assert.equal(info.tag, 0)
  assert.equal(info.upn, 4)
})

test('loose tag headers cannot masquerade as a MEL without MEL-ish corroboration', () => {
  assert.equal(detectMel(['Cable Tag', 'From', 'To']), null, 'a cable schedule is not a MEL')
  assert.equal(detectMel(['Tag']), null, 'a lone tag cell is not a MEL')
  assert.equal(detectMel(['Tag No.', 'Building', 'Description']), null, 'no UPN or System Parent column — not trusted')
  assert.ok(detectMel(['Tag No.', 'UPN', 'Discipline']), 'UPN plus a second corroborating column qualifies')
})

test('MEL tab-name synonyms are recognized without header detection', () => {
  assert.equal(isMelSheet('nofile' + KEYSEP + 'Master Equipment List'), true)
  assert.equal(isMelSheet('nofile' + KEYSEP + 'MEL'), true)
  assert.equal(isMelSheet('nofile' + KEYSEP + 'Cable Schedule'), false)
})

test('a real-world MEL (tab "Master Equipment List", "Equipment Tag Number") compiles alone', async () => {
  const app = await buildProjectApp(['compiler-mel-tagnumber.xlsx'])
  const pump = canonicalRecordOf(app, 'B31-PMP-101-01')
  assert.ok(pump, 'the loose-header MEL seeded canonical records')
  assert.equal(pump.ssmParentTag, 'B31-CH-101-01')
  assert.equal(pump.system, '101 Chilled Water')
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
