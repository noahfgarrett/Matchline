import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadApp } from './support/harness.mjs'

/**
 * ONE VM context for the whole file, with the draft reset per test.
 *
 * A context per test crashed the process with SIGSEGV in roughly 40% of full-suite
 * runs: `node --test` fans out across every core, and each context parses the
 * whole ~1.3 MB bundle, so a dozen of them per file on top of seventeen sibling
 * processes was enough to take V8 down. Nothing here needs a fresh interpreter
 * — these tests read markup out of render functions — so the draft is rebuilt
 * instead, which is both stable and considerably faster.
 */
let sharedApp = null
async function studioApp() {
  if (!sharedApp) {
    sharedApp = await loadApp()
    sharedApp.eval(`
      initProfiles();
      SITE = normalizeProfile(makeDefaultProfile('Studio Site'));
      PROFILE_STORE.profiles.push(SITE);
      PROFILE_STORE.activeId = SITE.id;
    `)
  }
  // Fresh draft, fresh UI selection, every time.
  sharedApp.eval(`
    PROFILE_STORE.activeId = SITE.id;
    S.profileDraft = profileClone(activeProfile());
    S.profileUi.engineRuleRef = '';
  `)
  return sharedApp
}

/** The locked Eagle profile as the draft, for the disabled-control checks. */
async function eagleDraftApp() {
  const app = await studioApp()
  app.eval(`PROFILE_STORE.activeId = 'builtin-eagle'; S.profileDraft = profileClone(activeProfile());`)
  return app
}

/* ---------------------------------------------------------------------------
 * Naming
 * ------------------------------------------------------------------------- */

test('the rule band is named for what it holds', () => {
  // "Baseline engine rules" described where the rules came from, not what they
  // are. They are the Normalize and Classify arrays, and once a legend can add
  // to them "baseline" is actively misleading.
  return studioApp().then(app => {
    const markup = app.eval('renderProfileEngineRules(S.profileDraft)')
    assert.ok(markup.includes('Normalize &amp; Classify Rules'))
    assert.equal(markup.includes('Baseline engine rules'), false)
  })
})

/* ---------------------------------------------------------------------------
 * Origin badges
 * ------------------------------------------------------------------------- */

test('a rule from a legend carries an origin badge naming the file and page', async () => {
  const app = await studioApp()
  const markup = app.eval(`
    RULE = { id: 'legend-classify-building-x', name: 'Building from prefix', kind: 'pattern', pattern: '^ZZ9', value: 'ZZ9', target: 'building', enabled: true };
    S.profileDraft.rules.classify.unshift(RULE);
    S.profileDraft.legendTraining = normalizeLegendTraining({
      sources: [{ id: 'source-1', name: 'site-legend.pdf', kind: 'pdf', pageCount: 12 }],
      ruleOrigins: { 'legend-classify-building-x': { sourceId: 'source-1', page: 4, generatedExecutionHash: legendRuleExecutionHash(RULE) } },
    });
    renderProfileEngineRules(S.profileDraft)
  `)
  assert.ok(markup.includes('Legend · site-legend.pdf · p. 4'), markup.slice(0, 400))
  assert.equal(markup.includes('· edited'), false, 'an untouched rule is not edited')
})

test('an edited generated rule says so, and renaming does not count as editing', async () => {
  const app = await studioApp()
  app.eval(`
    RULE = { id: 'legend-classify-building-x', name: 'Building from prefix', kind: 'pattern', pattern: '^ZZ9', value: 'ZZ9', target: 'building', enabled: true };
    S.profileDraft.rules.classify.unshift(RULE);
    S.profileDraft.legendTraining = normalizeLegendTraining({
      sources: [{ id: 'source-1', name: 'site-legend.pdf' }],
      ruleOrigins: { 'legend-classify-building-x': { sourceId: 'source-1', page: 4, generatedExecutionHash: legendRuleExecutionHash(RULE) } },
    });
  `)
  app.eval(`S.profileDraft.rules.classify[0].name = 'Renamed by hand'`)
  assert.equal(app.eval('renderProfileEngineRules(S.profileDraft)').includes('· edited'), false,
    'renaming a rule does not change what it does')

  app.eval(`S.profileDraft.rules.classify[0].pattern = '^YY8'`)
  assert.ok(app.eval('renderProfileEngineRules(S.profileDraft)').includes('· edited'),
    'changing the pattern is an execution change')
})

test('a hand-authored rule carries no origin badge at all', async () => {
  const app = await studioApp()
  const markup = app.eval(`
    S.profileDraft.rules.classify.unshift({ id: 'authored-1', name: 'Mine', kind: 'pattern', pattern: '^A', value: 'A', target: 'building', enabled: true });
    renderProfileEngineRules(S.profileDraft)
  `)
  assert.equal(markup.includes('legend-origin'), false)
})

/* ---------------------------------------------------------------------------
 * Anatomy editor
 * ------------------------------------------------------------------------- */

test('every anatomy field is editable, including the identity toggle', async () => {
  // Dropping a segment from identity silently rewrites the canonical tag of
  // everything the anatomy matches, so it is exactly the control that most
  // needs to be visible.
  const app = await studioApp()
  const markup = app.eval(`
    S.profileDraft.anatomies = [{ id: 'anatomy-1', name: 'Site tags', pattern: '^ZZ9', delimiter: '-',
      segments: [{ name: 'building', index: 0, identity: true }, { name: 'panelSide', index: 3, identity: false }] }];
    renderProfileAnatomies(S.profileDraft)
  `)
  for (const hook of ['data-anatomy-name="0"', 'data-anatomy-pattern="0"', 'data-anatomy-delimiter="0"',
    'data-anatomy-segment-name="0:0"', 'data-anatomy-segment-index="0:0"', 'data-anatomy-segment-identity="0:0"',
    'data-anatomy-segment-delete="0:1"', 'data-anatomy-segment-add="0"',
    'data-anatomy-up="0"', 'data-anatomy-down="0"', 'data-anatomy-delete="0"']) {
    assert.ok(markup.includes(hook), `the anatomy editor is missing ${hook}`)
  }
  assert.ok(markup.includes('Site tags'))
  // The non-identity segment's checkbox must be unchecked, the identity one checked.
  const panelSide = markup.slice(markup.indexOf('data-anatomy-segment-identity="0:1"'))
  assert.equal(panelSide.slice(0, 60).includes('checked'), false, 'a non-identity segment must not read as identity')
})

