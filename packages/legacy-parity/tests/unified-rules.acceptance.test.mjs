import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { buildHtml } from '../build/build.mjs'
import { createEngine } from '../src/rules/engine.js'
import { createMemoryLookup } from '../src/rules/lookup.js'
import { serializePortableProfileEnvelope } from '../src/profile/durable-storage.js'
import { loadApp } from './support/harness.mjs'

async function loadSourceApp() {
  const directory = mkdtempSync(join(tmpdir(), 'ssmanagement-unified-'))
  const htmlPath = join(directory, 'SSManagement.html')
  writeFileSync(htmlPath, buildHtml())
  try {
    return await loadApp(htmlPath)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

test('a custom Relate rule ID affects the hierarchy through the generic decision path', async () => {
  const app = await loadSourceApp()
  const result = JSON.parse(app.eval(`
    JSON.stringify((function () {
      const profile = {
        ...makeDefaultProfile('Custom Relationship Site'),
        ...makeExampleProfile(),
        id: 'custom-relationship-site',
        name: 'Custom Relationship Site'
      };
      profile.rules = JSON.parse(JSON.stringify(profile.rules));
      profile.rules.relate.find(rule => rule.id === 'cim-parent').id = 'site-authored-cim-parent';
      PROFILE_STORE.activeId = profile.id;
      PROFILE_STORE.profiles = [profile];
      setRuleProfile(profile);

      const lookupRows = [{
        tag: 'B14-PNL-CIM-01',
        columns: { Building: 'B14' },
        attributes: {}
      }];
      S.melRows = [{ tag: 'B14-PNL-CIM-01', building: 'B14' }];
      S.melLookup = createMemoryLookup(lookupRows);

      const decision = ruleEngine().relate('B14-PNL-CIM-01', '', { sources: { mel: S.melLookup } });
      return {
        decision: { status: decision.status, parent: decision.parent, ruleId: decision.ruleId },
        integratedParent: melSyntheticParent('B14-PNL-CIM-01')
      };
    })())
  `))

  assert.deepEqual(result.decision, {
    status: 'resolved',
    parent: 'B14 - CIM',
    ruleId: 'site-authored-cim-parent',
  }, 'control: the user-authored rule itself must resolve')
  assert.equal(
    result.integratedParent,
    'B14 - CIM',
    'production hierarchy behavior must consume the decision, not recognize a special built-in rule ID',
  )
})

test('anatomy identity is the one canonical identity used by keys and the canonical model', async () => {
  const app = await loadSourceApp()
  const result = JSON.parse(app.eval(`
    JSON.stringify((function () {
      const profile = makeDefaultProfile('Anatomy Identity Site');
      profile.anatomies = [{
        id: 'panel-side-anatomy',
        name: 'Panel side',
        delimiter: '-',
        pattern: '^B14-PNL-',
        segments: [
          { name: 'building', index: 0, identity: true },
          { name: 'type', index: 1, identity: true },
          { name: 'unit', index: 2, identity: true },
          { name: 'side', index: 3, identity: false }
        ]
      }];
      profile.rules = { normalize: [], classify: [], relate: [] };
      profile.modes = [{
        id: 'flow',
        name: 'Flow',
        executor: 'raw',
        levels: [{ kind: 'flow' }]
      }];
      PROFILE_STORE.activeId = profile.id;
      PROFILE_STORE.profiles = [profile];
      setRuleProfile(profile);

      const names = ['B14-PNL-1-LEFT', 'B14-PNL-1-RIGHT'];
      const roots = names.map((name, index) => ({
        id: 'raw-' + index,
        name,
        parent: null,
        children: [],
        isId: true,
        isLoad: false,
        isInstrument: false
      }));
      S.roots = roots;
      S.nodeById = new Map(roots.map(node => [node.id, node]));
      S.ssmCombined = [];
      buildCanonicalModel();

      return {
        engineCanonicals: names.map(name => ruleEngine().resolve(name).canonical),
        applicationKeys: names.map(name => tagKey(name)),
        canonicalSize: S.canonicalModel.size,
        canonicalTags: [...S.canonicalModel.values()].map(record => record.tag)
      };
    })())
  `))

  assert.deepEqual(result, {
    engineCanonicals: ['B14-PNL-1', 'B14-PNL-1'],
    applicationKeys: ['b14-pnl-1', 'b14-pnl-1'],
    canonicalSize: 1,
    canonicalTags: ['B14-PNL-1'],
  }, 'identity anatomy must control register keys, merges, hierarchy records, comparison, and export identity')
})

test('arbitrary Classify attributes survive canonicalization and drive projected levels', async () => {
  const app = await loadSourceApp()
  const result = JSON.parse(app.eval(`
    JSON.stringify((function () {
      const profile = makeDefaultProfile('Custom Attribute Site');
      profile.anatomies = [];
      profile.rules = {
        normalize: [],
        classify: [{
          id: 'classify-area-7',
          name: 'Area 7',
          kind: 'pattern',
          target: 'area',
          pattern: '^AREA7-',
          value: 'Area 7',
          enabled: true
        }],
        relate: []
      };
      const mode = {
        id: 'area-view',
        name: 'Area View',
        executor: 'projected',
        levels: [
          { kind: 'grouping', attribute: 'area', fallback: 'Unassigned Area' },
          { kind: 'flow' }
        ]
      };
      profile.modes = [mode];
      PROFILE_STORE.activeId = profile.id;
      PROFILE_STORE.profiles = [profile];
      setRuleProfile(profile);

      const raw = {
        id: 'raw-area-7',
        name: 'AREA7-PNL-1',
        parent: null,
        children: [],
        isId: true,
        isLoad: false,
        isInstrument: false
      };
      S.roots = [raw];
      S.nodeById = new Map([[raw.id, raw]]);
      S.ssmCombined = [];
      buildCanonicalModel();
      const projection = buildModeProjection(mode);
      const record = [...S.canonicalModel.values()][0];

      return {
        engineArea: ruleEngine().resolve(raw.name).attributes.area || '',
        recordArea: record.area || '',
        projectionRoots: projection.roots.map(node => node.name),
        projectedEquipment: [...projection.nodeById.values()]
          .filter(node => node.kind === 'equipment')
          .map(node => node.name)
      };
    })())
  `))

  assert.deepEqual(result, {
    engineArea: 'Area 7',
    recordArea: 'Area 7',
    projectionRoots: ['Area 7'],
    projectedEquipment: ['AREA7-PNL-1'],
  }, 'a user-defined attribute such as area, contractor, or package must remain available to any mode')
})

test('all dependencies survive canonical records and projected hierarchy nodes', async () => {
  const app = await loadSourceApp()
  const result = JSON.parse(app.eval(`
    JSON.stringify((function () {
      const profile = makeDefaultProfile('Multiple Dependency Site');
      profile.anatomies = [];
      profile.rules = { normalize: [], classify: [], relate: [] };
      const mode = {
        id: 'flat',
        name: 'Flat',
        executor: 'projected',
        levels: [{ kind: 'flow' }]
      };
      profile.modes = [mode];
      PROFILE_STORE.activeId = profile.id;
      PROFILE_STORE.profiles = [profile];
      setRuleProfile(profile);

      const raw = {
        id: 'raw-equip',
        name: 'EQUIP-1',
        parent: null,
        children: [],
        isId: true,
        isLoad: false,
        isInstrument: false
      };
      S.roots = [raw];
      S.nodeById = new Map([[raw.id, raw]]);
      S.ssmCombined = [
        ['EQUIP-1', 'PARENT-1', 'DEP-A'],
        ['EQUIP-1', 'PARENT-1', 'DEP-B']
      ];
      buildCanonicalModel();
      const projection = buildModeProjection(mode);
      const record = canonicalRecord('EQUIP-1');
      const node = [...projection.nodeById.values()].find(item => item.canonicalKey === record.key);
      const nodeDependencies = node && node.dependencies instanceof Set
        ? [...node.dependencies]
        : Array.isArray(node && node.dependencies)
          ? node.dependencies
          : [];

      return {
        canonicalDependencies: [...record.dependencies].sort(),
        projectedDependencies: [...nodeDependencies].sort()
      };
    })())
  `))

  assert.deepEqual(result.canonicalDependencies, ['DEP-A', 'DEP-B'],
    'normalize/merge must union dependency evidence')
  assert.deepEqual(result.projectedDependencies, ['DEP-A', 'DEP-B'],
    'projection must retain the complete dependency set instead of selecting its first member')
})

test('profile source priority resolves independent parent observations', async () => {
  const app = await loadSourceApp()
  const result = JSON.parse(app.eval(`
    JSON.stringify((function () {
      const profile=makeDefaultProfile('Source Priority Site');
      profile.rules={normalize:[],classify:[],relate:[]};
      profile.modes=[{id:'flow',name:'Flow',executor:'projected',levels:[{kind:'flow'}]}];
      PROFILE_STORE.activeId=profile.id;PROFILE_STORE.profiles=[profile];setRuleProfile(profile);
      const rawParent={id:'raw-parent',name:'EP-PARENT',parent:null,children:[],isId:false,isLoad:false,isInstrument:false};
      const rawEquipment={id:'raw-equipment',name:'EQUIP-1',parent:rawParent,children:[],isId:true,isLoad:false,isInstrument:false};
      rawParent.children=[rawEquipment];S.roots=[rawParent];S.nodeById=new Map([[rawParent.id,rawParent],[rawEquipment.id,rawEquipment]]);
      S.ssmCombined=[['EP-PARENT','',''],['EQUIP-1','EP-PARENT','']];
      resetSourceParentClaims();
      recordSourceParentClaim('easyPower','EQUIP-1','EP-PARENT',{row:2});
      recordSourceParentClaim('cable','EQUIP-1','CABLE-PARENT',{row:9});
      profile.hierarchy.parentSourcePriority=['easyPower','cable','mel','pmd'];
      buildCanonicalModel();const easyFirst=canonicalRecord('EQUIP-1').ssmParentTag;
      S.ssmCombined=[['EP-PARENT','',''],['EQUIP-1','EP-PARENT','']];
      profile.hierarchy.parentSourcePriority=['cable','easyPower','mel','pmd'];
      buildCanonicalModel();const cableFirst=canonicalRecord('EQUIP-1').ssmParentTag;
      return {easyFirst,cableFirst};
    })())
  `))
  assert.deepEqual(result,{easyFirst:'EP-PARENT',cableFirst:'CABLE-PARENT'})
})

test('a saved branch placement overrides every source and updates the canonical register', async () => {
  const app = await loadSourceApp()
  const result = JSON.parse(app.eval(`
    JSON.stringify((function () {
      const profile=makeDefaultProfile('Manual Placement Site');
      profile.rules={normalize:[],classify:[],relate:[]};
      profile.modes=[{id:'flow',name:'Flow',executor:'projected',levels:[{kind:'flow'}]}];
      profile.overrides={relationships:[{
        id:'placement-equip-1',
        equipment:'EQUIP-1',
        parent:'ENGINEER-PARENT',
        savedAt:'2026-07-27T12:00:00.000Z'
      }]};
      PROFILE_STORE.activeId=profile.id;PROFILE_STORE.profiles=[profile];setRuleProfile(profile);
      const sourceParent={id:'raw-parent',name:'SOURCE-PARENT',parent:null,children:[],isId:false,isLoad:false,isInstrument:false};
      const equipment={id:'raw-equipment',name:'EQUIP-1',parent:sourceParent,children:[],isId:true,isLoad:false,isInstrument:false};
      sourceParent.children=[equipment];S.roots=[sourceParent];S.nodeById=new Map([[sourceParent.id,sourceParent],[equipment.id,equipment]]);
      S.ssmCombined=[['SOURCE-PARENT','',''],['EQUIP-1','SOURCE-PARENT','']];
      resetSourceParentClaims();
      recordSourceParentClaim('easyPower','EQUIP-1','SOURCE-PARENT',{row:2});
      recordSourceParentClaim('cable','EQUIP-1','CABLE-PARENT',{row:9});
      buildCanonicalModel();
      const record=canonicalRecord('EQUIP-1');
      const register=S.ssmCombined.find(row=>tagKey(row[0])===tagKey('EQUIP-1'));
      return {
        parent:record.ssmParentTag,
        registerParent:register&&register[1],
        manual:record.resolution.parentResolution.manual,
        selected:record.resolution.parentResolution.selectedCandidateId
      };
    })())
  `))

  assert.deepEqual(result,{
    parent:'ENGINEER-PARENT',
    registerParent:'ENGINEER-PARENT',
    manual:true,
    selected:'manual:placement-equip-1'
  })
})

test('an embedded update profile handoff is committed to durable storage on first boot', async () => {
  const app = await loadSourceApp()
  const payload = {
    schemaVersion: 2,
    activeId: 'transferred-site',
    profiles: [{
      schemaVersion: 2,
      id: 'transferred-site',
      name: 'Transferred Site',
      builtIn: false,
      locked: false,
      revision: 7,
      updatedAt: '2026-07-27T12:00:00.000Z',
    }],
  }
  const envelope = serializePortableProfileEnvelope(payload, { clock: () => 123456, pretty: false })
  const encoded = Buffer.from(envelope, 'utf8').toString('base64')
  app.sandbox.atob = value => Buffer.from(value, 'base64').toString('binary')
  const result = JSON.parse(app.eval(`
    JSON.stringify((function () {
      document.querySelector = selector => selector === '#ssmanagement-profile-transfer'
        ? { textContent: ${JSON.stringify(encoded)} }
        : null;
      initProfiles();
      const durable=PROFILE_DURABLE_STORAGE.read();
      return {
        activeName:activeProfile().name,
        activeRevision:activeProfile().revision,
        durableOk:durable.ok,
        durableActiveId:durable.ok&&durable.value.activeId,
        durableProfileNames:durable.ok?durable.value.profiles.map(profile=>profile.name):[]
      };
    })())
  `))

  assert.deepEqual(result, {
    activeName: 'Transferred Site',
    activeRevision: 7,
    durableOk: true,
    durableActiveId: 'transferred-site',
    durableProfileNames: ['SSManagement Default', 'Transferred Site'],
  })
})

test('ambiguous fragment lookups are explicit instead of selecting the first row', () => {
  const engine = createEngine({
    anatomies: [],
    rules: {
      normalize: [],
      classify: [],
      relate: [{
        id: 'site-cim-parent',
        name: 'CIM parent',
        kind: 'fragmentLookup',
        markers: ['-CIM'],
        fragmentFrom: 'wholeTag',
        source: 'mel',
        mode: 'containing',
        parent: [
          { kind: 'column', name: 'Building' },
          { kind: 'literal', text: ' - CIM' },
        ],
        ambiguousReason: 'Several MEL rows contain the same CIM tag',
        enabled: true,
      }],
    },
  })
  const mel = createMemoryLookup([
    { tag: 'F15-B14-CIM', columns: { Building: 'F15' }, attributes: {} },
    { tag: 'F16-B14-CIM', columns: { Building: 'F16' }, attributes: {} },
  ])

  const decision = engine.relate('B14-CIM', '', { sources: { mel } })
  assert.equal(decision.status, 'ambiguous')
  assert.deepEqual(decision.candidates, ['F15-B14-CIM', 'F16-B14-CIM'])
  assert.match(decision.reason, /several|ambiguous|multiple/i)
  assert.equal(decision.parent, '', 'no guessed parent may leak out of an ambiguous lookup')
})

const SEMANTIC_PROFILE_CHANGES = [
  ['Normalize rules', `
    S.profileDraft.rules.normalize.push({
      id: 'strip-site-suffix',
      name: 'Strip site suffix',
      kind: 'stripSuffix',
      separators: ['-'],
      suffixes: ['ZZ'],
      stage: 'identity',
      enabled: true
    });
  `],
  ['Classify rules', `
    S.profileDraft.rules.classify.push({
      id: 'classify-area',
      name: 'Area',
      kind: 'pattern',
      target: 'area',
      pattern: '^AREA-',
      value: 'Area',
      enabled: true
    });
  `],
  ['Relate rules', `
    S.profileDraft.rules.relate.push({
      id: 'site-root',
      name: 'Site root',
      kind: 'constant',
      pattern: '^SITE-',
      parent: 'SITE ROOT',
      enabled: true
    });
  `],
  ['Tag anatomy', `
    S.profileDraft.anatomies.push({
      id: 'site-anatomy',
      name: 'Site anatomy',
      delimiter: '-',
      pattern: '^SITE-',
      segments: [{ name: 'site', index: 0, identity: true }]
    });
  `],
  ['Hierarchy modes and roots', `
    S.profileDraft.modes[0].rootPolicy.requireRoot = '900 High Voltage';
    S.profileDraft.modes[0].rootPolicy.fallbackParent = '900 High Voltage';
  `],
  ['Parent-source precedence', `
    S.profileDraft.hierarchy.parentSourcePriority =
      [...S.profileDraft.hierarchy.parentSourcePriority].reverse();
  `],
]

for (const [label, mutation] of SEMANTIC_PROFILE_CHANGES) {
  test(`${label} require a full hierarchy rebuild when published`, async () => {
    const app = await loadSourceApp()
    const result = JSON.parse(app.eval(`
      JSON.stringify((function () {
        const profile = normalizeProfile({
          ...makeDefaultProfile('Semantic Change Site'),
          ...makeExampleProfile(),
          id: 'semantic-change-site',
          name: 'Semantic Change Site',
          builtIn: false,
          locked: false
        });
        PROFILE_STORE.activeId = profile.id;
        PROFILE_STORE.profiles = [profile];
        setRuleProfile(profile);

        const root = {
          id: 'existing-root',
          name: '602 Medium Voltage',
          parent: null,
          children: [],
          isId: true,
          isLoad: false,
          isInstrument: false
        };
        S.roots = [root];
        S.nodeById = new Map([[root.id, root]]);
        S.ssmCombined = [];
        S.profileDraft = profileClone(profile);
        S.profileDirty = true;
        S.profileNeedsRebuild = false;
        ${mutation}
        publishProfileDraft();
        return {
          needsFullRebuild: S.profileNeedsRebuild,
          publishedRevision: activeProfile().revision
        };
      })())
    `))

    assert.equal(result.publishedRevision, 2, 'control: the semantic change was published')
    assert.equal(
      result.needsFullRebuild,
      true,
      `${label} can change identity or relationships, so projection-only refresh is unsafe`,
    )
  })
}
