import assert from 'node:assert/strict'
import { test } from 'node:test'
import { STARTER_PROFILE_NAME, installCurrentEagle, makeDefaultProfile, makeStarterProfile, normalizeProfile } from '../src/profile/schema.js'
import { compileRuleProfile } from '../src/rules/profile-compiler.js'
import { loadApp } from './support/harness.mjs'

const EAGLE_NAME = 'Eagle - SSM Builder Legacy'

/* ---------------------------------------------------------------------------
 * Eagle is a reference, not a starting point
 * ------------------------------------------------------------------------- */

test('a first run lands on an editable profile, with Eagle beside it', async () => {
  // The complaint this fixes: a first-run user inherited all five of Eagle's
  // legacy compatibility policies, including downstreamGapPolicy 'truncate',
  // which silently drops equipment after a blank downstream column.
  const app = await loadApp()
  app.eval('initProfiles()')

  const active = JSON.parse(app.eval('JSON.stringify(activeProfile())'))
  assert.equal(active.locked, false, 'a first run must not land on a locked profile')
  assert.equal(active.name, STARTER_PROFILE_NAME)
  assert.equal(active.hierarchy.downstreamGapPolicy, 'bridge-review')
  assert.equal(active.hierarchy.resolutionStrategy, 'source-priority')
  assert.equal(active.hierarchy.caseVariantPolicy, 'merge')

  const names = JSON.parse(app.eval('JSON.stringify(PROFILE_STORE.profiles.map(p => p.name))'))
  assert.ok(names.includes(EAGLE_NAME), 'Eagle stays available as a worked example')
  assert.equal(app.eval(`PROFILE_STORE.profiles.find(p => p.name === ${JSON.stringify(EAGLE_NAME)}).locked`), true)
})

test('the starter is a complete, valid, executable profile', () => {
  // compileRuleProfile refuses a profile with no executable rules, so "clean
  // starter" cannot mean "no rules". It means modern policies.
  const starter = normalizeProfile(makeStarterProfile())
  const validation = compileRuleProfile(starter, { allowUnmapped: true })
  assert.equal(validation.ok, true, JSON.stringify(validation.errors && validation.errors.slice(0, 2)))
  assert.ok(starter.rules.classify.length > 0, 'a profile with no rules does not validate')
})

test('the starter differs from Eagle by policy, not by being crippled', () => {
  const eagle = makeDefaultProfile()
  const starter = makeStarterProfile()
  const policy = profile => ({
    resolutionStrategy: profile.hierarchy.resolutionStrategy,
    downstreamGapPolicy: profile.hierarchy.downstreamGapPolicy,
    caseVariantPolicy: profile.hierarchy.caseVariantPolicy,
    duplicateRegisterPolicy: profile.hierarchy.duplicateRegisterPolicy,
    cableConflictPolicy: profile.hierarchy.cableConflictPolicy,
    duplicateParentReviewPolicy: profile.hierarchy.duplicateParentReviewPolicy,
    melSystemParentClaims: profile.hierarchy.workflow.melSystemParentClaims,
  })
  assert.deepEqual(policy(eagle), {
    resolutionStrategy: 'legacy-register', downstreamGapPolicy: 'truncate', caseVariantPolicy: 'preserve',
    duplicateRegisterPolicy: 'first', cableConflictPolicy: 'legacy-chain-review',
    duplicateParentReviewPolicy: 'first-silent', melSystemParentClaims: false,
  })
  assert.deepEqual(policy(starter), {
    resolutionStrategy: 'source-priority', downstreamGapPolicy: 'bridge-review', caseVariantPolicy: 'merge',
    duplicateRegisterPolicy: 'prefer-parent', cableConflictPolicy: 'first-review',
    duplicateParentReviewPolicy: 'first-review', melSystemParentClaims: true,
  })
  assert.equal(starter.rules.classify.length, eagle.rules.classify.length,
    'the starter inherits the rule set as a template to edit')
})

/* ---------------------------------------------------------------------------
 * Existing stores must not move under anyone
 * ------------------------------------------------------------------------- */

test('an existing store keeps whatever profile it had selected', () => {
  const project = normalizeProfile(makeDefaultProfile('Existing Project'))
  const store = installCurrentEagle({ activeId: project.id, profiles: [project] })
  assert.equal(store.activeId, project.id, 'a resolvable activeId is never reassigned')
  assert.equal(store.profiles.length, 2, 'Eagle is added, but nothing else is')
  assert.equal(store.profiles.filter(p => p.name === STARTER_PROFILE_NAME).length, 0,
    'a store that already has an editable profile gets no starter')
})

test('someone who deliberately selected Eagle keeps Eagle', () => {
  const project = normalizeProfile(makeDefaultProfile('Existing Project'))
  const eagle = makeDefaultProfile()
  const store = installCurrentEagle({ activeId: 'builtin-eagle', profiles: [eagle, project] })
  assert.equal(store.activeId, 'builtin-eagle', 'an explicit Eagle selection is preserved')
})

test('an empty store gains both Eagle and a starter, and selects the starter', () => {
  // The genuine first-run shape: nothing stored, nothing selected.
  const store = installCurrentEagle({ activeId: '', profiles: [] })
  assert.equal(store.profiles.length, 2)
  const starter = store.profiles.find(profile => profile.name === STARTER_PROFILE_NAME)
  assert.ok(starter, 'Eagle alone is nowhere to work')
  assert.equal(store.activeId, starter.id)
})

test('an existing Eagle-only store gains a starter but keeps Eagle selected', () => {
  // Someone upgrading who only ever had Eagle. They get somewhere to work, but
  // their selection is theirs — nothing moves under them.
  const store = installCurrentEagle({ activeId: 'builtin-eagle', profiles: [makeDefaultProfile()] })
  assert.equal(store.activeId, 'builtin-eagle')
  assert.ok(store.profiles.some(profile => profile.name === STARTER_PROFILE_NAME))
})

