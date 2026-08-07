import assert from 'node:assert/strict'
import { test } from 'node:test'
import { legendPageFromText } from '../src/legend/extract.js'
import { legendSampleTags, legendSections } from '../src/legend/parser.js'
import { legendBuildCorpus, legendSliceCoverage } from '../src/legend/corpus.js'
import { makeStarterProfile, normalizeProfile } from '../src/profile/schema.js'
import { loadApp } from './support/harness.mjs'

/**
 * The manual binding path.
 *
 * A real numbering sheet points a character position at a value list with a
 * DRAWN LEADER LINE. That geometry is not in the text layer and differs every
 * package, so the machine finds the sections and the sample tags and a person
 * makes the binding. These tests pin what the machine must offer, and that a
 * binding produces an ordinary rule.
 */

/* A numbering sheet in the shape the real one takes: several sections, most of
   them labelled with words the heading vocabulary has never seen. */
const NUMBERING_SHEET = [
  'ELECTRICAL EQUIPMENT NUMBERING',
  'GIS EQUIPMENT:',
  '3AAAB-QQQ-00-A',
  'TRAIN:',
  'A = TRAIN A',
  'B = TRAIN B',
  'C = TRAIN C',
  'AREA NUMBERING:',
  '30 = MAIN SUBSTATION',
  '31 = FUTURE',
  '32 = NOT USED',
  'LEVEL:',
  '0 = BASEMENT LEVEL',
  '1 = GROUND LEVEL',
  'POWER SUPPLY:',
  'N = NORMAL',
  'E = EMERGENCY',
].join('\n')

const pagesOf = text => [legendPageFromText(text, {})]

/* ---------------------------------------------------------------------------
 * What the picker offers
 * ------------------------------------------------------------------------- */

test('each labelled block becomes a section the user can pick', () => {
  const sections = legendSections(pagesOf(NUMBERING_SHEET))
  assert.deepEqual(sections.map(section => section.title), [
    'TRAIN:', 'AREA NUMBERING:', 'LEVEL:', 'POWER SUPPLY:',
  ])
  assert.deepEqual(sections[0].values.map(value => value.code), ['A', 'B', 'C'])
  assert.deepEqual(sections[1].values.map(value => value.code), ['30', '31', '32'])
})

test('sections are cut on labels the vocabulary has never seen', () => {
  // The whole point. "AREA NUMBERING:", "LEVEL:", and "POWER SUPPLY:" mean
  // nothing to the parser, and they still divide the sheet. Without this the
  // page is one undifferentiated pile of codes.
  const sections = legendSections(pagesOf(NUMBERING_SHEET))
  const level = sections.find(section => section.title === 'LEVEL:')
  assert.ok(level, 'an unrecognised label must still open a section')
  assert.deepEqual(level.values.map(value => value.code), ['0', '1'])
  assert.equal(level.values.some(value => value.code === 'N'), false,
    'the next section must not bleed into this one')
})

test('a section with no value pairs is not offered', () => {
  const sections = legendSections(pagesOf('GENERAL NOTES:\nAll work shall conform to the specification.'))
  assert.deepEqual(sections, [])
})

test('sample tags are detected and section labels are not', () => {
  const tags = legendSampleTags(pagesOf(NUMBERING_SHEET)).map(tag => tag.text)
  assert.deepEqual(tags, ['3AAAB-QQQ-00-A'])
})

test('a tag needs a digit, so a wordy label is never offered as a sample', () => {
  const tags = legendSampleTags(pagesOf([
    'POWER SUPPLY',
    'ABC-DEF-GHI',
    'ZZ9-QQQ-0001',
    'A = TRAIN A',
  ].join('\n'))).map(tag => tag.text)
  assert.deepEqual(tags, ['ZZ9-QQQ-0001'],
    'only the digit-bearing tag qualifies; a definition and a wordy label do not')
})

/* ---------------------------------------------------------------------------
 * What the binding is checked against
 * ------------------------------------------------------------------------- */

function corpusOf(tags) {
  const profile = normalizeProfile(makeStarterProfile())
  profile.rules = { normalize: [], classify: [], relate: [] }
  profile.mappings = { easyPower: { headerRow: 0, fields: { startingSource: 0 } } }
  return legendBuildCorpus(
    [{ fileId: 'f', sheet: 'S', sourceKind: 'easyPower', aoa: [['Starting Source'], ...tags.map(tag => [tag])] }],
    profile,
  )
}

