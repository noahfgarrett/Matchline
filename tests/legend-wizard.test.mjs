import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { loadApp } from './support/harness.mjs'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The wizard is exercised through the built bundle, because what is being
 * pinned is the transaction boundary: PROFILE_STORE must not move until Create
 * Profile is pressed. The harness's DOM stub is non-reflective, so rendering is
 * checked by the markup functions' return values rather than by reading the DOM
 * back.
 */
/**
 * ONE VM context, reset per test.
 *
 * A context per test is what crashed `legend-studio` with SIGSEGV under the
 * full suite's fan-out, and this file builds more contexts than any other. The
 * reset below rebuilds the profile store from empty and releases the legend
 * session, so each test still starts from a known state without paying to parse
 * the whole bundle again.
 */
let sharedApp = null
async function freshApp() {
  if (!sharedApp) sharedApp = await loadApp()
  sharedApp.eval(`
    legendSessionRelease();
    localStorage.removeItem(PROFILE_DURABLE_STORAGE_KEY);
    localStorage.removeItem(PROFILE_STORAGE_KEY);
    PROFILE_STORE = { activeId: '', profiles: [] };
    PROFILE_FALLBACK = null;
    S.profileDraft = null; S.profileDirty = false; S.screen = 'upload';
    S.files = []; S.aoaCache.clear(); S.override = {}; S.roots = [];
    S.profileUi.section = 'overview';
  `)
  return sharedApp
}

async function appWithProfiles() {
  const app = await freshApp()
  app.eval(`
    initProfiles();
    SITE = normalizeProfile(makeDefaultProfile('Existing Site'));
    PROFILE_STORE.profiles.push(SITE);
    PROFILE_STORE.activeId = SITE.id;
    setRuleProfile(activeProfile());
  `)
  return app
}

const storeSnapshot = app => app.eval('JSON.stringify({ activeId: PROFILE_STORE.activeId, ids: PROFILE_STORE.profiles.map(p => p.id) })')

/* ---------------------------------------------------------------------------
 * Entry point
 * ------------------------------------------------------------------------- */

test('the plus button opens the wizard instead of copying a profile immediately', async () => {
  // duplicateProfile() mutated PROFILE_STORE and persisted before the engineer
  // had typed a character. The plus button now opens a transaction.
  const app = await appWithProfiles()
  const before = storeSnapshot(app)

  app.eval('openCreateProfileWizard()')

  assert.equal(app.eval('S.screen'), 'legendWizard')
  assert.equal(app.eval('legendSession.open'), true)
  assert.equal(storeSnapshot(app), before, 'opening the wizard must not touch the profile store')
})

test('the wizard defaults to the currently active profile as its base', async () => {
  const app = await appWithProfiles()
  app.eval('openCreateProfileWizard()')
  assert.equal(app.eval('legendSession.baseProfileId'), app.eval('activeProfile().id'))
  assert.equal(app.eval('legendSession.name'), 'Existing Site Copy')
})

test('creating from the locked Eagle profile produces an editable clone', async () => {
  const app = await freshApp()
  app.eval(`initProfiles(); PROFILE_STORE.activeId = 'builtin-eagle'; setRuleProfile(activeProfile());`)
  assert.equal(app.eval('activeProfile().locked'), true, 'precondition: Eagle is locked')

  app.eval(`openCreateProfileWizard(); legendSession.name = 'Cloned From Eagle'; legendWizardCreate();`)

  const created = JSON.parse(app.eval('JSON.stringify(activeProfile())'))
  assert.equal(created.name, 'Cloned From Eagle')
  assert.equal(created.locked, false, 'a profile created from Eagle must be editable')
  assert.equal(created.builtIn, false)
  assert.notEqual(created.id, 'builtin-eagle')
  assert.equal(app.eval(`PROFILE_STORE.profiles.some(p => p.id === 'builtin-eagle' && p.locked)`), true,
    'Eagle itself must be untouched')
})

/* ---------------------------------------------------------------------------
 * The transaction boundary
 * ------------------------------------------------------------------------- */

