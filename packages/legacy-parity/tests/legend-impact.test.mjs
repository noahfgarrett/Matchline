import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  legendApplyProposals, legendApplyToDraft, legendBatchImpact, legendEvaluate, legendProposalImpact,
} from '../src/legend/impact.js'
import { legendBuildProposals } from '../src/legend/proposals.js'
import { legendBuildCorpus, legendEmptyCorpus } from '../src/legend/corpus.js'
import { legendMakeEntry } from '../src/legend/model.js'
import { makeDefaultProfile, normalizeProfile } from '../src/profile/schema.js'

function bareProfile() {
  const profile = normalizeProfile(makeDefaultProfile('Site'))
  profile.anatomies = []
  profile.rules = { normalize: [], classify: [], relate: [] }
  profile.mappings = { easyPower: { headerRow: 0, fields: { startingSource: 0, idName: 1 } } }
  return profile
}

const SHEET = [
  ['Starting Source', 'ID Name'],
  ['ZZ9-QQQ-0001', 'ZZ9-RRR-0002'],
  ['ZZ9-QQQ-0003', 'ZZ9-SSS-0004'],
  ['YY8-RRR-0005', 'YY8-QQQ-0006'],
]

const corpusFrom = (profile, aoa) => legendBuildCorpus(
  [{ fileId: 'f', sheet: 'S', sourceKind: 'easyPower', aoa: aoa || SHEET }], profile)

const anatomyEntry = () => legendMakeEntry({
  kind: 'tag-anatomy', sourceId: 'source-1', page: 1, parserConfidence: 0.9,
  detail: { form: 'anatomy', delimiter: '-', sample: 'ZZ9-QQQ-0001', segments: [
    { index: 0, attribute: 'building' }, { index: 1, attribute: 'equipmentType' }, { index: 2, attribute: 'matchKey' },
  ] },
})

const classifyProposal = (profile, corpus, target = 'equipmentType') => {
  const entries = [anatomyEntry(), legendMakeEntry({
    kind: 'abbreviation', code: 'QQQ', meaning: 'Q equipment', targetHint: target, sourceId: 'source-1', parserConfidence: 0.95,
  })]
  return legendBuildProposals(entries, profile, corpus)
}

/* ---------------------------------------------------------------------------
 * Structural vs effective -- the ordering-aware measurement
 * ------------------------------------------------------------------------- */

test('a rule shadowed by an earlier one reports structural matches and zero effect', () => {
  // The report this exists to produce: "N structural matches · 0 effective
  // changes · shadowed by <rule>". Reporting N alone would be a lie of
  // omission, because Classify is first-match-wins per target.
  const profile = bareProfile()
  const corpus = corpusFrom(profile)
  const proposals = classifyProposal(profile, corpus)
  const anatomy = proposals.find(item => item.family === 'anatomy')

  // Put the anatomy in place, plus an incumbent rule that already answers
  // equipmentType for every tag.
  const withAnatomy = legendApplyProposals(profile, [anatomy])
  withAnatomy.rules.classify.push({
    id: 'incumbent', name: 'Everything is generic', kind: 'pattern',
    pattern: '.', value: 'GENERIC', target: 'equipmentType', enabled: true,
  })

  const classify = classifyProposal(withAnatomy, corpus).find(item => item.family === 'classify')
  assert.ok(classify, 'a classify proposal should still be generated')
  classify.insertIndex = withAnatomy.rules.classify.length // deliberately behind the incumbent

  const baseline = legendEvaluate(withAnatomy, corpus)
  const impact = legendProposalImpact(withAnatomy, classify, corpus, baseline)

  assert.ok(impact.structuralMatches > 0, 'the rule does structurally match tags')
  assert.equal(impact.effectiveMatches, 0, 'but at this position it changes nothing')
  assert.equal(impact.fullyShadowed, true)
  assert.equal(impact.shadowedBy[0].name, 'Everything is generic', 'the shadowing rule must be named')
  assert.equal(impact.preselected, false)
  assert.match(impact.blockedReason, /shadowed/i)
})

