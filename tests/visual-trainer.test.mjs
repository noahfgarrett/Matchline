import test from 'node:test'
import assert from 'node:assert/strict'
import { loadApp } from './support/harness.mjs'

function record(tag, parent = '') {
  return {
    key: tag.toLowerCase(),
    tag,
    sourceKind: 'easyPower',
    mel: null,
    pmdBuilding: '',
    systemHint: '602 Medium Voltage',
    isInstrument: false,
    isLoad: false,
    isId: false,
    includeInHierarchy: true,
    includeInRegister: true,
    ssmParentTag: parent,
  }
}

test('Visual Trainer infers a reusable canonical LVS-to-XFM rule without mutating the draft', async () => {
  const app = await loadApp()
  const result = app.eval(`
    (() => {
      const profile=normalizeProfile({...makeDefaultProfile('Visual Test'),builtIn:false,locked:false});
      const x372=${JSON.stringify(record('F15-XFMY372B'))};
      const x373=${JSON.stringify(record('F15-XFMY373B'))};
      const l373=${JSON.stringify(record('F15-LVSY373B','F15-XFMY372B'))};
      const records=new Map([x372,x373,l373].map(item=>[item.key,item]));
      const before=JSON.stringify(profile);
      const rule=visualTrainerRelationshipRule(l373,x373,profile,records);
      const impact=visualTrainerRelationshipImpact(profile,l373,x373,'similar',records,rule);
      return {before,after:JSON.stringify(profile),rule,impact:{
        valid:impact.valid,moved:impact.moved,ambiguous:impact.ambiguous,
        dependenciesChanged:impact.dependenciesChanged,example:impact.examples[0]
      }};
    })()
  `)
  assert.equal(result.before, result.after)
  assert.equal(result.rule.kind, 'attributeMatch')
  assert.equal(result.rule.source, 'canonical')
  assert.deepEqual(JSON.parse(JSON.stringify(result.rule.match)), { equipmentType: 'XFM', matchKey: '@matchKey' })
  assert.deepEqual(JSON.parse(JSON.stringify(result.impact)), {
    valid: true,
    moved: 1,
    ambiguous: 0,
    dependenciesChanged: 0,
    example: { tag: 'F15-LVSY373B', before: 'F15-XFMY372B', after: 'F15-XFMY373B' },
  })
})

test('Visual Trainer refuses a reusable rule when the dragged example is ambiguous', async () => {
  const app = await loadApp()
  const result = app.eval(`
    (() => {
      const profile=normalizeProfile({...makeDefaultProfile('Visual Test'),builtIn:false,locked:false});
      const current=${JSON.stringify(record('F15-XFMY372B'))};
      const first=${JSON.stringify(record('F15-XFMY373B'))};
      const second=${JSON.stringify(record('F16-XFMY373B'))};
      const child=${JSON.stringify(record('F15-LVSY373B','F15-XFMY372B'))};
      const records=new Map([current,first,second,child].map(item=>[item.key,item]));
      const rule=visualTrainerRelationshipRule(child,first,profile,records);
      const impact=visualTrainerRelationshipImpact(profile,child,first,'similar',records,rule);
      return {valid:impact.valid,ambiguous:impact.ambiguous,reason:impact.reason};
    })()
  `)
  assert.equal(result.valid, false)
  assert.equal(result.ambiguous, 1)
  assert.match(result.reason, /more than one possible parent/i)
})

test('exact Visual Trainer moves reject descendant destinations and leave dependencies untouched', async () => {
  const app = await loadApp()
  const result = app.eval(`
    (() => {
      const profile=normalizeProfile({...makeDefaultProfile('Visual Test'),builtIn:false,locked:false});
      const a=${JSON.stringify(record('A','B'))};
      const b=${JSON.stringify(record('B','C'))};
      const c=${JSON.stringify(record('C'))};
      const records=new Map([a,b,c].map(item=>[item.key,item]));
      const impact=visualTrainerRelationshipImpact(profile,c,a,'single',records);
      return {valid:impact.valid,invalid:impact.invalid,dependenciesChanged:impact.dependenciesChanged,reason:impact.reason};
    })()
  `)
  assert.equal(result.valid, false)
  assert.equal(result.dependenciesChanged, 0)
  assert.match(result.reason, /descendants/i)
})

