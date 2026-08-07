import test from 'node:test'
import assert from 'node:assert/strict'
import { detectLineList } from '../src/io/linelist.js'
import { buildProjectApp, canonicalRecordOf } from './support/compiler-harness.mjs'

/* Piping roll-ups (spec §5.9): line-list segments collapse to one synthetic
   register row per UPN, placed in that UPN's system block and excluded from
   tag-vs-MEL validation. */

const CORE = ['easy-power.xlsx', 'compiler-cable.xlsx', 'compiler-mel.xlsx']

test('detectLineList anchors on Line ID + UPN and refuses MEL-shaped sheets', () => {
  const info = detectLineList(['Line ID', 'UPN', 'Service'])
  assert.equal(info.lineId, 0)
  assert.equal(info.upn, 1)
  assert.equal(detectLineList(['Equipment Tag', 'UPN']), null, 'a MEL is not a line list')
  assert.equal(detectLineList(['Line ID', 'Service']), null, 'no UPN means no roll-up target')
})

test('line-list segments roll up to one synthetic record per UPN in the right system block', async () => {
  const app = await buildProjectApp([...CORE, 'compiler-linelist.xlsx'])
  const piping = canonicalRecordOf(app, 'UPN 2201 Distribution Piping')
  assert.ok(piping, 'roll-up record exists')
  assert.equal(piping.system, '2201 Screening')
  assert.equal(piping.building, 'B14')
  assert.equal(piping.discipline, 'Mechanical')
  assert.equal(piping.includeInRegister, true)
  const fms = canonicalRecordOf(app, 'UPN 650 Distribution Piping')
  assert.equal(fms.system, '650 FMS Network')
})

test('roll-ups are synthetic: present in the register, excluded from tag-vs-MEL validation', async () => {
  const app = await buildProjectApp([...CORE, 'compiler-linelist.xlsx'])
  const flags = JSON.parse(app.eval(`
    JSON.stringify((function () {
      const r = S.canonicalModel.get(tagKey('UPN 2201 Distribution Piping'));
      const inRegister = S.ssmCombined.some(row => tagKey(row[0]) === r.key);
      return { synthetic: !!r.isSyntheticRollup, inRegister };
    })())
  `))
  assert.equal(flags.synthetic, true)
  assert.equal(flags.inRegister, true)
})