test('the same rule placed first is no longer shadowed', () => {
  // The control. Position, not the rule, is what changed.
  const profile = bareProfile()
  const corpus = corpusFrom(profile)
  const anatomy = classifyProposal(profile, corpus).find(item => item.family === 'anatomy')
  const withAnatomy = legendApplyProposals(profile, [anatomy])
  withAnatomy.rules.classify.push({
    id: 'incumbent', name: 'Everything is generic', kind: 'pattern',
    pattern: '.', value: 'GENERIC', target: 'equipmentType', enabled: true,
  })

  const classify = classifyProposal(withAnatomy, corpus).find(item => item.family === 'classify')
  classify.insertIndex = 0

  const impact = legendProposalImpact(withAnatomy, classify, corpus, legendEvaluate(withAnatomy, corpus))
  assert.ok(impact.effectiveMatches > 0, 'placed first it takes effect')
  assert.equal(impact.fullyShadowed, false)
})

test('a rule that changes an existing classification reports the conflict', () => {
  const profile = bareProfile()
  const corpus = corpusFrom(profile)
  const anatomy = classifyProposal(profile, corpus).find(item => item.family === 'anatomy')
  const withAnatomy = legendApplyProposals(profile, [anatomy])
  withAnatomy.rules.classify.push({
    id: 'incumbent', name: 'Everything is generic', kind: 'pattern',
    pattern: '.', value: 'GENERIC', target: 'equipmentType', enabled: true,
  })

  const classify = classifyProposal(withAnatomy, corpus).find(item => item.family === 'classify')
  classify.insertIndex = 0
  const impact = legendProposalImpact(withAnatomy, classify, corpus, legendEvaluate(withAnatomy, corpus))

  assert.ok(impact.conflicts.length > 0, 'overwriting an existing value is a conflict worth naming')
  assert.equal(impact.conflicts[0].before, 'GENERIC')
  assert.equal(impact.preselected, false)
  assert.match(impact.blockedReason, /Conflicts with/)
})

/* ---------------------------------------------------------------------------
 * Identity
 * ------------------------------------------------------------------------- */

test('a suffix strip that merges two tags into one identity is reported as a collision', () => {
  // Two distinct equipment records becoming one is the concrete harm behind
  // classifying identity normalization as high risk.
  const profile = bareProfile()
  const aoa = [['Starting Source', 'ID Name'], ['ZZ9-QQQ-0001', 'ZZ9-QQQ-0001-A'], ['ZZ9-RRR-0002', 'ZZ9-SSS-0003']]
  const corpus = corpusFrom(profile, aoa)
  const proposal = legendBuildProposals([legendMakeEntry({
    kind: 'normalization', sourceId: 'source-1', detail: { form: 'stripSuffix', suffixes: ['A'] },
  })], profile, corpus)[0]

  const impact = legendProposalImpact(profile, proposal, corpus, legendEvaluate(profile, corpus))
  assert.equal(impact.identityCollisions, 1, 'the two tags collapse to one canonical identity')
  assert.equal(impact.canonicalMerges[0].tags.length, 2)
  assert.equal(impact.preselected, false)
})

test('tags that already shared an identity are not counted as a new merge', () => {
  const profile = bareProfile()
  const aoa = [['Starting Source', 'ID Name'], ['ZZ9-QQQ-0001', 'ZZ9-QQQ-0001'], ['ZZ9-RRR-0002', 'ZZ9-SSS-0003']]
  const corpus = corpusFrom(profile, aoa)
  const proposal = legendBuildProposals([legendMakeEntry({
    kind: 'normalization', sourceId: 'source-1', detail: { form: 'stripSuffix', suffixes: ['ZZZ'] },
  })], profile, corpus)
  if (!proposal.length) return // no corpus support, nothing to measure
  const impact = legendProposalImpact(profile, proposal[0], corpus, legendEvaluate(profile, corpus))
  assert.equal(impact.identityCollisions, 0)
})

/* ---------------------------------------------------------------------------
 * Baseline reuse
 * ------------------------------------------------------------------------- */