test('coverage separates documented values from ones the legend never explains', () => {
  // This is the payoff of binding. The legend claims positions 4-6 are area
  // numbering 30/31/32; only the corpus can say whether the site agrees.
  const corpus = corpusOf([
    '3AA30XY-CAZ001', '3AA30XY-CAZ002',
    '3AA31XY-CAZ003',
    '3AA99XY-CAZ004',
  ])
  const coverage = legendSliceCoverage(corpus, 3, 5, [
    { code: '30', meaning: 'MAIN SUBSTATION' },
    { code: '31', meaning: 'FUTURE' },
    { code: '32', meaning: 'NOT USED' },
  ])
  assert.equal(coverage.tagsMatched, 4)
  assert.equal(coverage.distinct, 3)
  assert.deepEqual(coverage.documented.map(item => [item.value, item.count]), [['30', 2], ['31', 1]])
  assert.deepEqual(coverage.undocumented.map(item => item.value), ['99'],
    'a value the drawing never mentions is the signal worth surfacing')
  assert.deepEqual(coverage.unused, ['32'], 'a documented code no tag carries')
})

test('tags too short for the range are counted, not silently ignored', () => {
  // A range that overruns most tags usually means it is bound to the wrong
  // position, and reporting zero matches would hide that.
  const coverage = legendSliceCoverage(corpusOf(['AB', 'ABCDEFGH']), 3, 6, [])
  assert.equal(coverage.tooShort, 1)
  assert.equal(coverage.tagsMatched, 1)
})

test('coverage on an empty corpus is safe and reports nothing', () => {
  const coverage = legendSliceCoverage(corpusOf([]), 0, 3, [{ code: 'ZZ9' }])
  assert.equal(coverage.tagsMatched, 0)
  assert.deepEqual(coverage.documented, [])
  assert.deepEqual(coverage.unused, ['ZZ9'])
})

/* ---------------------------------------------------------------------------
 * Binding through to a rule
 * ------------------------------------------------------------------------- */

async function binderApp() {
  const app = await loadApp()
  app.eval(`
    initProfiles();
    SITE = normalizeProfile(makeDefaultProfile('Binder Site'));
    SITE.anatomies = []; SITE.rules = { normalize: [], classify: [], relate: [] };
    PROFILE_STORE.profiles.push(SITE);
    PROFILE_STORE.activeId = SITE.id;
    setRuleProfile(activeProfile());
    S.profileDraft = profileClone(activeProfile());
    legendSessionRelease();
    legendSession.open = true; legendSession.mode = 'studio';
    legendSession.candidate = S.profileDraft;
    legendSession.corpus = legendEmptyCorpus();
    legendSession.sections = legendSections([legendPageFromText(${JSON.stringify(NUMBERING_SHEET)}, {})]);
    legendSession.sampleTags = legendSampleTags([legendPageFromText(${JSON.stringify(NUMBERING_SHEET)}, {})]);
  `)
  return app
}

test('a committed binding becomes an ordinary Classify slice rule', async () => {
  const app = await binderApp()
  app.eval(`
    legendSession.binding = { sample: '3AAAB-QQQ-00-A', start: 1, end: 3, sectionId: legendSession.sections[1].id, target: 'building' };
    legendCommitBinding(S.profileDraft);
  `)
  const proposals = JSON.parse(app.eval(`JSON.stringify(legendSession.proposals.map(p => ({
    family: p.family, target: p.target, kind: p.rule.kind, start: p.rule.start, end: p.rule.end, risk: p.risk })))`))
  assert.equal(proposals.length, 1, JSON.stringify(proposals))
  assert.deepEqual(proposals[0], { family: 'classify', target: 'building', kind: 'slice', start: 1, end: 4, risk: 'low' })
})

test('a binding records which value list explained it', async () => {
  const app = await binderApp()
  app.eval(`
    legendSession.binding = { sample: '3AAAB-QQQ-00-A', start: 1, end: 3, sectionId: legendSession.sections[1].id, target: 'building' };
    legendCommitBinding(S.profileDraft);
  `)
  const binding = JSON.parse(app.eval('JSON.stringify(legendSession.bindings[0])'))
  assert.equal(binding.sectionTitle, 'AREA NUMBERING:')
  assert.deepEqual(binding.values.map(value => value.code), ['30', '31', '32'])
  assert.equal(binding.start, 1)
  assert.equal(binding.end, 4)
})

test('a binding without a target or a range is refused', async () => {
  const app = await binderApp()
  assert.equal(app.eval(`legendSession.binding = { sample: '3AAAB-QQQ-00-A', start: null, end: null, sectionId: '', target: 'building' }; String(legendCommitBinding(S.profileDraft))`), 'null')
  assert.equal(app.eval(`legendSession.binding = { sample: '3AAAB-QQQ-00-A', start: 1, end: 3, sectionId: '', target: '' }; String(legendCommitBinding(S.profileDraft))`), 'null')
  assert.equal(Number(app.eval('legendSession.bindings.length')), 0)
})