test('grouping moves compile to exact attribute overrides or reusable Classify rules', async () => {
  const app = await loadApp()
  const result = app.eval(`
    (() => {
      const profile=normalizeProfile({...makeDefaultProfile('Visual Test'),builtIn:false,locked:false});
      const first=${JSON.stringify(record('F15-LVSY373B','F15-XFMY373B'))};
      const second=${JSON.stringify(record('F16-LVSY374B','F16-XFMY374B'))};
      const records=new Map([first,second].map(item=>[item.key,item]));
      const values={building:'B14',discipline:'Electrical',system:'602 Medium Voltage'};
      const exact=visualTrainerGroupingImpact(profile,first,values,'single',records);
      const rules=visualTrainerGroupingRules(first,values,profile,records);
      const similar=visualTrainerGroupingImpact(profile,first,values,'similar',records,rules);
      const compiled=compileRuleProfile(similar.candidate,{allowUnmapped:true});
      return {
        exact:{valid:exact.valid,moved:exact.moved,values:exact.override.values},
        similar:{valid:similar.valid,moved:similar.moved,targets:rules.map(rule=>rule.target)},
        compiled:compiled.ok,
        originalOverrides:(profile.overrides.attributes||[]).length
      };
    })()
  `)
  assert.deepEqual(JSON.parse(JSON.stringify(result.exact)), {
    valid: true,
    moved: 1,
    values: { building: 'B14', discipline: 'Electrical', system: '602 Medium Voltage' },
  })
  assert.equal(result.similar.valid, true)
  assert.equal(result.similar.moved, 2)
  assert.deepEqual([...result.similar.targets], ['building', 'discipline', 'system'])
  assert.equal(result.compiled, true)
  assert.equal(result.originalOverrides, 0)
})

test('profile compiler validates canonical relationship sources and grouping overrides', async () => {
  const app = await loadApp()
  const result = app.eval(`
    (() => {
      const profile=normalizeProfile({...makeDefaultProfile('Visual Test'),builtIn:false,locked:false});
      profile.rules.relate.unshift({
        id:'visual-rule',name:'Visual rule',kind:'attributeMatch',source:'canonical',
        when:{equipmentType:'LVS'},match:{equipmentType:'XFM',matchKey:'@matchKey'},
        excludeSelf:true,enabled:true
      });
      profile.overrides.attributes=[{id:'visual-group',equipment:'F15-LVSY373B',values:{building:'B14'}}];
      const valid=compileRuleProfile(profile,{allowUnmapped:true});
      profile.overrides.attributes[0].values={unknownAttribute:'B14'};
      const invalid=compileRuleProfile(profile,{allowUnmapped:true});
      return {valid:valid.ok,code:invalid.errors.find(error=>error.path.includes('unknownAttribute'))?.code};
    })()
  `)
  assert.equal(result.valid, true)
  assert.equal(result.code, 'override.attribute-unknown')
})

test('parent training enables resolved flow on an editable clone without changing Eagle', async () => {
  const app = await loadApp()
  const result = app.eval(`
    (() => {
      const eagle=normalizeProfile(makeDefaultProfile());
      const before=JSON.stringify(eagle);
      const editable=profileClone(eagle);
      editable.id='profile-eagle-editable';
      editable.name='Eagle editable';
      editable.builtIn=false;
      editable.locked=false;
      visualTrainerEnableResolvedFlow(editable);
      return {
        eagleUnchanged:before===JSON.stringify(eagle),
        strategy:editable.hierarchy.resolutionStrategy,
        flowExecutors:editable.modes
          .filter(mode=>(mode.levels||[]).some(level=>level.kind==='flow'))
          .map(mode=>mode.executor),
      };
    })()
  `)
  assert.equal(result.eagleUnchanged, true)
  assert.equal(result.strategy, 'source-priority')
  assert.ok(result.flowExecutors.length > 0)
  assert.ok(result.flowExecutors.every(executor => executor === 'projected'))
})