test('an unresolvable activeId falls back to an editable profile, not the locked one', () => {
  const project = normalizeProfile(makeDefaultProfile('Existing Project'))
  const store = installCurrentEagle({ activeId: 'deleted-profile-id', profiles: [project] })
  assert.equal(store.activeId, project.id)
  assert.equal(store.profiles.find(profile => profile.id === store.activeId).locked, false)
})

/* ---------------------------------------------------------------------------
 * Copy
 * ------------------------------------------------------------------------- */

test('Duplicate copies the active profile into a new editable one', async () => {
  const app = await loadApp()
  app.eval(`
    initProfiles();
    SITE = normalizeProfile(makeDefaultProfile('Riverside'));
    SITE.mappings = { easyPower: { headerRow: 0, fields: { startingSource: 3 } } };
    SITE.rules.classify.unshift({ id: 'mine', name: 'My rule', kind: 'pattern', pattern: '^ZZ9', value: 'ZZ9', target: 'building', enabled: true });
    PROFILE_STORE.profiles.push(SITE);
    PROFILE_STORE.activeId = SITE.id;
    S.profileDraft = profileClone(activeProfile());
  `)
  const before = Number(app.eval('PROFILE_STORE.profiles.length'))
  app.eval('duplicateProfile()')

  assert.equal(Number(app.eval('PROFILE_STORE.profiles.length')), before + 1)
  const copy = JSON.parse(app.eval('JSON.stringify(activeProfile())'))
  assert.equal(copy.name, 'Riverside Copy')
  assert.equal(copy.locked, false)
  assert.equal(copy.revision, 1, 'a copy starts unpublished at revision 1')
  assert.deepEqual(copy.history, [])
  assert.equal(copy.mappings.easyPower.fields.startingSource, 3, 'column mappings come along')
  assert.ok(copy.rules.classify.some(rule => rule.id === 'mine'), 'authored rules come along')
  assert.notEqual(copy.id, app.eval('SITE.id'))
  assert.equal(app.eval('S.profileDirty'), true, 'the copy opens as an unpublished draft')
})

test('duplicating Eagle produces an editable clone and leaves Eagle locked', async () => {
  const app = await loadApp()
  app.eval(`initProfiles(); PROFILE_STORE.activeId = 'builtin-eagle'; S.profileDraft = profileClone(activeProfile()); duplicateProfile();`)
  const copy = JSON.parse(app.eval('JSON.stringify(activeProfile())'))
  assert.equal(copy.name, 'Eagle - Project Copy')
  assert.equal(copy.locked, false)
  assert.equal(copy.builtIn, false)
  assert.ok(copy.rules.classify.length > 0, 'the worked example comes with it')
  assert.equal(app.eval(`PROFILE_STORE.profiles.find(p => p.id === 'builtin-eagle').locked`), true,
    'Eagle itself is untouched')
})

test('a copy carries no legend provenance from its source', async () => {
  const app = await loadApp()
  app.eval(`
    initProfiles();
    SITE = normalizeProfile(makeDefaultProfile('Riverside'));
    SITE.legendTraining = normalizeLegendTraining({
      sources: [{ id: 'source-1', name: 'other-site.pdf' }],
      ruleOrigins: { 'rule-1': { sourceId: 'source-1', page: 2 } },
    });
    PROFILE_STORE.profiles.push(SITE);
    PROFILE_STORE.activeId = SITE.id;
    S.profileDraft = profileClone(activeProfile());
    duplicateProfile();
  `)
  const legend = JSON.parse(app.eval('JSON.stringify(activeProfile().legendTraining)'))
  assert.deepEqual(legend.sources, [])
  assert.deepEqual(legend.ruleOrigins, {}, 'a copy must not claim the original\'s documents')
})

test('the Duplicate button is offered on every profile, including the locked one', async () => {
  const app = await loadApp()
  app.eval(`initProfiles(); S.profileDraft = profileClone(activeProfile());`)
  assert.ok(app.eval('renderProfileOverview(S.profileDraft)').includes('id="duplicateProfileNow"'))

  app.eval(`PROFILE_STORE.activeId = 'builtin-eagle'; S.profileDraft = profileClone(activeProfile());`)
  const eagleMarkup = app.eval('renderProfileOverview(S.profileDraft)')
  assert.ok(eagleMarkup.includes('id="duplicateProfileNow"'), 'copying Eagle is the point of it being an example')
  assert.ok(eagleMarkup.includes('Duplicate it to start a project from its rules'))
})

/* ---------------------------------------------------------------------------
 * Delete
 * ------------------------------------------------------------------------- */

test('the last editable profile cannot be deleted down to a locked-only store', async () => {
  // Eagle is locked, so deleting the last project profile would leave nowhere
  // to work — and installCurrentEagle would quietly conjure a replacement on
  // the next load.
  const app = await loadApp()
  app.eval('initProfiles()')
  assert.equal(Number(app.eval('editableProfileCount()')), 1, 'a first run has exactly one editable profile')
  assert.ok(app.eval('renderProfileOverview(S.profileDraft = profileClone(activeProfile()))').includes('id="deleteProfile" disabled'))

  app.eval(`
    SECOND = normalizeProfile(makeDefaultProfile('Second Site'));
    PROFILE_STORE.profiles.push(SECOND);
    S.profileDraft = profileClone(activeProfile());
  `)
  assert.equal(Number(app.eval('editableProfileCount()')), 2)
  assert.equal(app.eval('renderProfileOverview(S.profileDraft)').includes('id="deleteProfile" disabled'), false,
    'with a second editable profile, delete is available')
})
