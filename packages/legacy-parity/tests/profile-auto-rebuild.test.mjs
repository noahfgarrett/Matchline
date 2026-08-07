import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadApp } from './support/harness.mjs'

test('switching to a profile with different executable logic rebuilds the loaded hierarchy', async () => {
  const app=await loadApp()
  const result=JSON.parse(await app.evalAsync(`
    initProfiles();
    const project=normalizeProfile({...profileCore(activeProfile()),id:'project-switch',name:'Project Switch',builtIn:false,locked:false,revision:1});
    project.hierarchy.unassignedBuilding='Project Building';
    PROFILE_STORE.profiles.push(project);
    S.roots=[{name:'Existing hierarchy'}];S.selected=new Set(['f0\\u0001Sheet1']);S.screen='profile';S.profileDraft=profileClone(activeProfile());
    let calls=0;const originalBuild=buildHierarchy,originalProjection=rebuildProfileProjections;
    buildHierarchy=async()=>{calls++;S.profileNeedsRebuild=false;S.screen='result';return true;};
    rebuildProfileProjections=()=>{};
    await switchProfile(project.id);
    buildHierarchy=originalBuild;rebuildProfileProjections=originalProjection;
    return JSON.stringify({calls,active:PROFILE_STORE.activeId,needsRebuild:S.profileNeedsRebuild,screen:S.screen});
  `))
  assert.deepEqual(result,{calls:1,active:'project-switch',needsRebuild:false,screen:'result'})
})

test('Save & apply rebuilds after executable edits but not after details-only edits', async () => {
  const app=await loadApp()
  const result=JSON.parse(await app.evalAsync(`
    initProfiles();
    const project=normalizeProfile({...profileCore(activeProfile()),id:'project-save',name:'Project Save',builtIn:false,locked:false,revision:1});
    PROFILE_STORE.profiles.push(project);PROFILE_STORE.activeId=project.id;persistProfiles();
    S.roots=[{name:'Existing hierarchy'}];S.selected=new Set(['f0\\u0001Sheet1']);S.screen='profile';
    let calls=0;const originalBuild=buildHierarchy,originalProjection=rebuildProfileProjections;
    buildHierarchy=async()=>{calls++;S.profileNeedsRebuild=false;S.screen='result';return true;};
    rebuildProfileProjections=()=>{};

    S.profileDraft=profileClone(activeProfile());S.profileDraft.hierarchy.unassignedBuilding='Changed Building';S.profileDirty=true;
    await publishProfileDraft();
    const afterExecution={calls,revision:activeProfile().revision,screen:S.screen,needsRebuild:S.profileNeedsRebuild};

    S.screen='profile';S.profileDraft=profileClone(activeProfile());S.profileDraft.details.layout=[...S.profileDraft.details.layout].reverse();S.profileDirty=true;
    await publishProfileDraft();
    const afterDetails={calls,revision:activeProfile().revision,screen:S.screen,needsRebuild:S.profileNeedsRebuild};
    buildHierarchy=originalBuild;rebuildProfileProjections=originalProjection;
    return JSON.stringify({afterExecution,afterDetails});
  `))
  assert.deepEqual(result,{
    afterExecution:{calls:1,revision:2,screen:'result',needsRebuild:false},
    afterDetails:{calls:1,revision:3,screen:'profile',needsRebuild:false},
  })
})

test('a failed automatic rebuild leaves an explicit pending state and the previous hierarchy', async () => {
  const app=await loadApp()
  const result=JSON.parse(await app.evalAsync(`
    initProfiles();
    const project=normalizeProfile({...profileCore(activeProfile()),id:'project-failure',name:'Project Failure',builtIn:false,locked:false,revision:1});
    project.hierarchy.unassignedBuilding='Changed Building';
    PROFILE_STORE.profiles.push(project);
    const roots=[{name:'Previous hierarchy'}];S.roots=roots;S.selected=new Set(['f0\\u0001Sheet1']);S.screen='profile';S.profileDraft=profileClone(activeProfile());
    let calls=0;const originalBuild=buildHierarchy;
    buildHierarchy=async()=>{calls++;return false;};
    await switchProfile(project.id);
    buildHierarchy=originalBuild;
    return JSON.stringify({calls,needsRebuild:S.profileNeedsRebuild,sameRoots:S.roots===roots,screen:S.screen});
  `))
  assert.deepEqual(result,{calls:1,needsRebuild:true,sameRoots:true,screen:'profile'})
})

