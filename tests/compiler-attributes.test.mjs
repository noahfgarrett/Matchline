import test from 'node:test'
import assert from 'node:assert/strict'
import { buildProjectApp, canonicalRecordOf } from './support/compiler-harness.mjs'

/* Compiler fork (spec §4): under a project profile the MEL is the attribute
   authority — Discipline comes straight from the MEL column and System is
   composed as "{UPN} {System Description}". Eagle keeps the frozen legacy
   behavior (pinned by hierarchy-modes' "no System value may be composed"
   test, which runs without a project profile). */

test('MEL discipline and UPN+description compose record attributes', async () => {
  const app = await buildProjectApp(['easy-power.xlsx', 'compiler-cable.xlsx', 'compiler-mel.xlsx'])
  const rio = canonicalRecordOf(app, 'B14-RIO-6500')
  assert.equal(rio.discipline, 'I&C')
  assert.equal(rio.system, '650 FMS Network')
  assert.equal(rio.building, 'B14')
  const ahu = canonicalRecordOf(app, 'B14-AHU-7001')
  assert.equal(ahu.discipline, 'Mechanical')
  assert.equal(ahu.system, '2201 Screening')
})

test('MEL-derived attributes are explicit, so parent inheritance cannot overwrite them', async () => {
  const app = await buildProjectApp(['easy-power.xlsx', 'compiler-cable.xlsx', 'compiler-mel.xlsx'])
  const rio = canonicalRecordOf(app, 'B14-RIO-6500')
  assert.equal(rio.explicit.discipline, true)
  assert.equal(rio.explicit.system, true)
})

test('records absent from the MEL keep fallback attributes and non-explicit flags', async () => {
  const app = await buildProjectApp(['easy-power.xlsx', 'compiler-cable.xlsx', 'compiler-mel.xlsx'])
  const mtr = canonicalRecordOf(app, 'MTR-9002')
  assert.ok(mtr, 'easy-power load exists as a record')
  assert.equal(mtr.explicit.system, false, 'fallback system is not explicit — it must never form a partition')
})
