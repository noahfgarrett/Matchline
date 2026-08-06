import assert from 'node:assert/strict'
import test from 'node:test'
import { buildProjectApp } from './support/compiler-harness.mjs'

test('PMD power variants converge on one MEL parent without aborting the build', async () => {
  const app = await buildProjectApp(['easy-power-pmd-variants.xlsx', 'pmd-building-prefix.xlsx'])
  const result = JSON.parse(await app.evalAsync(`
    const rows = [
      ['Equipment Tag', 'UPN', 'Building', 'Discipline', 'System Description'],
      ['OO44-RIO-1', '650', 'OO44', 'I&C', 'Control System'],
    ]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Equipment_List')
    S.files.push({ id: 'canonical-pmd-mel', name: 'canonical-pmd-mel.xlsx', ext: 'xlsx', size: 1,
      wb, sheets: wb.SheetNames.slice(), strikes: new Map(), error: null })
    await prewarmSheets()
    const ok = await buildHierarchy()
    if (!ok) return JSON.stringify({ ok })

    const paths = roots => {
      const found = []
      const walk = (node, path) => {
        const next = [...path, node.name]
        if (/TET-100$/i.test(node.name)) found.push(next)
        node.children.forEach(child => walk(child, next))
      }
      roots.forEach(root => walk(root, []))
      return found
    }
    const record = S.canonicalModel.get(tagKey('TET-100'))
    return JSON.stringify({
      ok,
      parent: record && record.ssmParentTag,
      resolution: record && record.resolution && record.resolution.parentResolution,
      flowPaths: paths(S.projections['electrical-flow'].roots),
      ssmPaths: paths(S.projections.ssm.roots),
      registerRows: S.ssmCombined.filter(row => tagKey(row[0]) === tagKey('TET-100')),
    })
  `))

  assert.equal(result.ok, true)
  assert.equal(result.parent, 'OO44-RIO-1')
  assert.equal(result.resolution.status, 'resolved')
  assert.equal(result.resolution.provenance[0].provenance.count, 2,
    'both NPS and CPS PMD observations remain as support for the canonical parent')
  assert.deepEqual(result.resolution.provenance[0].provenance.claimedParents,
    ['RIO-1_NPS', 'RIO-1_CPS'])
  assert.equal(result.flowPaths.length, 2,
    'Electrical Flow preserves one instrument occurrence under each matched power variant')
  assert.deepEqual(result.ssmPaths, [
    ['OO44', 'I&C', '650 Control System', 'OO44-RIO-1', 'TET-100'],
  ])
  assert.deepEqual(result.registerRows, [['TET-100', 'OO44-RIO-1', '']])
})
