import assert from 'node:assert/strict'
import { test } from 'node:test'
import { captureLegacyComparableScenario, FROZEN_SSM_BUILDER } from './support/legacy-differential.mjs'
import { loadApp } from './support/harness.mjs'
import { SCENARIOS } from './support/snapshot.mjs'

const legacyCore = snapshot => ({
  roots: snapshot.roots,
  register: snapshot.register,
  sheets: snapshot.sheets,
  review: snapshot.review,
  compare: snapshot.compare,
  stats: {
    nodes: snapshot.stats.nodes,
    leaves: snapshot.stats.leaves,
    maxDepth: snapshot.stats.maxDepth,
    rowsRead: snapshot.stats.rowsRead,
    loads: snapshot.stats.loads,
    instruments: snapshot.stats.instruments,
    deps: snapshot.stats.deps,
  },
})

for (const scenario of SCENARIOS) {
  test(`Eagle data output exactly matches frozen SSM Builder v1.1.37: ${scenario.name}`, async () => {
    const legacy = await captureLegacyComparableScenario(scenario, FROZEN_SSM_BUILDER)
    const eagle = await captureLegacyComparableScenario(scenario)
    assert.deepEqual(legacyCore(eagle), legacyCore(legacy))
    assert.deepEqual(eagle.placements,legacy.placements)
    assert.equal(eagle.stats.review,legacy.stats.review)
  })
}

for (const scenario of [
  {name:'downstream-gap-row-order',files:['downstream-gap.xlsx']},
  {name:'case-variant-occurrences',files:['case-variants.xlsx']},
  {name:'duplicate-parent-first-wins',files:['duplicate-parents.xlsx']},
  {name:'PMD panel matched to two power variants',files:['easy-power-pmd-variants.xlsx','pmd-building-prefix.xlsx']},
]) {
  test(`Eagle preserves a frozen edge contract: ${scenario.name}`, async () => {
    const legacy=await captureLegacyComparableScenario(scenario,FROZEN_SSM_BUILDER)
    const eagle=await captureLegacyComparableScenario(scenario)
    assert.deepEqual(legacyCore(eagle),legacyCore(legacy))
    assert.deepEqual(eagle.placements,legacy.placements)
    assert.equal(eagle.stats.review,legacy.stats.review)
  })
}

test('Eagle visible Electrical Flow repeats PMD instruments under every matching load variant', async () => {
  const scenario={files:['easy-power-pmd-variants.xlsx','pmd-building-prefix.xlsx']}
  const snapshot=await captureLegacyComparableScenario(scenario)
  const occurrences=[]
  const walk=(node,path=[])=>{
    const next=[...path,node.name]
    if(node.isInstrument)occurrences.push(next)
    node.kids.forEach(child=>walk(child,next))
  }
  snapshot.roots.forEach(root=>walk(root))
  assert.equal(occurrences.filter(path=>path.at(-1)==='OO44-TET-100').length,2)
  assert.equal(occurrences.filter(path=>path.at(-1)==='OO44-TIV-200').length,2)
  assert.ok(occurrences.some(path=>path.includes('RIO-1_NPS')))
  assert.ok(occurrences.some(path=>path.includes('RIO-1_CPS')))
  assert.equal(snapshot.register.filter(row=>row[0]==='TET-100').length,1)
  assert.equal(snapshot.register.filter(row=>row[0]==='TIV-200').length,1)
})

test('Eagle tag and row helpers match frozen SSM Builder across a generated edge corpus', async () => {
  const legacy = await loadApp(FROZEN_SSM_BUILDER)
  const eagle = await loadApp()
  // Eagle explicitly: this compares helper output against the frozen builder,
  // so it must be the compatibility profile and not whatever a first run picks.
  eagle.eval(`initProfiles(); PROFILE_STORE.activeId = 'builtin-eagle'; setRuleProfile(activeProfile());`)
  const bases = [
    'MCC-01', 'B14-LVS-1234', 'GIS-01', 'B14-XFM-9', 'PNL-1', 'SCR-02', 'SCC-03',
    'BUS-1', 'GIS-BUS-1', 'R22-MAH777-99-00_MED-B', 'PDU-SCR-239JEF_D-7_CPS',
    'NOTE', 'SPARE', 'SPACE',
  ]
  const suffixes = [
    '', '-A', '-B', '-P', '-S', '-OUTPUT', '-A-B', '-a', '_CPS', '_NPS', '_cps',
    '-A_CPS', '-P-S', '-OUTPUT-A', '_nps', '-B_NPS',
  ]
  const tags = [...new Set(bases.flatMap(base => suffixes.map(suffix => base + suffix)))]
  const expression = `JSON.stringify((${JSON.stringify(tags)}).map(tag => ({
    tag,
    identity: cleanTag(tag),
    matching: stripPowerVariant(tag),
    equipmentRole: equipmentRole(tag),
    matchKey: equipmentSuffix(tag),
    spare: isSpareName(tag),
    space: isSpaceName(tag),
    note: isNote(tag),
    topology: gisBusCut(['ROOT', tag, 'BUS-1', 'TAIL']),
    loadRelation: loadSsmRelation(tag, 'FINAL', tag)
  })))`
  assert.deepEqual(JSON.parse(eagle.eval(expression)), JSON.parse(legacy.eval(expression)))
})
