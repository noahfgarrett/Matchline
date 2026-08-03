import assert from 'node:assert/strict'
import { test } from 'node:test'
import { legendBuildProposals, legendConsistentSegment, legendEscapeRegex, legendInsertIndex, legendPreselect } from '../src/legend/proposals.js'
import { legendBuildCorpus, legendEmptyCorpus } from '../src/legend/corpus.js'
import { legendMakeEntry } from '../src/legend/model.js'
import { makeDefaultProfile, normalizeProfile, profileClone } from '../src/profile/schema.js'
import { compileRuleProfile } from '../src/rules/profile-compiler.js'
import { legendApplyProposals } from '../src/legend/impact.js'

/* A bare profile: no inherited rules, so proposals are the only thing acting. */
function bareProfile() {
  const profile = normalizeProfile(makeDefaultProfile('Site'))
  profile.anatomies = []
  profile.rules = { normalize: [], classify: [], relate: [] }
  profile.mappings = { easyPower: { headerRow: 0, fields: { startingSource: 0, idName: 1 } } }
  return profile
}

const TAG_SHEET = [
  ['Starting Source', 'ID Name'],
  ['ZZ9-QQQ-0001', 'ZZ9-RRR-0002'],
  ['ZZ9-QQQ-0003', 'ZZ9-SSS-0004'],
  ['YY8-RRR-0005', 'YY8-QQQ-0006'],
]

const corpusFor = profile => legendBuildCorpus(
  [{ fileId: 'f', sheet: 'S', sourceKind: 'easyPower', aoa: TAG_SHEET }], profile)

const abbreviation = (code, meaning, targetHint) =>
  legendMakeEntry({ kind: 'abbreviation', code, meaning, targetHint, sourceId: 'source-1', page: 1, parserConfidence: 0.95 })

const anatomyEntry = () => legendMakeEntry({
  kind: 'tag-anatomy', sourceId: 'source-1', page: 1, parserConfidence: 0.9,
  detail: { form: 'anatomy', delimiter: '-', sample: 'ZZ9-QQQ-0001', segments: [
    { index: 0, attribute: 'building' }, { index: 1, attribute: 'equipmentType' }, { index: 2, attribute: 'matchKey' },
  ] },
})

/* ---------------------------------------------------------------------------
 * Anatomy is preferred over a rule per code
 * ------------------------------------------------------------------------- */

test('an anatomy plus one generic segment rule replaces a rule per abbreviation', () => {
  // Sixty codes must not become sixty rules. A profile nobody can read is a
  // profile nobody can correct.
  const profile = bareProfile()
  const entries = [
    anatomyEntry(),
    ...['QQQ', 'RRR', 'SSS', 'TTT', 'UUU', 'VVV'].map(code => abbreviation(code, code + ' equipment', 'equipmentType')),
  ]
  const proposals = legendBuildProposals(entries, profile, corpusFor(profile))
  const classify = proposals.filter(proposal => proposal.family === 'classify')

  assert.equal(proposals.filter(proposal => proposal.family === 'anatomy').length, 1)
  assert.equal(classify.length, 1, `expected one generic rule, got ${classify.length}`)
  assert.equal(classify[0].rule.kind, 'segment')
  assert.equal(classify[0].rule.segment, 'equipmentType')
  assert.equal(classify[0].entryIds.length, 6, 'all six abbreviations back the one rule')
})

test('without an anatomy, bounded per-code rules are generated instead', () => {
  const profile = bareProfile()
  const entries = ['QQQ', 'RRR'].map(code => abbreviation(code, code + ' equipment', 'equipmentType'))
  const proposals = legendBuildProposals(entries, profile, corpusFor(profile))
  const classify = proposals.filter(proposal => proposal.family === 'classify')
  assert.equal(classify.length, 2)
  for (const proposal of classify) {
    assert.equal(proposal.rule.kind, 'pattern')
    assert.ok(/\(\^\|-\)/.test(proposal.rule.pattern) || /^\^/.test(proposal.rule.pattern),
      `pattern must be anchored to a delimiter boundary, got ${proposal.rule.pattern}`)
  }
})

test('a code the project never uses produces no rule at all', () => {
  const profile = bareProfile()
  const proposals = legendBuildProposals(
    [abbreviation('WWW', 'Not used on this site', 'equipmentType')], profile, corpusFor(profile))
  assert.equal(proposals.filter(proposal => proposal.family === 'classify').length, 0,
    'a code with no corpus support is not worth a rule')
})

