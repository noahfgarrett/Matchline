import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyRelate } from '../src/rules/relate.js'
import { createMemoryLookup } from '../src/rules/lookup.js'

const MEL = createMemoryLookup([
  { tag: 'B14-SCR-2201', columns: { Building: 'B14' }, attributes: {} },
  { tag: 'B14-CIM-0001', columns: { Building: 'B14' }, attributes: {} },
  { tag: 'B14-XFM-1234', columns: {}, attributes: { equipmentType: 'XFM', matchKey: '1234' } },
  { tag: 'B14-XFM-5678', columns: {}, attributes: { equipmentType: 'XFM', matchKey: '5678' } },
  { tag: 'B99-XFM-5678', columns: {}, attributes: { equipmentType: 'XFM', matchKey: '5678' } },
])
const SOURCES = { mel: MEL }

test('fragmentLookup composes a parent from the matched record', () => {
  const rule = {
    id: 'scr', kind: 'fragmentLookup', enabled: true,
    markers: ['SCR-', 'SCC-'], source: 'mel', mode: 'containing',
    buildingFrom: 'tagBeforeFirst', buildingDelimiter: '-',
    unitFrom: 'fragmentBeforeFirst', unitDelimiter: '_',
    parent: [{ kind: 'part', name: 'building' }, { kind: 'literal', text: '-' }, { kind: 'part', name: 'unit' }],
  }
  const d = applyRelate('B14-SCR-2201', '', [rule], { sources: SOURCES })
  assert.equal(d.status, 'resolved')
  // Plan bug: the plan's test asserted 'B14-B14-SCR-2201' (a doubled "B14-"
  // prefix). Per the plan's own convention table, building = the matched MEL
  // tag up to its first '-' ('B14'), unit = the fragment up to its first '_'
  // ('SCR-2201', no underscore present so the whole fragment), giving
  // building + '-' + unit = 'B14-SCR-2201'. Corrected here; reported upstream.
  assert.equal(d.parent, 'B14-SCR-2201')
})

test('fragmentLookup yields none when the fragment is not found', () => {
  const rule = {
    id: 'scr', kind: 'fragmentLookup', enabled: true,
    markers: ['SCR-'], source: 'mel', mode: 'containing',
    buildingFrom: 'tagBeforeFirst', buildingDelimiter: '-',
    unitFrom: 'fragmentBeforeFirst', unitDelimiter: '_',
    parent: [{ kind: 'part', name: 'building' }],
  }
  assert.equal(applyRelate('ZZ-SCR-9999', '', [rule], { sources: SOURCES }).status, 'none')
})

test('fragmentLookup can read a column instead of the matched tag', () => {
  const rule = {
    id: 'cim', kind: 'fragmentLookup', enabled: true,
    markers: ['-CIM'], source: 'mel', mode: 'containing', fragmentFrom: 'wholeTag',
    parent: [{ kind: 'column', name: 'Building' }, { kind: 'literal', text: ' - CIM' }],
  }
  const d = applyRelate('B14-CIM-0001', '', [rule], { sources: SOURCES })
  assert.equal(d.status, 'resolved')
  assert.equal(d.parent, 'B14 - CIM')
})

test('prefixSplit uses the part before the delimiter when it matches', () => {
  const rule = { id: 'mah', kind: 'prefixSplit', enabled: true, delimiter: '_', pattern: '-MAH' }
  const d = applyRelate('B14-MAH-01_SEC1', '', [rule], { sources: SOURCES })
  assert.equal(d.status, 'resolved')
  assert.equal(d.parent, 'B14-MAH-01')
  assert.equal(applyRelate('B14-LVS-01_SEC1', '', [rule], { sources: SOURCES }).status, 'none')
  assert.equal(applyRelate('_LEADING', '', [rule], { sources: SOURCES }).status, 'none')
})

test('prefixSplit can transform the current parent and preserve its full tag as a dependency', () => {
  const rule={id:'mah-parent',kind:'prefixSplit',enabled:true,delimiter:'_',pattern:'-MAH',alsoCurrentParent:true}
  const d=applyRelate('B14-PNL-0700','B14-MAH-01_SEC1',[rule],{
    sources:SOURCES,rawParentTag:'B14-MAH-01_SEC1',normalizeIdentity:value=>value
  })
  assert.equal(d.status,'resolved')
  assert.equal(d.parent,'B14-MAH-01')
  assert.deepEqual(d.dependencies,['B14-MAH-01_SEC1'])
})

