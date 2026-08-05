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

test('undo and redo walk the massage history, restoring prior overrides exactly', async () => {
  const app = await buildProjectApp(EXTO)
  // move 1: TT (inferred under AHU) manually under MTR; move 2: manually rooted
  app.eval(`applyManualReparent('B14-TT-7001-02A','MTR-9001')`)
  app.eval(`applyManualReparent('B14-TT-7001-02A','')`)
  assert.equal(canonicalRecordOf(app, 'B14-TT-7001-02A').ssmParentTag, '')
  app.eval(`undoManualReparent()`)
  assert.equal(canonicalRecordOf(app, 'B14-TT-7001-02A').ssmParentTag, 'MTR-9001', 'first undo restores the earlier override')
  app.eval(`undoManualReparent()`)
  assert.equal(canonicalRecordOf(app, 'B14-TT-7001-02A').ssmParentTag, 'B14-AHU-7001', 'second undo removes the override entirely — inferred claim returns')
  const cleared = JSON.parse(app.eval(`
    JSON.stringify(((activeProfile().overrides.relationships)||[]).some(o => /TT-7001-02A/.test(o.equipment)))
  `))
  assert.equal(cleared, false, 'no override remains after full undo')
  app.eval(`redoManualReparent()`)
  assert.equal(canonicalRecordOf(app, 'B14-TT-7001-02A').ssmParentTag, 'MTR-9001', 'redo re-applies the first move')
  const stacks = JSON.parse(app.eval(`JSON.stringify({ undo: S.massageUndo.length, redo: S.massageRedo.length })`))
  assert.deepEqual(stacks, { undo: 1, redo: 1 })
})

test('a new move clears the redo stack; manual badge keys track overrides', async () => {
  const app = await buildProjectApp(EXTO)
  app.eval(`applyManualReparent('B14-TT-7001-02A','MTR-9001')`)
  app.eval(`undoManualReparent()`)
  app.eval(`applyManualReparent('B14-PT-7001-01','B14-AHU-7001')`)
  const stacks = JSON.parse(app.eval(`JSON.stringify({ undo: S.massageUndo.length, redo: S.massageRedo.length })`))
  assert.deepEqual(stacks, { undo: 1, redo: 0 }, 'new move invalidates redo history')
  const keys = JSON.parse(app.eval(`JSON.stringify([...manualOverrideKeySet()])`))
  assert.ok(keys.includes('b14-pt-7001-01'.replace(/-/g, '')) || keys.some(k => /pt7001/.test(k.replace(/[^a-z0-9]/g, ''))),
    `override key present for the badge, got: ${keys}`)
})

test('drag-to-teach: one move generalizes to siblings of the same kind, each matched by numbers', async () => {
  const app = await buildProjectApp(EXTO)
  const similar = JSON.parse(app.eval(`JSON.stringify(similarNestingMoves('B14-PT-7001-01','B14-AHU-7001'))`))
  assert.deepEqual(similar, [{ tag: 'B14-PT-7001-02', parent: 'B14-AHU-7001' }],
    'the sibling PT with the matching number is offered, nothing else')
  app.eval(`applyManualReparent('B14-PT-7001-01','B14-AHU-7001')`)
  const applied = JSON.parse(app.eval(`JSON.stringify(applyManualReparentBatch(${JSON.stringify(similar)}))`))
  assert.equal(applied, 1)
  assert.equal(canonicalRecordOf(app, 'B14-PT-7001-02').ssmParentTag, 'B14-AHU-7001')
  // the batch is ONE history entry: a single undo reverts the whole generalization
  app.eval(`undoManualReparent()`)
  assert.equal(canonicalRecordOf(app, 'B14-PT-7001-02').ssmParentTag, '', 'batch undone in one step')
  assert.equal(canonicalRecordOf(app, 'B14-PT-7001-01').ssmParentTag, 'B14-AHU-7001', 'the original drag survives its own undo entry')
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
