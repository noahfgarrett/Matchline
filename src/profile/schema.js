import { clean, KEYSEP } from '../core/text.js'
import { cleanTag } from '../core/tags.js'
import { S, fileById, tagKey, clearResultCache } from '../state.js'
import { RULES_SCHEMA_VERSION, emptyLegendTraining, migrateProfile } from '../rules/schema.js'
import { legendStripForHistory, normalizeLegendTraining, pruneLegendRuleOrigins } from './legend.js'
import { ruleEngine, setRuleProfile } from '../rules/provider.js'
import { EAGLE_PRESET_ID, EAGLE_PRESET_VERSION, EAGLE_PROFILE_NAME, makeEagleRuleProfile } from '../rules/defaults.js'
import { materializeTrainedRules } from '../rules/legacy.js'
import { createEngine } from '../rules/engine.js'
import { createDurableProfileStorage, parsePortableProfileEnvelope, serializePortableProfileEnvelope } from './durable-storage.js'

/* ---- site profiles ---- */
/* Profile structure is versioned in exactly one place: RULES_SCHEMA_VERSION in
   src/rules/schema.js, the constant migrateProfile actually stamps. A second
   PROFILE_SCHEMA_VERSION used to sit here at 1, so a freshly created profile
   reported 1 while a migrated one reported 2, and an exported envelope
   declared 1 while the profile inside it declared 2. */