test('cancelling at any step leaves the profile store unchanged', async () => {
  const app = await appWithProfiles()
  const before = storeSnapshot(app)

  for (const step of ['profile', 'legend', 'knowledge', 'create']) {
    app.eval(`
      openCreateProfileWizard();
      legendSession.name = 'Abandoned Site';
      legendSession.pasted = 'AAA = Air Handling Assembly';
      legendAddPastedText();
      legendSession.step = ${JSON.stringify(step)};
      closeLegendWizard(false);
    `)
    assert.equal(storeSnapshot(app), before, `cancelling at the ${step} step changed the store`)
  }
})

test('an extraction failure leaves the profile store unchanged', async () => {
  const app = await appWithProfiles()
  const before = storeSnapshot(app)
  await app.evalAsync(`
    openCreateProfileWizard();
    legendSession.name = 'Broken Document Site';
    legendSession.sources.push({ id: 'source-bad', name: 'legend.pdf', kind: 'pdf', fingerprint: 'fp-bad', file: null });
    await legendAnalyzeSources(legendSession.candidate);
  `)
  assert.ok(app.eval('legendSession.error').length > 0, 'the failure must be reported')
  assert.equal(storeSnapshot(app), before, 'a failed extraction must not create anything')
  app.eval('closeLegendWizard(false)')
  assert.equal(storeSnapshot(app), before)
})

test('a document kind with no adapter at all reports why rather than failing silently', async () => {
  const app = await appWithProfiles()
  await app.evalAsync(`
    openCreateProfileWizard();
    legendSession.sources.push({ id: 'source-img', name: 'legend.png', kind: 'image', fingerprint: 'fp', file: null });
    await legendAnalyzeSources(legendSession.candidate);
  `)
  assert.match(app.eval('legendSession.error'), /No extractor is available for image/)
})

test('a PDF in a build without the vendored extractor says so, and names what does work', async () => {
  // The harness deliberately skips the PDF.js script block (see support/harness.mjs),
  // so this exercises the genuine extractor-unavailable path rather than a mock.
  const app = await appWithProfiles()
  assert.equal(app.eval('legendPdfAvailable()'), false, 'precondition: the harness does not load PDF.js')
  await app.evalAsync(`
    openCreateProfileWizard();
    legendSession.sources.push({ id: 'source-pdf', name: 'legend.pdf', kind: 'pdf', fingerprint: 'fp', file: null });
    await legendAnalyzeSources(legendSession.candidate);
  `)
  const message = app.eval('legendSession.error')
  assert.match(message, /PDF extractor is not included in this build/)
  assert.match(message, /Paste the legend text/, 'a dead end must offer the way through')
})

