import assert from 'node:assert/strict'
import { test } from 'node:test'
import { legendBuildCorpus, legendEmptyCorpus, legendResolveColumns } from '../src/legend/corpus.js'
import { makeDefaultProfile, normalizeProfile } from '../src/profile/schema.js'
import { loadApp } from './support/harness.mjs'

const candidate = mappings => {
  const profile = normalizeProfile(makeDefaultProfile('Candidate'))
  profile.mappings = mappings
  return profile
}

const EASY_POWER = [
  ['Starting Source', 'Downstream 1', 'ID Name'],
  ['ZZ9-QQQ-0001', 'ZZ9-RRR-0002', 'ZZ9-SSS-0003'],
  ['ZZ9-QQQ-0001', 'ZZ9-RRR-0004', 'ZZ9-SSS-0005'],
]

const CABLE = [
  ['Load Name (To)', 'Panel (From)', 'Cable Tag'],
  ['ZZ9-SSS-0003', 'ZZ9-RRR-0002', 'C-0001'],
]

const MEL = [
  ['Equipment Tag', 'UPN', 'System Parent Equipment Tag(s)'],
  ['ZZ9-QQQ-0001', 'UPN-1', 'ZZ9-TTT-0009'],
]

const PMD = [
  ['PANEL', 'INSTRUMENT TAG'],
  ['ZZ9-RRR-0002', 'ZZ9-III-0100'],
]

const sheet = (aoa, sourceKind, extra) => ({ fileId: 'file-1', sheet: 'Sheet1', sourceKind, aoa, ...extra })

/* ---------------------------------------------------------------------------
 * Coverage across the four source kinds
 * ------------------------------------------------------------------------- */

test('every Easy Power tag column reaches the corpus with its own semantic field', () => {
  const corpus = legendBuildCorpus([sheet(EASY_POWER, 'easyPower')], candidate({}))
  const fields = new Set(corpus.records.map(record => record.semanticField))
  assert.deepEqual([...fields].sort(), ['downstream', 'idName', 'startingSource'])
  assert.ok(corpus.exactMatches('ZZ9-RRR-0004').length, 'a downstream tag must be in the corpus')
})

test('Cable Schedule, MEL, and PMD tags each carry their source kind', () => {
  const corpus = legendBuildCorpus([
    sheet(CABLE, 'cable'), sheet(MEL, 'mel'), sheet(PMD, 'pmd'),
  ], candidate({}))
  assert.deepEqual(corpus.sourcesFor('ZZ9-RRR-0002').sort(), ['cable', 'pmd'],
    'a tag appearing in two sources must report both')
  assert.deepEqual(corpus.sourcesFor('ZZ9-III-0100'), ['pmd'])
  assert.ok(corpus.exactMatches('ZZ9-TTT-0009').length, 'a MEL system parent is corpus evidence too')
})

test('provenance survives on every record', () => {
  const corpus = legendBuildCorpus([sheet(MEL, 'mel')], candidate({}))
  const record = corpus.exactMatches('ZZ9-QQQ-0001')[0]
  assert.equal(record.fileId, 'file-1')
  assert.equal(record.sheet, 'Sheet1')
  assert.equal(record.sourceKind, 'mel')
  assert.equal(record.semanticField, 'equipmentTag')
  assert.equal(record.row, 1, 'the header row is not a record')
})

test('a repeated tag is counted, not duplicated', () => {
  const corpus = legendBuildCorpus([sheet(EASY_POWER, 'easyPower')], candidate({}))
  const starting = corpus.records.filter(record => record.semanticField === 'startingSource')
  assert.equal(starting.length, 1, 'the same source tag on two rows is one record')
  assert.equal(starting[0].occurrenceCount, 2)
})

test('one tag reached through two semantic fields does not inflate match counts', () => {
  // A profile may legitimately map two fields onto one column, producing a
  // record per role. Match counts are taken over DISTINCT canonical tags, so
  // that modelling choice cannot overstate how much evidence a proposal has.
  const aoa = [['A'], ['ZZ9-QQQ-0001']]
  const corpus = legendBuildCorpus([sheet(aoa, 'easyPower')],
    candidate({ easyPower: { headerRow: 0, fields: { startingSource: 0, idName: 0 } } }))
  assert.equal(corpus.records.length, 2, 'the tag is recorded in both roles')
  assert.equal(corpus.distinct, 1, 'but it is one tag')
  assert.equal(corpus.segmentMatches('-', 1, 'QQQ').size, 1, 'and one match, not two')
})

