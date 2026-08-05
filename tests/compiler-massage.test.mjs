import test from 'node:test'
import assert from 'node:assert/strict'
import { buildProjectApp, canonicalRecordOf } from './support/compiler-harness.mjs'

/* Drag-and-drop massaging: a manual reparent persists as a relationship
   override in the active profile, outranks every claim, survives rebuilds,
   supports explicit make-root, and refuses cross-block moves and cycles. */

const EXTO = ['easy-power.xlsx', 'compiler-ep.xlsx', 'compiler-cable.xlsx', 'compiler-mel.xlsx', 'compiler-extoreg.xlsx', 'compiler-imtemplate.xlsx']

test('a manual reparent wins the parent slot and persists in the profile', async () => {
  const app = await buildProjectApp(EXTO)
  const ok = JSON.parse(app.eval(`JSON.stringify(applyManualReparent('B14-PT-7001-01','B14-AHU-7001'))`))
  assert.equal(ok, true)
  const pt = canonicalRecordOf(app, 'B14-PT-7001-01')
  assert.equal(pt.ssmParentTag, 'B14-AHU-7001', 'the override took the parent slot')
  const saved = JSON.parse(app.eval(`
    JSON.stringify((activeProfile().overrides.relationships || []).find(o => /PT-7001-01/.test(o.equipment)) || null)
  `))
  assert.ok(saved, 'override persisted in the active profile')
  assert.equal(saved.parent, 'B14-AHU-7001')
})

test('a manual reparent overrides even an inferred claim, and make-root undoes nesting', async () => {
  const app = await buildProjectApp(EXTO)
  assert.equal(canonicalRecordOf(app, 'B14-TT-7001-02A').ssmParentTag, 'B14-AHU-7001', 'starts nested by inferred claim')
  JSON.parse(app.eval(`JSON.stringify(applyManualReparent('B14-TT-7001-02A',''))`))
  const tt = canonicalRecordOf(app, 'B14-TT-7001-02A')
  assert.equal(tt.ssmParentTag, '', 'explicit manual root beats the inferred claim')
})

test('cross-block moves and cycles are refused', async () => {
  const app = await buildProjectApp(EXTO)
  const cross = JSON.parse(app.eval(`JSON.stringify(applyManualReparent('B14-RIO-6500','B14-AHU-7001'))`))
  assert.equal(cross, false, 'I&C/650 equipment cannot nest under Mechanical/2201')
  assert.equal(canonicalRecordOf(app, 'B14-RIO-6500').ssmParentTag, '', 'refused move leaves the record untouched')
  const cycle = JSON.parse(app.eval(`JSON.stringify(applyManualReparent('B14-AHU-7001','B14-FCU-7101'))`))
  assert.equal(cycle, false, 'FCU is a child of the AHU — nesting the AHU under it would cycle')
})

test('equipment rows render draggable; folder rows do not', async () => {
  const app = await buildProjectApp(EXTO)
  const rows = JSON.parse(app.eval(`
    JSON.stringify((function () {
      const mode = activeModes(activeProfile()).find(m => m.executor === 'projected')
      const projection = S.projections[mode.id]
      const nodes = [...projection.nodeById.values()]
      const equipment = nodes.find(n => n.kind === 'equipment')
      const system = nodes.find(n => n.kind === 'system')
      return { equipment: rowInner(equipment, [], true, false, ''), system: rowInner(system, [], true, true, '') }
    })())
  `))
  assert.match(rows.equipment, /draggable="true"/)
  assert.doesNotMatch(rows.system, /draggable="true"/)
})