test('a range selected backwards still reads low to high', async () => {
  const app = await binderApp()
  app.eval(`legendSession.binding = { sample: '3AAAB-QQQ-00-A', start: 4, end: 1, sectionId: '', target: 'building' };`)
  assert.deepEqual(JSON.parse(app.eval('JSON.stringify(legendBindingRange())')), { start: 1, end: 5 })
})

test('re-binding the same range and target replaces rather than duplicates', async () => {
  const app = await binderApp()
  app.eval(`
    legendSession.binding = { sample: '3AAAB-QQQ-00-A', start: 1, end: 3, sectionId: legendSession.sections[0].id, target: 'building' };
    legendCommitBinding(S.profileDraft);
    legendSession.binding = { sample: '3AAAB-QQQ-00-A', start: 1, end: 3, sectionId: legendSession.sections[1].id, target: 'building' };
    legendCommitBinding(S.profileDraft);
  `)
  assert.equal(Number(app.eval('legendSession.bindings.length')), 1)
  assert.equal(app.eval('legendSession.bindings[0].sectionTitle'), 'AREA NUMBERING:',
    'the later binding wins')
})

test('removing a binding removes the rule it produced', async () => {
  const app = await binderApp()
  app.eval(`
    legendSession.binding = { sample: '3AAAB-QQQ-00-A', start: 1, end: 3, sectionId: '', target: 'building' };
    legendCommitBinding(S.profileDraft);
  `)
  assert.equal(Number(app.eval('legendSession.proposals.length')), 1)
  app.eval(`legendRemoveBinding(legendSession.bindings[0].id, S.profileDraft)`)
  assert.equal(Number(app.eval('legendSession.bindings.length')), 0)
  assert.equal(Number(app.eval('legendSession.proposals.length')), 0)
})

/* ---------------------------------------------------------------------------
 * Markup
 * ------------------------------------------------------------------------- */

test('the binder renders the sample tag, its characters, and the value lists', async () => {
  const app = await binderApp()
  const markup = app.eval('renderLegendAnatomyBinder()')
  assert.ok(markup.includes('Tag anatomy'))
  assert.ok(markup.includes('data-legend-char="0"'), 'characters must be individually selectable')
  assert.ok(markup.includes('data-legend-section='), 'value lists must be pickable')
  assert.ok(markup.includes('AREA NUMBERING:'))
  assert.ok(markup.includes('id="legendBindTarget"'))
})

test('the binder stays out of the way when there is nothing to bind', async () => {
  const app = await binderApp()
  app.eval('legendSession.sections = []; legendSession.sampleTags = []; legendSession.bindings = [];')
  assert.equal(app.eval('renderLegendAnatomyBinder()'), '')
})

test('document text in the binder is escaped', async () => {
  const app = await binderApp()
  const markup = app.eval(`
    legendSession.sections = [{ id: 's1', title: '<img src=x onerror=alert(1)>', page: 1,
      values: [{ code: '"><script>alert(2)</script>', meaning: 'x' }], lines: [] }];
    legendSession.sampleTags = [{ text: '<b>ZZ9-1</b>', page: 1 }];
    legendSession.binding = { sample: '', start: null, end: null, sectionId: '', target: '' };
    renderLegendAnatomyBinder()
  `)
  assert.equal(markup.includes('<img src=x'), false)
  assert.equal(markup.includes('<script>alert(2)'), false)
  assert.ok(markup.includes('&lt;img src=x'))
})

/* ---------------------------------------------------------------------------
 * Re-analysis
 * ------------------------------------------------------------------------- */

test('re-analysing the same sources does not duplicate the sections on offer', async () => {
  const app = await binderApp()
  app.eval(`
    legendSession.sections = []; legendSession.sampleTags = [];
    legendSession.sources = [{ id: 'src-1', kind: 'text', name: 'legend.txt', text: ${JSON.stringify(NUMBERING_SHEET)} }];
  `)
  await app.evalAsync('await legendAnalyzeSources(S.profileDraft)')
  const first = Number(app.eval('legendSession.sections.length'))
  assert.ok(first > 0, 'expected the first analysis to find sections')

  await app.evalAsync('await legendAnalyzeSources(S.profileDraft)')
  assert.equal(Number(app.eval('legendSession.sections.length')), first)
  assert.equal(Number(app.eval('legendSession.sampleTags.length')), Number(app.eval('new Set(legendSession.sampleTags.map(t => t.text)).size')))
})