test('prefixSplit cleanPrefix re-strips a panel side from the extracted prefix', () => {
  // The original mahClosestParent applied cleanTag to the part before the
  // delimiter; the rule kind did not. A panel side sitting before the delimiter
  // therefore survived into the parent, naming a tag no canonical node carries:
  // the node for 'B14-MAH-01-A_CPS' is 'B14-MAH-01', not 'B14-MAH-01-A'.
  const plain = { id: 'mah', kind: 'prefixSplit', enabled: true, delimiter: '_', pattern: '-MAH' }
  const cleaned = { ...plain, cleanPrefix: true }

  assert.equal(applyRelate('B14-MAH-01-A_CPS', '', [plain], { sources: SOURCES }).parent, 'B14-MAH-01-A',
    'without cleanPrefix the panel side survives -- the behaviour being fixed')
  assert.equal(applyRelate('B14-MAH-01-A_CPS', '', [cleaned], { sources: SOURCES }).parent, 'B14-MAH-01',
    'with cleanPrefix the prefix is normalised the way every other path normalises tags')

  // A prefix with no panel side is unaffected, which is why no existing fixture
  // caught this and why the golden snapshots do not move.
  assert.equal(applyRelate('B14-MAH-01_SEC1', '', [cleaned], { sources: SOURCES }).parent, 'B14-MAH-01')
})

test('the shipped MAH rule strips a panel side before the delimiter', async () => {
  const { makeExampleProfile } = await import('../src/rules/defaults.js')
  const { createEngine } = await import('../src/rules/engine.js')
  const { cleanTag } = await import('../src/core/tags.js')
  const engine = createEngine(makeExampleProfile())
  const parentOf = tag => {
    const d = engine.relate(cleanTag(tag), '', { sources: {} })
    return d.ruleId === 'mah-parent' && d.status === 'resolved' ? d.parent : ''
  }
  assert.equal(parentOf('B14-MAH-01-A_CPS'), 'B14-MAH-01', 'the example profile must enable cleanPrefix')
  assert.equal(parentOf('B14-MAH-02-A_NPS'), 'B14-MAH-02')
  assert.equal(parentOf('B14-MAH-01_SEC1'), 'B14-MAH-01', 'the shape existing fixtures use is unchanged')
})

test('attributeMatch resolves on exactly one candidate', () => {
  const rule = {
    id: 'xfm', kind: 'attributeMatch', enabled: true, source: 'mel',
    when: { equipmentType: 'LVS' }, whenParent: { equipmentType: 'XFM' },
    match: { equipmentType: 'XFM', matchKey: '@matchKey' },
    ambiguousReason: 'Multiple MEL transformers share the matching final four characters',
    emptyReason: 'No MEL transformer has matching final four characters',
  }
  const context = { sources: SOURCES, attributes: { equipmentType: 'LVS', matchKey: '1234' }, parentAttributes: { equipmentType: 'XFM' } }
  const d = applyRelate('B14-LVS-1234', 'B14-XFM-9999', [rule], context)
  assert.equal(d.status, 'resolved')
  assert.equal(d.parent, 'B14-XFM-1234')
})

test('attributeMatch is ambiguous on several candidates, naming them', () => {
  const rule = {
    id: 'xfm', kind: 'attributeMatch', enabled: true, source: 'mel',
    when: { equipmentType: 'LVS' }, whenParent: { equipmentType: 'XFM' },
    match: { equipmentType: 'XFM', matchKey: '@matchKey' },
    ambiguousReason: 'Multiple MEL transformers share the matching final four characters',
    emptyReason: 'No MEL transformer has matching final four characters',
  }
  const context = { sources: SOURCES, attributes: { equipmentType: 'LVS', matchKey: '5678' }, parentAttributes: { equipmentType: 'XFM' } }
  const d = applyRelate('B70-LVS-5678', 'B70-XFM-0000', [rule], context)
  assert.equal(d.status, 'ambiguous')
  assert.deepEqual(d.candidates.sort(), ['B14-XFM-5678', 'B99-XFM-5678'])
  assert.match(d.reason, /Multiple MEL transformers/)
})

test('attributeMatch is ambiguous with the empty reason when nothing matches', () => {
  const rule = {
    id: 'xfm', kind: 'attributeMatch', enabled: true, source: 'mel',
    when: { equipmentType: 'LVS' }, whenParent: { equipmentType: 'XFM' },
    match: { equipmentType: 'XFM', matchKey: '@matchKey' },
    ambiguousReason: 'several', emptyReason: 'none found',
  }
  const context = { sources: SOURCES, attributes: { equipmentType: 'LVS', matchKey: '0000' }, parentAttributes: { equipmentType: 'XFM' } }
  const d = applyRelate('B70-LVS-0000', 'B70-XFM-1111', [rule], context)
  assert.equal(d.status, 'ambiguous')
  assert.deepEqual(d.candidates, [])
  assert.equal(d.reason, 'none found')
})

