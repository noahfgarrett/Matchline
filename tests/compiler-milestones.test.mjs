import test from 'node:test'
import assert from 'node:assert/strict'
import { buildProjectApp, canonicalRecordOf } from './support/compiler-harness.mjs'

/* Milestone ladder + sequencing (spec §5/§6). P6 is strictly optional: with
   no schedule everything sits on the building-ready rung, and every other
   output stays complete. A fuller P6 promotes records up the ladder on the
   next compile. */

const CORE = ['easy-power.xlsx', 'compiler-cable.xlsx', 'compiler-mel.xlsx']

test('without P6, every register record lands on the building-ready rung', async () => {
  const app = await buildProjectApp(CORE)
  for (const tag of ['B14-AHU-7001', 'B14-RIO-6500', 'B14-XFM-1234']) {
    const record = canonicalRecordOf(app, tag)
    assert.equal(record.milestone.rung, 4, `${tag} defaults to rung 4`)
    assert.equal(record.milestone.label, 'OP / Building Ready')
  }
})

test('an XER promotes UPNs named in milestone tasks to the name-pattern rung', async () => {
  const app = await buildProjectApp([...CORE, 'compiler-p6.xer'])
  const ahu = canonicalRecordOf(app, 'B14-AHU-7001')
  assert.equal(ahu.milestone.rung, 3, 'UPN 2201 extracted from the milestone name')
  assert.match(ahu.milestone.label, /UPN 2201 Screening/)
  const xfm = canonicalRecordOf(app, 'B14-XFM-1234')
  assert.equal(xfm.milestone.rung, 3)
  assert.match(xfm.milestone.label, /UPN 1234 Main Intake/)
  const rio = canonicalRecordOf(app, 'B14-RIO-6500')
  assert.equal(rio.milestone.rung, 4, 'no milestone names UPN 650 — stays building-ready')
})

test('a P6 sheet with explicit equipment and UPN columns promotes to rungs 1 and 2', async () => {
  const app = await buildProjectApp([...CORE, 'compiler-p6.xer', 'compiler-p6.xlsx'])
  const rio = canonicalRecordOf(app, 'B14-RIO-6500')
  assert.equal(rio.milestone.rung, 1, 'explicit Equipment ID column is a direct association')
  assert.match(rio.milestone.label, /RIO 6500/)
})

test('sequencing follows polarity: electrical top-down, mechanical bottom-up', async () => {
  const app = await buildProjectApp(CORE)
  const xfm = canonicalRecordOf(app, 'B14-XFM-1234')
  const lvs = canonicalRecordOf(app, 'B14-LVS-1234')
  assert.ok(xfm.sequence < lvs.sequence, `electrical parents first: XFM ${xfm.sequence} < LVS ${lvs.sequence}`)
  const mtr = canonicalRecordOf(app, 'MTR-9001')
  const ahu = canonicalRecordOf(app, 'B14-AHU-7001')
  assert.ok(mtr.sequence < ahu.sequence, `mechanical children first: MTR ${mtr.sequence} < AHU ${ahu.sequence}`)
})

test('cross-partition dependencies collapse to a UPN precedence order', async () => {
  const app = await buildProjectApp(CORE)
  const precedence = JSON.parse(app.eval(`JSON.stringify(S.upnPrecedence)`))
  assert.ok(precedence.edges.some(e => e.from === '1234' && e.to === '650'), 'RIO dependency yields 1234 → 650')
  assert.ok(precedence.edges.some(e => e.from === '1234' && e.to === '2201'), 'MTR dependency yields 1234 → 2201')
  const order = precedence.order
  assert.ok(order.indexOf('1234') < order.indexOf('650'), '1234 energizes before 650')
  assert.ok(order.indexOf('1234') < order.indexOf('2201'), '1234 energizes before 2201')
  assert.deepEqual(precedence.cycles, [])
})