export const PROFILE_STORAGE_KEY='ssmanagement.site-profiles.v1';
export const PROFILE_DURABLE_STORAGE_KEY='ssmanagement.site-profiles.v2';
export const PROFILE_SOURCE_LABELS={cable:'Cable Schedule',mel:'Master Equipment List',easyPower:'Easy Power',pmd:'Point Master Database'};
export const PROFILE_FIELD_SETS={
  easyPower:[
    ['startingSource','Starting Source'],['downstream1','Downstream 1'],['downstream2','Downstream 2'],['downstream3','Downstream 3'],
    ['downstream4','Downstream 4'],['downstream5','Downstream 5'],['downstream6','Downstream 6'],['downstream7','Downstream 7'],
    ['downstream8','Downstream 8'],['downstream9','Downstream 9'],['downstream10','Downstream 10'],['downstream11','Downstream 11'],
    ['downstream12','Downstream 12'],['finalSource','Final Source'],['idName','ID Name'],['loadDescription','Load Description'],['circuit','Circuit Number']
  ],
  cable:[
    ['loadName','Load Name (To)'],['panel','Panel (From)'],['circuitsId','Circuits_Id'],['cableTag','Cable Tag'],
    ['circuitNumber','Circuit_Number'],['circuitId','Circuit ID'],['loadRating','Load kVA/HP/Amps'],['cableReference','Cable (ref table)'],
    ['packageRevision','Package/Revision'],['rfiNumber','RFI Number'],['cableLength','Cable Length [ft]'],['raceway','Raceway']
  ],
  pmd:[
    ['panel','PANEL'],['instrumentTag','INSTRUMENT TAG'],['card','CARD'],['pointPosition','POINT POSITION'],['pointType','POINT TYPE'],
    ['pid','P&ID'],['location','Location'],['release','RELEASE'],['description','DESCRIPTION']
  ],
  mel:[
    ['equipmentTag','Equipment Tag'],['upn','UPN'],['building','Bldg / Building'],['systemParent','System Parent Equipment Tag(s)'],
    ['discipline','Discipline'],['systemDescription','System Description'],['projectPhase','Project Phase'],['description','Equipment Description']
  ]
};
export const PROFILE_DETAIL_FIELDS=[
  {id:'equipmentTag',label:'Equipment Tag',source:'Core'},
  {id:'equipmentType',label:'Equipment Type',source:'Profile'},
  {id:'building',label:'Building',source:'Profile'},
  {id:'discipline',label:'Discipline',source:'Profile'},
  {id:'system',label:'System',source:'Profile'},
  {id:'flowParent',label:'Electrical Flow Parent',source:'Hierarchy'},
  {id:'ssmParent',label:'SSM Parent',source:'Hierarchy'},
  {id:'dependency',label:'Dependency',source:'Hierarchy'},
  {id:'upn',label:'UPN',source:'MEL'},
  {id:'melSystemParent',label:'System Parent Equipment Tag',source:'MEL'},
  {id:'melParentCheck',label:'MEL Parent Check',source:'MEL'},
  {id:'cableStatus',label:'Cable Schedule Status',source:'Cable'},
  {id:'pmdPanel',label:'PMD Panel Match',source:'PMD'},
  {id:'pmdBuilding',label:'PMD Building',source:'PMD'},
  {id:'easyCircuit',label:'Circuit Number',source:'Easy Power'},
  {id:'cableCircuit',label:'Circuit Number',source:'Cable'},
  {id:'cableLoadName',label:'Load Name (To)',source:'Cable'},
  {id:'cablePanel',label:'Panel (From)',source:'Cable'},
  {id:'cableTag',label:'Cable Tag',source:'Cable'},
  {id:'cableLoadRating',label:'Load kVA/HP/Amps',source:'Cable'},
  {id:'cableReference',label:'Cable (ref table)',source:'Cable'},
  {id:'cablePackageRevision',label:'Package/Revision',source:'Cable'},
  {id:'cableRfi',label:'RFI Number',source:'Cable'},
  {id:'cableLength',label:'Cable Length [ft]',source:'Cable'},
  {id:'cableRaceway',label:'Raceway',source:'Cable'},
  {id:'pmdCard',label:'CARD',source:'PMD'},
  {id:'pmdPointPosition',label:'POINT POSITION',source:'PMD'},
  {id:'pmdPointType',label:'POINT TYPE',source:'PMD'},
  {id:'pmdPid',label:'P&ID',source:'PMD'},
  {id:'pmdLocation',label:'Location',source:'PMD'},
  {id:'pmdRelease',label:'RELEASE',source:'PMD'},
  {id:'description',label:'Description',source:'PMD'},
  {id:'provenance',label:'Rule Provenance',source:'Profile'}
];
export const DEFAULT_DETAIL_LAYOUT=PROFILE_DETAIL_FIELDS.map(field=>field.id);
export let PROFILE_STORE={activeId:'',profiles:[]};
export let PROFILE_FALLBACK=null;
let PROFILE_ENGINE_CACHE=new WeakMap();
let PROFILE_ATTRIBUTE_OVERRIDE_CACHE=new WeakMap();
let PROFILE_DURABLE_STORAGE=null;
export const profileClone=value=>JSON.parse(JSON.stringify(value));
export function profileId(){return 'profile-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,7);}
export function profileCore(profile){
  const copy=profileClone(profile||{});delete copy.history;delete copy.migratedFrom;return copy;
}
/* profileCore feeds both profile copying and revision history, but those two
   want different things from the legend container. A copy keeps nothing; a
   history snapshot keeps rule origins and drops the rest. Snapshots are kept
   eight deep, so carrying the pending-entry list and source metadata through
   every one of them would store the same non-executable knowledge nine times. */
export function profileHistorySnapshot(profile){
  return legendStripForHistory(profileCore(profile));
}
/* Deliberately an allowlist, and legendTraining is deliberately absent. This
   signature decides whether a save forces a full hierarchy rebuild, and legend
   metadata -- a source's name, an entry's confidence, when a page was analyzed
   -- changes nothing the engine executes. Adding it here would make reviewing a
   document cost a rebuild. */
export function profileExecutionSignature(profile){
  const value=profile||{};
  return JSON.stringify({mappings:value.mappings||{},anatomies:value.anatomies||[],rules:value.rules||{},tagRules:value.tagRules||[],
    hierarchy:value.hierarchy||{},modes:value.modes||[],overrides:value.overrides||{}});
}
export function makeDefaultProfile(name){
  const now=new Date().toISOString();
  const eagle=makeEagleRuleProfile(),isBuiltIn=!clean(name);
  return {
    schemaVersion:RULES_SCHEMA_VERSION,
    id:isBuiltIn?'builtin-eagle':profileId(),name:name||EAGLE_PROFILE_NAME,siteCode:'',description:isBuiltIn?'Original SSM Builder behavior for the Eagle project.':'',
    presetId:EAGLE_PRESET_ID,presetVersion:EAGLE_PRESET_VERSION,builtIn:isBuiltIn,locked:isBuiltIn,
    basePreset:{id:EAGLE_PRESET_ID,version:String(EAGLE_PRESET_VERSION),fingerprint:null},attributes:[],
    revision:1,publishedAt:now,updatedAt:now,mappings:{},tagRules:[],
    overrides:{relationships:[],attributes:[]},
    anatomies:profileClone(eagle.anatomies),rules:profileClone(eagle.rules),modes:profileClone(eagle.modes),
    hierarchy:{
      unassignedBuilding:'Unassigned Building',
      disciplineFallbacks:{instrument:'I&C',default:'Electrical'},
      systemFallbacks:{Electrical:'602 Medium Voltage','I&C':'Instrumentation',default:'Unassigned System'},
      parentSourcePriority:['cable','mel','easyPower','pmd'],
      /* Compiler fork: the MEL is the seed universe (spec §4). Off for Eagle,
         which reproduces the frozen Easy-Power-seeded SSM Builder register. */
      melSeed:{enabled:!isBuiltIn,excludedPhases:['Future']},
      /* Milestone ladder (spec §6a): custom UPN pattern is optional — blank
         uses the built-in default. Polarity map overrides the discipline-name
         heuristic (top-down for electrical/LSS/security, bottom-up otherwise). */
      milestones:{upnPattern:'',buildingReadyLabel:'OP / Building Ready'},
      polarity:{},
      /* EXTO upload column indexes (0-based). Defaults reproduce the
         historical G/K/P/AM layout; milestone -1 = column not emitted. */
      extoColumns:{upn:6,equipmentId:10,closestParent:15,dependencies:38,milestone:-1},
      roleParents:{LVS:'XFM',XFM:'GIS',GIS:'SYSTEM'},
      resolutionStrategy:isBuiltIn?'legacy-register':'source-priority',
      downstreamGapPolicy:isBuiltIn?'truncate':'bridge-review',
      caseVariantPolicy:isBuiltIn?'preserve':'merge',
      duplicateRegisterPolicy:isBuiltIn?'first':'prefer-parent',
      cableConflictPolicy:isBuiltIn?'legacy-chain-review':'first-review',
      duplicateParentReviewPolicy:isBuiltIn?'first-silent':'first-review',
      workflow:{
        gisBusCompaction:true,
        cableParentChains:true,
        melUpnParents:true,
        /* Off for Eagle, on for every project profile. Eagle reproduces the
           frozen SSM Builder tree, where MEL only ever acted as a UPN-mismatch
           correction; a project profile trusts MEL to parent whatever the Cable
           Schedule does not cover. */
        melSystemParentClaims:!isBuiltIn,
        pmdInstrumentAttachment:true,
        enforceSystemRoot:true
      }
    },
    details:{layout:[...DEFAULT_DETAIL_LAYOUT]},
    /* Eagle is built from this too, and gets an empty container only. A locked
       compatibility profile has no documents and must never claim to. */
    legendTraining:emptyLegendTraining(),
    history:[]
  };
}
export function normalizeProfile(raw){
  const base=makeDefaultProfile(clean(raw&&raw.name)||'Imported Site Profile'),src=raw&&typeof raw==='object'?raw:{};
  const profile={...base,...src};
  profile.id=clean(profile.id)||profileId();profile.name=clean(profile.name)||'Site Profile';
  profile.presetId=clean(profile.presetId)||EAGLE_PRESET_ID;
  profile.presetVersion=Math.max(1,Number(profile.presetVersion)||EAGLE_PRESET_VERSION);
  profile.basePreset=profile.basePreset&&typeof profile.basePreset==='object'?profile.basePreset:{id:profile.presetId,version:String(profile.presetVersion),fingerprint:null};
  profile.attributes=Array.isArray(profile.attributes)?profile.attributes:[];
  profile.builtIn=profile.builtIn===true;profile.locked=profile.builtIn||profile.locked===true;
  profile.revision=Math.max(1,Number(profile.revision)||1);
  profile.mappings=profile.mappings&&typeof profile.mappings==='object'?profile.mappings:{};
  profile.tagRules=Array.isArray(profile.tagRules)?profile.tagRules.filter(rule=>rule&&typeof rule==='object').map(rule=>({
    id:clean(rule.id)||'rule-'+Math.random().toString(36).slice(2,8),name:clean(rule.name)||'Tag rule',
    target:clean(rule.target)||'equipmentType',mode:clean(rule.mode)||'contains',needle:clean(rule.needle),
    start:Math.max(0,Number(rule.start)||0),end:Math.max(0,Number(rule.end)||0),segmentIndex:Math.max(0,Number(rule.segmentIndex)||0),
    value:clean(rule.value),sourceKind:clean(rule.sourceKind),enabled:rule.enabled!==false,strict:rule.strict!==false,
    example:clean(rule.example),exclusions:Array.isArray(rule.exclusions)?rule.exclusions.map(clean).filter(Boolean):[]
  })):[];
  const relationships=new Map();
  for(const override of Array.isArray(profile.overrides&&profile.overrides.relationships)?profile.overrides.relationships:[]){
    const equipment=clean(override&&override.equipment),parent=clean(override&&override.parent),key=equipment.toLowerCase();if(!equipment||!parent||key===parent.toLowerCase())continue;
    relationships.set(key,{id:clean(override.id)||'placement-'+key,equipment,parent,savedAt:clean(override.savedAt)});
  }
  const attributeOverrides=new Map();
  for(const override of Array.isArray(profile.overrides&&profile.overrides.attributes)?profile.overrides.attributes:[]){
    const equipment=clean(override&&override.equipment),key=equipment.toLowerCase(),values={};
    for(const [attribute,value] of Object.entries(override&&override.values||{})){
      const resolved=clean(value);if(clean(attribute)&&resolved)values[attribute]=resolved;
    }
    if(!equipment||!Object.keys(values).length)continue;
    attributeOverrides.set(key,{id:clean(override.id)||'grouping-'+key,equipment,values,savedAt:clean(override.savedAt)});
  }
  profile.overrides={...(profile.overrides||{}),relationships:[...relationships.values()],attributes:[...attributeOverrides.values()]};
  profile.hierarchy={
    ...base.hierarchy,...(profile.hierarchy||{}),
    disciplineFallbacks:{...base.hierarchy.disciplineFallbacks,...(profile.hierarchy&&profile.hierarchy.disciplineFallbacks||{})},
    systemFallbacks:{...base.hierarchy.systemFallbacks,...(profile.hierarchy&&profile.hierarchy.systemFallbacks||{})},
    roleParents:profile.hierarchy&&profile.hierarchy.roleParents&&typeof profile.hierarchy.roleParents==='object'
      ?{...profile.hierarchy.roleParents}
      :{...base.hierarchy.roleParents},
    resolutionStrategy:profile.hierarchy&&profile.hierarchy.resolutionStrategy==='legacy-register'?'legacy-register':'source-priority',
    downstreamGapPolicy:profile.hierarchy&&profile.hierarchy.downstreamGapPolicy==='truncate'?'truncate':'bridge-review',
    caseVariantPolicy:profile.hierarchy&&profile.hierarchy.caseVariantPolicy==='preserve'?'preserve':'merge',
    duplicateRegisterPolicy:profile.hierarchy&&profile.hierarchy.duplicateRegisterPolicy==='first'?'first':'prefer-parent',
    cableConflictPolicy:['legacy-chain-review','first-silent'].includes(profile.hierarchy&&profile.hierarchy.cableConflictPolicy)
      ?profile.hierarchy.cableConflictPolicy
      :'first-review',
    duplicateParentReviewPolicy:profile.hierarchy&&profile.hierarchy.duplicateParentReviewPolicy==='first-silent'?'first-silent':'first-review',
    workflow:{
      ...base.hierarchy.workflow,
      ...(profile.hierarchy&&profile.hierarchy.workflow||{})
    },
    parentSourcePriority:Array.isArray(profile.hierarchy&&profile.hierarchy.parentSourcePriority)
      ?profile.hierarchy.parentSourcePriority.filter(source=>PROFILE_SOURCE_LABELS[source])
      :[...base.hierarchy.parentSourcePriority]
  };
  for(const source of Object.keys(PROFILE_SOURCE_LABELS))if(!profile.hierarchy.parentSourcePriority.includes(source))profile.hierarchy.parentSourcePriority.push(source);
  const layout=Array.isArray(profile.details&&profile.details.layout)?profile.details.layout.filter(id=>PROFILE_DETAIL_FIELDS.some(field=>field.id===id)):[];
  profile.details={...(profile.details||{}),layout:layout.length?layout:[...DEFAULT_DETAIL_LAYOUT]};
  profile.history=Array.isArray(profile.history)?profile.history.slice(0,8):[];
  const migrated=materializeTrainedRules(migrateProfile(profile));
  migrated.legendTraining=normalizeLegendTraining(migrated.legendTraining);
  /* Origins can outlive their rules -- restoring an older revision swaps the
     executable arrays while the legend knowledge stays put -- so prune here,
     where every load, import, and save already passes through. */
  return pruneLegendRuleOrigins(migrated);
}
export function activeProfile(){
  const found=PROFILE_STORE.profiles.find(profile=>profile.id===PROFILE_STORE.activeId);
  if(found)return found;
  if(!PROFILE_FALLBACK)PROFILE_FALLBACK=makeDefaultProfile();
  return PROFILE_FALLBACK;
}
export function activeProfileRevision(){const profile=activeProfile();return profile.id+':'+profile.revision;}
export function currentProfileStorePayload(){return {schemaVersion:RULES_SCHEMA_VERSION,activeId:PROFILE_STORE.activeId,profiles:profileClone(PROFILE_STORE.profiles)};}
export function portableProfileTransferBase64(){
  const text=serializePortableProfileEnvelope(currentProfileStorePayload(),{pretty:false});
  const bytes=new TextEncoder().encode(text);let binary='';
  for(let offset=0;offset<bytes.length;offset+=0x8000)binary+=String.fromCharCode(...bytes.subarray(offset,offset+0x8000));
  return btoa(binary);
}
export function embeddedProfileTransfer(){
  if(typeof document==='undefined')return null;
  const node=document.querySelector('#ssmanagement-profile-transfer'),encoded=clean(node&&node.textContent);
  if(!encoded)return null;
  try{
    const binary=atob(encoded),bytes=Uint8Array.from(binary,char=>char.charCodeAt(0));
    const parsed=parsePortableProfileEnvelope(new TextDecoder().decode(bytes));
    return parsed.ok&&parsed.value&&Array.isArray(parsed.value.profiles)?parsed.value:null;
  }catch(_){return null;}
}
export function mergeProfileStores(current,incoming){
  if(!incoming||!Array.isArray(incoming.profiles))return current;
  if(!current||!Array.isArray(current.profiles))return profileClone(incoming);
  const merged=new Map(current.profiles.map(profile=>[profile.id,profile]));
  for(const profile of incoming.profiles){
    if(!profile||!clean(profile.id)||profile.builtIn)continue;
    const existing=merged.get(profile.id),incomingRevision=Math.max(0,Number(profile.revision)||0),existingRevision=Math.max(0,Number(existing&&existing.revision)||0);
    const incomingTime=Date.parse(profile.updatedAt||profile.publishedAt||'')||0,existingTime=Date.parse(existing&&existing.updatedAt||existing&&existing.publishedAt||'')||0;
    if(!existing||incomingRevision>existingRevision||(incomingRevision===existingRevision&&incomingTime>existingTime))merged.set(profile.id,profile);
  }
  const activeId=merged.has(current.activeId)?current.activeId:(merged.has(incoming.activeId)?incoming.activeId:current.activeId);
  return {...current,activeId,profiles:[...merged.values()]};
}
export const STARTER_PROFILE_NAME='New Site Profile';
/**
 * The editable profile a first run actually works in.
 *
 * What makes it different from Eagle is the POLICIES, not the rules: modern
 * resolution (source-priority), bridged downstream gaps, merged case variants,
 * parent-preferring duplicate registers, and reviewable conflicts, instead of
 * the five legacy compatibility policies Eagle must keep. A first run should
 * never silently inherit `downstreamGapPolicy: 'truncate'`.
 *
 * It DOES start from Eagle's rules, and deliberately so. compileRuleProfile
 * rejects a profile with no executable rules -- "profiles are complete
 * executable documents" -- and there is no site-neutral rule set to offer
 * instead: every classification in the shipped set encodes some site's
 * convention. So the rules are a starting template to edit or delete, and the
 * Legend Trainer is how a site's own nomenclature replaces them.
 */
export function makeStarterProfile(){
  const profile=makeDefaultProfile(STARTER_PROFILE_NAME);
  profile.description='Starting point for a new site. Teach it your nomenclature in the Legend Trainer, and edit or remove the inherited rules as you go.';
  return profile;
}
export function installCurrentEagle(store){
  const eagle=makeDefaultProfile(),profiles=[];let eagleAdded=false;
  let activeId=clean(store&&store.activeId);
  for(const profile of store&&store.profiles||[]){
    if(profile&&(profile.builtIn||profile.id==='builtin-eagle')){
      if(!eagleAdded){profiles.push(eagle);eagleAdded=true;}
      if(activeId===profile.id)activeId=eagle.id;
      continue;
    }
    profiles.push(profile);
  }
  if(!eagleAdded)profiles.unshift(eagle);
  /* Eagle is a locked reference, not somewhere to work. A store carrying
     nothing else gets an editable starter beside it. */
  if(!profiles.some(profile=>!profile.locked))profiles.push(makeStarterProfile());
  /* An activeId that still resolves is left alone, so an existing store -- and
     anyone who deliberately selected Eagle -- keeps exactly what it had. Only a
     store with nothing to point at picks a new profile, and it prefers an
     editable one over the locked reference. */
  if(!profiles.some(profile=>profile.id===activeId)){
    activeId=(profiles.find(profile=>!profile.locked)||profiles[0]).id;
  }
  return {activeId,profiles};
}
export function initProfiles(){
  PROFILE_DURABLE_STORAGE=createDurableProfileStorage({key:PROFILE_DURABLE_STORAGE_KEY});
  const durable=PROFILE_DURABLE_STORAGE.read();let parsed=durable.ok?durable.value:null;
  const transfer=embeddedProfileTransfer();
  S.profileStorageIssue=durable.ok&&durable.status==='degraded'?durable:null;
  if(durable.ok)S.profileStorage='local';
  else if(durable.code==='no_valid_generation'||durable.status==='corrupt'){S.profileStorage='recovery';S.profileStorageIssue=durable;}
  /* One-way migration from the original single-key store. The legacy payload
     remains untouched as an additional recovery copy. */
  if(!parsed&&durable.status==='empty'){
    try{parsed=JSON.parse(localStorage.getItem(PROFILE_STORAGE_KEY)||'null');}
    catch(error){S.profileStorage='recovery';S.profileStorageIssue={code:'legacy_invalid_json',error};}
  }
  parsed=mergeProfileStores(parsed,transfer);
  if(parsed&&Array.isArray(parsed.profiles)){
    PROFILE_STORE={activeId:clean(parsed.activeId),profiles:parsed.profiles.map(normalizeProfile)};
  }
  PROFILE_STORE=installCurrentEagle(PROFILE_STORE);
  /* A replacement HTML carries a checksummed profile envelope inside itself.
     Commit that handoff to durable storage on first boot so a later launch of
     the same file does not depend on the one-time embedded copy. */
  if((durable.status==='empty'||transfer)&&S.profileStorage!=='recovery')persistProfiles();
  if(!PROFILE_STORE.profiles.some(profile=>profile.id===PROFILE_STORE.activeId))PROFILE_STORE.activeId=PROFILE_STORE.profiles[0].id;
  if(navigator.storage&&navigator.storage.persist)navigator.storage.persist().catch(()=>{});
  setRuleProfile(activeProfile());
}
export function persistProfiles(){
  if(!PROFILE_DURABLE_STORAGE)PROFILE_DURABLE_STORAGE=createDurableProfileStorage({key:PROFILE_DURABLE_STORAGE_KEY});
  const result=PROFILE_DURABLE_STORAGE.write({schemaVersion:RULES_SCHEMA_VERSION,...PROFILE_STORE}),ok=!!result.ok;
  if(ok){S.profileStorage='local';S.profileStorageIssue=result.status==='degraded'?result:null;}
  else{S.profileStorage=result.status==='corrupt'?'recovery':'session';S.profileStorageIssue=result;}
  setRuleProfile(activeProfile());
  return ok;
}
export function invalidateProfileEvaluation(profile){
  if(profile&&typeof profile==='object'){PROFILE_ENGINE_CACHE.delete(profile);PROFILE_ATTRIBUTE_OVERRIDE_CACHE.delete(profile);}
}
export function profileEvaluationEngine(profile){
  const selected=profile||activeProfile();
  if(selected===activeProfile())return ruleEngine();
  let engine=PROFILE_ENGINE_CACHE.get(selected);
  if(!engine){materializeTrainedRules(selected);engine=createEngine(selected);PROFILE_ENGINE_CACHE.set(selected,engine);}
  return engine;
}
export function profileMapping(kind,profile){return ((profile||activeProfile()).mappings||{})[kind]||null;}
export function profileManualFields(mapping){
  const auto=new Set(mapping&&mapping.autoFields||[]);
  return Object.fromEntries(Object.entries(mapping&&mapping.fields||{}).filter(([id])=>!auto.has(id)));
}
export function profileKindForKey(key,rows){
  const parts=String(key||'').split(KEYSEP),file=fileById(parts[0]),sheet=parts[1]||'',normalized=normH(sheet);
  if(normalized===MEL_SHEET_NAME)return 'mel';
  if(file&&file.sheets&&file.sheets.some(name=>normH(name)===PMD_SHEET_NAME))return 'pmd';
  if(/cable\s*schedule/i.test(sheet)||/cable\s*schedule/i.test(file&&file.name||''))return 'cable';
  const aoa=rows||(S.aoaCache.get(key)||{}).aoa||[];
  for(let row=0;row<Math.min(aoa.length,200);row++){
    const headers=(aoa[row]||[]).map(clean);
    if(row<60&&detectPmd(headers))return 'pmd';
    if(row<30&&detectCable(headers))return 'cable';
    if(detectMel(headers))return 'mel';
  }
  return 'easyPower';
}
export function clearProfileDetectionCaches(){
  /* Caches only. S.override is a per-sheet column choice the engineer made by
     hand, and resolveCols (src/io/detect.js) ranks it above both the profile
     mapping and auto-detection -- it is input, not derived data. Clearing it
     here meant any Studio save, profile switch, or profile import silently
     discarded it. "Clear all files" still resets it (src/ui/screens.js), which
     is correct: the sheets it keyed off are gone. */
  S.aoaCache.clear();
  if(typeof _cableCache!=='undefined')_cableCache.clear();
  if(typeof _pmdCache!=='undefined')_pmdCache.clear();
  if(typeof _melCache!=='undefined')_melCache.clear();
  clearResultCache();
}
export function ruleSelection(rule,tag){
  const value=clean(tag),upper=value.toUpperCase(),needle=clean(rule.needle),find=needle.toUpperCase();
  if(!value||rule.enabled===false||(rule.exclusions||[]).some(item=>tagKey(item)===tagKey(value)))return null;
  if(rule.mode==='contains')return upper.includes(find)?(rule.value||needle):null;
  if(rule.mode==='prefix')return upper.startsWith(find)?(rule.value||needle):null;
  if(rule.mode==='suffix')return upper.endsWith(find)?(rule.value||needle):null;
  if(rule.mode==='slice'){
    const sample=value.slice(rule.start,rule.end||undefined);
    if(!sample)return null;
    if(rule.strict&&find&&sample.toUpperCase()!==find)return null;
    return rule.value||sample;
  }
  if(rule.mode==='segment'){
    const sample=value.split('-')[rule.segmentIndex];
    if(!sample)return null;
    if(rule.strict&&find&&sample.toUpperCase()!==find)return null;
    return rule.value||sample;
  }
  return null;
}
export function profileAssignments(tag,profile,sourceKind){
  const resolved=profileEvaluationEngine(profile).resolve(tag,{sourceKind});
  return {values:{...resolved.attributes},rules:[...(resolved.classificationRules||[])]};
}
export function profileAttributeOverride(tag,profile){
  const selected=profile||activeProfile(),key=tagKey(tag);
  let overrides=PROFILE_ATTRIBUTE_OVERRIDE_CACHE.get(selected);
  if(!overrides){
    overrides=new Map(((selected.overrides&&selected.overrides.attributes)||[]).map(override=>[tagKey(override.equipment),override]));
    PROFILE_ATTRIBUTE_OVERRIDE_CACHE.set(selected,overrides);
  }
  return overrides.get(key)||null;
}
export function profileAssignment(tag,target,profile,sourceKind){return profileAssignments(tag,profile,sourceKind).values[target]||'';}
export function profileEquipmentRole(value,profile,sourceKind){
  const role=profileAssignment(value,'equipmentType',profile,sourceKind||'easyPower').toUpperCase().replace(/[^A-Z0-9]/g,'');
  if(role==='TRANSFORMER'||role==='XFMR')return 'XFM';
  if(role==='LOWVOLTAGESWITCHGEAR'||role==='LVSWITCHGEAR'||role==='LV')return 'LVS';
  return role;
}
export function profileTrimmedTag(value,profile,sourceKind){
  let tag=cleanTag(value);
  for(const rule of (profile||activeProfile()).tagRules||[]){
    if(rule.target!=='ignoreSuffix'||rule.enabled===false)continue;
    if(rule.sourceKind&&rule.sourceKind!==(sourceKind||'easyPower'))continue;
    const suffix=clean(rule.needle);
    if(suffix&&ruleSelection(rule,tag)!=null&&tag.toUpperCase().endsWith(suffix.toUpperCase()))tag=clean(tag.slice(0,-suffix.length));
  }
  return tag;
}
export function profileFieldLabel(kind,id){return (PROFILE_FIELD_SETS[kind]||[]).find(field=>field[0]===id)?.[1]||id;}
/* The trailing `profile` argument is what lets a profile be validated against
   its own column mappings rather than whichever profile happens to be active.
   Omitting it keeps the historical behaviour for every existing caller; the
   Legend Trainer always passes a candidate explicitly, because validating a
   profile being CREATED against another profile's columns produces confident,
   verified, wrong answers -- the worst failure mode available, since it looks
   exactly like evidence. */
export function profileMappedColumn(kind,id,fallback,profile){
  const mapping=profileMapping(kind,profile),value=profileManualFields(mapping)[id];
  return value!=null&&Number.isInteger(Number(value))?Number(value):fallback;
}
export function profileMappedHeaderRow(kind,fallback,profile){
  const mapping=profileMapping(kind,profile),value=mapping&&mapping.headerRow;
  if(mapping&&mapping.autoHeaderRow===true)return fallback;
  return value!=null&&Number.isInteger(Number(value))&&Number(value)>=0?Number(value):fallback;
}
