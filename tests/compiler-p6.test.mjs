import test from 'node:test'
import assert from 'node:assert/strict'
import { parseXer, detectP6 } from '../src/io/p6.js'

/* P6 ingestion (spec §3 input 5). XER is plain tab-delimited text with
   %T (table) / %F (fields) / %R (row) records; the XLSX activity export is a
   plain sheet. Both are strictly optional inputs — nothing downstream may
   require them. */

const XER = [
  'ERMHDR\t19.12\t2026-08-03',
  '%T\tPROJECT',
  '%F\tproj_id\tproj_short_name',
  '%R\t100\tEAGLE',
  '%T\tTASK',
  '%F\ttask_id\ttask_code\ttask_name\ttask_type',
  '%R\t1001\tA1000\tL2-M1-1118 - UPN 114 CW Condenser Water Enabling\tTT_Mile',
  '%R\t1002\tA1010\tInstall CT114 Cooling Tower\tTT_Task',
  '%R\t1003\tA1020\tL2-M1-1129 - UPN 261 AWN Enabling System\tTT_FinMile',
  '%T\tTASKPRED',
  '%F\ttask_pred_id\ttask_id\tpred_task_id\tpred_type',
  '%R\t5001\t1002\t1001\tPR_FS',
  '%E',
].join('\n')

test('parseXer extracts tasks, milestone flags, and predecessor links', () => {
  const p6 = parseXer(XER)
  assert.equal(p6.tasks.length, 3)
  const mile = p6.tasks.find(t => t.code === 'A1000')
  assert.equal(mile.milestone, true)
  assert.equal(mile.name, 'L2-M1-1118 - UPN 114 CW Condenser Water Enabling')
  assert.equal(p6.tasks.find(t => t.code === 'A1010').milestone, false)
  assert.equal(p6.tasks.find(t => t.code === 'A1020').milestone, true, 'TT_FinMile counts as a milestone')
  assert.deepEqual(p6.links, [{ taskId: '1002', predTaskId: '1001' }])
})

test('parseXer tolerates unknown tables and empty input', () => {
  assert.deepEqual(parseXer(''), { tasks: [], links: [] })
  assert.deepEqual(parseXer('%T\tRSRC\n%F\trsrc_id\n%R\t9'), { tasks: [], links: [] })
})

test('detectP6 anchors on Activity ID + Activity Name with optional equipment and UPN columns', () => {
  const info = detectP6(['Activity ID', 'Activity Name', 'Equipment ID', 'UPN', 'Start', 'Finish'])
  assert.equal(info.activityId, 0)
  assert.equal(info.activityName, 1)
  assert.equal(info.equipmentId, 2)
  assert.equal(info.upn, 3)
  const minimal = detectP6(['Activity ID', 'Activity Name'])
  assert.equal(minimal.equipmentId, -1)
  assert.equal(minimal.upn, -1)
  assert.equal(detectP6(['Task', 'Description']), null, 'no anchors means no detection')
})
