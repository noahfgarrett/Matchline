import test from 'node:test'
import assert from 'node:assert/strict'
import { buildProjectApp } from './support/compiler-harness.mjs'

/* Compiler exports (spec §8): the register carries the partition columns, and
   the Completed MEL sheet is the flywheel — proposals fill blank System Parent
   cells with provenance, and contradictions are flagged, never overwritten. */

function sheets(app) {
  return JSON.parse(app.eval(`
    JSON.stringify((function () {
      const wb = XLSX.utils.book_new(), used = new Set();
      addSsm3Sheet(wb, 'SSM', S.ssmCombined, used);
      addCompletedMelSheet(wb, used);
      return {
        ssm: XLSX.utils.sheet_to_json(wb.Sheets['SSM'], { header: 1, defval: '' }),
        mel: XLSX.utils.sheet_to_json(wb.Sheets['Completed MEL'], { header: 1, defval: '' }),
      };
    })())
  `))
}

test('register rows carry UPN, system, building, discipline', async () => {
  const app = await buildProjectApp(['easy-power.xlsx', 'compiler-cable.xlsx', 'compiler-mel.xlsx'])
  const { ssm } = sheets(app)
  assert.deepEqual(ssm[0], ['Equipment ID', 'Closest Parent', 'Dependencies', 'UPN', 'System', 'Building', 'Discipline'])
  const rio = ssm.find(row => /RIO-6500/.test(row[0]))
  assert.ok(rio, 'seeded RIO row must be in the register')
  assert.equal(rio[1], 'N/A', 'RIO roots in its own system (register renders blank parents as N/A)')
  assert.match(rio[2], /LVS-1234/, 'demoted feeder appears as a dependency')
  assert.equal(rio[3], '650')
  assert.equal(rio[4], '650 FMS Network')
  assert.equal(rio[5], 'B14')
  assert.equal(rio[6], 'I&C')
})

test('completed MEL proposes parents for blank cells and never overwrites asserted ones', async () => {
  const app = await buildProjectApp(['easy-power.xlsx', 'compiler-cable.xlsx', 'compiler-mel.xlsx'])
  const { mel } = sheets(app)
  assert.deepEqual(mel[0], ['Equipment Tag', 'Equipment Description', 'Building', 'Discipline', 'UPN', 'System Description',
    'System Parent Equipment Tag(s)', 'Proposed System Parent', 'Proposed Dependencies', 'Provenance', 'Contradiction'])
  const xfm = mel.find(row => /XFM-1234/.test(row[0]))
  assert.equal(xfm[6], '', 'assertion column reproduces the MEL as-is')
  assert.match(xfm[7], /GIS-01/, 'blank assertion gets the derived parent proposed')
  const mtr = mel.find(row => /MTR-9001/.test(row[0]))
  assert.equal(mtr[6], 'B14-AHU-7002', 'asserted value is reproduced, not overwritten')
  assert.equal(mtr[7], '', 'no proposal where the MEL already asserts a parent')
  assert.match(mtr[10], /AHU-7001/, 'contradiction names the derived parent')
  assert.match(mtr[10], /AHU-7002/, 'contradiction names the asserted parent')
  const lvs = mel.find(row => /LVS-1234/.test(row[0]))
  assert.equal(lvs[10], '', 'agreeing assertion raises no contradiction')
})

test('every non-excluded MEL row appears in the completed MEL exactly once', async () => {
  const app = await buildProjectApp(['easy-power.xlsx', 'compiler-cable.xlsx', 'compiler-mel.xlsx'])
  const { mel } = sheets(app)
  const tags = mel.slice(1).map(row => row[0])
  assert.equal(new Set(tags).size, tags.length, 'no duplicate rows')
  assert.equal(tags.length, 6, 'all six MEL rows are present, including the Future one')
})