test('a character-range statement produces a slice rule, not an anatomy', () => {
  // Found in the browser: "Characters 1 through 3 indicate Building" parsed
  // into knowledge but generated nothing, because only anatomy and segment
  // forms were being converted. A character range is a positional claim that
  // only READS the tag, so it is a Classify slice -- not an anatomy, which
  // would restructure identity.
  const profile = bareProfile()
  const entry = legendMakeEntry({
    kind: 'tag-anatomy', sourceId: 'source-1', page: 1, parserConfidence: 0.8,
    detail: { form: 'slice', start: 0, end: 3, attribute: 'building' },
  })
  const proposals = legendBuildProposals([entry], profile, corpusFor(profile))
  assert.equal(proposals.length, 1, JSON.stringify(proposals.map(p => p.title)))
  const [proposal] = proposals
  assert.equal(proposal.family, 'classify')
  assert.equal(proposal.rule.kind, 'slice')
  assert.equal(proposal.rule.start, 0)
  assert.equal(proposal.rule.end, 3)
  assert.equal(proposal.target, 'building')
  assert.equal(proposal.risk, 'low')

  const validation = compileRuleProfile(legendApplyProposals(profile, proposals), { allowUnmapped: true })
  assert.equal(validation.ok, true, JSON.stringify(validation.errors && validation.errors.slice(0, 2)))
})

test('a slice feeding matchKey is medium risk, because it re-parents rather than relabels', () => {
  const profile = bareProfile()
  const entry = legendMakeEntry({
    kind: 'tag-anatomy', sourceId: 'source-1',
    detail: { form: 'slice', start: 8, end: 12, attribute: 'matchKey' },
  })
  assert.equal(legendBuildProposals([entry], profile, corpusFor(profile))[0].risk, 'medium')
})

/* ---------------------------------------------------------------------------
 * Regex safety
 * ------------------------------------------------------------------------- */

test('document text is escaped before it reaches a pattern', () => {
  assert.equal(legendEscapeRegex('A/B (typ.)'), 'A/B \\(typ\\.\\)')
  assert.equal(legendEscapeRegex('.*'), '\\.\\*')

  const profile = bareProfile()
  const aoa = [['Starting Source', 'ID Name'], ['A.C', 'X.Y'], ['ABC', 'XYZ']]
  const corpus = legendBuildCorpus([{ fileId: 'f', sheet: 'S', sourceKind: 'easyPower', aoa }], profile)
  const proposals = legendBuildProposals([abbreviation('A.C', 'Dotted code', 'equipmentType')], profile, corpus)
  const rule = proposals.find(proposal => proposal.family === 'classify')
  assert.ok(rule, 'the dotted code is in the corpus, so it should propose')
  const compiled = new RegExp(rule.rule.pattern, 'i')
  assert.equal(compiled.test('A.C'), true)
  assert.equal(compiled.test('ABC'), false, 'an unescaped dot would match ABC too')
})

test('a generated anatomy pattern is anchored', () => {
  const profile = bareProfile()
  const proposal = legendBuildProposals([anatomyEntry()], profile, corpusFor(profile))
    .find(item => item.family === 'anatomy')
  assert.ok(proposal.rule.pattern.startsWith('^'), 'an unanchored anatomy would claim unrelated tags')
  assert.ok(proposal.rule.pattern.endsWith('$'))
})

/* ---------------------------------------------------------------------------
 * Evidence thresholds
 * ------------------------------------------------------------------------- */

test('a Normalize rule is only proposed from an explicit statement', () => {
  const profile = bareProfile()
  const fromAbbreviation = legendBuildProposals(
    [abbreviation('A', 'Panel side A', 'equipmentType')], profile, corpusFor(profile))
  assert.equal(fromAbbreviation.filter(proposal => proposal.family === 'normalize').length, 0,
    'an abbreviation is not evidence for an identity change')

  const fromStatement = legendBuildProposals([legendMakeEntry({
    kind: 'normalization', sourceId: 'source-1', page: 1, parserConfidence: 0.8,
    detail: { form: 'stripSuffix', suffixes: ['A', 'B'] },
  })], profile, corpusFor(profile))
  assert.equal(fromStatement.filter(proposal => proposal.family === 'normalize').length, 1)
})

test('a relationship rule is only proposed from explicit parent language', () => {
  const profile = bareProfile()
  const none = legendBuildProposals(
    [abbreviation('QQQ', 'Some equipment parented somewhere', 'equipmentType')], profile, corpusFor(profile))
  assert.equal(none.filter(proposal => proposal.family === 'relate').length, 0)

  const stated = legendBuildProposals([legendMakeEntry({
    kind: 'relationship', sourceId: 'source-1', page: 1, parserConfidence: 0.8,
    detail: { form: 'attributeMatch', childType: 'QQQ', parentType: 'RRR', matchOn: 'matchKey' },
  })], profile, corpusFor(profile))
  assert.equal(stated.filter(proposal => proposal.family === 'relate').length, 1)
})

