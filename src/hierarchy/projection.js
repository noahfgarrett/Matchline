import { clean, natCmp, KEYSEP } from '../core/text.js'
import { cleanRegisterTag, normSep } from '../core/tags.js'
import { S, tagKey, clearResultCache } from '../state.js'
import { profileTrimmedTag, activeProfile, profileAssignments, profileAttributeOverride } from '../profile/schema.js'
import { isSpareName, isSpaceName, nodeDep } from '../profile/classify.js'
import { isSystemName, legacyEquipmentRole, melResolvedRecord, melSources, melTagLookup, pmdExportTag, ssmResolve, activePlacements } from './build.js'
import { groupingLevels, activeModes } from './modes.js'
import { ruleEngine } from '../rules/provider.js'
import { createMemoryLookup } from '../rules/lookup.js'
import { resolveHierarchyClaims, HIERARCHY_CLAIM_KIND } from './claims.js'
import { foldClaimsByPartition, recordPartitionKey } from '../compiler/fold.js'
import { recordCompilerCableEdges, recordCompilerMelClaims } from '../compiler/edges.js'
import { assignMilestones } from '../compiler/ladders.js'
import { synthesizeLineRollups, finalizeLineRollups } from '../compiler/rollups.js'
import { learnItemMasterTable, assignItemMasters, assignClassifications } from '../compiler/itemmasters.js'
import { computeSequence, upnPrecedence } from '../compiler/sequence.js'