/* Twelve matched pairs: more than the eight-example sample cap, so a complete
   affected list is distinguishable from the sample. Every LVS starts under
   XFM-0000, so LVS-0000 is already correct and the other eleven would move. */
const TWELVE_PAIRS = `
  const records=new Map();
  for(let index=0;index<12;index++){
    const suffix='00'+String(index).padStart(2,'0');
    const transformer=${record.toString()}('XFM-'+suffix);
    const switchgear=${record.toString()}('LVS-'+suffix,'XFM-0000');
    records.set(transformer.key,transformer);records.set(switchgear.key,switchgear);
  }
  const child=records.get('lvs-0001'),parent=records.get('xfm-0001');
`

test('the affected list names every applicable tag, not just the eight-example sample', async () => {
  const app = await loadApp()
  const result = app.eval(`
    (() => {
      const profile=normalizeProfile({...makeDefaultProfile('Visual Exclusions'),builtIn:false,locked:false});
      ${TWELVE_PAIRS}
      const rule=visualTrainerRelationshipRule(child,parent,profile,records);
      const impact=visualTrainerRelationshipImpact(profile,child,parent,'similar',records,rule);
      return {valid:impact.valid,applicable:impact.applicable,moved:impact.moved,
        examples:impact.examples.length,affected:impact.affected.length,
        tags:impact.affected.map(item=>item.tag),
        excludedFlags:impact.affected.map(item=>item.excluded),
        sample:impact.affected.find(item=>item.tag==='LVS-0006')};
    })()
  `)
  assert.equal(result.valid, true)
  assert.equal(result.applicable, 12)
  assert.equal(result.moved, 11)
  assert.equal(result.examples, 8, 'the capped sample stays capped so existing callers do not change')
  assert.equal(result.affected, result.applicable, 'the affected list is the full applicable set')
  assert.ok(result.affected > 8, 'the case must exceed the sample cap or it proves nothing')
  assert.deepEqual([...result.tags].sort(), Array.from({ length: 12 }, (_, i) => 'LVS-00' + String(i).padStart(2, '0')).sort())
  assert.ok([...result.excludedFlags].every(flag => flag === false), 'nothing is excluded until a tag is deselected')
  assert.deepEqual(JSON.parse(JSON.stringify(result.sample)), { tag: 'LVS-0006', before: 'XFM-0000', after: 'XFM-0006', excluded: false })
})

test('excluding a tag drops it from the rule effect and from the will-move count', async () => {
  const app = await loadApp()
  const result = app.eval(`
    (() => {
      const profile=normalizeProfile({...makeDefaultProfile('Visual Exclusions'),builtIn:false,locked:false});
      ${TWELVE_PAIRS}
      const rule=visualTrainerRelationshipRule(child,parent,profile,records);
      const before=visualTrainerRelationshipImpact(profile,child,parent,'similar',records,rule);
      rule.exclusions=['LVS-0005'];
      const after=visualTrainerRelationshipImpact(profile,child,parent,'similar',records,rule);
      const evaluated=visualTrainerEvaluateParents(after.candidate,records);
      return {
        beforeMoved:before.moved,afterMoved:after.moved,
        beforeApplicable:before.applicable,afterApplicable:after.applicable,
        valid:after.valid,
        affected:after.affected.length,
        excludedRow:after.affected.find(item=>item.tag==='LVS-0005'),
        excludedParent:evaluated.parents.get('lvs-0005'),
        keptParent:evaluated.parents.get('lvs-0006'),
        anchorParent:evaluated.parents.get('lvs-0001'),
      };
    })()
  `)
  assert.equal(result.beforeMoved, 11)
  assert.equal(result.afterMoved, 10, 'the deselected tag stops counting towards Will move')
  assert.equal(result.beforeApplicable, 12)
  assert.equal(result.afterApplicable, 11)
  assert.equal(result.valid, true, 'excluding another tag must not invalidate the example move')
  assert.equal(result.excludedParent, 'XFM-0000', 'the excluded tag keeps the parent it already had')
  assert.equal(result.keptParent, 'XFM-0006', 'every other matching tag still moves')
  assert.equal(result.anchorParent, 'XFM-0001')
  assert.equal(result.affected, 12, 'the excluded tag stays listed so it can be selected back')
  assert.deepEqual(JSON.parse(JSON.stringify(result.excludedRow)), { tag: 'LVS-0005', before: 'XFM-0000', after: 'XFM-0000', excluded: true })
})