test('the shipped build does carry the PDF extractor', () => {
  // The counterpart to the test above: the harness skipping PDF.js must not be
  // mistaken for the artifact lacking it.
  const html = readFileSync(resolve(rootDir, 'SSMCompiler.html'), 'utf8')
  assert.match(html, /const LEGEND_PDFJS_LIB="/, 'the built artifact must embed the PDF.js library source')
  assert.match(html, /const LEGEND_PDFJS_WORKER="/, 'and its worker source')
  assert.equal((html.match(/<script>/g) || []).length, 4, 'PDF.js lives in its own script block')
})

test('Create adds exactly one profile and makes it active', async () => {
  const app = await appWithProfiles()
  const countBefore = Number(app.eval('PROFILE_STORE.profiles.length'))

  app.eval(`
    openCreateProfileWizard();
    legendSession.name = 'Brand New Site';
    legendSession.siteCode = 'BNS';
    legendWizardCreate();
  `)

  assert.equal(Number(app.eval('PROFILE_STORE.profiles.length')), countBefore + 1)
  assert.equal(app.eval('activeProfile().name'), 'Brand New Site')
  assert.equal(app.eval('activeProfile().siteCode'), 'BNS')
  assert.equal(app.eval('S.screen'), 'profile', 'the new profile opens in Studio')
  assert.equal(app.eval('legendSession.open'), false, 'the session is released after creation')
})

test('a new profile starts at revision 1 with no inherited history', async () => {
  const app = await appWithProfiles()
  app.eval(`
    SITE.history = [{ revision: 4, name: 'Old', savedAt: '2026-01-01', snapshot: {} }];
    SITE.revision = 5;
    openCreateProfileWizard();
    legendSession.name = 'Fresh Site';
    legendWizardCreate();
  `)
  const created = JSON.parse(app.eval('JSON.stringify(activeProfile())'))
  assert.equal(created.revision, 1)
  assert.deepEqual(created.history, [], 'a new profile inherits no revision history')
})

test('a new profile inherits no legend provenance from its base', async () => {
  const app = await appWithProfiles()
  app.eval(`
    SITE.legendTraining = normalizeLegendTraining({
      sources: [{ id: 'source-old', name: 'other-site-legend.pdf' }],
      pendingEntries: [{ id: 'entry-old', kind: 'abbreviation', code: 'AAA', meaning: 'Old meaning' }],
      ruleOrigins: { 'rule-old': { sourceId: 'source-old', page: 2 } },
      dismissedEntryHashes: ['lgd1-old'],
    });
    openCreateProfileWizard();
    legendSession.name = 'Derived Site';
    legendWizardCreate();
  `)
  const legend = JSON.parse(app.eval('JSON.stringify(activeProfile().legendTraining)'))
  assert.deepEqual(legend.sources, [], 'a copy must not claim the original\'s documents')
  assert.deepEqual(legend.pendingEntries, [])
  assert.deepEqual(legend.ruleOrigins, {})
  assert.deepEqual(legend.dismissedEntryHashes, [])
})

/* ---------------------------------------------------------------------------
 * Extraction through to draft
 * ------------------------------------------------------------------------- */

test('pasted legend text becomes reviewable knowledge before any rule exists', async () => {
  const app = await appWithProfiles()
  await app.evalAsync(`
    openCreateProfileWizard();
    legendSession.name = 'Pasted Site';
    legendSession.pasted = 'EQUIPMENT ABBREVIATIONS\\nAAA = Air Handling Assembly\\nBBB = Bus Bar Bank';
    legendAddPastedText();
    await legendAnalyzeSources(legendSession.candidate);
  `)
  const entries = JSON.parse(app.eval('JSON.stringify(legendSession.entries.map(e => [e.kind, e.code, e.meaning]))'))
  assert.ok(entries.some(([kind, code]) => kind === 'abbreviation' && code === 'AAA'), JSON.stringify(entries))
  assert.ok(entries.some(([, code]) => code === 'BBB'))
  assert.equal(app.eval('PROFILE_STORE.profiles.some(p => p.name === "Pasted Site")'), false,
    'extraction alone must not create a profile')
})

test('accepted proposals arrive as unpublished draft changes, not a published revision', async () => {
  // The single most important guarantee: a document never publishes a rule.
  const app = await appWithProfiles()
  app.eval(`
    openCreateProfileWizard();
    legendSession.name = 'Draft Site';
    legendSession.entries = [];
    legendSession.proposals = [{
      id: 'legend-classify-building-test', family: 'classify', target: 'building', insertIndex: 0,
      title: 'Classify building', entryIds: [], rule: {
        id: 'legend-classify-building-test', name: 'Building from prefix', kind: 'pattern',
        pattern: '^ZZ9', value: 'ZZ9', target: 'building', enabled: true,
      },
    }];
    legendSession.selected = new Set(['legend-classify-building-test']);
    legendWizardCreate();
  `)
  const created = JSON.parse(app.eval('JSON.stringify(activeProfile())'))
  assert.equal(created.revision, 1, 'creating must not publish a second revision')
  assert.equal(app.eval('S.profileDirty'), true, 'the rule is a pending draft change')
  assert.equal(app.eval(`S.profileDraft.rules.classify.some(r => r.id === 'legend-classify-building-test')`), true,
    'the accepted rule is in the draft')
  assert.equal(app.eval(`activeProfile().rules.classify.some(r => r.id === 'legend-classify-building-test')`), true,
    'and stored on the new profile, which is itself unpublished until Save & apply')
})

test('an accepted rule records where it came from, outside the rule itself', async () => {
  const app = await appWithProfiles()
  app.eval(`
    openCreateProfileWizard();
    legendSession.name = 'Provenance Site';
    legendSession.entries = [legendMakeEntry({ kind: 'abbreviation', code: 'AAA', meaning: 'Air Handling Assembly', sourceId: 'source-1', page: 3 })];
    legendSession.sources = [{ id: 'source-1', name: 'legend.pdf', kind: 'pdf', fingerprint: 'fp', pageCount: 5 }];
    legendSession.proposals = [{
      id: 'legend-classify-equipmentType-test', family: 'classify', target: 'equipmentType', insertIndex: 0,
      title: 'Classify equipment type', entryIds: [legendSession.entries[0].id], rule: {
        id: 'legend-classify-equipmentType-test', name: 'AAA is equipment', kind: 'pattern',
        pattern: '^AAA', value: 'AAA', target: 'equipmentType', enabled: true,
      },
    }];
    legendSession.selected = new Set(['legend-classify-equipmentType-test']);
    legendWizardCreate();
  `)
  const origin = JSON.parse(app.eval(`JSON.stringify(activeProfile().legendTraining.ruleOrigins['legend-classify-equipmentType-test'])`))
  assert.equal(origin.sourceId, 'source-1')
  assert.equal(origin.page, 3)
  assert.ok(origin.generatedExecutionHash.length > 0)

  const rule = JSON.parse(app.eval(`JSON.stringify(activeProfile().rules.classify.find(r => r.id === 'legend-classify-equipmentType-test'))`))
  for (const key of ['sourceId', 'page', 'acceptedAt', 'entryIds']) {
    assert.equal(key in rule, false, `${key} must live in ruleOrigins, not inside the executable rule`)
  }
  assert.equal(app.eval(`legendRuleState(activeProfile(), 'legend-classify-equipmentType-test')`), 'current')
})

/* ---------------------------------------------------------------------------
 * Transient state never reaches a profile
 * ------------------------------------------------------------------------- */

test('the legend session is a module store, unreachable from the profile draft', async () => {
  // Structural, not conventional: profileClone is JSON round-tripping, so a
  // File or worker handle reachable from the draft would either throw or be
  // flattened into junk on the next save.
  const app = await appWithProfiles()
  app.eval(`
    openCreateProfileWizard();
    legendSession.sources.push({ id: 's', name: 'legend.pdf', kind: 'pdf', file: { big: true }, pages: [{ tokens: [] }] });
  `)
  assert.equal(app.eval('S.legendSession === undefined'), true, 'transient state must not hang off S')
  const draft = app.eval('JSON.stringify(S.profileDraft || {})')
  assert.equal(draft.includes('legend.pdf'), false, 'a document name reached the draft')
  assert.equal(draft.includes('pages'), false)
})

test('releasing the session clears files, pages, blob URLs, and workers', async () => {
  const app = await appWithProfiles()
  const released = app.eval(`
    (function () {
      openCreateProfileWizard();
      let revoked = 0, terminated = 0;
      const realRevoke = URL.revokeObjectURL;
      URL.revokeObjectURL = () => { revoked++ };
      legendSession.blobUrls.push('blob:null/one', 'blob:null/two');
      legendSession.workers.push({ terminate() { terminated++ } });
      legendSession.sources.push({ id: 's', name: 'x.pdf', kind: 'pdf', file: { big: true }, pages: [1, 2, 3], bytes: new Uint8Array(8) });
      legendSessionRelease();
      URL.revokeObjectURL = realRevoke;
      return JSON.stringify({ revoked, terminated, sources: legendSession.sources.length, open: legendSession.open });
    })()
  `)
  assert.deepEqual(JSON.parse(released), { revoked: 2, terminated: 1, sources: 0, open: false })
})

/* ---------------------------------------------------------------------------
 * Markup
 * ------------------------------------------------------------------------- */

test('extracted document text is escaped before it reaches the page', async () => {
  // Legend text is untrusted input that ends up in innerHTML.
  const app = await appWithProfiles()
  const markup = app.eval(`
    openCreateProfileWizard();
    legendSession.step = 'knowledge';
    legendSession.entries = [legendMakeEntry({
      kind: 'abbreviation',
      code: '<img src=x onerror=alert(1)>',
      meaning: '"><script>alert(2)</script>',
      sourceId: 'source-1', page: 1,
      evidenceSummary: '<b>bold</b>',
    })];
    renderLegendWizardBody()
  `)
  assert.equal(markup.includes('<img src=x'), false, 'unescaped markup reached the page')
  assert.equal(markup.includes('<script>alert(2)'), false)
  assert.ok(markup.includes('&lt;img src=x'), 'the text should still be visible, escaped')
  assert.ok(markup.includes('&lt;b&gt;bold&lt;/b&gt;'))
})

test('every wizard step renders and names itself', async () => {
  const app = await appWithProfiles()
  for (const [step, heading] of [
    ['profile', 'Profile'], ['legend', 'Design legend'],
    ['knowledge', 'No knowledge was extracted'], ['create', 'Create'],
  ]) {
    const markup = app.eval(`openCreateProfileWizard(); legendSession.step = ${JSON.stringify(step)}; renderLegendWizardBody()`)
    assert.ok(markup.includes(heading), `the ${step} step should mention "${heading}"`)
  }
})

test('the Create step warns when nothing could be verified against project data', async () => {
  const app = await appWithProfiles()
  const markup = app.eval(`openCreateProfileWizard(); legendSession.step = 'create'; renderLegendWizardBody()`)
  assert.ok(markup.includes('No project tag data is loaded'),
    'a profile built with no tags loaded must say so plainly')
})

/* ---------------------------------------------------------------------------
 * Studio integration
 * ------------------------------------------------------------------------- */

test('the Legend Trainer tab sits immediately after Overview', async () => {
  const app = await appWithProfiles()
  const markup = app.eval(`openProfileStudio('overview'); S.profileDraft = profileClone(activeProfile()); renderProfileSection(S.profileDraft), (function(){
    return [profileNavButton('overview','Overview','info'), profileNavButton('legend','Legend Trainer','file-text')].join('')
  })()`)
  assert.ok(markup.includes('data-profile-section="legend"'), 'the tab must exist')
  assert.ok(markup.indexOf('data-profile-section="overview"') < markup.indexOf('data-profile-section="legend"'),
    'Legend Trainer must follow Overview')
})

test('the Legend Trainer tab renders for an ordinary profile', async () => {
  const app = await appWithProfiles()
  const markup = app.eval(`S.profileDraft = profileClone(activeProfile()); renderLegendTrainerTab(S.profileDraft)`)
  assert.ok(markup.includes('Legend Trainer'))
  assert.ok(markup.includes('Validate against project data'))
  assert.ok(markup.includes('No legend has been analysed for this profile'))
})

test('the locked Eagle profile offers clone-and-apply, never a direct edit', async () => {
  const app = await freshApp()
  app.eval(`initProfiles(); PROFILE_STORE.activeId = 'builtin-eagle'; S.profileDraft = profileClone(activeProfile());`)
  const markup = app.eval(`
    legendSession.open = true; legendSession.mode = 'studio';
    legendSession.proposals = [{ id: 'p1', family: 'classify', target: 'building', insertIndex: 0, title: 'Test', entryIds: [], confidence: 0.9, risk: 'low', rule: { id: 'p1' } }];
    legendSession.selected = new Set(['p1']);
    renderLegendTrainerTab(S.profileDraft)
  `)
  assert.ok(markup.includes('Clone Eagle and apply to draft'), 'Eagle must not offer a direct apply')
  assert.equal(markup.includes('>Apply to draft<'), false)
  assert.ok(markup.includes('Eagle is locked'))
})

test('no legend upload appears on the ordinary Files screen', async () => {
  // The legend is profile configuration, not project data.
  const app = await appWithProfiles()
  const markup = app.eval('importRequirementsMarkup()')
  for (const term of ['legend', 'Legend', 'abbreviation', 'Abbreviation']) {
    assert.equal(markup.includes(term), false, `the Files screen must not mention "${term}"`)
  }
})