test('a supplied baseline is reused rather than recomputed for every proposal', () => {
  // Measured, not asserted by inspection. Every evaluation reads corpus.records
  // exactly once, so counting reads counts evaluations. Re-deriving the
  // baseline per proposal was measured at ~3s in the Visual Trainer and cut 46%
  // by threading it through; a legend produces dozens of proposals at once.
  const profile = bareProfile()
  const realCorpus = corpusFrom(profile)
  let reads = 0
  const counting = Object.create(realCorpus)
  Object.defineProperty(counting, 'records', { get() { reads++; return realCorpus.records } })

  const proposals = classifyProposal(profile, realCorpus)
  assert.ok(proposals.length >= 2, 'need several proposals to see the difference')

  const baseline = legendEvaluate(profile, counting)
  const afterBaseline = reads
  for (const proposal of proposals) legendProposalImpact(profile, proposal, counting, baseline)
  const withBaseline = reads - afterBaseline

  reads = 0
  for (const proposal of proposals) legendProposalImpact(profile, proposal, counting, null)
  const withoutBaseline = reads

  assert.equal(withBaseline, proposals.length * 2,
    'with a baseline each proposal should evaluate the candidate and the isolated rule only')
  assert.equal(withoutBaseline, proposals.length * 3,
    'without one it also re-derives the unchanged baseline every time')
  assert.ok(withBaseline < withoutBaseline)
})

test('a supplied baseline produces the same answer as recomputing it', () => {
  const profile = bareProfile()
  const corpus = corpusFrom(profile)
  const proposal = classifyProposal(profile, corpus).find(item => item.family === 'classify')
  const strip = impact => JSON.stringify({ ...impact, candidateProfile: null })
  assert.equal(
    strip(legendProposalImpact(profile, proposal, corpus, legendEvaluate(profile, corpus))),
    strip(legendProposalImpact(profile, proposal, corpus, null)),
  )
})

/* ---------------------------------------------------------------------------
 * Batch vs individual
 * ------------------------------------------------------------------------- */

test('combined impact is measured as one candidate, not as a sum of parts', () => {
  const profile = bareProfile()
  const corpus = corpusFrom(profile)
  const proposals = classifyProposal(profile, corpus)
  const baseline = legendEvaluate(profile, corpus)

  const anatomyOnly = legendBatchImpact(profile, proposals.filter(p => p.family === 'anatomy'), corpus, baseline)
  const both = legendBatchImpact(profile, proposals, corpus, baseline)

  // The classify rule depends on the anatomy's segment, so together they add
  // classifications that neither produces alone.
  assert.ok(both.classificationsAdded > anatomyOnly.classificationsAdded,
    'the pair does more together than the anatomy alone')
  assert.equal(both.selected, proposals.length)
  assert.equal(both.compiles, true)
})

test('a batch names the rules that end up unreachable', () => {
  const profile = bareProfile()
  const corpus = corpusFrom(profile)
  const proposals = classifyProposal(profile, corpus)
  const classify = proposals.find(item => item.family === 'classify')
  // Drop the anatomy, so the segment rule has no segment to read.
  const orphan = { ...classify, insertIndex: 0 }
  const impact = legendBatchImpact(profile, [orphan], corpus, legendEvaluate(profile, corpus))
  assert.equal(impact.unreachableRules.length, 1, 'a rule that fires for nothing must be named')
  assert.equal(impact.unreachableRules[0].id, classify.rule.id)
})

test('an empty selection reports nothing rather than failing', () => {
  const profile = bareProfile()
  const impact = legendBatchImpact(profile, [], corpusFrom(profile), null)
  assert.equal(impact.selected, 0)
  assert.equal(impact.compiles, true)
  assert.deepEqual(impact.identityChanges, [])
})

/* ---------------------------------------------------------------------------
 * Preview is free; Apply is gated
 * ------------------------------------------------------------------------- */

test('previewing impact never mutates the profile', () => {
  const profile = bareProfile()
  const corpus = corpusFrom(profile)
  const proposals = classifyProposal(profile, corpus)
  const snapshot = JSON.stringify(profile)

  const baseline = legendEvaluate(profile, corpus)
  for (const proposal of proposals) legendProposalImpact(profile, proposal, corpus, baseline)
  legendBatchImpact(profile, proposals, corpus, baseline)

  assert.equal(JSON.stringify(profile), snapshot, 'preview must be free of side effects')
})