test('sections from different sources never share an id', async () => {
  const app = await binderApp()
  app.eval(`
    legendSession.sections = []; legendSession.sampleTags = [];
    legendSession.sources = [
      { id: 'src-1', kind: 'text', name: 'a.txt', text: ${JSON.stringify(NUMBERING_SHEET)} },
      { id: 'src-2', kind: 'text', name: 'b.txt', text: ${JSON.stringify(NUMBERING_SHEET)} },
    ];
  `)
  await app.evalAsync('await legendAnalyzeSources(S.profileDraft)')
  const ids = JSON.parse(app.eval('JSON.stringify(legendSession.sections.map(s => s.id))'))
  assert.ok(ids.length >= 2, JSON.stringify(ids))
  assert.equal(new Set(ids).size, ids.length, 'ids collided: ' + JSON.stringify(ids))
})

/* ---------------------------------------------------------------------------
 * Committing a lassoed selection
 * ------------------------------------------------------------------------- */

/* A worked example is how a legend prints its sample tag: the tag, a
   separator, and the meaning of each segment. Only the left side is the tag. */
const WORKED_EXAMPLE = {
  lines: ['ZZ9-QQQ-4321 = Building-Equipment Type-Unit'],
  sampleTags: [],
  sections: [],
  tokenCount: 4,
}

test('a sample lassoed from a worked example is the tag, not the whole sentence', async () => {
  const app = await binderApp()
  app.eval(`legendSession.lasso.preview = ${JSON.stringify(WORKED_EXAMPLE)};`)
  assert.equal(app.eval('legendLassoSampleText(legendSession.lasso.preview)'), 'ZZ9-QQQ-4321')
})

test('committing that sample sets the tag the character strip counts along', async () => {
  const app = await binderApp()
  app.eval(`
    legendSession.lasso.open = true; legendSession.lasso.page = 2;
    legendSession.lasso.preview = ${JSON.stringify(WORKED_EXAMPLE)};
    legendLassoUseAsSample();
  `)
  assert.equal(app.eval('legendSession.binding.sample'), 'ZZ9-QQQ-4321')
  const tags = JSON.parse(app.eval('JSON.stringify(legendSession.sampleTags.map(t => t.text))'))
  assert.ok(tags.includes('ZZ9-QQQ-4321'), JSON.stringify(tags))
  assert.equal(new Set(tags).size, tags.length, 'a committed sample must not duplicate an existing one')
})

test('a detected tag wins over the code side of a definition', async () => {
  const app = await binderApp()
  app.eval(`legendSession.lasso.preview = { lines: ['AAA = Air Handler'], sampleTags: [{ text: '3AAAB-QQQ-00-A', page: 1 }], sections: [], tokenCount: 2 };`)
  assert.equal(app.eval('legendLassoSampleText(legendSession.lasso.preview)'), '3AAAB-QQQ-00-A')
})

test('lassoing the same block twice does not stack two identical lists', async () => {
  const app = await binderApp()
  app.eval(`
    legendSession.sections = [];
    legendSession.lasso.open = true; legendSession.lasso.sourceId = 'src-1'; legendSession.lasso.page = 1;
    legendSession.lasso.preview = { lines: [], sampleTags: [], tokenCount: 4, sections: [
      { id: 's1', title: 'DEVICE CODES', page: 1, lines: [], values: [{ code: 'QQQ', meaning: 'Quench Panel' }] },
    ] };
  `)
  assert.equal(Number(app.eval('legendLassoUseAsSection()')), 1)
  assert.equal(Number(app.eval('legendLassoUseAsSection()')), 0, 'the second commit must be refused')
  assert.equal(Number(app.eval('legendSession.sections.length')), 1)
})

test('a different list from the same page is still added', async () => {
  const app = await binderApp()
  app.eval(`
    legendSession.sections = [];
    legendSession.lasso.open = true; legendSession.lasso.sourceId = 'src-1'; legendSession.lasso.page = 1;
    legendSession.lasso.preview = { lines: [], sampleTags: [], tokenCount: 4, sections: [
      { id: 's1', title: 'DEVICE CODES', page: 1, lines: [], values: [{ code: 'QQQ', meaning: 'Quench Panel' }] },
    ] };
    legendLassoUseAsSection();
    legendSession.lasso.preview.sections = [
      { id: 's2', title: 'TRAIN:', page: 1, lines: [], values: [{ code: 'A', meaning: 'Train A' }] },
    ];
  `)
  assert.equal(Number(app.eval('legendLassoUseAsSection()')), 1)
  assert.deepEqual(JSON.parse(app.eval('JSON.stringify(legendSession.sections.map(s => s.title))')), ['DEVICE CODES', 'TRAIN:'])
  assert.equal(Number(app.eval('new Set(legendSession.sections.map(s => s.id)).size')), 2)
})
