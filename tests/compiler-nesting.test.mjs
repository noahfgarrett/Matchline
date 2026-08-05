import test from 'node:test'
import assert from 'node:assert/strict'
import { buildProjectApp, canonicalRecordOf } from './support/compiler-harness.mjs'

/* Nesting proposals (spec §5, propose-don't-assume): Equipment Description
   decides the role, number nomenclature picks the instance, and the result is
   a PROPOSAL — Completed MEL cell + review queue — never a silent claim. */

const EXTO = ['easy-power.xlsx', 'compiler-cable.xlsx', 'compiler-mel.xlsx', 'compiler-extoreg.xlsx', 'compiler-imtemplate.xlsx']

function record(app, tag) {
  return JSON.parse(app.eval(`
    JSON.stringify((function () {
      const r = S.canonicalModel.get(tagKey(${JSON.stringify(tag)}));
      return r ? { parent: r.ssmParentTag, proposal: r.nestingProposal || null,
        classification: (r.attributes && r.attributes.equipmentClassification) || null } : null;
    })())
  `))
}

test('a child-class device proposes the same-partition equipment sharing its number', async () => {
  const app = await buildProjectApp(EXTO)
  const tt = record(app, 'B14-TT-7001-02A')
  assert.equal(tt.classification, 'TT', 'description classified the transmitter')
  assert.equal(tt.parent, '', 'no evidence-based parent — this is exactly the gap proposals fill')
  assert.ok(tt.proposal, 'proposal exists')
  assert.equal(tt.proposal.parent, 'B14-AHU-7001', 'AHU shares the 7001 number and TT→AHU is the learned convention')
  assert.equal(tt.proposal.rule, 'role-affinity')
})

test('a tag that extends another tag proposes its container deterministically', async () => {
  const app = await buildProjectApp(EXTO)
  const psu = record(app, 'B14-RIO-6500-PS1')
  assert.ok(psu.proposal, 'containment proposal exists')
  assert.equal(psu.proposal.parent, 'B14-RIO-6500')
  assert.equal(psu.proposal.rule, 'containment')
})

test('proposals never become structural parents on their own', async () => {
  const app = await buildProjectApp(EXTO)
  for (const tag of ['B14-TT-7001-02A', 'B14-RIO-6500-PS1']) {
    assert.equal(record(app, tag).parent, '', `${tag} stays a root until a human accepts the proposal`)
  }
})

test('proposals surface in the Completed MEL and the QA sheets', async () => {
  const app = await buildProjectApp(EXTO)
  const sheets = JSON.parse(app.eval(`
    JSON.stringify((function () {
      const wb = XLSX.utils.book_new(), used = new Set();
      addCompletedMelSheet(wb, used); addQaSheets(wb, used);
      return {
        mel: XLSX.utils.sheet_to_json(wb.Sheets['Completed MEL'], { header: 1, defval: '' }),
        exceptions: XLSX.utils.sheet_to_json(wb.Sheets['QA Exceptions'], { header: 1, defval: '' }),
      };
    })())
  `))
  const tt = sheets.mel.find(row => /TT-7001-02A/.test(row[0]))
  assert.equal(tt[7], 'B14-AHU-7001', 'proposal fills the Proposed System Parent cell')
  assert.match(tt[9], /Nesting proposal/, 'rationale rides in Provenance')
  assert.ok(sheets.exceptions.some(row => row[0] === 'Nesting proposal' && /TT-7001-02A/.test(row[1])))
})

test('without a registry the proposal layer is inert', async () => {
  const app = await buildProjectApp(['easy-power.xlsx', 'compiler-cable.xlsx', 'compiler-mel.xlsx'])
  const psu = record(app, 'B14-RIO-6500-PS1')
  assert.equal(psu.proposal, null, 'no learning source, no proposals')
})