/* ---------------------------------------------------------------------------
 * The candidate-profile guarantee
 * ------------------------------------------------------------------------- */

test('column mapping comes from the supplied candidate, not the active profile', async () => {
  // The failure this prevents is the worst kind available: validating a profile
  // being CREATED against a DIFFERENT profile's columns yields a corpus of the
  // wrong values, which then "confirms" proposals that are wrong -- and it looks
  // exactly like evidence.
  const app = await loadApp()

  // Two unlabelled columns, so nothing can be auto-detected and the mapping is
  // the only thing deciding which column holds tags.
  const aoa = [
    ['Col A', 'Col B'],
    ['ACTIVE-0001', 'CANDIDATE-0001'],
    ['ACTIVE-0002', 'CANDIDATE-0002'],
  ]

  app.eval(`
    ACTIVE_PROFILE = normalizeProfile(makeDefaultProfile('Active Site'));
    ACTIVE_PROFILE.mappings = { easyPower: { headerRow: 0, fields: { startingSource: 0 } } };
    PROFILE_STORE.profiles.push(ACTIVE_PROFILE);
    PROFILE_STORE.activeId = ACTIVE_PROFILE.id;

    CANDIDATE_PROFILE = normalizeProfile(makeDefaultProfile('Candidate Site'));
    CANDIDATE_PROFILE.mappings = { easyPower: { headerRow: 0, fields: { startingSource: 1 } } };
  `)

  assert.equal(app.eval('activeProfile().name'), 'Active Site', 'precondition: the active profile is the other one')

  app.eval(`globalThis.__aoa = ${JSON.stringify(aoa)}`)
  const tags = JSON.parse(app.eval(`
    JSON.stringify(legendBuildCorpus([{ fileId: 'f', sheet: 'S', sourceKind: 'easyPower', aoa: __aoa }], CANDIDATE_PROFILE)
      .records.map(record => record.raw).sort())
  `))

  assert.deepEqual(tags, ['CANDIDATE-0001', 'CANDIDATE-0002'],
    'the corpus read the active profile\'s columns instead of the candidate\'s')

  // And the active profile is not disturbed in the process.
  assert.equal(app.eval('activeProfile().name'), 'Active Site')
  assert.equal(app.eval('JSON.stringify(activeProfile().mappings.easyPower.fields)'), '{"startingSource":0}')
})

test('omitting the candidate is what falls back to the active profile', async () => {
  // The other half of the contract, stated explicitly: the fallback still
  // exists for the app's own long-standing callers, so the Legend Trainer's
  // guarantee rests on always passing a candidate rather than on the fallback
  // having been removed.
  const app = await loadApp()
  app.eval(`
    ACTIVE_PROFILE = normalizeProfile(makeDefaultProfile('Active Site'));
    ACTIVE_PROFILE.mappings = { easyPower: { headerRow: 0, fields: { startingSource: 0 } } };
    PROFILE_STORE.profiles.push(ACTIVE_PROFILE);
    PROFILE_STORE.activeId = ACTIVE_PROFILE.id;
    globalThis.__aoa = [['Col A', 'Col B'], ['ACTIVE-0001', 'CANDIDATE-0001']];
  `)
  const tags = JSON.parse(app.eval(`
    JSON.stringify(legendBuildCorpus([{ fileId: 'f', sheet: 'S', sourceKind: 'easyPower', aoa: __aoa }], null)
      .records.map(record => record.raw))
  `))
  assert.deepEqual(tags, ['ACTIVE-0001'])
})

test('the corpus keeps the true raw tag, not one the active profile already normalised', async () => {
  // Regression. `cleanTag` is `ruleEngine().resolve(...).identity` -- it runs
  // the GLOBALLY ACTIVE profile's Normalize rules. Using it here recorded
  // active-profile-normalised values as "raw", which is both the leak the
  // candidate-profile rule exists to prevent and the thing that makes an
  // identity-change proposal unmeasurable: a suffix-stripping rule cannot be
  // seen to merge two tags if the suffix was gone before the corpus saw it.
  const app = await loadApp()
  app.eval(`
    STRIPPER = normalizeProfile(makeDefaultProfile('Stripping Site'));
    STRIPPER.rules.normalize = [{ id: 'strip-a', kind: 'stripSuffix', suffixes: ['A'], separators: ['-'], stage: 'identity', enabled: true }];
    PROFILE_STORE.profiles.push(STRIPPER);
    PROFILE_STORE.activeId = STRIPPER.id;
    setRuleProfile(activeProfile());
    globalThis.__aoa = [['Starting Source'], ['ZZ9-QQQ-0001-A']];
  `)
  assert.equal(app.eval(`cleanTag('ZZ9-QQQ-0001-A')`), 'ZZ9-QQQ-0001',
    'precondition: the active profile really does strip this suffix')

  // A candidate with no Normalize rules of its own must still see the suffix.
  const raw = app.eval(`
    PLAIN = normalizeProfile(makeDefaultProfile('Plain Site'));
    PLAIN.rules.normalize = [];
    legendBuildCorpus([{ fileId: 'f', sheet: 'S', sourceKind: 'easyPower', aoa: __aoa }], PLAIN).records[0].raw
  `)
  assert.equal(raw, 'ZZ9-QQQ-0001-A', 'the active profile normalised the corpus behind the candidate\'s back')
})