test('a code the document defines two ways produces no rule', () => {
  const profile = bareProfile()
  const clashing = [
    abbreviation('QQQ', 'One meaning', 'equipmentType'),
    abbreviation('QQQ', 'A different meaning', 'equipmentType'),
  ]
  clashing.forEach(entry => { entry.unresolved = true })
  assert.equal(legendBuildProposals(clashing, profile, corpusFor(profile)).length, 0,
    'picking one reading would bury a real drafting inconsistency')
})

test('reference-only knowledge never becomes a proposal', () => {
  const profile = bareProfile()
  const entries = [legendMakeEntry({ kind: 'reference-only', meaning: 'Coordinate with the mechanical contractor.', sourceId: 'source-1' })]
  assert.deepEqual(legendBuildProposals(entries, profile, corpusFor(profile)), [])
})

/* ---------------------------------------------------------------------------
 * Determinism, duplicates, ordering
 * ------------------------------------------------------------------------- */

test('proposal ids are deterministic and carry no timestamp', () => {
  const profile = bareProfile()
  const entries = [anatomyEntry(), abbreviation('QQQ', 'Q equipment', 'equipmentType')]
  const first = legendBuildProposals(entries, profile, corpusFor(profile)).map(proposal => proposal.id)
  const second = legendBuildProposals(entries, profile, corpusFor(profile)).map(proposal => proposal.id)
  assert.deepEqual(first, second)
  for (const id of first) {
    assert.ok(id.startsWith('legend-'), id)
    assert.equal(/\d{13}/.test(id), false, `${id} looks like it contains a timestamp`)
  }
})

test('a semantically identical existing rule is reported as already covered', () => {
  const profile = bareProfile()
  const entries = [anatomyEntry(), abbreviation('QQQ', 'Q equipment', 'equipmentType')]
  const first = legendBuildProposals(entries, profile, corpusFor(profile))

  // Accept them, then re-analyze the same document.
  const updated = legendApplyProposals(profile, first)
  const second = legendBuildProposals(entries, updated, corpusFor(updated))
  for (const proposal of second) {
    assert.ok(proposal.duplicateOf, `${proposal.title} should be recognised as already covered`)
  }
})

test('re-analyzing the same page merges provenance instead of duplicating the rule', () => {
  const profile = bareProfile()
  const entries = [
    anatomyEntry(),
    abbreviation('QQQ', 'Q equipment', 'equipmentType'),
    abbreviation('RRR', 'R equipment', 'equipmentType'),
  ]
  const proposals = legendBuildProposals([...entries, ...entries], profile, corpusFor(profile))
  const classify = proposals.filter(proposal => proposal.family === 'classify')
  assert.equal(classify.length, 1, 'the duplicated page must not produce a second rule')
})

test('a legend rule sits ahead of an inherited fallback but behind an authored rule', () => {
  const rules = [
    { id: 'authored-1', target: 'equipmentType' },
    { id: 'inherited-1', target: 'equipmentType' },
    { id: 'inherited-2', target: 'building' },
  ]
  const baseIds = new Set(['inherited-1', 'inherited-2'])
  assert.equal(legendInsertIndex(rules, 'equipmentType', baseIds), 1,
    'it must displace the inherited fallback, not the authored rule')
  assert.equal(legendInsertIndex(rules, 'system', baseIds), rules.length,
    'with no inherited rule for the target it appends and displaces nothing')
  assert.equal(legendInsertIndex(rules, 'equipmentType', new Set()), rules.length,
    'with nothing inherited at all it appends')
})

test('a consistent segment position is only claimed when the codes agree', () => {
  const profile = bareProfile()
  const corpus = corpusFor(profile)
  const agreeing = legendConsistentSegment([{ code: 'QQQ' }, { code: 'RRR' }, { code: 'SSS' }], corpus)
  assert.ok(agreeing, 'these codes all sit at segment 1')
  assert.equal(agreeing.index, 1)
  assert.equal(legendConsistentSegment([{ code: 'NOPE' }, { code: 'ALSONOPE' }], corpus), null)
  assert.equal(legendConsistentSegment([], corpus), null)
  assert.equal(legendConsistentSegment([{ code: 'QQQ' }], legendEmptyCorpus()), null)
})

/* ---------------------------------------------------------------------------
 * Preselection
 * ------------------------------------------------------------------------- */

