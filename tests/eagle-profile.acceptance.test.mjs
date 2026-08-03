import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import * as defaults from '../src/rules/defaults.js'
import { RULES_SCHEMA_VERSION } from '../src/rules/schema.js'
import { invalidateRuleEngine, ruleEngine, setRuleProfile } from '../src/rules/provider.js'
import { buildHtml } from '../build/build.mjs'
import { loadApp } from './support/harness.mjs'
import { captureScenario, SCENARIOS } from './support/snapshot.mjs'

const EAGLE_NAME = 'Eagle - SSM Builder Legacy'
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EAGLE_RULE_IDS = {
  normalize: ['norm-panel-sides', 'norm-power-variant'],
  classify: [
    'role-gis',
    'role-xfm',
    'role-lvs',
    'topology-gis-token',
    'topology-bus-token',
    'ph-spare-sp',
    'ph-spare-word',
    'ph-space',
    'ph-note',
    'match-last4',
  ],
  relate: [
    'scr-scc-parent',
    'cim-parent',
    'mah-parent',
    'transformer-match',
    'gis-system-root',
  ],
}

async function withSourceHtml(run) {
  const directory = mkdtempSync(join(tmpdir(), 'ssmanagement-eagle-'))
  const htmlPath = join(directory, 'SSMCompiler.html')
  writeFileSync(htmlPath, buildHtml())
  try {
    return await run(htmlPath)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

async function loadSourceApp() {
  return withSourceHtml(htmlPath => loadApp(htmlPath))
}

function ids(profile, family) {
  return (profile.rules?.[family] || []).map(rule => rule.id)
}

test('Eagle is an explicit named compatibility-profile factory', () => {
  assert.equal(
    typeof defaults.makeEagleRuleProfile,
    'function',
    'export makeEagleRuleProfile() so Eagle is a first-class compatibility preset, not an implicit provider fallback',
  )

  const eagle = defaults.makeEagleRuleProfile()
  assert.equal(eagle.name, EAGLE_NAME)
  assert.equal(eagle.locked, true, 'the compatibility baseline must be immutable')
})

test('a first-run profile store exposes Eagle as a selectable self-contained profile', async () => {
  const app = await loadSourceApp()
  app.eval('initProfiles()')
  const profiles = JSON.parse(app.eval('JSON.stringify(PROFILE_STORE.profiles)'))
  const eagle = profiles.find(profile => profile.name === EAGLE_NAME)

  assert.ok(eagle, 'a fresh install must visibly offer a profile named Eagle')
  assert.equal(eagle.locked, true)
  assert.ok(Object.hasOwn(eagle, 'anatomies'), 'Eagle must own its anatomy definitions')
  assert.ok(Object.hasOwn(eagle, 'modes'), 'Eagle must own its hierarchy modes')
  assert.ok(Object.hasOwn(eagle, 'rules'), 'Eagle must own its rules instead of inheriting hidden defaults')
  assert.deepEqual(Object.keys(eagle.rules).sort(), ['classify', 'normalize', 'relate'])
  assert.deepEqual({
    resolutionStrategy:eagle.hierarchy.resolutionStrategy,
    downstreamGapPolicy:eagle.hierarchy.downstreamGapPolicy,
    caseVariantPolicy:eagle.hierarchy.caseVariantPolicy,
    duplicateRegisterPolicy:eagle.hierarchy.duplicateRegisterPolicy,
    cableConflictPolicy:eagle.hierarchy.cableConflictPolicy,
    duplicateParentReviewPolicy:eagle.hierarchy.duplicateParentReviewPolicy,
    workflow:eagle.hierarchy.workflow,
  },{
    resolutionStrategy:'legacy-register',
    downstreamGapPolicy:'truncate',
    caseVariantPolicy:'preserve',
    duplicateRegisterPolicy:'first',
    cableConflictPolicy:'legacy-chain-review',
    duplicateParentReviewPolicy:'first-silent',
    workflow:{
      gisBusCompaction:true,
      cableParentChains:true,
      melUpnParents:true,
      /* Off for Eagle specifically. The frozen SSM Builder only ever used MEL
         as a UPN-mismatch correction, never as a general parent source, so a
         project profile's default would move the frozen tree. */
      melSystemParentClaims:false,
      pmdInstrumentAttachment:true,
      enforceSystemRoot:true,
    },
  },'Eagle must declare its legacy execution policies instead of inheriting hidden behavior')
})

test('Eagle materializes every shipped normalize, classify, and relate rule', () => {
  const eagle = defaults.makeEagleRuleProfile()
  assert.deepEqual(
    {
      schemaVersion: eagle.schemaVersion,
      normalize: ids(eagle, 'normalize'),
      classify: ids(eagle, 'classify'),
      relate: ids(eagle, 'relate'),
    },
    {
      schemaVersion: RULES_SCHEMA_VERSION,
      ...EAGLE_RULE_IDS,
    },
    'the compatibility profile is the auditable source of every shipped convention',
  )
})

test('Eagle declares the exact legacy modes and medium-voltage root', () => {
  const eagle = defaults.makeEagleRuleProfile()
  assert.deepEqual(
    (eagle.modes || []).map(mode => ({
      id: mode.id,
      name: mode.name,
      executor: mode.executor,
      root: mode.rootPolicy?.requireRoot || '',
      levels: mode.levels.map(level => level.kind === 'grouping' ? level.attribute : level.kind),
    })),
    [
      {
        id: 'electrical-flow',
        name: 'Electrical Flow',
        executor: 'raw',
        root: '602 Medium Voltage',
        levels: ['flow'],
      },
      {
        id: 'ssm',
        name: 'SSM Hierarchy',
        executor: 'projected',
        root: '',
        levels: ['building', 'discipline', 'system', 'flow'],
      },
    ],
  )
})

test('Eagle keeps the staged MEL result ahead of raw source claims', async () => {
  const app=await loadSourceApp()
  const result=JSON.parse(app.eval(`
    JSON.stringify((function(){
      initProfiles();
      /* Eagle explicitly. This pins Eagle's legacy-register staging, and a first
         run now lands on an editable starter that resolves by source priority
         instead -- so relying on the default would silently test the wrong
         resolution strategy. */
      PROFILE_STORE.activeId='builtin-eagle';
      const profile=activeProfile();profile.rules={normalize:[],classify:[],relate:[]};setRuleProfile(profile);
      const parent={id:'parent',name:'EP-PARENT',parent:null,children:[],isId:false,isLoad:false,isInstrument:false};
      const equipment={id:'equipment',name:'EQUIP-1',parent,children:[],isId:true,isLoad:false,isInstrument:false};
      parent.children=[equipment];S.roots=[parent];S.nodeById=new Map([[parent.id,parent],[equipment.id,equipment]]);
      S.ssmCombined=[['EP-PARENT','',''],['MEL-PARENT','',''],['EQUIP-1','MEL-PARENT','CABLE-PARENT']];
      resetSourceParentClaims();
      recordSourceParentClaim('easyPower','EQUIP-1','EP-PARENT',{row:1});
      recordSourceParentClaim('cable','EQUIP-1','CABLE-PARENT',{row:2});
      recordSourceParentClaim('mel','EQUIP-1','MEL-PARENT',{row:3});
      buildCanonicalModel();
      const record=canonicalRecord('EQUIP-1');
      return {parent:record.ssmParentTag,dependency:[...record.dependencies],register:S.ssmCombined};
    })())
  `))
  assert.equal(result.parent,'MEL-PARENT')
  assert.deepEqual(result.dependency,['CABLE-PARENT'])
  assert.deepEqual(result.register,[['EP-PARENT','',''],['MEL-PARENT','',''],['EQUIP-1','MEL-PARENT','CABLE-PARENT']])
})

for (const scenario of SCENARIOS) {
  test(`Eagle reproduces the approved compatibility baseline: ${scenario.name}`, async () => {
    const golden = JSON.parse(
      readFileSync(resolve(rootDir, 'tests/golden', `${scenario.name}.json`), 'utf8'),
    )
    const actual = await withSourceHtml(htmlPath => captureScenario(scenario, htmlPath))
    assert.deepEqual(actual, golden)
  })
}

test('a profile with no materialized rules never silently behaves like Eagle', () => {
  invalidateRuleEngine()
  let rejected = false
  let resolved = null
  try {
    setRuleProfile({ schemaVersion: RULES_SCHEMA_VERSION, name: 'Incomplete Project Profile' })
    resolved = ruleEngine().resolve('B14-LVS-1234-A')
  } catch (_) {
    rejected = true
  } finally {
    setRuleProfile(null)
  }

  assert.ok(
    rejected || (
      resolved?.canonical === 'B14-LVS-1234-A'
      && resolved?.attributes?.equipmentType == null
    ),
    'an incomplete profile may be rejected or act empty, but it must not inherit Eagle invisibly',
  )
})

function seedLockedEagle(app) {
  app.eval(`
    (function () {
      const profile = normalizeProfile({
        ...makeDefaultProfile(${JSON.stringify(EAGLE_NAME)}),
        ...makeEagleRuleProfile(),
        id: 'eagle-compatibility',
        name: ${JSON.stringify(EAGLE_NAME)},
        locked: true
      });
      PROFILE_STORE.activeId = profile.id;
      PROFILE_STORE.profiles = [profile];
      S.profileDraft = null;
      S.profileDirty = false;
      setRuleProfile(profile);
    })()
  `)
}

test('Eagle is locked against direct publication changes', async () => {
  const app = await loadSourceApp()
  seedLockedEagle(app)

  const result = JSON.parse(app.eval(`
    JSON.stringify((function () {
      const before = profileClone(activeProfile());
      S.profileDraft = profileClone(before);
      S.profileDraft.rules.normalize[0].enabled = false;
      S.profileDirty = true;
      publishProfileDraft();
      const after = activeProfile();
      return {
        beforeRevision: before.revision,
        afterRevision: after.revision,
        beforeEnabled: before.rules.normalize[0].enabled,
        afterEnabled: after.rules.normalize[0].enabled,
        locked: after.locked
      };
    })())
  `))

  assert.deepEqual(result, {
    beforeRevision: 1,
    afterRevision: 1,
    beforeEnabled: true,
    afterEnabled: true,
    locked: true,
  }, 'saving edits while Eagle is selected must leave the compatibility baseline untouched')
})

test('Eagle can be cloned into an editable profile without losing behavior', async () => {
  const app = await loadSourceApp()
  seedLockedEagle(app)

  const result = JSON.parse(app.eval(`
    JSON.stringify((function () {
      const original = profileClone(activeProfile());
      duplicateProfile();
      const copy = activeProfile();
      return {
        count: PROFILE_STORE.profiles.length,
        originalStillLocked: PROFILE_STORE.profiles.find(item => item.id === original.id).locked,
        differentId: copy.id !== original.id,
        copyName: copy.name,
        copyLocked: copy.locked,
        sameAnatomies: JSON.stringify(copy.anatomies) === JSON.stringify(original.anatomies),
        sameModes: JSON.stringify(copy.modes) === JSON.stringify(original.modes),
        sameRules: JSON.stringify(copy.rules) === JSON.stringify(original.rules)
      };
    })())
  `))

  assert.deepEqual(result, {
    count: 2,
    originalStillLocked: true,
    differentId: true,
    copyName: 'Eagle - Project Copy',
    copyLocked: false,
    sameAnatomies: true,
    sameModes: true,
    sameRules: true,
  }, 'Clone must produce an editable, behaviorally identical starting point')
})