test('deselected tags reach the saved rule through the apply step and compile', async () => {
  const app = await loadApp()
  const result = app.eval(`
    (() => {
      initProfiles();
      const profile=normalizeProfile({...makeDefaultProfile('Visual Exclusions'),builtIn:false,locked:false});
      ${TWELVE_PAIRS}
      S.canonicalModel=records;
      S.profileDraft=profile;
      S.profileUi.section='visual';
      S.profileUi.visualScope='similar';
      S.profileUi.visualSourceKey='lvs-0001';
      const rule=visualTrainerRelationshipRule(child,parent,profile,records);
      const impact=visualTrainerRelationshipImpact(profile,child,parent,'similar',records,rule);
      S.profileUi.visualProposal={kind:'relationship',sourceKey:'lvs-0001',targetKey:'xfm-0001',
        sourceTag:'LVS-0001',targetTag:'XFM-0001',sourcePath:['XFM-0000','LVS-0001'],targetPath:['XFM-0001'],
        similarSummary:'',impacts:{single:null,similar:impact}};
      profileVisualToggleAffected('LVS-0005');
      profileVisualToggleAffected('LVS-0007');
      profileVisualToggleAffected('LVS-0005');
      const staged=S.profileUi.visualProposal.impacts.similar;
      const markup=profileVisualAffectedMarkup(S.profileUi.visualProposal,staged,'similar');
      profileVisualApplyProposal();
      const saved=S.profileDraft.rules.relate.find(item=>item.id===rule.id);
      const compiled=compileRuleProfile(S.profileDraft,{allowUnmapped:true});
      return {
        exclusions:saved&&saved.exclusions,
        stagedMoved:staged.moved,
        checkboxes:(markup.match(/data-visual-affect=/g)||[]).length,
        checked:(markup.match(/data-visual-affect="[^"]+" checked/g)||[]).length,
        deselectedIsUnchecked:/data-visual-affect="LVS-0007" >/.test(markup),
        anchorDisabled:/data-visual-affect="LVS-0001" checked disabled/.test(markup),
        compiled:compiled.ok,
        compileErrors:compiled.errors.map(error=>error.code),
      };
    })()
  `)
  assert.deepEqual([...(result.exclusions || [])], ['LVS-0007'], 'the exclusion survives into the rule written to the draft')
  assert.equal(result.stagedMoved, 10, 'toggling recomputes the impact so Will move tracks the selection')
  assert.equal(result.checkboxes, 12, 'every affected tag gets its own checkbox')
  assert.equal(result.checked, 11, 'every tag but the deselected one stays checked')
  assert.equal(result.deselectedIsUnchecked, true, 'the deselected tag renders unchecked')
  assert.equal(result.anchorDisabled, true, 'the dragged tag cannot be deselected out of its own rule')
  assert.deepEqual([...result.compileErrors], [])
  assert.equal(result.compiled, true)
})