test('a high-risk proposal is never preselected, however confident', () => {
  const proposal = { id: 'p', risk: 'high', confidence: 1, matches: 500, duplicateOf: '' }
  const result = legendPreselect(proposal, { corpusLoaded: true, compiles: true, effectiveMatches: 500 })
  assert.equal(result.preselected, false)
  assert.match(result.blockedReason, /High-risk/)
})

test('nothing is preselected without a project corpus', () => {
  const proposal = { id: 'p', risk: 'low', confidence: 1, matches: 0, duplicateOf: '' }
  const result = legendPreselect(proposal, { corpusLoaded: false, compiles: true, effectiveMatches: 0 })
  assert.equal(result.preselected, false)
  assert.match(result.blockedReason, /Unverified/)
})

test('every preselection condition is individually blocking', () => {
  const base = { id: 'p', risk: 'low', confidence: 0.95, matches: 12, duplicateOf: '' }
  const ok = { corpusLoaded: true, compiles: true, effectiveMatches: 12, conflicts: 0, collisions: 0, fullyShadowed: false }
  assert.equal(legendPreselect(base, ok).preselected, true, 'control: all conditions met')

  for (const [label, override] of [
    ['no effective match', { effectiveMatches: 0 }],
    ['a conflicting assignment', { conflicts: 1 }],
    ['an identity collision', { collisions: 1 }],
    ['fully shadowed', { fullyShadowed: true }],
    ['compile failure', { compiles: false }],
  ]) {
    assert.equal(legendPreselect(base, { ...ok, ...override }).preselected, false, `${label} must block preselection`)
  }
  assert.equal(legendPreselect({ ...base, confidence: 0.5 }, ok).preselected, false, 'low confidence must block')
  assert.equal(legendPreselect({ ...base, duplicateOf: 'rule-1' }, ok).preselected, false, 'a duplicate must block')
})

/* ---------------------------------------------------------------------------
 * The generated rules must be real, valid profile rules
 * ------------------------------------------------------------------------- */

test('every generated rule family compiles inside a real profile', () => {
  const profile = bareProfile()
  const entries = [
    anatomyEntry(),
    abbreviation('QQQ', 'Q equipment', 'equipmentType'),
    legendMakeEntry({ kind: 'normalization', sourceId: 'source-1', detail: { form: 'stripSuffix', suffixes: ['A', 'B'] } }),
    legendMakeEntry({ kind: 'relationship', sourceId: 'source-1', detail: { form: 'attributeMatch', childType: 'QQQ', parentType: 'RRR', matchOn: 'matchKey' } }),
    legendMakeEntry({ kind: 'relationship', sourceId: 'source-1', detail: { form: 'prefixSplit', delimiter: '_' } }),
    legendMakeEntry({ kind: 'hierarchy-root', sourceId: 'source-1', detail: { form: 'constant', equipmentType: 'QQQ', parent: '602 Medium Voltage' } }),
  ]
  const proposals = legendBuildProposals(entries, profile, corpusFor(profile))
  const families = new Set(proposals.map(proposal => proposal.family))
  assert.deepEqual([...families].sort(), ['anatomy', 'classify', 'normalize', 'relate'])

  const candidate = legendApplyProposals(profile, proposals)
  const validation = compileRuleProfile(candidate, { allowUnmapped: true })
  assert.equal(validation.ok, true,
    `generated rules failed validation: ${JSON.stringify(validation.errors && validation.errors.slice(0, 3))}`)
})

test('building proposals does not mutate the profile it is given', () => {
  const profile = bareProfile()
  const before = JSON.stringify(profile)
  legendBuildProposals([anatomyEntry(), abbreviation('QQQ', 'Q equipment', 'equipmentType')], profile, corpusFor(profile))
  assert.equal(JSON.stringify(profile), before, 'proposal generation must be free of side effects')
})

test('proposals against an empty corpus are all marked unverified', () => {
  const profile = bareProfile()
  const proposals = legendBuildProposals(
    [anatomyEntry(), abbreviation('QQQ', 'Q equipment', 'equipmentType')], profile, legendEmptyCorpus())
  assert.ok(proposals.length > 0, 'knowledge is still worth keeping without a corpus')
  for (const proposal of proposals) {
    assert.equal(proposal.unverified, true, `${proposal.title} should be marked unverified`)
  }
})

test('applying proposals leaves the source profile untouched', () => {
  const profile = bareProfile()
  const proposals = legendBuildProposals([anatomyEntry()], profile, corpusFor(profile))
  const snapshot = JSON.stringify(profile)
  const candidate = legendApplyProposals(profile, proposals)
  assert.equal(JSON.stringify(profile), snapshot)
  assert.equal(candidate.anatomies.length, 1)
  assert.notEqual(candidate.anatomies[0], profileClone(proposals[0].rule), 'the candidate holds its own copy')
})