test('resolveColumns honours a candidate header row over detection', () => {
  const aoa = [
    ['Project XYZ — Equipment Schedule', '', ''],
    ['Starting Source', 'Downstream 1', 'ID Name'],
    ['ZZ9-QQQ-0001', 'ZZ9-RRR-0002', 'ZZ9-SSS-0003'],
  ]
  const resolved = legendResolveColumns(aoa, 'easyPower', candidate({
    easyPower: { headerRow: 1, autoHeaderRow: false, fields: { startingSource: 0, idName: 2 } },
  }))
  assert.equal(resolved.headerRow, 1)
  assert.equal(resolved.columns.startingSource, 0)
  assert.equal(resolved.columns.idName, 2)
})

test('a caller-supplied sheet override is honoured only when passed explicitly', () => {
  // Session overrides are the user's own column choice, but they are session
  // state -- so they arrive as an argument rather than being read from ambient
  // state, keeping this a pure function of its inputs.
  const aoa = [['A', 'B'], ['LEFT-1', 'RIGHT-1']]
  const profile = candidate({ easyPower: { headerRow: 0, fields: { startingSource: 0 } } })

  const withoutOverride = legendBuildCorpus([sheet(aoa, 'easyPower')], profile)
  assert.deepEqual(withoutOverride.records.map(record => record.raw), ['LEFT-1'])

  const withOverride = legendBuildCorpus([sheet(aoa, 'easyPower', { overrides: { source: 1 } })], profile)
  assert.deepEqual(withOverride.records.map(record => record.raw), ['RIGHT-1'])
})

/* ---------------------------------------------------------------------------
 * Indexes
 * ------------------------------------------------------------------------- */

test('segment, prefix, and suffix indexes are built from the canonical value', () => {
  const corpus = legendBuildCorpus([sheet(EASY_POWER, 'easyPower')], candidate({}))
  assert.ok(corpus.segmentMatches('-', 0, 'ZZ9').size >= 3, 'building segment index')
  assert.ok(corpus.segmentMatches('-', 1, 'RRR').size >= 2, 'equipment segment index')
  assert.equal(corpus.segmentMatches('-', 1, 'NOPE').size, 0)
  assert.ok(corpus.prefixMatches('ZZ9').size >= 3)
  assert.ok(corpus.suffixMatches('0002').size >= 1)
})

test('a substring hit is not a segment match', () => {
  // The distinction that keeps a proposal honest: "QQ" appears inside "QQQ",
  // but a segment rule looking for QQ would match nothing, so counting it as
  // corpus support would overstate the evidence.
  const corpus = legendBuildCorpus([sheet(EASY_POWER, 'easyPower')], candidate({}))
  assert.equal(corpus.segmentMatches('-', 1, 'QQ').size, 0, 'a partial segment must not count as a match')
  assert.ok(corpus.segmentMatches('-', 1, 'QQQ').size > 0, 'the whole segment does match')
})

test('an empty corpus answers every query without special-casing', () => {
  const empty = legendEmptyCorpus()
  assert.equal(empty.size, 0)
  assert.deepEqual(empty.exactMatches('anything'), [])
  assert.equal(empty.segmentMatches('-', 0, 'ZZ9').size, 0)
  assert.deepEqual(empty.sourcesFor('anything'), [])
})

test('building a corpus from no sheets is safe', () => {
  assert.equal(legendBuildCorpus([], candidate({})).size, 0)
  assert.equal(legendBuildCorpus(null, candidate({})).size, 0)
  assert.equal(legendBuildCorpus([sheet([], 'easyPower')], candidate({})).size, 0)
})