test('a reusable Visual Trainer rule evaluates 10,000 canonical tags within budget', async () => {
  const app = await loadApp()
  const result = app.eval(`
    (() => {
      const profile=normalizeProfile({...makeDefaultProfile('Visual Performance'),builtIn:false,locked:false});
      const records=new Map();
      for(let index=0;index<5000;index++){
        const suffix=index.toString(36).padStart(4,'0').slice(-4);
        const transformer=${record.toString()}('XFM-'+suffix);
        const switchgear=${record.toString()}('LVS-'+suffix,'XFM-0000');
        records.set(transformer.key,transformer);records.set(switchgear.key,switchgear);
      }
      const child=records.get('lvs-0001'),parent=records.get('xfm-0001');
      const rule=visualTrainerRelationshipRule(child,parent,profile,records);
      const started=performance.now();
      const impact=visualTrainerRelationshipImpact(profile,child,parent,'similar',records,rule);
      return {elapsed:performance.now()-started,valid:impact.valid,moved:impact.moved};
    })()
  `)
  assert.equal(result.valid, true)
  assert.equal(result.moved, 4999)
  assert.ok(result.elapsed < 2500, `10,000-tag impact preview took ${result.elapsed.toFixed(1)}ms`)
})

/* Two equipment roots, two children under the first, one grandchild. Enough to
   ask every drop question: a row with an equipment parent, a row with no parent
   at all, the dragged row itself, and a descendant of the dragged row. */
const DRAG_TREE = `
  initProfiles();
  const profile=normalizeProfile({...makeDefaultProfile('Visual Drag'),builtIn:false,locked:false});
  const records=new Map();
  [${['XFM-0000', 'XFM-0001'].map(tag => JSON.stringify(record(tag))).join(',')},
   ${JSON.stringify(record('LVS-0001', 'XFM-0000'))},${JSON.stringify(record('LVS-0002', 'XFM-0000'))},
   ${JSON.stringify(record('MCC-0002', 'LVS-0002'))}].forEach(item=>records.set(item.key,item));
  S.canonicalModel=records;S.profileDraft=profile;S.profileUi.visualMode='flow';
`

test('a sibling drop re-aims at the hovered row own parent instead of nesting under it', async () => {
  const app = await loadApp()
  const result = app.eval(`
    (() => {
      ${DRAG_TREE}
      const tree=profileVisualBuildTree(profile,'flow');
      const drop=(node,zone)=>profileVisualResolveDrop(tree,'lvs-0002',node,zone);
      return {
        sibling:drop('equipment:lvs-0001','sibling'),
        child:drop('equipment:lvs-0001','child'),
        siblingIsRowParent:drop('equipment:lvs-0001','sibling').targetId===tree.nodes.get('equipment:lvs-0001').parent.id,
        rowDepth:tree.nodes.get('equipment:lvs-0001').depth
      };
    })()
  `)
  assert.equal(result.siblingIsRowParent, true, 'sibling of a row means: same parent as that row')
  assert.deepEqual(JSON.parse(JSON.stringify(result.sibling)), { targetId: 'equipment:xfm-0000', zone: 'sibling', depth: 1, rowId: 'equipment:lvs-0001' })
  assert.equal(result.sibling.depth, result.rowDepth, 'the indicator indents to the row it sits beside, not one level deeper')
  assert.deepEqual(JSON.parse(JSON.stringify(result.child)), { targetId: 'equipment:lvs-0001', zone: 'child', depth: 2, rowId: 'equipment:lvs-0001' })
})

