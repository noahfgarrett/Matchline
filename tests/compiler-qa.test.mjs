import test from 'node:test'
import assert from 'node:assert/strict'
import { buildProjectApp } from './support/compiler-harness.mjs'

/* QA scorecard, UPN predecessor matrix, and the EXTO profile column map
   (spec §8.1, §8.3, §8.4). */

const CORE = ['easy-power.xlsx', 'compiler-cable.xlsx', 'compiler-mel.xlsx']

function exportSheets(app, expr) {
  return JSON.parse(app.eval(`
    JSON.stringify((function () {
      const wb = XLSX.utils.book_new(), used = new Set();
      ${expr}
      const out = {};
      for (const name of wb.SheetNames) out[name] = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' });
      return out;
    })())
  `))
}

test('the predecessor matrix derives the one-pager from cross-partition dependencies', async () => {
  const app = await buildProjectApp(CORE)
  const sheets = exportSheets(app, `addPredecessorMatrixSheet(wb, used);`)
  const edges = sheets['UPN Predecessors']
  assert.deepEqual(edges[0], ['Predecessor UPN', 'Successor UPN', 'Via'])
  assert.ok(edges.some(row => row[0] === '1234' && row[1] === '650'), '1234 precedes 650')
  assert.ok(edges.some(row => row[0] === '1234' && row[1] === '2201'), '1234 precedes 2201')
  const matrix = sheets['UPN Matrix']
  const header = matrix[0], row1234 = matrix.find(row => row[0] === '1234')
  assert.equal(row1234[header.indexOf('650')], 'X', 'matrix cell marks 1234 → 650')
})

test('the QA scorecard reports coverage KPIs and lists exceptions', async () => {
  const app = await buildProjectApp(CORE)
  const sheets = exportSheets(app, `addQaSheets(wb, used);`)
  const kpis = new Map(sheets['QA Scorecard'].slice(1).map(row => [row[0], row[1]]))
  assert.ok(kpis.get('Register rows (non-synthetic)') > 0)
  assert.match(String(kpis.get('Tag vs MEL validation')), /%$/)
  assert.equal(kpis.get('UPN precedence cycles'), 0)
  assert.equal(kpis.get('Milestone rung 1 (direct P6 equipment match)'), 0, 'no P6 loaded — nothing on rung 1')
  assert.ok(kpis.get('Milestone rung 4 (building-ready default)') > 0)
  assert.equal(kpis.get('MEL assertions contradicting the wiring'), 1, 'MTR-9001 assertion vs cable')
  const exceptions = sheets['QA Exceptions']
  assert.ok(exceptions.some(row => row[0] === 'MEL contradiction' && /MTR-9001/.test(row[1])))
})

test('the EXTO sheet follows the Rev21 layout and attaches roots to their System Name', async () => {
  const app = await buildProjectApp(CORE)
  const byDefault = exportSheets(app, `addExtoSheet(wb, 'Exto SSM', S.ssmCombined, used);`)['Exto SSM']
  assert.equal(byDefault[1][6], 'UPN')
  assert.equal(byDefault[1][10], 'Equipment ID')
  assert.equal(byDefault[1][15], 'Closest Parent')
  assert.equal(byDefault[1][24], 'Milestone')
  assert.equal(byDefault[1][26], 'Item Master Unique Identifier')
  assert.equal(byDefault[1][39], 'Dependencies', 'Rev21 moved Dependencies to AN')
  const rioDefault = byDefault.find(row => /RIO-6500/.test(row[10]))
  assert.equal(rioDefault[15], '650 FMS Network', 'a root attaches to its own System Name, not N/A')
  const custom = exportSheets(app, `
    activeProfile().hierarchy.extoColumns = { upn: 0, equipmentId: 1, closestParent: 2, dependencies: 3, milestone: 4, itemMaster: -1 };
    addExtoSheet(wb, 'Exto SSM', S.ssmCombined, used);
  `)['Exto SSM']
  assert.deepEqual(custom[1], ['UPN', 'Equipment ID', 'Closest Parent', 'Dependencies', 'Milestone'])
  const rio = custom.find(row => /RIO-6500/.test(row[1]))
  assert.equal(rio[4], 'OP / Building Ready', 'milestone column carries the ladder label')
})