/* ---- canonical equipment model and projections ---- */
const PROFILE_SOURCE_ORDER=['cable','mel','easyPower','pmd'];
export function canonicalRecord(value){return S.canonicalModel.get(tagKey(profileTrimmedTag(value)))||null;}
export function resolveRecordContext(record,profile){
  const p=profile||activeProfile(),assign=profileAssignments(record.tag,p,record.sourceKind),mel=record.mel||null,h=p.hierarchy;
  const attributeOverride=profileAttributeOverride(record.tag,p),overrideValues=attributeOverride&&attributeOverride.values||{};
  const equipmentType=overrideValues.equipmentType||assign.values.equipmentType||legacyEquipmentRole(record.tag)||(record.isInstrument?'Instrument':record.isLoad?'Load':record.isId?'Equipment ID':'Equipment');
  const building=overrideValues.building||assign.values.building||clean(mel&&mel.building)||clean(record.pmdBuilding)||clean(h.unassignedBuilding)||'Unassigned Building';
  /* Compiler fork (spec §4): under a MEL-first profile the MEL is the attribute
     authority. Discipline reads straight from the MEL column; System composes
     as "{UPN} {System Description}". Rules and manual overrides still outrank
     both; Eagle (melSeed off) keeps the frozen fallback-only behavior. */
  const melFirst=h.melSeed&&h.melSeed.enabled!==false;
  const melDiscipline=melFirst?clean(mel&&mel.discipline):'';
  const melUpnValue=melFirst?clean(mel&&mel.upn):'',melSystemDescription=melFirst?clean(mel&&mel.systemDescription):'';
  const melSystem=melUpnValue&&melSystemDescription?`${melUpnValue} ${melSystemDescription}`:melSystemDescription;
  const discipline=overrideValues.discipline||assign.values.discipline||melDiscipline||(record.isInstrument?clean(h.disciplineFallbacks.instrument):clean(h.disciplineFallbacks.default))||'Unassigned Discipline';
  const system=overrideValues.system||assign.values.system||melSystem||record.systemHint||clean(h.systemFallbacks[discipline])||clean(h.systemFallbacks.default)||'Unassigned System';
  const attributes={...assign.values,building,discipline,system,equipmentType,matchKey:overrideValues.matchKey||assign.values.matchKey||normSep(record.tag),...overrideValues};
  const explicit=Object.fromEntries(Object.keys(assign.values).map(key=>[key,true]));
  explicit.building=!!(assign.values.building||clean(mel&&mel.building)||clean(record.pmdBuilding));
  explicit.discipline=!!(assign.values.discipline||melDiscipline)||record.isInstrument;
  explicit.system=!!(assign.values.system||melSystem)||isSystemName(record.tag);
  explicit.equipmentType=!!assign.values.equipmentType;
  for(const key of Object.keys(overrideValues))explicit[key]=true;
  return {...attributes,attributes,rules:assign.rules,explicit,attributeOverride};
}
export function recordAttribute(record,name){
  const value=record&&record.attributes&&record.attributes[name]!==undefined?record.attributes[name]:record&&record[name];
  return clean(value);
}
function profileSourcePriority(profile,source){
  const order=profile.hierarchy&&profile.hierarchy.parentSourcePriority||[],index=order.indexOf(source);
  return index<0?100:1000-index*100;
}
function relationshipRulePriority(profile,ruleId){
  const rules=profile.rules&&profile.rules.relate||[],index=rules.findIndex(rule=>rule.id===ruleId);
  return 2000-(index<0?rules.length:index);
}
function sourceClaims(record,source){
  const sourceMap=S.sourceParentClaims&&S.sourceParentClaims[source];
  if(!sourceMap)return [];
  /* Claims are recorded under the spelling the source document used. A record
     unified across documents (suffix identity, spec §5) collects claims from
     every spelling it has absorbed. */
  const merged=new Map();
  const collect=claimKey=>{
    const parents=claimKey&&sourceMap.get(claimKey);
    if(parents)for(const [targetKey,claim] of parents)if(!merged.has(targetKey))merged.set(targetKey,claim);
  };
  collect(record.key);
  for(const variant of record.sourceTags){
    const variantKey=tagKey(profileTrimmedTag(variant));
    if(variantKey&&variantKey!==record.key)collect(variantKey);
  }
  return [...merged.values()];
}
function relationshipCurrentParent(record,profile){
  for(const source of profile.hierarchy&&profile.hierarchy.parentSourcePriority||PROFILE_SOURCE_ORDER){
    const claims=sourceClaims(record,source);
    if(claims.length===1)return claims[0].parent;
    if(claims.length>1)return '';
  }
  return [...record.registerParents][0]||[...record.flowParents][0]||'';
}
function resolvedRegisterRows(rows,records,includeMissing=true){
  const seen=new Set(),out=[];
  for(const row of rows||[]){
    const fixed=[...row],record=records.get(tagKey(fixed[0]));if(!record)continue;
    fixed[0]=record.tag;fixed[1]=record.ssmParentTag||'';
    if(record.dependencies.size)fixed[2]=[...record.dependencies].join('; ');
    if(seen.has(record.key))continue;seen.add(record.key);out.push(fixed);
  }
  if(includeMissing)for(const record of records.values()){
    if(seen.has(record.key)||!record.includeInRegister)continue;
    seen.add(record.key);out.push([record.tag,record.ssmParentTag||'',record.dependencies.size?[...record.dependencies].join('; '):'']);
  }
  return out;
}
export function resolvedRegisterRowsFor(rows){
  if(activeProfile().hierarchy&&activeProfile().hierarchy.resolutionStrategy==='legacy-register')return rows||[];
  return resolvedRegisterRows(rows,S.canonicalModel,false);
}
export function buildCanonicalModel(){
  const records=new Map();
  const melSeed=activeProfile().hierarchy&&activeProfile().hierarchy.melSeed;
  const melFirst=!!(melSeed&&melSeed.enabled!==false);
  const ensure=(value,flags={})=>{
    const normalized=profileTrimmedTag(value),preserved=cleanRegisterTag(value),rawTag=preserved||normalized;
    let key=tagKey(normalized||rawTag);if(!key)return null;
    let tag=rawTag,unified=false;
    /* Default identity wiring (spec §5): documents spell the same asset
       differently — the MEL carries the building prefix, Easy Power/cable/PMD
       often only the back end. An unambiguous suffix match unifies them into
       one record, and the MEL spelling wins. Ambiguous matches stay separate
       and surface in review rather than being guessed. */
    if(melFirst&&S.melByTag.size&&!S.melByTag.has(key)){
      const lookup=melTagLookup(rawTag);
      if(lookup.record&&lookup.candidates.length===1){
        const melKey=tagKey(lookup.record.tag);
        if(melKey&&melKey!==key){key=melKey;tag=cleanRegisterTag(lookup.record.tag)||lookup.record.tag;unified=true;}
      }
    }
    let record=records.get(key);
    if(!record){record={key,tag,sourceTags:new Set(),occurrences:[],flowParents:new Set(),registerParents:new Set(),dependencies:new Set(),
      isId:false,isLoad:false,isInstrument:false,pmdKey:'',pmdPanel:'',pmdBuilding:'',description:'',systemHint:'',sourceKind:'easyPower',
      mel:null,parentCandidates:{},context:null,attributes:{},ssmParentTag:'',provenance:[],resolution:null,
      observed:false,hasRegisterRow:false,includeInHierarchy:false,includeInRegister:false,phaseExcluded:false};records.set(key,record);}
    if(!unified&&preserved&&preserved!==normalized)record.tag=preserved;
    if(flags.observed)record.observed=true;
    if(flags.hierarchy)record.includeInHierarchy=true;
    if(flags.register)record.hasRegisterRow=true;
    record.sourceTags.add(clean(value));return record;
  };
  /* systemAbove is the nearest system name scanning from the ROOT down, which is
     exactly what [...path,node.name].find(isSystemName) used to return: the
     root-most match wins, so once an ancestor supplies one it never changes.
     Threading that single value replaces rebuilding the whole ancestor array at
     every node -- the walk was allocating one array per node for the lookup and
     another per child for the recursion, and retaining a third on every
     occurrence for the life of the session. Nothing read that retained path:
     occurrences are only ever consulted for .length and [0].nodeId. */
  const walk=(node,systemAbove)=>{
    const identity=node.isInstrument?pmdExportTag(node.name,node.pmdBuilding):node.name;
    const record=ensure(identity,{observed:true,hierarchy:true});if(!record)return;
    node.canonicalKey=record.key;const parent=node.parent?profileTrimmedTag(node.parent.name):'';
    record.occurrences.push({nodeId:node.id,parent});if(parent)record.flowParents.add(parent);
    record.isId=record.isId||!!node.isId;record.isLoad=record.isLoad||!!node.isLoad;record.isInstrument=record.isInstrument||!!node.isInstrument;
    if(node.pmdKey&&!record.pmdKey)record.pmdKey=node.pmdKey;if(node.pmdPanel&&!record.pmdPanel)record.pmdPanel=node.pmdPanel;
    if(node.pmdBuilding&&!record.pmdBuilding)record.pmdBuilding=node.pmdBuilding;if(node.description&&!record.description)record.description=node.description;
    const systemAlong=systemAbove||(isSystemName(node.name)?node.name:'');
    if(systemAlong&&!record.systemHint)record.systemHint=systemAlong;
    for(const child of node.children)walk(child,systemAlong);
  };
  S.roots.forEach(root=>walk(root,''));
  for(const row of S.ssmCombined){
    const resolved=ssmResolve(row),record=ensure(resolved.equip,{observed:true,hierarchy:true,register:true});if(!record)continue;
    if(resolved.parent){record.registerParents.add(cleanRegisterTag(resolved.parent));ensure(resolved.parent);}
    if(resolved.dep)record.dependencies.add(cleanRegisterTag(resolved.dep));
  }
  /* Compiler fork — MEL-first seeding (spec §4): every MEL row is a
     commissionable record, whether or not any electrical source mentions it.
     Excluded phases stay out of the register but remain records so edges can
     still attach and lint can still see them. */
  if(melFirst){
    const excludedPhases=new Set((melSeed.excludedPhases||['Future']).map(phase=>clean(phase).toLowerCase()));
    for(const row of S.melRows||[]){
      const record=ensure(row.tag,{observed:true});if(!record)continue;
      const phase=clean(row.projectPhase).toLowerCase();
      record.phaseExcluded=!!phase&&excludedPhases.has(phase);
      if(!record.description&&row.description)record.description=row.description;
      if(!record.phaseExcluded){record.includeInRegister=true;record.includeInHierarchy=true;}
    }
    synthesizeLineRollups(records,ensure);
  }
  /* Cable evidence honors the same workflow switch as the raw-tree cable
     stage: a profile that disables cable parent chains gets no cable claims
     from the compiler edge pass either. */
  const cableWorkflow=activeProfile().hierarchy&&activeProfile().hierarchy.workflow;
  if(!cableWorkflow||cableWorkflow.cableParentChains!==false)recordCompilerCableEdges(records);
  if(!cableWorkflow||cableWorkflow.melSystemParentClaims!==false)recordCompilerMelClaims(records);
  /* Trailing System Parent tags. The first became the structural parent claim
     in buildMel; these are additive, so they join the dependency set the cable
     schedule also writes into rather than competing with it. */
  for(const [key,tags] of S.melDependencyClaims||[]){
    const record=records.get(key);
    if(!record)continue;
    for(const tag of tags){const target=cleanRegisterTag(tag);if(target&&tagKey(target)!==key){record.dependencies.add(target);ensure(target);}}
  }
  for(const record of records.values()){
    record.mel=melResolvedRecord(record.tag);
    if(record.isInstrument)record.sourceKind='pmd';
    else if(record.mel&&!record.occurrences.length)record.sourceKind='mel';
    const fallbackParents=[...record.registerParents,...record.flowParents].filter(Boolean);
    record.parentCandidates={};
    for(const source of PROFILE_SOURCE_ORDER){
      const claims=sourceClaims(record,source);
      record.parentCandidates[source]=claims[0]&&claims[0].parent||'';
      for(const claim of claims)ensure(claim.parent);
    }
    for(const candidate of fallbackParents)ensure(candidate);
  }
  for(const record of records.values()){
    if(!record.mel)record.mel=melResolvedRecord(record.tag);
    record.context=resolveRecordContext(record,activeProfile());Object.assign(record,record.context);
    record.attributes={...record.context.attributes};
    record.provenance=[
      ...record.context.rules.map(rule=>`${rule.target} · ${rule.name}`),
      record.mel&&record.mel.building?'Building · MEL':'',
      record.pmdBuilding?'Building · PMD prefix':'',
      record.isInstrument?'Discipline · PMD fallback':'',
      record.context.attributeOverride?'Grouping · Visual Trainer':''
    ].filter(Boolean);
  }
  const profile=activeProfile(),observations=[],candidates=[],manualOverrides=[];let order=0;
  const canonicalLookup=createMemoryLookup([...records.values()].map(record=>({
    tag:record.tag,columns:{},attributes:{...record.attributes}
  })));
  const relationshipSources={...melSources(),canonical:canonicalLookup};
  const addParent=(record,parent,source,priority,provenance)=>{
    const target=cleanRegisterTag(parent);if(!target||tagKey(target)===record.key)return;
    const targetRecord=ensure(target);targetRecord.isSyntheticParent=true;
    candidates.push({id:`parent:${source}:${record.key}:${targetRecord.key}`,kind:HIERARCHY_CLAIM_KIND.STRUCTURAL_PARENT,
      subjectId:record.key,targetId:targetRecord.key,priority,order:order++,provenance});
  };
  const addDependency=(record,dependency,source,priority)=>{
    const target=cleanRegisterTag(dependency);if(!target||tagKey(target)===record.key)return;
    const targetRecord=ensure(target);
    candidates.push({id:`dependency:${source}:${record.key}:${targetRecord.key}`,kind:HIERARCHY_CLAIM_KIND.DEPENDENCY,
      subjectId:record.key,targetId:targetRecord.key,priority,order:order++,provenance:{source}});
  };
  for(const record of records.values()){
    observations.push({id:'asset:'+record.key,entityId:record.key,provenance:{sourceTags:[...record.sourceTags]}});
    for(const source of PROFILE_SOURCE_ORDER)for(const claim of sourceClaims(record,source)){
      addParent(record,claim.parent,source,profileSourcePriority(profile,source),{source,count:claim.count,observations:claim.provenance});
    }
    const registerPriority=profile.hierarchy&&profile.hierarchy.resolutionStrategy==='legacy-register'?1500:500;
    for(const parent of record.registerParents)addParent(record,parent,'resolved-register',registerPriority,{source:'Resolved legacy register'});
    for(const parent of record.flowParents)addParent(record,parent,'resolved-flow',450,{source:'Resolved legacy flow'});
    for(const dependency of record.dependencies)addDependency(record,dependency,'register',1000);
    const current=relationshipCurrentParent(record,profile);
    const currentRecord=records.get(tagKey(current));
    const decision=ruleEngine().relate(record.tag,current,{sources:relationshipSources,sourceKind:record.sourceKind,
      attributes:record.attributes,parentAttributes:currentRecord&&currentRecord.attributes||{}});
    record.ruleDecision=decision;
    if(decision.status==='resolved'&&decision.parent)addParent(record,decision.parent,'rule-'+decision.ruleId,relationshipRulePriority(profile,decision.ruleId),
      {source:'Rule Engine',ruleId:decision.ruleId,reason:decision.reason||''});
    else if(decision.status==='ambiguous')S.resolutionIssues.push({type:'rule-ambiguity',entityId:record.key,tag:record.tag,ruleId:decision.ruleId,
      candidates:decision.candidates||[],reason:decision.reason||'Rule matched multiple possible parents'});
    for(const dependency of decision.dependencies||[])addDependency(record,dependency,'rule-'+decision.ruleId,relationshipRulePriority(profile,decision.ruleId));
  }
  const relationshipOverrides=new Map();
  for(const override of [...(profile.overrides&&profile.overrides.relationships||[]),...(S.sessionRelationshipOverrides||[])])relationshipOverrides.set(tagKey(override.equipment),override);
  for(const override of relationshipOverrides.values()){
    const subject=records.get(tagKey(override.equipment)),target=ensure(override.parent);if(!subject||!target)continue;
    target.isSyntheticParent=true;
    manualOverrides.push({id:`manual:${override.id||subject.key}`,kind:HIERARCHY_CLAIM_KIND.STRUCTURAL_PARENT,subjectId:subject.key,targetId:target.key,
      provenance:{source:'Placement Review',savedAt:override.savedAt||''}});
  }
  for(const record of records.values())if(!record.context){
    record.mel=melResolvedRecord(record.tag);record.context=resolveRecordContext(record,profile);Object.assign(record,record.context);
    record.attributes={...record.context.attributes};
  }
  /* Compiler fork — the partition fold (spec §5). Record contexts are already
     resolved above, so partition keys are available. Manual overrides bypass
     the fold on purpose: a human placement wins, and contradictions surface in
     review rather than being silently reclassified. */
  const partitionOf=id=>{const partitionRecord=records.get(id);return partitionRecord?recordPartitionKey(partitionRecord):null;};
  const foldedCandidates=foldClaimsByPartition(candidates,partitionOf);
  const snapshot=resolveHierarchyClaims({observations,candidates:foldedCandidates,manualOverrides});S.resolvedSnapshot=snapshot;
  S.resolutionIssues=[...S.resolutionIssues,...snapshot.issues];
  for(const entity of snapshot.entities){
    const record=records.get(entity.id);if(!record)continue;
    record.resolution=entity;const parent=entity.parentId&&records.get(entity.parentId);
    record.ssmParentTag=parent?parent.tag:'';
    /* SOP: a child of a parent does not also list that parent as a dependency.
       The frozen legacy register deliberately writes the feeder into both
       columns for load rows, so the dedup applies to MEL-first profiles only. */
    const dependencyIds=melSeed&&melSeed.enabled!==false?entity.dependencyIds.filter(id=>id!==entity.parentId):entity.dependencyIds;
    record.dependencies=new Set(dependencyIds.map(id=>records.get(id)&&records.get(id).tag||id));
    if(parent){parent.includeInHierarchy=true;parent.includeInRegister=true;}
  }
  const groupingAttributes=[...new Set(activeModes(profile).flatMap(mode=>groupingLevels(mode).map(level=>level.attribute)))],inherited=new Set();
  const inherit=(record,trail)=>{
    if(!record||inherited.has(record.key))return;const next=new Set(trail||[]);
    if(next.has(record.key))return;next.add(record.key);
    const parent=records.get(tagKey(record.ssmParentTag));if(parent){inherit(parent,next);
      for(const attribute of groupingAttributes)if(!record.context.explicit[attribute]){
        const value=recordAttribute(parent,attribute);if(value&&!/^unassigned/i.test(value)){record.attributes[attribute]=value;record[attribute]=value;}
      }}
    inherited.add(record.key);
  };
  for(const record of records.values())inherit(record,new Set());
  /* Compiler fork — milestone ladder + sequencing (spec §5/§6), after
     attribute inheritance so grouping is final. P6 is strictly optional:
     without it every record lands on the building-ready rung. */
  if(melSeed&&melSeed.enabled!==false){
    finalizeLineRollups(records);
    assignMilestones(records);
    computeSequence(records,profile);
    S.upnPrecedence=upnPrecedence(records);
    /* Optional EXTO layer: item-master assignment runs only when the profile
       keeps EXTO on AND a learning source (registry / IM template) was given. */
    const exto=profile.hierarchy&&profile.hierarchy.exto;
    if((!exto||exto.enabled!==false)&&(!exto||exto.itemMasters!==false)){
      const imTable=learnItemMasterTable();
      S.imAudit=imTable.audit;
      assignClassifications(records,imTable);
      assignItemMasters(records,imTable);
    }else{
      S.imAudit=[];
    }
  }else{
    S.upnPrecedence={edges:[],order:[],cycles:[]};
    S.imAudit=[];
  }
  if(profile.hierarchy&&profile.hierarchy.resolutionStrategy!=='legacy-register'){
    S.ssmCombined=resolvedRegisterRows(S.ssmCombined,records);
  }
  S.canonicalModel=records;return records;
}
export function projectionStats(roots){
  let nodes=0,leaves=0,maxDepth=0,idCount=0,deps=0,loads=0,instruments=0;
  const stack=[...roots];
  while(stack.length){const node=stack.pop();nodes++;if(!node.children.length)leaves++;maxDepth=Math.max(maxDepth,node.depth);
    if(node.isId)idCount++;if(node.isLoad)loads++;if(node.isInstrument)instruments++;if(nodeDep(node))deps++;
    for(let i=node.children.length-1;i>=0;i--)stack.push(node.children[i]);}
  return {nodes,leaves,maxDepth:maxDepth+1,idCount,sources:roots.length,deps,loads,instruments,review:S.review.length+activePlacements().length};
}
export function buildModeProjection(mode){
  if(mode&&mode.executor==='raw'){
    const projection={roots:S.roots,nodeById:S.nodeById,stats:projectionStats(S.roots),
      revision:((S.projections[mode.id]||{}).revision||0)+1};
    S.projections[mode.id]=projection;return projection;
  }
  const records=S.canonicalModel,nodeById=new Map(),roots=[],groups=new Map(),equipmentNodes=new Map();let id=0;
  const makeNode=(name,kind,parent,record)=>{
    const representative=record&&record.occurrences.length?S.nodeById.get(record.occurrences[0].nodeId):null;
    const node={id:'ssm-'+(id++),name,kind,depth:parent?parent.depth+1:0,parent,children:[],canonicalKey:record?record.key:'',
      isId:!!(record&&record.isId),isLoad:!!(record&&record.isLoad),isInstrument:!!(record&&record.isInstrument),
      dependencies:record?[...record.dependencies]:[],loadDependency:record?[...record.dependencies].join('; '):'',dependencyOverride:record?[...record.dependencies].join('; '):'',
      description:record&&record.description||'',pmdKey:record&&record.pmdKey||'',pmdPanel:record&&record.pmdPanel||'',pmdBuilding:record&&record.pmdBuilding||'',
      placementId:'',placementStatus:'',isSpare:isSpareName(name),isSpace:isSpaceName(name),_raw:representative&&representative._raw||null};
    nodeById.set(node.id,node);return node;
  };
  /* One folder chain per grouping level, in order. The node's `kind` is the
     level's attribute name, which is what the old hardcoded chain produced
     ('building'/'discipline'/'system') and what the sort ranking and the panel
     CSS key off. The key accumulates down the chain so two records only share a
     folder when every level above it agreed. */
  const levels=groupingLevels(mode);
  /* The boundary rule, derived from the levels rather than configured
     separately: two records may nest only when every grouping attribute agrees,
     which is exactly what sameRecordContext hardcoded for building/discipline/
     system. A mode with no grouping levels never separates anything. */
  const sameGroup=(a,b)=>!!a&&!!b&&levels.every(level=>recordAttribute(a,level.attribute)===recordAttribute(b,level.attribute));
  const groupFor=record=>{
    let parent=null,key='';
    for(const level of levels){
      const value=recordAttribute(record,level.attribute)||clean(level.fallback)||'Unassigned';
      key+=KEYSEP+level.attribute+KEYSEP+tagKey(value);
      let node=groups.get(key);
      if(!node){
        node=makeNode(value,level.attribute,parent,null);
        groups.set(key,node);
        if(parent)parent.children.push(node);else roots.push(node);
      }
      parent=node;
    }
    return parent;
  };
  for(const record of records.values()){
    if(!record.includeInHierarchy)continue;
    /* A record that IS one of this mode's group folders must not also appear as
       a leaf inside it. Scoped to the mode's own levels: the old form named
       record.system/record.building outright, so a mode grouping by neither
       dropped those records entirely rather than skipping a duplicate. */
    if(levels.some(level=>tagKey(record.tag)===tagKey(recordAttribute(record,level.attribute))))continue;
    equipmentNodes.set(record.key,makeNode(record.tag,'equipment',null,record));
  }
  const attached=new Set();
  const place=(node,record)=>{
    /* groupFor is null for a mode with no grouping levels, where records sit at
       the root with no folder above them. */
    const group=groupFor(record);
    if(group){node.parent=group;group.children.push(node);}
    else{node.parent=null;roots.push(node);}
  };
  const attach=(record,trail)=>{
    const node=equipmentNodes.get(record.key);if(!node||attached.has(record.key))return node;
    const nextTrail=new Set(trail||[]);if(nextTrail.has(record.key)){place(node,record);attached.add(record.key);return node;}
    nextTrail.add(record.key);
    const parentRecord=records.get(tagKey(record.ssmParentTag)),parentNode=parentRecord&&equipmentNodes.get(parentRecord.key);
    if(parentRecord&&parentNode&&sameGroup(record,parentRecord)&&!nextTrail.has(parentRecord.key)){
      attach(parentRecord,nextTrail);node.parent=parentNode;parentNode.children.push(node);
    }else place(node,record);
    attached.add(record.key);return node;
  };
  for(const record of records.values())if(equipmentNodes.has(record.key))attach(record,new Set());
  const rank=Object.create(null);levels.forEach((level,index)=>{rank[level.attribute]=index;});
  rank.equipment=levels.length;
  const sortAndDepth=(node,depth)=>{
    node.depth=depth;node.children.sort((a,b)=>((rank[a.kind]??rank.equipment)-(rank[b.kind]??rank.equipment))||natCmp(a.name,b.name));
    node.children.forEach(child=>{child.parent=node;sortAndDepth(child,depth+1);});
  };
  roots.sort((a,b)=>natCmp(a.name,b.name));roots.forEach(root=>sortAndDepth(root,0));
  const stats=projectionStats(roots);
  const projection={roots,nodeById,stats,revision:((S.projections[mode.id]||{}).revision||0)+1};
  S.projections[mode.id]=projection;
  return projection;
}
export function rebuildProfileProjections(){
  if(!S.roots.length)return;
  S.resolutionIssues=[];buildCanonicalModel();
  for(const mode of activeModes(activeProfile()))buildModeProjection(mode);
  clearResultCache();
}