test('a sibling drop falls back to child when the hovered row has no parent node to re-aim at', async () => {
  const app = await loadApp()
  const result = app.eval(`
    (() => {
      ${DRAG_TREE}
      const flow=profileVisualBuildTree(profile,'flow'),ssm=profileVisualBuildTree(profile,'ssm');
      const rootNode=ssm.nodes.get('equipment:xfm-0001'),folder=ssm.roots[0];
      return {
        flowRoot:profileVisualResolveDrop(flow,'lvs-0002','equipment:xfm-0001','sibling'),
        ssmRoot:profileVisualResolveDrop(ssm,'lvs-0002','equipment:xfm-0001','sibling'),
        ssmRootParentIsFolder:ssm.nodes.get('equipment:xfm-0001').parent.id===rootNode.parent.id&&rootNode.parent.kind!=='equipment',
        ssmRootTargetsFolder:profileVisualResolveDrop(ssm,'lvs-0002','equipment:xfm-0001','sibling').targetId===rootNode.parent.id,
        topFolder:profileVisualResolveDrop(ssm,'lvs-0002',folder.id,'sibling'),
        topFolderIsRoot:folder.parent===null
      };
    })()
  `)
  /* Electrical Flow has no grouping folders, so a root row has no parent node and
     nothing beside it can be named. Same for the outermost SSM folder. */
  assert.equal(result.flowRoot.zone, 'child', 'a root row in Electrical Flow falls back to nesting')
  assert.equal(result.flowRoot.targetId, 'equipment:xfm-0001')
  assert.equal(result.topFolderIsRoot, true)
  assert.equal(result.topFolder.zone, 'child', 'a top-level SSM folder falls back to dropping into it')
  /* An SSM root row does have a parent -- the grouping folder holding it -- so it
     resolves normally and the proposal becomes a grouping one. */
  assert.equal(result.ssmRoot.zone, 'sibling')
  assert.equal(result.ssmRootParentIsFolder, true)
  assert.equal(result.ssmRootTargetsFolder, true)
})

test('no drop zone can aim a tag at itself or at one of its own descendants', async () => {
  const app = await loadApp()
  const result = app.eval(`
    (() => {
      ${DRAG_TREE}
      const tree=profileVisualBuildTree(profile,'flow');
      const drop=(node,zone)=>profileVisualResolveDrop(tree,'lvs-0002',node,zone);
      return {
        selfSibling:drop('equipment:lvs-0002','sibling'),selfChild:drop('equipment:lvs-0002','child'),
        descendantSibling:drop('equipment:mcc-0002','sibling'),descendantChild:drop('equipment:mcc-0002','child'),
        missing:drop('equipment:nope','child'),
        parentSibling:drop('equipment:lvs-0001','sibling')
      };
    })()
  `)
  assert.equal(result.selfSibling, null)
  assert.equal(result.selfChild, null)
  /* The descendant's sibling zone re-aims at its parent, which is the dragged tag
     itself -- so it falls back to child, which is the descendant, also refused. */
  assert.equal(result.descendantSibling, null, 'the sibling fallback must not smuggle in an invalid target')
  assert.equal(result.descendantChild, null)
  assert.equal(result.missing, null)
  assert.ok(result.parentSibling, 'a valid row still resolves, so the refusals above are not vacuous')
})

test('edge auto-scroll eases in from a crawl to a capped sprint', async () => {
  const app = await loadApp()
  const result = app.eval(`
    (() => {
      const band=VISUAL_DRAG_BAND,max=VISUAL_DRAG_MAX_SPEED;
      const at=distance=>visualDragScrollSpeed(distance,band,max);
      return {band,max,outside:at(band+30),threshold:at(band),
        quarter:at(band*.75),half:at(band*.5),edge:at(0),past:at(-20),
        ramp:[at(band*.9),at(band*.75),at(band*.5),at(band*.25),at(0)]};
    })()
  `)
  assert.equal(result.outside, 0, 'outside the band nothing scrolls')
  assert.equal(result.threshold, 0, 'the band boundary itself is still at rest')
  assert.equal(result.edge, result.max, 'the very edge runs at the cap')
  assert.equal(result.past, result.max, 'dragging past the edge is clamped to the cap, not unbounded')
  const ramp = [...result.ramp]
  assert.deepEqual(ramp, [...ramp].sort((a, b) => a - b), 'speed rises monotonically toward the edge')
  const firstQuarter = result.quarter - result.threshold
  const lastHalf = result.edge - result.half
  assert.ok(lastHalf > firstQuarter * 3, `the curve must accelerate: ${firstQuarter.toFixed(0)} px/s over the first quarter, ${lastHalf.toFixed(0)} over the last half`)
  assert.ok(result.quarter > 0, 'the first sliver of the band still creeps, so the threshold is not a dead zone')
})