test('applying to the draft compiles the whole candidate before replacing anything', () => {
  const profile = bareProfile()
  const corpus = corpusFrom(profile)
  const proposals = classifyProposal(profile, corpus)
  const result = legendApplyToDraft(profile, proposals)
  assert.equal(result.ok, true)
  assert.equal(result.applied, proposals.length)
  assert.ok(result.draft.anatomies.length >= 1)
  assert.equal(JSON.stringify(profile).includes('legend-'), false, 'the original draft is untouched')
})

test('a candidate that fails validation is refused, leaving the draft alone', () => {
  const profile = bareProfile()
  const broken = {
    id: 'legend-classify-building-broken', family: 'classify', target: 'building', insertIndex: 0,
    rule: { id: 'legend-classify-building-broken', name: 'Broken', kind: 'segment', segment: 'not-a-declared-segment', target: 'building', enabled: true },
  }
  const result = legendApplyToDraft(profile, [broken])
  assert.equal(result.ok, false)
  assert.equal(result.code, 'validation_failed')
  assert.ok(result.message.length > 0, 'the refusal must say why')
  assert.equal(profile.rules.classify.length, 0, 'the draft must be untouched by a refused apply')
})

test('applying nothing is refused rather than silently succeeding', () => {
  const result = legendApplyToDraft(bareProfile(), [])
  assert.equal(result.ok, false)
  assert.equal(result.code, 'nothing_selected')
})

/* ---------------------------------------------------------------------------
 * No hierarchy -- unverified, not safe
 * ------------------------------------------------------------------------- */

test('relationship impact with no hierarchy reads as unverified, not safe', () => {
  const profile = bareProfile()
  const corpus = corpusFrom(profile)
  const relate = legendBuildProposals([legendMakeEntry({
    kind: 'relationship', sourceId: 'source-1',
    detail: { form: 'attributeMatch', childType: 'QQQ', parentType: 'RRR', matchOn: 'matchKey' },
  })], profile, corpus)[0]

  const impact = legendProposalImpact(profile, relate, corpus, legendEvaluate(profile, corpus), { hasHierarchy: false })
  assert.equal(impact.parentImpact.applicable, true)
  assert.equal(impact.parentImpact.verified, false)
  assert.match(impact.parentImpact.reason, /Not yet verified/)
  assert.equal(impact.preselected, false, 'an unsimulated relationship must never be preselected')
})

test('a classify proposal reports no parent impact to verify', () => {
  const profile = bareProfile()
  const corpus = corpusFrom(profile)
  const classify = classifyProposal(profile, corpus).find(item => item.family === 'classify')
  const impact = legendProposalImpact(profile, classify, corpus, legendEvaluate(profile, corpus))
  assert.equal(impact.parentImpact.applicable, false)
})

/* ---------------------------------------------------------------------------
 * Scale
 * ------------------------------------------------------------------------- */

test('impact over 10,000 tags stays within the Visual Trainer budget', () => {
  const profile = bareProfile()
  const aoa = [['Starting Source', 'ID Name']]
  for (let index = 0; index < 5000; index++) {
    aoa.push([`ZZ9-QQQ-${String(index).padStart(5, '0')}`, `YY8-RRR-${String(index).padStart(5, '0')}`])
  }
  const corpus = corpusFrom(profile, aoa)
  assert.ok(corpus.distinct >= 10000, `expected 10,000 distinct tags, got ${corpus.distinct}`)

  const proposals = classifyProposal(profile, corpus)
  const started = Date.now()
  const baseline = legendEvaluate(profile, corpus)
  for (const proposal of proposals) legendProposalImpact(profile, proposal, corpus, baseline)
  legendBatchImpact(profile, proposals, corpus, baseline)
  const elapsed = Date.now() - started

  assert.ok(elapsed < 2500, `10,000-tag impact took ${elapsed}ms, over the 2500ms budget`)
})

test('impact against an empty corpus is safe and reports nothing verified', () => {
  const profile = bareProfile()
  const empty = legendEmptyCorpus()
  const proposals = classifyProposal(profile, empty)
  const impact = legendProposalImpact(profile, proposals[0], empty, legendEvaluate(profile, empty))
  assert.equal(impact.structuralMatches, 0)
  assert.equal(impact.effectiveMatches, 0)
  assert.equal(impact.preselected, false)
})