test('an anatomy with no segments still renders, and an empty list explains itself', async () => {
  const app = await studioApp()
  assert.ok(app.eval(`S.profileDraft.anatomies = []; renderProfileAnatomies(S.profileDraft)`)
    .includes('No tag anatomy is defined'))
  assert.doesNotThrow(() => app.eval(`
    S.profileDraft.anatomies = [{ id: 'a', name: 'Bare' }];
    renderProfileAnatomies(S.profileDraft)
  `))
})

test('every anatomy control is disabled on the locked Eagle profile', async () => {
  const app = await eagleDraftApp()
  assert.equal(app.eval('S.profileDraft.locked'), true, 'precondition: the draft is the locked profile')
  // Eagle ships no anatomies of its own -- it classifies with slice and pattern
  // rules -- so one is added here purely to have a row whose controls can be
  // checked.
  assert.equal(Number(app.eval('S.profileDraft.anatomies.length')), 0, 'Eagle defines no anatomy')

  const markup = app.eval(`
    S.profileDraft.anatomies = [{ id: 'a1', name: 'Test', pattern: '^A', delimiter: '-', segments: [{ name: 's', index: 0, identity: true }] }];
    renderProfileAnatomies(S.profileDraft)
  `)
  const inputs = markup.match(/<input[^>]*>/g) || []
  assert.ok(inputs.length >= 3, 'the row should render several inputs')
  for (const input of inputs) assert.ok(input.includes('disabled'), `an editable control survived on a locked profile: ${input}`)
  assert.ok((markup.match(/<button[^>]*data-anatomy-[^>]*>/g) || []).every(button => button.includes('disabled')),
    'anatomy buttons must be disabled too')
})

test('wiring the anatomy editor is a no-op on a locked profile', async () => {
  const app = await eagleDraftApp()
  const before = app.eval('JSON.stringify(S.profileDraft.anatomies)')
  assert.doesNotThrow(() => app.eval('wireProfileAnatomies()'))
  assert.equal(app.eval('JSON.stringify(S.profileDraft.anatomies)'), before)
})

/* ---------------------------------------------------------------------------
 * Exclusions
 * ------------------------------------------------------------------------- */

test('a rule editor exposes the tags the rule has been told to skip', async () => {
  // These were writable only by the Visual Trainer's deselect flow, with no way
  // to see or undo them.
  const app = await studioApp()
  const markup = app.eval(`
    S.profileDraft.rules.classify.unshift({ id: 'c1', name: 'Some rule', kind: 'pattern', pattern: '^A', value: 'A', target: 'building', enabled: true, excludeTags: ['ZZ9-QQQ-0001', 'ZZ9-RRR-0002'] });
    S.profileUi.engineRuleRef = 'classify:c1';
    profileEngineRuleFields(S.profileDraft)
  `)
  assert.ok(markup.includes('id="engineExclusions"'))
  assert.ok(markup.includes('ZZ9-QQQ-0001, ZZ9-RRR-0002'))
  assert.ok(markup.includes('2 tags excluded'))
})

test('a relate rule shows its exclusions under the name that family uses', async () => {
  const app = await studioApp()
  const markup = app.eval(`
    S.profileDraft.rules.relate.unshift({ id: 'r1', name: 'Some relation', kind: 'constant', pattern: '^A', parent: 'X', enabled: true, exclusions: ['ZZ9-SSS-0003'] });
    S.profileUi.engineRuleRef = 'relate:r1';
    profileEngineRuleFields(S.profileDraft)
  `)
  assert.ok(markup.includes('ZZ9-SSS-0003'))
  assert.ok(markup.includes('1 tag excluded'))
})

/* ---------------------------------------------------------------------------
 * Escaping
 * ------------------------------------------------------------------------- */

test('a legend-derived source name cannot inject markup into the badge', async () => {
  const app = await studioApp()
  const markup = app.eval(`
    RULE = { id: 'legend-classify-building-x', name: 'R', kind: 'pattern', pattern: '^A', value: 'A', target: 'building', enabled: true };
    S.profileDraft.rules.classify.unshift(RULE);
    S.profileDraft.legendTraining = normalizeLegendTraining({
      sources: [{ id: 'source-1', name: '<img src=x onerror=alert(1)>.pdf' }],
      ruleOrigins: { 'legend-classify-building-x': { sourceId: 'source-1', page: 1, generatedExecutionHash: legendRuleExecutionHash(RULE) } },
    });
    renderProfileEngineRules(S.profileDraft)
  `)
  assert.equal(markup.includes('<img src=x'), false, 'a document filename reached the page unescaped')
  assert.ok(markup.includes('&lt;img src=x'))
})

test('an anatomy name from a document cannot inject markup', async () => {
  const app = await studioApp()
  const markup = app.eval(`
    S.profileDraft.anatomies = [{ id: 'a1', name: '"><script>alert(1)</script>', pattern: '^A', delimiter: '-', segments: [] }];
    renderProfileAnatomies(S.profileDraft)
  `)
  assert.equal(markup.includes('<script>alert(1)'), false)
})
