import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadApp } from './support/harness.mjs'

test('Site Profile Studio exposes every built-in rule and hierarchy mode as reference material', async () => {
  const app = await loadApp()
  const result = JSON.parse(app.eval(`
    JSON.stringify((function () {
      initProfiles();
      /* Select the locked SSManagement Default reference explicitly. */
      PROFILE_STORE.activeId = 'builtin-eagle';
      setRuleProfile(activeProfile());
      const eagle = activeProfile();
      S.profileDraft = profileClone(eagle);
      S.profileUi.engineRuleRef = 'classify:role-gis';
      const trainer = renderTagTrainer(eagle);
      const relationships = renderRelationshipsProfile(eagle);
      const hierarchy = renderHierarchyProfile(eagle);
      return {
        normalize: eagle.rules.normalize.map(rule => ({
          name: rule.name,
          visible: trainer.includes(rule.name),
          noteVisible: !rule.note || trainer.includes(esc(rule.note))
        })),
        classify: eagle.rules.classify.map(rule => ({
          name: rule.name,
          visible: trainer.includes(rule.name),
          noteVisible: !rule.note || trainer.includes(esc(rule.note))
        })),
        relate: eagle.rules.relate.map(rule => ({
          name: rule.name,
          visible: relationships.includes(rule.name),
          noteVisible: !rule.note || relationships.includes(esc(rule.note))
        })),
        modes: eagle.modes.map(mode => ({
          name: mode.name,
          visible: hierarchy.includes(mode.name),
          levelsVisible: mode.levels.every(level =>
            level.kind === 'flow' ? hierarchy.includes('Electrical relationship flow') : hierarchy.includes(level.attribute)
          )
        })),
        hasSuffixValues: trainer.includes('P, S, OUTPUT'),
        hasPatternEditor: trainer.includes('enginePattern'),
        hasRoot: hierarchy.includes('602 Medium Voltage'),
        hasExecutionPolicies:['resolutionStrategy','downstreamGapPolicy','caseVariantPolicy','duplicateRegisterPolicy',
          'cableConflictPolicy','duplicateParentReviewPolicy']
          .every(id=>hierarchy.includes('id="'+id+'"')),
        workflowPolicies:Object.keys(eagle.hierarchy.workflow).every(key=>hierarchy.includes('data-workflow-policy="'+key+'"')),
        hasFallbackDefault:hierarchy.includes('id="fallbackDefaultSystem"'),
        lockedEditor: trainer.includes('id="saveEngineRule" disabled')
      };
    })())
  `))

  for (const family of ['normalize', 'classify', 'relate']) {
    assert.ok(result[family].every(item => item.visible && item.noteVisible), `${family} rules must be fully visible`)
  }
  assert.ok(result.modes.every(item => item.visible && item.levelsVisible), 'every hierarchy mode and level must be visible')
  assert.equal(result.hasSuffixValues, true)
  assert.equal(result.hasPatternEditor, true)
  assert.equal(result.hasRoot, true)
  assert.equal(result.hasExecutionPolicies, true)
  assert.equal(result.workflowPolicies, true)
  assert.equal(result.hasFallbackDefault, true)
  assert.equal(result.lockedEditor, true)
})

test('an Eagle clone exposes enabled structured editors without losing executable definitions', async () => {
  const app = await loadApp()
  const result = JSON.parse(app.eval(`
    JSON.stringify((function () {
      initProfiles();
      const original = profileClone(activeProfile());
      const copy = normalizeProfile({
        ...profileCore(original),
        id: 'editable-eagle-copy',
        name: 'Editable Eagle Copy',
        builtIn: false,
        locked: false
      });
      S.profileDraft = copy;
      S.profileUi.engineRuleRef = 'classify:match-last4';
      S.profileUi.relationRuleId = 'transformer-match';
      const trainer = renderTagTrainer(copy);
      const relationships = renderRelationshipsProfile(copy);
      const hierarchy = renderHierarchyProfile(copy);
      return {
        sameRules: JSON.stringify(copy.rules) === JSON.stringify(original.rules),
        sameModes: JSON.stringify(copy.modes) === JSON.stringify(original.modes),
        sameHierarchy: JSON.stringify(copy.hierarchy) === JSON.stringify(original.hierarchy),
        engineSaveEnabled: trainer.includes('id="saveEngineRule"') && !trainer.includes('id="saveEngineRule" disabled'),
        relationshipSaveEnabled: relationships.includes('id="saveRelationRule"') && !relationships.includes('id="saveRelationRule" disabled'),
        modeInputsEnabled: hierarchy.includes('data-mode-field="requireRoot"') && !hierarchy.includes('data-mode-field="requireRoot" value="602 Medium Voltage" disabled'),
        policiesEnabled: hierarchy.includes('id="resolutionStrategy"')&&!hierarchy.includes('id="resolutionStrategy" disabled')
      };
    })())
  `))

  assert.deepEqual(result, {
    sameRules: true,
    sameModes: true,
    sameHierarchy: true,
    engineSaveEnabled: true,
    relationshipSaveEnabled: true,
    modeInputsEnabled: true,
    policiesEnabled: true,
  })
})

test('every Eagle relationship method opens as a structured editable reference after cloning', async () => {
  const app=await loadApp()
  const result=JSON.parse(app.eval(`
    JSON.stringify((function(){
      initProfiles();
      const original=activeProfile(),copy=normalizeProfile({...profileCore(original),id:'all-editors',name:'All Editors',builtIn:false,locked:false});
      S.profileDraft=copy;
      const required={
        'scr-scc-parent':['relMarkers','relLookupMode','relOnMultiple','relationPartSuggestions'],
        'cim-parent':['relMarkers','relFragmentFrom','relOnMultiple','relationPartSuggestions'],
        'mah-parent':['relNeedle','relDelimiter','relAlsoParent'],
        'transformer-match':['relOwnAttribute','relParentAttribute','relSharedAttribute','relPreferExact'],
        'gis-system-root':['relMatchMode','relParent','relRequiresNoParent']
      };
      return Object.fromEntries(Object.entries(required).map(([id,fields])=>{
        S.profileUi.relationRuleId=id;
        const html=renderRelationshipsProfile(copy);
        return [id,fields.every(field=>html.includes('id="'+field+'"'))&&!html.includes('id="saveRelationRule" disabled')];
      }));
    })())
  `))
  assert.ok(Object.values(result).every(Boolean),JSON.stringify(result))
})