test('profile changes do not rebuild before a hierarchy has been created', async () => {
  const app=await loadApp()
  const result=JSON.parse(await app.evalAsync(`
    initProfiles();
    const project=normalizeProfile({...profileCore(activeProfile()),id:'project-empty',name:'Project Empty',builtIn:false,locked:false,revision:1});
    project.hierarchy.unassignedBuilding='Changed Building';
    PROFILE_STORE.profiles.push(project);
    S.roots=[];S.selected=new Set();S.screen='profile';S.profileDraft=profileClone(activeProfile());
    let calls=0;const originalBuild=buildHierarchy;buildHierarchy=async()=>{calls++;return true;};
    await switchProfile(project.id);
    buildHierarchy=originalBuild;
    return JSON.stringify({calls,needsRebuild:S.profileNeedsRebuild,screen:S.screen});
  `))
  assert.deepEqual(result,{calls:0,needsRebuild:false,screen:'profile'})
})

test('repeated rebuild clicks share one in-flight hierarchy build', async () => {
  const app=await loadApp()
  const result=JSON.parse(await app.evalAsync(`
    initProfiles();
    S.roots=[{name:'Existing hierarchy'}];S.selected=new Set(['f0\\u0001Sheet1']);S.profileNeedsRebuild=true;
    let calls=0;const originalBuild=buildHierarchy;
    buildHierarchy=async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,20));S.profileNeedsRebuild=false;return true;};
    const results=await Promise.all([rebuildActiveProfileHierarchy(),rebuildActiveProfileHierarchy(),rebuildActiveProfileHierarchy()]);
    buildHierarchy=originalBuild;
    return JSON.stringify({calls,results,needsRebuild:S.profileNeedsRebuild});
  `))
  assert.deepEqual(result,{calls:1,results:[true,true,true],needsRebuild:false})
})

test('a newer profile selection supersedes a slow rebuild and commits only the latest profile', async () => {
  const app=await loadApp()
  const result=JSON.parse(await app.evalAsync(`
    initProfiles();
    const first=normalizeProfile({...profileCore(activeProfile()),id:'profile-slow-first',name:'Slow First',builtIn:false,locked:false,revision:1});
    const second=normalizeProfile({...profileCore(activeProfile()),id:'profile-fast-second',name:'Fast Second',builtIn:false,locked:false,revision:1});
    first.hierarchy.unassignedBuilding='First Building';second.hierarchy.unassignedBuilding='Second Building';
    PROFILE_STORE.profiles.push(first,second);
    S.roots=[{name:'Existing hierarchy'}];S.selected=new Set(['f0\\u0001Sheet1']);S.screen='profile';S.profileDraft=profileClone(activeProfile());
    let calls=[],committed='';const originalBuild=buildHierarchy;
    buildHierarchy=async revision=>{
      const id=activeProfile().id;calls.push({id,revision});
      await new Promise(resolve=>setTimeout(resolve,id===first.id?25:1));
      if(revision!==S.profileBuildRevision)return false;
      committed=id;S.profileNeedsRebuild=false;S.screen='result';return true;
    };
    const firstSwitch=switchProfile(first.id);
    await new Promise(resolve=>setTimeout(resolve,5));
    const secondSwitch=switchProfile(second.id);
    await Promise.all([firstSwitch,secondSwitch]);
    buildHierarchy=originalBuild;
    return JSON.stringify({calls,committed,active:PROFILE_STORE.activeId,needsRebuild:S.profileNeedsRebuild,screen:S.screen});
  `))
  assert.deepEqual(result,{
    calls:[
      {id:'profile-slow-first',revision:1},
      {id:'profile-fast-second',revision:2},
    ],
    committed:'profile-fast-second',
    active:'profile-fast-second',
    needsRebuild:false,
    screen:'result',
  })
})

test('source input changes invalidate an existing hierarchy and advance the build revision', async () => {
  const app=await loadApp()
  const result=JSON.parse(app.eval(`
    JSON.stringify((function(){
      S.profileBuildRevision=7;S.profileNeedsRebuild=false;S.roots=[{name:'Built hierarchy'}];
      invalidateHierarchyBuild();
      const existing={revision:S.profileBuildRevision,needsRebuild:S.profileNeedsRebuild};
      S.roots=[];S.profileNeedsRebuild=false;invalidateHierarchyBuild();
      return {existing,empty:{revision:S.profileBuildRevision,needsRebuild:S.profileNeedsRebuild}};
    })())
  `))
  assert.deepEqual(result,{
    existing:{revision:8,needsRebuild:true},
    empty:{revision:9,needsRebuild:false},
  })
})
