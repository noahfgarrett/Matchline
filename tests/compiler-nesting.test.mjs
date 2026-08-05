import test from 'node:test'
import assert from 'node:assert/strict'
import { buildProjectApp } from './support/compiler-harness.mjs'

/* Graded nesting inference (spec §5): Equipment Description decides the role,
   number nomenclature picks the instance, and the model SELF-GRADES per class
   against the registry's own Closest Parent answers. Claim-grade classes build
   the hierarchy (lowest priority — evidence outranks); the rest stay proposals
   for the review/massage pass. */

const CORE = ['easy-power.xlsx', 'compiler-ep.xlsx', 'compiler-cable.xlsx', 'compiler-mel.xlsx']
const EXTO = [...CORE, 'compiler-extoreg.xlsx', 'compiler-imtemplate.xlsx']

function record(app, tag) {
  return JSON.parse(app.eval(`
    JSON.stringify((function () {
      const r = S.canonicalModel.get(tagKey(${JSON.stringify(tag)}));
      return r ? { parent: r.ssmParentTag, inference: r.nestingInference || null,
        provenance: r.provenance, deps: [...r.dependencies] } : null;
    })())
  `))
}

test('a claim-grade class builds the hierarchy: TT nests under its numbered AHU', async () => {
  const app = await buildProjectApp(EXTO)
  const tt = record(app, 'B14-TT-7001-02A')
  assert.equal(tt.inference.grade, 'claim', 'TT self-graded at 100% on the fixture registry')
  assert.equal(tt.parent, 'B14-AHU-7001', 'inferred claim became the structural parent')
  assert.ok(tt.provenance.some(entry => /Nesting \(inferred claim\)/.test(entry)))
})

test('containment is claim-grade: the PSU nests under the tag it extends', async () => {
  const app = await buildProjectApp(EXTO)
  const psu = record(app, 'B14-RIO-6500-PS1')
  assert.equal(psu.inference.rule, 'containment')
  assert.equal(psu.parent, 'B14-RIO-6500')
})

test('a propose-grade class stays a root with a reviewable proposal', async () => {
  const app = await buildProjectApp(EXTO)
  const pt = record(app, 'B14-PT-7001-01')
  assert.equal(pt.inference.grade, 'propose', 'PT nested inconsistently in the registry — not trusted to claim')
  assert.equal(pt.parent, '', 'proposal does not build the hierarchy')
  const qa = JSON.parse(app.eval(`
    JSON.stringify((function () {
      const wb = XLSX.utils.book_new(), used = new Set();
      addQaSheets(wb, used);
      return XLSX.utils.sheet_to_json(wb.Sheets['QA Exceptions'], { header: 1, defval: '' });
    })())
  `))
  assert.ok(qa.some(row => row[0] === 'Nesting proposal' && /PT-7001-01/.test(row[1])))
  assert.ok(qa.some(row => row[0] === 'Nesting applied (inferred)' && /TT-7001-02A/.test(row[1])))
})

test('evidence always outranks inference', async () => {
  const app = await buildProjectApp(EXTO)
  const fcu = record(app, 'B14-FCU-7101')
  assert.equal(fcu.parent, 'B14-AHU-7001', 'the MEL System Parent assertion, not inference, holds the slot')
  const mtr = record(app, 'MTR-9001')
  assert.equal(mtr.parent, 'B14-AHU-7001', 'the cable claim holds the slot')
})

test('the Electrical Flow view lists what an instrument controls beneath it', async () => {
  const app = await buildProjectApp(EXTO)
  const found = JSON.parse(app.eval(`
    JSON.stringify((function () {
      let hit = null
      const walk = node => {
        if (/TT-7001-02A/i.test(node.name)) {
          const ref = node.children.find(child => child.isControlsRef)
          if (ref) hit = ref.name
        }
        node.children.forEach(walk)
      }
      S.roots.forEach(walk)
      return hit
    })())
  `))
  assert.equal(found, 'controls → B14-AHU-7001')
})

test('without a registry the inference layer is inert', async () => {
  const app = await buildProjectApp(CORE)
  const psu = record(app, 'B14-RIO-6500-PS1')
  assert.equal(psu.inference, null)
  assert.equal(psu.parent, '')
})