test('a rule whose when-guard fails is skipped entirely', () => {
  const rule = {
    id: 'xfm', kind: 'attributeMatch', enabled: true, source: 'mel',
    when: { equipmentType: 'LVS' }, whenParent: { equipmentType: 'XFM' },
    match: { equipmentType: 'XFM', matchKey: '@matchKey' }, ambiguousReason: 'a', emptyReason: 'b',
  }
  const context = { sources: SOURCES, attributes: { equipmentType: 'XFM' }, parentAttributes: { equipmentType: 'XFM' } }
  assert.equal(applyRelate('B14-XFM-1', 'B14-XFM-2', [rule], context).status, 'none')
})

test('constant applies a literal parent when its condition holds', () => {
  const rule = { id: 'gis', kind: 'constant', enabled: true, pattern: 'GIS', requiresNoParent: true, parent: '602 Medium Voltage' }
  assert.equal(applyRelate('B14-GIS-01', '', [rule], { sources: SOURCES }).parent, '602 Medium Voltage')
  assert.equal(applyRelate('B14-GIS-01', 'HAS-PARENT', [rule], { sources: SOURCES }).status, 'none')
  assert.equal(applyRelate('B14-LVS-01', '', [rule], { sources: SOURCES }).status, 'none')
})

test('the first resolved rule wins, and an ambiguous result stops the search', () => {
  const first = { id: 'a', kind: 'constant', enabled: true, pattern: 'GIS', parent: 'FIRST' }
  const second = { id: 'b', kind: 'constant', enabled: true, pattern: 'GIS', parent: 'SECOND' }
  assert.equal(applyRelate('GIS-1', '', [first, second], { sources: SOURCES }).parent, 'FIRST')

  const ambiguous = {
    id: 'amb', kind: 'attributeMatch', enabled: true, source: 'mel',
    when: {}, match: { equipmentType: 'XFM', matchKey: '5678' }, ambiguousReason: 'many', emptyReason: 'none',
  }
  const d = applyRelate('GIS-1', '', [ambiguous, second], { sources: SOURCES, attributes: {} })
  assert.equal(d.status, 'ambiguous')
  assert.equal(d.parent, '')
})

test('a rule never fires for a tag on its exclusion list', () => {
  const rule = {
    id: 'xfm', kind: 'attributeMatch', enabled: true, source: 'mel',
    when: { equipmentType: 'LVS' },
    match: { equipmentType: 'XFM', matchKey: '@matchKey' },
    ambiguousReason: 'several', emptyReason: 'none found',
  }
  const context = { sources: SOURCES, attributes: { equipmentType: 'LVS', matchKey: '1234' }, parentAttributes: {} }
  assert.equal(applyRelate('B14-LVS-1234', '', [rule], context).parent, 'B14-XFM-1234',
    'the rule resolves for this tag when nothing is excluded')
  assert.equal(applyRelate('B14-LVS-1234', '', [{ ...rule, exclusions: [] }], context).parent, 'B14-XFM-1234',
    'an empty exclusion list must behave exactly as an absent one')

  // Compared through tagKey, not raw strings, so case and separator spelling
  // do not decide whether an opt-out sticks.
  const excluded = applyRelate('B14-LVS-1234', '', [{ ...rule, exclusions: ['B14 - lvs-1234'] }], context)
  assert.equal(excluded.status, 'none')
  assert.equal(excluded.parent, '')
  assert.equal(excluded.ruleId, '')

  assert.equal(applyRelate('B14-LVS-1234', '', [{ ...rule, exclusions: ['B14-LVS-9999'] }], context).parent, 'B14-XFM-1234',
    'excluding a different tag leaves this one alone')
})

test('an excluded rule yields its turn to the next rule instead of ending the search', () => {
  const excluded = { id: 'a', kind: 'constant', enabled: true, pattern: 'GIS', parent: 'FIRST', exclusions: ['GIS-1'] }
  const fallback = { id: 'b', kind: 'constant', enabled: true, pattern: 'GIS', parent: 'SECOND' }
  assert.equal(applyRelate('GIS-1', '', [excluded, fallback], { sources: SOURCES }).parent, 'SECOND')
  assert.equal(applyRelate('GIS-2', '', [excluded, fallback], { sources: SOURCES }).parent, 'FIRST')
})

test('disabled rules are skipped', () => {
  const rule = { id: 'gis', kind: 'constant', enabled: false, pattern: 'GIS', parent: 'X' }
  assert.equal(applyRelate('GIS-1', '', [rule], { sources: SOURCES }).status, 'none')
})
