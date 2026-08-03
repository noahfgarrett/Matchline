import { clean, natCmp, KEYSEP, raf } from '../core/text.js'
import { cleanTag, cleanRegisterTag, normSep } from '../core/tags.js'
import { _yT, resetYield, maybeYield } from '../core/async.js'
import { S, fileById, tagKey, clearResultCache } from '../state.js'
import { profileEquipmentRole, activeProfile, persistProfiles, profileExecutionSignature } from '../profile/schema.js'
import { ruleEngine } from '../rules/provider.js'
import { createMemoryLookup } from '../rules/lookup.js'
import { validLoad, topFuzzy, gisBusCut, isGisTag, depOf } from '../profile/classify.js'
import { withLoading, toast } from '../ui/progress.js'
import { resolveCols, cableInfo, PMD_FIELDS, pmdInfo, pmdPanelMatchParts, pmdPanelKey, melInfo } from '../io/detect.js'
import { getAoa, cellIsStruck, rowTag, collectLoadDescriptionTags } from '../io/workbook.js'
import { rowToPath, loadSsmRelation, insertPath, addLoadChild, finalize, computeStats, countTreeDependencies } from './tree.js'
import { rebuildProfileProjections } from './projection.js'
import { activeModes } from './modes.js'

/* ---- build ---- */
export function resetSourceParentClaims(){
  S.sourceParentClaims={easyPower:new Map(),cable:new Map(),mel:new Map(),pmd:new Map()};
}
export function recordSourceParentClaim(source,equipment,parent,provenance){
  const subject=cleanTag(equipment),target=cleanRegisterTag(parent),subjectKey=tagKey(subject),targetKey=tagKey(target);
  const sourceMap=S.sourceParentClaims&&S.sourceParentClaims[source];
  if(!sourceMap||!subjectKey||!targetKey||subjectKey===targetKey)return;
  let parents=sourceMap.get(subjectKey);
  if(!parents){parents=new Map();sourceMap.set(subjectKey,parents);}
  let claim=parents.get(targetKey);
  if(!claim){claim={equipment:subject,parent:target,source,count:0,provenance:[]};parents.set(targetKey,claim);}
  claim.count++;
  if(provenance&&claim.provenance.length<12)claim.provenance.push(provenance);
}
export async function buildMel(tick){
  S.melRows=[];S.melByTag=new Map();S.melByNorm=new Map();S.melBySuffix=new Map();S.melByGram=new Map();S.melLookupCache=new Map();S.melContainingCache=new Map();
  for(const key of S.melSel){
    const [fid]=key.split(KEYSEP);if(!fileById(fid))continue;
    const mi=melInfo(key);if(!mi)continue;
    const {map,headerRow}=mi,{aoa}=getAoa(key);
    for(let i=headerRow+1;i<aoa.length;i++){
      if(tick){const pending=tick('Reading Master Equipment List');if(pending)await pending;}
      const tag=cleanTag(aoa[i][map.tag]);if(!tag)continue;
      const upn=map.upn>=0?clean(aoa[i][map.upn]):'',building=map.building>=0?clean(aoa[i][map.building]):'';
      const systemParent=map.systemParent>=0?clean(aoa[i][map.systemParent]):'',keyTag=tagKey(tag),existing=S.melByTag.get(keyTag);
      const discipline=map.discipline>=0?clean(aoa[i][map.discipline]):'',systemDescription=map.systemDescription>=0?clean(aoa[i][map.systemDescription]):'';
      const rec={tag,upn,building,systemParent,discipline,systemDescription};S.melRows.push(rec);
      if(existing){if(!existing.upn&&upn)existing.upn=upn;if(!existing.building&&building)existing.building=building;if(!existing.systemParent&&systemParent)existing.systemParent=systemParent;if(!existing.discipline&&discipline)existing.discipline=discipline;if(!existing.systemDescription&&systemDescription)existing.systemDescription=systemDescription;continue;}
      S.melByTag.set(keyTag,rec);
      const normKey=normSep(tag);if(normKey&&!S.melByNorm.has(normKey))S.melByNorm.set(normKey,rec);
      indexMelLookupRecord(rec);
      const suffixKeys=new Set([normSep(stripPowerVariant(tag))]),separators=[...stripPowerVariant(tag).matchAll(/[\s\-_\/.]+/g)];
      for(const match of separators){const suffixKey=normSep(stripPowerVariant(tag).slice(match.index+match[0].length));if(suffixKey)suffixKeys.add(suffixKey);}
      for(const suffixKey of suffixKeys){if(!suffixKey)continue;const list=S.melBySuffix.get(suffixKey)||[];list.push(rec);S.melBySuffix.set(suffixKey,list);}
    }
  }
  S.melLookup=createMemoryLookup(S.melRows.map(rec=>{
    const resolved=ruleEngine().resolve(cleanTag(rec.tag));
    return {tag:rec.tag,columns:{Building:rec.building,UPN:rec.upn,SystemParent:rec.systemParent,Discipline:rec.discipline,SystemDescription:rec.systemDescription},
      attributes:{equipmentType:resolved.attributes.equipmentType||'',matchKey:resolved.attributes.matchKey||''}};
  }));
}
export function hasMelData(){return !!(S.melByTag.size||S.melRows.length);}
export function melSources(){return {mel:S.melLookup||createMemoryLookup([])};}
export function melRecord(value){return S.melByTag.get(tagKey(value))||S.melByNorm.get(normSep(cleanTag(value)))||null;}
export const MEL_LOOKUP_GRAM_SIZE=3;
export function melLookupGrams(value){
  const key=normSep(stripPowerVariant(value)),grams=[],seen=new Set();
  for(let i=0;i<=key.length-MEL_LOOKUP_GRAM_SIZE;i++){
    const gram=key.slice(i,i+MEL_LOOKUP_GRAM_SIZE);
    if(!seen.has(gram)){seen.add(gram);grams.push(gram);}
  }
  return grams;
}
export function indexMelLookupRecord(rec){
  for(const gram of melLookupGrams(rec.tag)){
    const list=S.melByGram.get(gram)||[];list.push(rec);S.melByGram.set(gram,list);
  }
}
export function melLookupSearchRows(value){
  const key=normSep(stripPowerVariant(value));
  if(!S.melByGram.size)return S.melRows;
  if(key.length<MEL_LOOKUP_GRAM_SIZE)return S.melRows;
  let smallest=null;
  for(const gram of melLookupGrams(key)){
    const matches=S.melByGram.get(gram);
    if(!matches)return [];
    if(!smallest||matches.length<smallest.length)smallest=matches;
  }
  return smallest||[];
}
export function melTagLookup(value){
  const exact=melRecord(value);if(exact)return {record:exact,match:'exact',candidates:[exact]};
  const key=normSep(stripPowerVariant(value));if(!key)return {record:null,match:'none',candidates:[]};
  if(S.melLookupCache.has(key))return S.melLookupCache.get(key);
  let candidates=[...new Set((S.melBySuffix.get(key)||[]))],match='contained';
  if(!candidates.length){
    const normalized=[],contained=[];
    for(const rec of melLookupSearchRows(key)){
      const recKey=normSep(stripPowerVariant(rec.tag));if(!recKey)continue;
      if(recKey===key)normalized.push(rec);else if(recKey.endsWith(key))candidates.push(rec);else if(recKey.includes(key))contained.push(rec);
    }
    if(normalized.length){candidates=normalized;match='normalized';}
    else if(!candidates.length)candidates=contained;
  }
  const result={record:candidates.length===1?candidates[0]:null,match:candidates.length?match:'none',candidates};
  S.melLookupCache.set(key,result);return result;
}
export function melResolvedRecord(value){return melTagLookup(value).record;}
export function melUpn(value){const rec=melResolvedRecord(value);return rec?rec.upn:'';}
/* The column is "System Parent Equipment Tag(s)" -- plural, and sites really do
   fill it with several. Everything after the first entry used to be discarded
   silently. A structural parent is singular and dependencies are additive, so
   the first tag is the parent and the rest are dependencies. */
export function melSystemParentTags(value){
  const seen=new Set(),out=[];
  for(const part of clean(value).split(/[;\n\r,|]+/)){
    const tag=cleanTag(part),key=tagKey(tag);
    if(!tag||!key||seen.has(key))continue;
    seen.add(key);out.push(tag);
  }
  return out;
}
export function firstSystemParentTag(value){return melSystemParentTags(value)[0]||'';}
/**
 * Record MEL System Parent as an ordinary parent claim, for every row that has
 * one -- not only where a UPN mismatch was detected.
 *
 * The scoping falls out of parentSourcePriority rather than needing a rule of
 * its own: Cable Schedule claims only exist for equipment that appears in the
 * Cable Schedule, so ranking cable above mel means MEL can only win where cable
 * is silent. That is exactly the non-electrical equipment MEL is trusted for,
 * and the electrical spine stays cable-driven without anyone configuring it.
 *
 * `known` limits this to equipment actually in the build; a MEL row for
 * something that was never imported would otherwise sit in the claim map
 * forever, and a large MEL is mostly rows this build does not care about.
 */
export function recordMelSystemParentClaims(rows){
  const known=new Set();
  for(const row of rows||[]){const key=tagKey(row&&row[0]);if(key)known.add(key);}
  const dependencies=new Map();
  for(const rec of S.melRows){
    const key=tagKey(rec.tag);
    if(!key||!known.has(key))continue;
    const tags=melSystemParentTags(rec.systemParent);
    if(!tags.length)continue;
    if(tagKey(tags[0])!==key)recordSourceParentClaim('mel',rec.tag,tags[0],{status:'system-parent-column'});
    const extra=tags.slice(1).filter(tag=>tagKey(tag)&&tagKey(tag)!==key);
    if(extra.length)dependencies.set(key,extra);
  }
  return dependencies;
}
export function legacyEquipmentRole(value){
  return ruleEngine().resolve(cleanTag(value)).attributes.equipmentType || '';
}
export function equipmentRole(value){return profileEquipmentRole(value)||legacyEquipmentRole(value);}
export function hasEquipmentRole(value,role){return equipmentRole(value)===(role==='LV'?'LVS':role);}
export function equipmentSuffix(value){return ruleEngine().resolve(cleanTag(value)).attributes.matchKey || '';}
export function stripPowerVariant(value){return ruleEngine().normalizeOnly(cleanTag(value),'matching');}
export function melContainingRecord(value){
  const key=normSep(stripPowerVariant(value));if(!key)return null;
  if(S.melContainingCache.has(key))return S.melContainingCache.get(key);
  let contained=null;
  for(const rec of melLookupSearchRows(key)){
    const recKey=normSep(rec.tag);
    if(recKey===key||recKey.endsWith(key)){S.melContainingCache.set(key,rec);return rec;}
    if(!contained&&recKey.includes(key))contained=rec;
  }
  S.melContainingCache.set(key,contained);return contained;
}
export function relateRuleById(id){return (activeProfile().rules&&activeProfile().rules.relate||[]).find(rule=>rule.id===id)||null;}
export function melScrSccParent(equipment){
  const d=ruleEngine().relate(cleanTag(equipment),'',{sources:melSources()});
  const rule=relateRuleById(d.ruleId),markers=rule&&rule.markers||[];
  return d.status==='resolved'&&rule&&rule.kind==='fragmentLookup'&&markers.some(marker=>/S(?:CR|CC)-/i.test(marker))?d.parent:'';
}
export function melCimParent(equipment){
  const d=ruleEngine().relate(cleanTag(equipment),'',{sources:melSources()});
  const rule=relateRuleById(d.ruleId),markers=rule&&rule.markers||[];
  return d.status==='resolved'&&rule&&rule.kind==='fragmentLookup'&&markers.some(marker=>/CIM/i.test(marker))?d.parent:'';
}
export function melSyntheticParent(equipment){
  if(!hasMelData())return '';
  const decision=ruleEngine().relate(cleanTag(equipment),'',{sources:melSources()}),rule=relateRuleById(decision.ruleId);
  return decision.status==='resolved'&&rule&&rule.kind!=='attributeMatch'&&rule.kind!=='prefixSplit'?decision.parent:'';
}
export function melTransformerDecision(equipment,parent){
  if(!hasMelData())return null;
  const d=ruleEngine().relate(cleanTag(equipment),cleanTag(parent),{sources:melSources()});
  const rule=relateRuleById(d.ruleId);if(!rule||rule.kind!=='attributeMatch')return null;
  const current=stripPowerVariant(parent);
  if(d.status==='resolved')return {status:'suggested',corrected:d.parent,suffix:equipmentSuffix(equipment),candidates:[d.parent]};
  if(d.status==='ambiguous')return {status:'unplaced',corrected:current,suffix:equipmentSuffix(equipment),candidates:d.candidates,reason:d.reason};
  return null;
}
export function melCorrectClosestParent(equipment,parent){
  const current=cleanTag(parent),decision=melTransformerDecision(equipment,current);
  return decision?decision.corrected:current;
}
export function rememberMelPlacement(branch,parent,decision){
  if(!decision||decision.status==='matched')return;
  const rec={branchName:cleanTag(branch),originalParent:cleanTag(parent),currentParent:decision.status==='suggested'?decision.corrected:cleanTag(parent),suggestedParent:decision.status==='suggested'?decision.corrected:'',
    status:decision.status,source:'Master Equipment List',suffix:decision.suffix,reason:decision.reason||'MEL supplied the transformer with matching final four characters'};
  const key=[tagKey(rec.branchName),tagKey(rec.currentParent),tagKey(rec.suggestedParent),rec.status].join(KEYSEP);
  if(!S._melPlacementSeeds.has(key))S._melPlacementSeeds.set(key,rec);
}
export function applyMelParentCorrections(segs,loadDesc,track){
  const out=segs.slice();
  for(let i=out.length-1;i>0;i--){const decision=melTransformerDecision(out[i],out[i-1]);if(track)rememberMelPlacement(out[i],out[i-1],decision);if(decision)out[i-1]=decision.corrected;}
  if(out.length&&loadDesc){const decision=melTransformerDecision(loadDesc,out[out.length-1]);if(track)rememberMelPlacement(loadDesc,out[out.length-1],decision);if(decision)out[out.length-1]=decision.corrected;}
  return out;
}
export function melCorrectLoadRelation(loadDesc,relation){
  const original=relation.parent,corrected=melCorrectClosestParent(loadDesc,original);
  if(corrected===original)return relation;
  const dep=relation.dep&&tagKey(relation.dep)===tagKey(original)?corrected:relation.dep;
  return {...relation,parent:corrected,dep};
}
export function rawKidEntry(kids,value){
  if(kids.has(value))return [value,kids.get(value)];
  const key=tagKey(value);
  for(const entry of kids.entries())if(tagKey(entry[1].name)===key)return entry;
  return null;
}
export function mergeRawHierarchyNode(target,source){
  target.isId=!!(target.isId||source.isId);target.isLoad=!!(target.isLoad||source.isLoad);target.isInstrument=!!(target.isInstrument||source.isInstrument);
  for(const field of ['loadDependency','dependencyOverride','description','pmdKey','pmdPanel','pmdBuilding'])if(!target[field]&&source[field])target[field]=source[field];
  for(const child of source.kids.values()){
    const existing=rawKidEntry(target.kids,child.name);
    if(existing)mergeRawHierarchyNode(existing[1],child);else target.kids.set(child.name,child);
  }
  return target;
}
export function mahClosestParent(value){
  const d=ruleEngine().relate(cleanTag(value),'',{sources:melSources()});
  const rule=relateRuleById(d.ruleId);
  return d.status==='resolved'&&rule&&rule.kind==='prefixSplit'?d.parent:'';
}
export function repairMahHierarchyParents(root){
  let repaired=0;const kidIndexes=new WeakMap();
  const kidsByName=node=>{
    let index=kidIndexes.get(node);
    if(!index){index=new Map();for(const child of node.kids.values())if(!index.has(tagKey(child.name)))index.set(tagKey(child.name),child);kidIndexes.set(node,index);}
    return index;
  };
  const merge=(target,source)=>{
    target.isId=!!(target.isId||source.isId);target.isLoad=!!(target.isLoad||source.isLoad);target.isInstrument=!!(target.isInstrument||source.isInstrument);
    for(const field of ['loadDependency','dependencyOverride','description','pmdKey','pmdPanel','pmdBuilding'])if(!target[field]&&source[field])target[field]=source[field];
    const index=kidsByName(target);
    for(const child of source.kids.values()){
      const key=tagKey(child.name),existing=index.get(key);
      if(existing&&existing!==child)merge(existing,child);
      else{target.kids.set(child.name,child);index.set(key,child);}
    }
    return target;
  };
  const walk=holder=>{
    const entries=[...holder.kids.entries()],canonical=new Map();
    for(const [,node] of entries)if(!mahClosestParent(node.name)&&!canonical.has(tagKey(node.name)))canonical.set(tagKey(node.name),node);
    for(const [key,node] of entries){
      const full=cleanTag(node.name),parent=mahClosestParent(full);
      if(parent&&node.kids.size&&tagKey(parent)!==tagKey(full)){
        const childNames=[...node.kids.values()].map(child=>child.name);
        for(const child of node.kids.values())child.dependencyOverride=full;
        holder.kids.delete(key);
        const parentKey=tagKey(parent),existing=canonical.get(parentKey);
        const target=existing&&existing!==node?merge(existing,node):node;
        if(!existing){node.name=parent;holder.kids.set(parent,node);canonical.set(parentKey,node);}
        for(const childName of childNames){
          const child=kidsByName(target).get(tagKey(childName));
          if(child)child.dependencyOverride=full;
        }
        repaired++;
      }
    }
    for(const node of holder.kids.values())walk(node);
  };
  walk(root);return repaired;
}
export function repairMahSsmRows(rows){
  const replacements=new Map();
  for(const row of rows){
    const full=cleanRegisterTag(row&&row[1]),parent=mahClosestParent(full);
    if(parent)replacements.set(tagKey(full),{full,parent});
  }
  return rows.map(row=>{
    const fixed=[...row],equipmentReplacement=replacements.get(tagKey(fixed[0]));
    if(equipmentReplacement)fixed[0]=equipmentReplacement.parent;
    const full=cleanRegisterTag(fixed[1]),parent=mahClosestParent(full);
    if(parent){fixed[1]=parent;fixed[2]=full;}
    return fixed;
  });
}
/* The root a mode requires, read from the profile. '602 Medium Voltage' is one
   site's system name and used to be compiled in here; it now lives in the
   example profile's electrical-flow mode like any other convention. */
export function rootPolicy(){
  const mode=activeModes(activeProfile()).find(item=>item.rootPolicy);
  return (mode&&mode.rootPolicy)||{requireRoot:'',fallbackParent:''};
}
export function profileWorkflow(){
  return activeProfile().hierarchy&&activeProfile().hierarchy.workflow||{};
}
export function systemRootName(){return clean(rootPolicy().requireRoot);}
export function isSystemName(value){const root=systemRootName();return !!root&&tagKey(value)===tagKey(root);}
export function placementKey(rec){return [rec.source,tagKey(rec.branchName),tagKey(rec.currentParent),tagKey(rec.suggestedParent),rec.status].join(KEYSEP);}
export function placementReviewSearchKey(rec){return [rec.branchName,rec.currentParent,rec.suggestedParent,rec.source,rec.reason].map(clean).join(' ').toLowerCase();}
export function activePlacements(){return S.placements.filter(rec=>!rec.resolved);}
export function registerPlacement(rec){
  const key=placementKey(rec),byKey=S._placementByKey||(S._placementByKey=new Map()),existing=byKey.get(key);
  if(existing){if(!existing.node&&rec.node)existing.node=rec.node;return existing;}
  const item={id:'place-'+(++S._placementId),resolved:false,...rec,key};
  item.searchKey=placementReviewSearchKey(item);
  if(item.node){item.node.placementId=item.id;item.node.placementStatus=item.status;}
  S.placements.push(item);byKey.set(key,item);return item;
}
export function rawOccurrences(root,value){
  const found=[],wanted=tagKey(value);
  const walk=(holder,path)=>{for(const [key,node] of holder.kids){const next=[...path,node.name];if(tagKey(node.name)===wanted)found.push({holder,key,node,path:next});walk(node,next);}};
  walk(root,[]);return found;
}
export function buildRawHierarchyIndex(root){
  const index={root,byName:new Map(),byParentName:new Map(),location:new Map()};
  const walk=holder=>{
    for(const [key,node] of holder.kids){
      const nameKey=tagKey(node.name),matches=index.byName.get(nameKey)||[];
      matches.push(node);index.byName.set(nameKey,matches);
      const parentKey=nameKey+KEYSEP+tagKey(holder.name),parentMatches=index.byParentName.get(parentKey)||[];
      parentMatches.push(node);index.byParentName.set(parentKey,parentMatches);
      index.location.set(node,{holder,key});walk(node);
    }
  };
  walk(root);return index;
}
export function indexedRawKidEntry(index,holder,value){
  for(const node of index.byName.get(tagKey(value))||[]){
    const location=index.location.get(node);
    if(location&&location.holder===holder)return [location.key,node];
  }
  return null;
}
export function indexedRawContains(index,root,target){
  let node=target;const seen=new Set();
  while(node&&!seen.has(node)){
    if(node===root)return true;
    if(node===index.root)return false;
    seen.add(node);const location=index.location.get(node);node=location&&location.holder;
  }
  return false;
}
export function indexedRawPath(index,node){
  const path=[],seen=new Set();
  while(node&&node!==index.root&&!seen.has(node)){
    seen.add(node);path.push(node.name);const location=index.location.get(node);node=location&&location.holder;
  }
  return path.reverse();
}
export function indexedRawOccurrences(index,value,includePath){
  const found=[];
  for(const node of index.byName.get(tagKey(value))||[]){
    const location=index.location.get(node);if(!location)continue;
    found.push({holder:location.holder,key:location.key,node,path:includePath?indexedRawPath(index,node):[]});
  }
  return found;
}
export function indexedRawOccurrence(index,value,parent,includePath){
  const nameKey=tagKey(value),parentKey=nameKey+KEYSEP+tagKey(parent);
  const preferred=index.byParentName.get(parentKey)||[],fallback=index.byName.get(nameKey)||[];
  for(const node of preferred.length?preferred:fallback){
    const location=index.location.get(node);if(!location)continue;
    return {holder:location.holder,key:location.key,node,path:includePath?indexedRawPath(index,node):[]};
  }
  return null;
}
export function indexedRawNode(index,value,blocked){
  for(const node of index.byName.get(tagKey(value))||[]){
    if(!index.location.has(node))continue;
    if(blocked&&(node===blocked||indexedRawContains(index,blocked,node)))continue;
    return node;
  }
  return null;
}
export function indexRawHierarchyNode(index,holder,key,node){
  const nameKey=tagKey(node.name),matches=index.byName.get(nameKey)||[];
  if(!matches.includes(node)){matches.push(node);index.byName.set(nameKey,matches);}
  const parentKey=nameKey+KEYSEP+tagKey(holder.name),parentMatches=index.byParentName.get(parentKey)||[];
  if(!parentMatches.includes(node)){parentMatches.push(node);index.byParentName.set(parentKey,parentMatches);}
  index.location.set(node,{holder,key});
}
export function mergeRawHierarchyNodeIndexed(index,target,source){
  target.isId=!!(target.isId||source.isId);target.isLoad=!!(target.isLoad||source.isLoad);target.isInstrument=!!(target.isInstrument||source.isInstrument);
  for(const field of ['loadDependency','dependencyOverride','description','pmdKey','pmdPanel','pmdBuilding'])if(!target[field]&&source[field])target[field]=source[field];
  for(const child of source.kids.values()){
    const existing=indexedRawKidEntry(index,target,child.name);
    if(existing&&existing[1]!==child)mergeRawHierarchyNodeIndexed(index,existing[1],child);
    else{target.kids.set(child.name,child);index.location.set(child,{holder:target,key:child.name});}
  }
  index.location.delete(source);return target;
}
/* The review flags raised while reading rows (a bridged downstream gap, a
   duplicate parent, a conflicting cable feed) describe equipment that has no
   display node yet -- some are raised before the tree exists at all. Registered
   as-is they produced an entry the drawer could do nothing with: no branch size,
   no candidate parents, no way to move the branch. Seeding them and binding once
   the tree is final gives each one its node, so Placement Review can act on it
   the same way it acts on a MEL suggestion. */
export function seedReviewFlag(rec){S._reviewFlagSeeds.push(rec);}
export function bindReviewFlagSeeds(root,index){
  if(!S._reviewFlagSeeds||!S._reviewFlagSeeds.length)return;
  index=index||buildRawHierarchyIndex(root);
  for(const seed of S._reviewFlagSeeds){
    const occurrence=indexedRawOccurrence(index,seed.branchName,seed.currentParent,true);
    registerPlacement({...seed,node:occurrence&&occurrence.node,path:occurrence?occurrence.path:[]});
  }
  S._reviewFlagSeeds=[];
}
export function bindMelPlacementSeeds(root,index){
  if(!S._melPlacementSeeds||!S._melPlacementSeeds.size)return;
  index=index||buildRawHierarchyIndex(root);
  for(const seed of S._melPlacementSeeds.values()){
    const expectedParent=seed.status==='suggested'?seed.suggestedParent:seed.currentParent;
    const occurrence=indexedRawOccurrence(index,seed.branchName,expectedParent,true);
    registerPlacement({...seed,node:occurrence&&occurrence.node,path:occurrence?occurrence.path:[],
      currentParent:occurrence?occurrence.holder.name:seed.currentParent});
  }
}
export function enforceSystemRoots(root,collect){
  const rootName=systemRootName();if(!rootName)return 0;
  if(!rawKidEntry(root.kids,rootName))return 0;
  let detached=0;
  for(const [key,node] of [...root.kids.entries()]){
    if(isSystemName(node.name))continue;
    root.kids.delete(key);
    if(collect!==false)registerPlacement({node,branchName:node.name,originalParent:'Top level',currentParent:'Unplaced',suggestedParent:'',status:'unplaced',source:'Hierarchy validation',
      reason:'Only System Names can be top-level hierarchy items',path:[node.name]});
    else{if(!root._detached)root._detached=new Map();root._detached.set(node.name,node);}
    detached++;
  }
  return detached;
}
export function repairEasyPowerHierarchyParents(root){
  let moved=0;
  const walk=holder=>{
    for(const [key,node] of [...holder.kids.entries()]){
      const parentName=melSyntheticParent(node.name);
      if(!parentName||tagKey(parentName)===tagKey(node.name)||tagKey(parentName)===tagKey(holder.name)){walk(node);continue;}
      let parentEntry=rawKidEntry(holder.kids,parentName),target=parentEntry&&parentEntry[1];
      if(!target){target={name:parentName,kids:new Map(),isId:false};holder.kids.set(parentName,target);}
      holder.kids.delete(key);
      const existing=rawKidEntry(target.kids,node.name),movedNode=existing?mergeRawHierarchyNode(existing[1],node):node;
      if(!existing)target.kids.set(node.name,node);
      moved++;walk(movedNode);
    }
  };
  if(hasMelData())walk(root);
  /* The fallback parent is now site-configurable, so it can itself classify as GIS;
     excluding it keeps it from being moved into itself and cycling the tree. */
  const fallbackParent=clean(rootPolicy().fallbackParent);
  const gisRoots=fallbackParent?[...root.kids.entries()].filter(([,node])=>isGisTag(node.name)&&tagKey(node.name)!==tagKey(fallbackParent)):[];
  if(gisRoots.length){
    let parentEntry=rawKidEntry(root.kids,fallbackParent),target=parentEntry&&parentEntry[1];
    if(!target){target={name:fallbackParent,kids:new Map(),isId:false};root.kids.set(fallbackParent,target);}
    for(const [key,node] of gisRoots){
      root.kids.delete(key);const existing=rawKidEntry(target.kids,node.name);
      if(existing)mergeRawHierarchyNode(existing[1],node);else target.kids.set(node.name,node);moved++;
    }
  }
  return moved;
}
export function melLvsDescendants(transformer){
  const found=[];
  const walk=holder=>{
    for(const [key,node] of [...holder.kids.entries()]){
      if(hasEquipmentRole(node.name,'XFM'))continue;
      if(hasEquipmentRole(node.name,'LVS')){found.push({holder,key,node});continue;}
      walk(node);
    }
  };
  walk(transformer);return found;
}
export function repairMelTransformerBranches(root){
  if(!hasMelData())return 0;
  let moved=0;
  const visit=container=>{
    const transformers=[...container.kids.values()].filter(node=>hasEquipmentRole(node.name,'XFM'));
    for(const transformer of transformers){
      for(const {holder,key:childKey,node:child} of melLvsDescendants(transformer)){
        const corrected=melCorrectClosestParent(child.name,transformer.name);
        if(tagKey(corrected)===tagKey(transformer.name))continue;
        let targetEntry=rawKidEntry(container.kids,corrected),target=targetEntry&&targetEntry[1];
        if(!target){target={name:corrected,kids:new Map(),isId:false};container.kids.set(corrected,target);}
        holder.kids.delete(childKey);
        const existing=rawKidEntry(target.kids,child.name);
        if(existing)mergeRawHierarchyNode(existing[1],child);else target.kids.set(child.name,child);
        moved++;
      }
    }
    for(const node of [...container.kids.values()])visit(node);
  };
  visit(root);return moved;
}
export function ssmAncestorByRole(row,byEquipment,role){
  let name=cleanTag(row&&row[1]),seen=new Set();
  while(name&&!seen.has(tagKey(name))){
    const key=tagKey(name);seen.add(key);
    if(hasEquipmentRole(name,role))return name;
    const parentRow=byEquipment.get(key);name=cleanTag(parentRow&&parentRow[1]);
  }
  return '';
}
export function repairMelSsmRows(rows){
  if(!S.melByTag.size)return rows;
  const byEquipment=new Map();for(const row of rows){const key=tagKey(row&&row[0]);if(key&&!byEquipment.has(key))byEquipment.set(key,row);}
  const emitted=new Set(),out=[];
  for(const row of rows){
    const equip=cleanTag(row&&row[0]),parent=cleanTag(row&&row[1]);
    const transformer=hasEquipmentRole(parent,'XFM')?parent:(hasEquipmentRole(equip,'LVS')?ssmAncestorByRole(row,byEquipment,'XFM'):'');
    const corrected=transformer?melCorrectClosestParent(equip,transformer):parent;
    if(transformer&&tagKey(corrected)!==tagKey(transformer)){
      const correctedKey=tagKey(corrected);
      if(!emitted.has(correctedKey)){
        const existing=byEquipment.get(correctedKey),sourceParent=byEquipment.get(tagKey(transformer));
        out.push(existing?[...existing]:[corrected,sourceParent?cleanTag(sourceParent[1]):'']);emitted.add(correctedKey);
      }
      const fixed=[...row];fixed[1]=corrected;
      if(fixed[2]!=null&&(tagKey(fixed[2])===tagKey(parent)||tagKey(fixed[2])===tagKey(transformer)))fixed[2]=corrected;
      out.push(fixed);emitted.add(tagKey(equip));continue;
    }
    out.push(row);emitted.add(tagKey(equip));
  }
  return out;
}
export function repairEasyPowerSsmRows(rows){
  const byEquipment=new Map();for(const row of rows){const key=tagKey(row&&row[0]);if(key&&!byEquipment.has(key))byEquipment.set(key,row);}
  const emitted=new Set(),out=[];
  for(const row of rows){
    const equip=cleanTag(row&&row[0]),parent=cleanTag(row&&row[1]);
    const parentName=melSyntheticParent(equip)||(!parent&&isGisTag(equip)?clean(rootPolicy().fallbackParent):'');
    if(parentName&&tagKey(parentName)!==tagKey(equip)&&tagKey(parentName)!==tagKey(parent)){
      const parentKey=tagKey(parentName);
      if(!emitted.has(parentKey)){const existing=byEquipment.get(parentKey);out.push(existing?[...existing]:[parentName,parent]);emitted.add(parentKey);}
      const fixed=[...row];fixed[1]=parentName;out.push(fixed);emitted.add(tagKey(equip));continue;
    }
    out.push(row);emitted.add(tagKey(equip));
  }
  return out;
}
export function buildCableParentPlan(rows){
  if(!S.hasCable&&!S.deps.size)return {relations:new Map(),seeds:new Set(),generated:new Set(),unresolved:[]};
  const existing=new Map();
  for(const row of rows){const key=tagKey(row&&row[0]);if(key&&!existing.has(key))existing.set(key,row);}
  const candidates=[],resolved=[],relations=new Map(),seeds=new Set(),generated=new Set(),unresolved=[];
  for(const row of rows){
    const equip=cleanTag(row&&row[0]),parent=cleanTag(row&&row[1]);
    const dependency=row&&row[2]!=null?cleanTag(row[2]):depOf(equip);
    const cableParent=depOf(equip),seedKey=tagKey(equip);
    if(!equip||!parent||!dependency||tagKey(parent)!==tagKey(dependency)||!cableParent||tagKey(cableParent)===tagKey(parent))continue;
    candidates.push({equip,parent,cableParent,seedKey});
  }
  for(const {equip,parent,cableParent,seedKey} of candidates){
    const local=[{equip,parent:cableParent,generated:false}],seen=new Set([seedKey]);
    let cursor=cableParent,cyclic=false,anchored=false;
    while(cursor){
      const cursorKey=tagKey(cursor);
      if(seen.has(cursorKey)){cyclic=true;break;}
      seen.add(cursorKey);
      if(cursorKey===tagKey(parent)||existing.has(cursorKey)){anchored=true;break;}
      const upstream=depOf(cursor);
      local.push({equip:cursor,parent:upstream,generated:true});
      if(!upstream)break;
      cursor=upstream;
    }
    if(cyclic||!anchored){unresolved.push({branchName:equip,currentParent:parent,suggestedParent:cableParent,status:'unplaced',source:'Cable Schedule',
      reason:cyclic?'Cable Schedule parent chain contains a cycle':'Cable Schedule parent chain does not connect to the existing hierarchy',chain:local.map(item=>item.equip)});continue;}
    resolved.push({seedKey,local});
  }
  for(const candidate of resolved){
    seeds.add(candidate.seedKey);
    for(const relation of candidate.local){
      const key=tagKey(relation.equip);if(relations.has(key))continue;
      relations.set(key,{equip:relation.equip,parent:relation.parent});
      if(relation.generated)generated.add(key);
    }
  }
  return {relations,seeds,generated,unresolved};
}
export function registerCablePlacementIssues(root,plan){
  if(!plan||!plan.unresolved.length)return;
  const index=buildRawHierarchyIndex(root);
  for(const issue of (plan&&plan.unresolved)||[]){
    const occurrence=indexedRawOccurrence(index,issue.branchName,issue.currentParent,true);
    registerPlacement({...issue,node:occurrence&&occurrence.node,path:occurrence?occurrence.path:[]});
  }
}
export function cablePlannedParents(plan,equipment){
  const names=[],seen=new Set();let relation=plan.relations.get(tagKey(equipment));
  while(relation&&relation.parent){
    const key=tagKey(relation.parent);if(seen.has(key))break;
    seen.add(key);names.push(relation.parent);relation=plan.relations.get(key);
  }
  return names;
}
export function findRawHierarchyNode(holder,value,blocked){
  const key=tagKey(value);
  for(const node of holder.kids.values()){
    if(node===blocked)continue;
    if(tagKey(node.name)===key)return node;
    const found=findRawHierarchyNode(node,value,blocked);if(found)return found;
  }
  return null;
}
export function ensureRawHierarchyChild(holder,name){
  const existing=rawKidEntry(holder.kids,name);if(existing)return existing[1];
  const node={name,kids:new Map(),isId:false};holder.kids.set(name,node);return node;
}
export function repairCableHierarchyParents(root,plan){
  if(!plan||!plan.seeds.size)return 0;
  const index=buildRawHierarchyIndex(root),occurrences=[];
  const depthOf=node=>{let depth=0,current=node,seen=new Set();while(current&&current!==root&&!seen.has(current)){seen.add(current);const location=index.location.get(current);if(!location)break;current=location.holder;depth++;}return depth;};
  for(const seed of plan.seeds)for(const node of index.byName.get(seed)||[])if(index.location.has(node))occurrences.push({node,depth:depthOf(node)});
  occurrences.sort((a,b)=>b.depth-a.depth);
  let moved=0;
  for(const occurrence of occurrences){
    const live=index.location.get(occurrence.node);if(!live)continue;
    const relation=plan.relations.get(tagKey(occurrence.node.name)),chain=cablePlannedParents(plan,occurrence.node.name);
    if(!relation||!chain.length||tagKey(live.holder.name)===tagKey(relation.parent))continue;
    const local=[];let cursor=live.holder;
    while(cursor){local.push(cursor);if(cursor===root)break;const location=index.location.get(cursor);cursor=location&&location.holder;}
    let anchor=null,anchorIndex=-1;
    for(let i=0;i<chain.length&&!anchor;i++)for(const candidate of local)if(tagKey(candidate.name)===tagKey(chain[i])){anchor=candidate;anchorIndex=i;break;}
    if(!anchor){
      for(let i=0;i<chain.length;i++){
        const found=indexedRawNode(index,chain[i],occurrence.node);
        if(found){anchor=found;anchorIndex=i;break;}
      }
    }
    if(!anchor)continue;
    live.holder.kids.delete(live.key);
    let target=anchor;
    for(let i=anchorIndex-1;i>=0;i--){
      const existing=indexedRawKidEntry(index,target,chain[i]);
      if(existing)target=existing[1];
      else{const node={name:chain[i],kids:new Map(),isId:false};target.kids.set(chain[i],node);indexRawHierarchyNode(index,target,chain[i],node);target=node;}
    }
    if(occurrence.node.isLoad)occurrence.node.loadDependency=relation.parent;
    const duplicate=indexedRawKidEntry(index,target,occurrence.node.name);
    if(duplicate&&duplicate[1]!==occurrence.node)mergeRawHierarchyNodeIndexed(index,duplicate[1],occurrence.node);
    else{target.kids.set(occurrence.node.name,occurrence.node);index.location.set(occurrence.node,{holder:target,key:occurrence.node.name});}
    moved++;
  }
  return moved;
}
export function cablePlannedSsmRow(relation,row){
  const fixed=row?[...row]:[relation.equip,'',''];fixed[0]=row?row[0]:relation.equip;fixed[1]=relation.parent;fixed[2]=relation.parent;
  if(relation.parent){const meta=fixed[3]&&typeof fixed[3]==='object'?{...fixed[3]}:{};meta.keepDuplicateDep=true;fixed[3]=meta;}
  return fixed;
}
export function repairCableSsmRows(rows,plan){
  if(!plan||!plan.seeds.size)return rows;
  const out=[],emittedGenerated=new Set();
  const emitGenerated=key=>{
    if(!plan.generated.has(key)||emittedGenerated.has(key))return;
    const relation=plan.relations.get(key);if(!relation)return;
    const parentKey=tagKey(relation.parent);if(parentKey)emitGenerated(parentKey);
    out.push(cablePlannedSsmRow(relation,null));emittedGenerated.add(key);
  };
  for(const row of rows){
    const key=tagKey(row&&row[0]),relation=plan.relations.get(key);
    if(plan.seeds.has(key)&&relation){emitGenerated(tagKey(relation.parent));out.push(cablePlannedSsmRow(relation,row));}
    else out.push(row);
  }
  for(const key of plan.generated)emitGenerated(key);
  return out;
}
export function melUpnKey(value){return clean(value).replace(/\s+/g,'').toLowerCase();}
export function recordMelSystemParentCheck(plan,check){
  const key=tagKey(check.equip),rank={corrected:4,warning:3,matched:2,'not-found':1},existing=plan.checks.get(key);
  if(!key||existing&&(rank[existing.status]||0)>(rank[check.status]||0))return;
  plan.checks.set(key,check);
}
export function addMelSystemParentWarning(plan,warning){
  const key=[tagKey(warning.equip),tagKey(warning.currentParent),warning.missingField,warning.reason].join(KEYSEP);
  if(plan._warningKeys.has(key))return;
  plan._warningKeys.add(key);plan.warnings.push(warning);recordMelSystemParentCheck(plan,{...warning,status:'warning'});
}
export function buildMelSystemParentPlan(rows){
  const corrections=new Map(),warnings=[],plan={corrections,warnings,checks:new Map(),_warningKeys:new Set()};
  if(!hasMelData())return plan;
  const byEquipment=new Map();for(const row of rows){const key=tagKey(row&&row[0]);if(key&&!byEquipment.has(key))byEquipment.set(key,row);}
  for(const row of rows){
    const equip=cleanTag(row&&row[0]),key=tagKey(equip),currentParent=cleanTag(row&&row[1]);
    if(!equip||!currentParent||isSystemName(currentParent)||corrections.has(key))continue;
    const equipmentLookup=melTagLookup(equip),equipmentMel=equipmentLookup.record;
    if(!equipmentMel){
      if(equipmentLookup.candidates.length>1){
        addMelSystemParentWarning(plan,{equip,currentParent,missingField:'Unique Equipment Tag match',
          reason:`MEL parent check skipped because ${equip} matched multiple MEL Equipment Tags`});continue;
      }
      recordMelSystemParentCheck(plan,{equip,currentParent,status:'not-found',reason:`${equip} was not found in the MEL Equipment Tag column`});continue;
    }
    const equipmentUpn=clean(equipmentMel.upn);
    if(!equipmentUpn){
      addMelSystemParentWarning(plan,{equip,currentParent,missingField:'Equipment UPN',reason:`MEL parent check skipped because ${equip} has no UPN`});continue;
    }
    const parentLookup=melTagLookup(currentParent),parentMel=parentLookup.record,parentUpn=clean(parentMel&&parentMel.upn);
    if(!parentMel){
      if(parentLookup.candidates.length>1){
        addMelSystemParentWarning(plan,{equip,currentParent,missingField:'Unique Closest Parent MEL match',
          reason:`MEL parent check skipped because ${currentParent} matched multiple MEL Equipment Tags`});continue;
      }
      addMelSystemParentWarning(plan,{equip,currentParent,missingField:'Closest Parent MEL record',reason:`MEL parent check skipped because ${currentParent} was not found in the MEL`});continue;
    }
    if(!parentUpn){
      addMelSystemParentWarning(plan,{equip,currentParent,missingField:'Closest Parent UPN',reason:`MEL parent check skipped because ${currentParent} has no UPN`});continue;
    }
    if(melUpnKey(equipmentUpn)===melUpnKey(parentUpn)){
      recordMelSystemParentCheck(plan,{equip,currentParent,status:'matched',equipmentUpn,parentUpn,equipmentMelTag:equipmentMel.tag,parentMelTag:parentMel.tag,reason:'Equipment and Closest Parent UPNs match'});continue;
    }
    const newParent=firstSystemParentTag(equipmentMel.systemParent);
    if(!newParent){
      addMelSystemParentWarning(plan,{equip,currentParent,missingField:'System Parent Equipment Tag(s)',reason:`UPNs differ, but ${equip} has no System Parent Equipment Tag`});continue;
    }
    if(tagKey(newParent)===key){
      addMelSystemParentWarning(plan,{equip,currentParent,missingField:'Valid System Parent Equipment Tag',reason:`UPNs differ, but ${equip}'s System Parent would create a hierarchy cycle`});continue;
    }
    if(tagKey(newParent)===tagKey(currentParent)){
      addMelSystemParentWarning(plan,{equip,currentParent,missingField:'Consistent System Parent Equipment Tag',reason:`UPNs differ, but ${equip}'s System Parent repeats its current Closest Parent`});continue;
    }
    const parentRow=byEquipment.get(tagKey(currentParent));
    corrections.set(key,{equip,currentParent,newParent,sourceParent:cleanTag(parentRow&&parentRow[1]),equipmentUpn,parentUpn,equipmentMelTag:equipmentMel.tag,parentMelTag:parentMel.tag});
  }
  return plan;
}
export function repairMelSystemParentHierarchy(root,plan){
  if(!plan||!plan.corrections.size)return 0;
  const index=buildRawHierarchyIndex(root);let moved=0;
  for(const [correctionKey,correction] of plan.corrections){
    const occurrences=indexedRawOccurrences(index,correction.equip,false);
    if(!occurrences.length){
      addMelSystemParentWarning(plan,{equip:correction.equip,currentParent:correction.currentParent,missingField:'Hierarchy branch',
        reason:`UPNs differ, but ${correction.equip} was not available for a safe hierarchy move`});
      plan.corrections.delete(correctionKey);continue;
    }
    const basis=occurrences.find(hit=>tagKey(hit.holder.name)===tagKey(correction.currentParent))||occurrences[0];
    const currentParentNode=tagKey(basis.holder.name)===tagKey(correction.currentParent)?basis.holder:indexedRawNode(index,correction.currentParent,basis.node);
    const parentLocation=currentParentNode&&index.location.get(currentParentNode),container=parentLocation?parentLocation.holder:root;
    let targetEntry=indexedRawKidEntry(index,container,correction.newParent),target=targetEntry&&targetEntry[1],targetCreated=false;
    if(!target)target=indexedRawNode(index,correction.newParent,basis.node);
    if(!target){
      target={name:correction.newParent,kids:new Map(),isId:false};container.kids.set(correction.newParent,target);
      indexRawHierarchyNode(index,container,correction.newParent,target);targetCreated=true;
    }
    if(indexedRawContains(index,basis.node,target)){
      addMelSystemParentWarning(plan,{equip:correction.equip,currentParent:correction.currentParent,missingField:'Valid System Parent placement',
        reason:`UPNs differ, but moving ${correction.equip} under ${correction.newParent} would create a hierarchy cycle`});
      plan.corrections.delete(correctionKey);continue;
    }
    let applied=false;
    for(const occurrence of occurrences){
      const live=index.location.get(occurrence.node);if(!live||occurrence.node===target||indexedRawContains(index,occurrence.node,target))continue;
      if(live.holder===target){occurrence.node.dependencyOverride=correction.currentParent;applied=true;continue;}
      live.holder.kids.delete(live.key);
      const duplicate=indexedRawKidEntry(index,target,occurrence.node.name);
      const movedNode=duplicate&&duplicate[1]!==occurrence.node?mergeRawHierarchyNodeIndexed(index,duplicate[1],occurrence.node):occurrence.node;
      movedNode.dependencyOverride=correction.currentParent;
      if(!duplicate){target.kids.set(occurrence.node.name,occurrence.node);index.location.set(occurrence.node,{holder:target,key:occurrence.node.name});}
      moved++;applied=true;
    }
    if(!applied){
      if(targetCreated&&!target.kids.size){
        const created=indexedRawKidEntry(index,container,correction.newParent);
        if(created&&created[1]===target){container.kids.delete(created[0]);index.location.delete(target);}
      }
      addMelSystemParentWarning(plan,{equip:correction.equip,currentParent:correction.currentParent,missingField:'Valid System Parent placement',
        reason:`UPNs differ, but ${correction.equip} could not be moved under ${correction.newParent} safely`});
      plan.corrections.delete(correctionKey);
    }else{
      recordMelSystemParentCheck(plan,{...correction,status:'corrected',reason:`Closest Parent changed from ${correction.currentParent} to ${correction.newParent}; the previous parent is now the Dependency`});
    }
  }
  return moved;
}
export function repairMelSystemParentSsmRows(rows,plan){
  if(!plan||!plan.corrections.size)return rows;
  const existing=new Set(rows.map(row=>tagKey(row&&row[0])).filter(Boolean)),emittedParents=new Set(),out=[];
  for(const row of rows){
    const correction=plan.corrections.get(tagKey(row&&row[0]));
    if(!correction){out.push(row);continue;}
    const parentKey=tagKey(correction.newParent);
    if(!existing.has(parentKey)&&!emittedParents.has(parentKey)){out.push([correction.newParent,correction.sourceParent]);emittedParents.add(parentKey);}
    const fixed=[...row];fixed[1]=correction.newParent;fixed[2]=correction.currentParent;
    if(fixed[3]&&typeof fixed[3]==='object'){const meta={...fixed[3]};delete meta.keepDuplicateDep;if(Object.keys(meta).length)fixed[3]=meta;else fixed.length=3;}
    out.push(fixed);
  }
  return out;
}
export function registerMelSystemParentIssues(root,plan,index){
  const warnings=(plan&&plan.warnings)||[];if(!warnings.length)return;
  index=index||buildRawHierarchyIndex(root);
  for(const warning of warnings){
    const occurrence=indexedRawOccurrence(index,warning.equip,warning.currentParent,true);
    registerPlacement({node:occurrence&&occurrence.node,branchName:warning.equip,originalParent:warning.currentParent,currentParent:occurrence?occurrence.holder.name:warning.currentParent,
      suggestedParent:'',status:'missing-data',source:'Master Equipment List',reason:warning.reason,missingField:warning.missingField,path:occurrence?occurrence.path:[]});
  }
}
export async function buildDeps(tick){
  S.deps=new Map();S.depDetail=new Map();S.hasCable=false;
  /* Extra Panel (From) values for a load whose first one already won. cleanTag
     strips panel sides, so 'PNL-1-A' fed from SWBD-2 and 'PNL-1-B' fed from
     SWBD-3 collapse onto one key and the second feed was dropped in silence.

     Only reported here, not merged into S.deps. The design calls for
     dependencies to be a set rendered semicolon-separated, but S.deps currently
     serves two different roles: the dependency shown in the register AND a
     single parent tag that the cable parent-chain repair walks upward
     (`cursor=depOf(cursor)`, this file, and projection.js's cableParent).
     Joining the values would feed "SWBD-2; SWBD-3" into that walk as if it were
     a tag name. Splitting parent from dependency-set is the P3 modes work; this
     stops the loss being invisible in the meantime. */
  const feedConflicts=new Map();
  for(const key of S.cableSel){
    const [fid]=key.split(KEYSEP);if(!fileById(fid))continue;
    const ci=cableInfo(key);if(!ci)continue; // named "Cable Schedule" but no Load/Panel columns -> nothing to attach
    const {map,headerRow}=ci;
    S.hasCable=true;
    const rec=getAoa(key),{aoa}=rec;
    const loadC=map['Load Name (To)'],panelC=map['Panel (From)'],ents=Object.entries(map);
    for(let i=headerRow+1;i<aoa.length;i++){
      if(tick){const pending=tick('Reading cable schedule');if(pending)await pending;}
      const row=aoa[i],load=rowTag(row,loadC,rec,i);if(!load)continue;
      const lk=load.toLowerCase(),panel=rowTag(row,panelC,rec,i);
      if(cellIsStruck(rec,i,loadC))S.cableStruckTags.add(tagKey(load));
      if(panel&&cellIsStruck(rec,i,panelC))S.cableStruckTags.add(tagKey(panel));
      if(panel){
        const kept=S.deps.get(lk);
        if(!kept)S.deps.set(lk,panel);
        else if(tagKey(kept)!==tagKey(panel)){
          let rec=feedConflicts.get(lk);
          if(!rec){rec={load,kept,others:[]};feedConflicts.set(lk,rec);}
          if(!rec.others.some(other=>tagKey(other)===tagKey(panel)))rec.others.push(panel);
        }
      }
      if(!S.depDetail.has(lk)){
        const fields={};for(const [label,idx] of ents)fields[label]=(label==='Load Name (To)'||label==='Panel (From)')?cleanTag(row[idx]):clean(row[idx]);
        S.depDetail.set(lk,fields);
      }
    }
  }
  if(activeProfile().hierarchy.cableConflictPolicy==='first-review'){
    for(const rec of feedConflicts.values()){
      seedReviewFlag({branchName:rec.load,originalParent:rec.kept,currentParent:rec.kept,suggestedParent:'',
        status:'cable-conflict',source:'Cable Schedule',
        reason:'Also fed from '+rec.others.map(name=>'"'+name+'"').join(', ')+' - only the first Panel (From) is used'});
    }
  }
}
export async function buildPmd(tick){
  S.pmdRows=[];S.pmdPanels=[];S.pmdLinks=[];S.pmdPanelMap=new Map();S.pmdSuffixMap=new Map();S.pmdDetail=new Map();S.pmdMatchedPanels=new Set();
  const seen=new Set();
  for(const key of S.pmdSel){
    const [fid]=key.split(KEYSEP);if(!fileById(fid))continue;
    const pi=pmdInfo(key);if(!pi)continue;
    const {map,headerRow}=pi,{aoa}=getAoa(key);
    for(let i=headerRow+1;i<aoa.length;i++){
      if(tick){const pending=tick('Reading Point Master Database');if(pending)await pending;}
      const row=aoa[i],panel=cleanTag(row[map.PANEL]),tag=cleanTag(row[map['INSTRUMENT TAG']]);
      if(!panel||!tag)continue;
      const parts=pmdPanelMatchParts(panel),panelKey=parts.key;if(!panelKey)continue;
      const recKey=panelKey+KEYSEP+tag.toLowerCase();if(seen.has(recKey))continue;seen.add(recKey);
      const fields={};for(const [label] of PMD_FIELDS)if(map[label]!=null)fields[label]=clean(row[map[label]]);
      const rec={key:recKey,panel,panelKey,tag,description:fields.DESCRIPTION||'',fields};
      S.pmdRows.push(rec);S.pmdDetail.set(recKey,rec);
      let group=S.pmdPanelMap.get(panelKey);
      if(!group){
        group={key:panelKey,panel,building:parts.building,matchKey:parts.matchKey,instruments:[]};S.pmdPanelMap.set(panelKey,group);
        if(group.matchKey&&group.matchKey!==group.key){const matches=S.pmdSuffixMap.get(group.matchKey)||[];matches.push(group);S.pmdSuffixMap.set(group.matchKey,matches);}
      }
      group.instruments.push(rec);
    }
  }
  S.pmdPanels=[...S.pmdPanelMap.values()].sort((a,b)=>natCmp(a.panel,b.panel));
  for(const panel of S.pmdPanels)panel.instruments.sort((a,b)=>natCmp(a.tag,b.tag));
}
export function pmdPanelsForLoad(value){
  const key=pmdPanelKey(value),exact=S.pmdPanelMap.get(key);
  return exact?[{panel:exact,building:''}]:(S.pmdSuffixMap.get(key)||[]).map(panel=>({panel,building:panel.building||''}));
}
export function _attachPmdInstruments(root,collect){
  if(!S.pmdPanels.length)return 0;
  let attached=0;const linkSeen=new Set();
  const walk=m=>{
    const originalKids=[...m.kids.values()];
    if(m.isLoad){
      const matches=pmdPanelsForLoad(m.name);
      if(matches.length){
        m.pmdPanel=[...new Set(matches.map(match=>match.panel.panel))].join(', ');
        m.pmdBuilding=[...new Set(matches.map(match=>match.building).filter(Boolean))].join(', ');
        for(const match of matches){
          const {panel,building}=match;S.pmdMatchedPanels.add(panel.key);
          for(const rec of panel.instruments){
            if(!m.kids.has(rec.tag))m.kids.set(rec.tag,{name:rec.tag,kids:new Map(),isId:false,isInstrument:true,description:rec.description,pmdKey:rec.key,pmdPanel:panel.panel,pmdBuilding:building});
            attached++;
          }
          if(collect){
            const loadKey=cleanTag(m.name).toLowerCase(),linkKey=loadKey+KEYSEP+panel.key;
            if(!linkSeen.has(linkKey)){linkSeen.add(linkKey);collect.push({panel:panel.panel,pmdPanel:panel.panel,panelKey:panel.key,building,loadName:m.name,loadKey,instruments:panel.instruments});}
          }
        }
      }
    }
    originalKids.forEach(walk);
  };
  walk(root);return attached;
}
export function attachPmdInstruments(root){
  const links=[];S.pmdMatchedPanels=new Set();
  if(!S.pmdPanels.length){S.pmdLinks=links;return 0;}
  const attached=_attachPmdInstruments(root,links);S.pmdLinks=links;return attached;
}
export function pmdExportTag(value,building){
  const tag=cleanTag(value),prefix=clean(building);
  return prefix&&tag.toLowerCase().startsWith((prefix+'-').toLowerCase())?tag.slice(prefix.length+1):tag;
}
export function appendPmdSsmRows(rows,includeUnmatched){
  if(!S.pmdPanels.length)return rows;
  const rowKeys=new Set(rows.map(r=>cleanTag(r[0]).toLowerCase()));
  const links=S.pmdLinks.filter(link=>includeUnmatched||rowKeys.has(link.loadKey));
  if(includeUnmatched){
    for(const panel of S.pmdPanels){
      if(S.pmdMatchedPanels.has(panel.key))continue;
      links.push({panel:panel.panel,building:'',loadName:panel.panel,loadKey:cleanTag(panel.panel).toLowerCase(),instruments:panel.instruments});
    }
  }
  if(!links.length)return rows;
  const linkKeys=new Set(links.map(link=>link.loadKey)),existingRows=new Map(),base=[];
  for(const row of rows){
    const key=cleanTag(row[0]).toLowerCase();
    if(linkKeys.has(key)&&row[2]!=null){if(!existingRows.has(key))existingRows.set(key,row);continue;}
    base.push(row);
  }
  const out=[...base];
  for(const link of links){const row=existingRows.get(link.loadKey);out.push(row?[link.loadName,...row.slice(1)]:[link.loadName,'',depOf(link.loadName)||depOf(link.panel)||'']);}
  for(const link of links)for(const rec of link.instruments)out.push([pmdExportTag(rec.tag,link.building),link.loadName,'']);
  return out;
}
/* Eagle keeps the frozen register's first row per tag. Modern profiles replace
   an earlier blank-parent row with a later stated parent, avoiding row-order data
   loss while retaining genuine roots whose parent is always blank. */
export function uniqueSsmRows(rows){
  const policy=activeProfile().hierarchy&&activeProfile().hierarchy.duplicateRegisterPolicy||'prefer-parent';
  if(policy==='first'){
    const seen=new Set(),out=[];
    for(const row of rows){const key=tagKey(row&&row[0]);if(!key||seen.has(key))continue;seen.add(key);out.push(row);}
    return out;
  }
  const at=new Map(),out=[];
  for(const row of rows){
    const key=tagKey(row&&row[0]);if(!key)continue;
    const index=at.get(key);
    if(index===undefined){at.set(key,out.length);out.push(row);continue;}
    if(!clean(out[index][1])&&clean(row[1]))out[index]=row;
  }
  return out;
}
/* uniqueSsmRows keeps the FIRST row for a tag and silently drops the rest, so a
   tag that arrived under two different parents loses one, order-dependently,
   with nothing to show for it. The kept parent stays kept -- choosing a
   different winner would be a guess, and the register must stay a strict tree --
   but the conflict is surfaced in Placement Review instead of vanishing.

   A row whose parent is empty is the top of its own path, not a competing
   claim, so it is not treated as a conflicting parent: a tag legitimately
   appears as a Starting Source in one row and downstream in another. */
export function collectDuplicateRegisterParents(rows){
  const byTag=new Map();
  for(const row of rows){
    const key=tagKey(row&&row[0]);if(!key)continue;
    const parent=clean(row[1]||'');
    let rec=byTag.get(key);
    if(!rec){rec={equip:row[0],kept:parent,others:[]};byTag.set(key,rec);continue;}
    if(!parent||!rec.kept||tagKey(parent)===tagKey(rec.kept))continue;
    if(!rec.others.some(other=>tagKey(other)===tagKey(parent)))rec.others.push(parent);
  }
  return [...byTag.values()].filter(rec=>rec.others.length);
}
export function flagDuplicateRegisterParents(rows){
  const conflicts=collectDuplicateRegisterParents(rows);
  for(const rec of conflicts){
    seedReviewFlag({branchName:rec.equip,originalParent:rec.kept,currentParent:rec.kept,suggestedParent:'',
      status:'duplicate-parent',source:'Register',
      reason:'Also listed under '+rec.others.map(name=>'"'+name+'"').join(', ')+' - the first parent was kept'});
  }
  return conflicts.length;
}
export async function buildHierarchy(expectedProfileRevision=S.profileBuildRevision){
  const keys=[...S.selected];if(!keys.length)return;
  const previous={...S};
  const superseded=()=>{
    if(expectedProfileRevision!==S.profileBuildRevision){const error=new Error('Profile changed during hierarchy build');error.code='profile_build_superseded';throw error;}
  };
  try{
    clearResultCache();
    await withLoading('Building hierarchy',keys.length+' tab'+(keys.length!==1?'s':''),async(report)=>{
    resetYield();
    // weight progress by actual rows so the bar tracks reality on big datasets
    const rowsIn=key=>{const {aoa,headerRow}=getAoa(key);return Math.max(0,aoa.length-headerRow-1);};
    let cableRows=0;for(const k of S.cableSel)if(cableInfo(k)){cableRows+=Math.max(0,(getAoa(k).aoa.length)-(cableInfo(k).headerRow)-1);}
    let pmdRows=0;for(const k of S.pmdSel)if(pmdInfo(k)){pmdRows+=Math.max(0,getAoa(k).aoa.length-pmdInfo(k).headerRow-1);}
    let melRows=0;for(const k of S.melSel)if(melInfo(k)){melRows+=Math.max(0,getAoa(k).aoa.length-melInfo(k).headerRow-1);}
    let hierRows=0;for(const k of keys)hierRows+=rowsIn(k);
    const total=Math.max(1,cableRows+pmdRows+melRows+hierRows*2);let done=0;
    const READ_LO=.03,READ_HI=.74;
    const tick=label=>{
      done++;
      if((done&127)!==0&&performance.now()-_yT<=28)return null;
      return maybeYield(report,READ_LO+(READ_HI-READ_LO)*(done/total),label);
    };

    report(.02,'Reading source data');await raf();
    S.cableStruckTags=new Set();S.placements=[];S._placementByKey=new Map();S._placementId=0;S._melPlacementSeeds=new Map();S._reviewFlagSeeds=[];S.placementScrollTop=0;S.lastPlacementMove=null;
    resetSourceParentClaims();
    const loadTags=await collectLoadDescriptionTags(keys,tick);
    await buildMel(tick);
    await buildDeps(tick);
    await buildPmd(tick);
    S.epDetail=new Map();S.melParentChecks=new Map();
    const combined={name:'__root__',kids:new Map()};let rowsRead=0,loadCount=0;
    const seenC=new Set(),ssmCombined=[],sheets=[];
    /* One spelling per tag identity, first occurrence wins.
       tagKey (lowercased) is the identity the register dedupe, the MEL index and
       the working-copy comparison all use. The tree and the SSM path accumulator
       were the outliers: insertPath keys children by the raw string and `acc`
       joins raw segments, so 'MCC-1' and 'mcc-1' became two tree nodes AND two
       pushed rows -- which uniqueSsmRows, which does use tagKey, then collapsed
       to one. Canonicalising the spelling here fixes all three together and
       keeps every count derived from the tree in agreement with the register. */
    const spellings=new Map(),mergeCaseVariants=activeProfile().hierarchy&&activeProfile().hierarchy.caseVariantPolicy!=='preserve';
    const canonSpelling=value=>{
      if(!mergeCaseVariants)return value;
      const key=tagKey(value);if(!key)return value;
      const first=spellings.get(key);if(first!==undefined)return first;
      spellings.set(key,value);return value;
    };
    const noteEP=(name,circuit)=>{const k=clean(name).toLowerCase();if(!k)return;const e=S.epDetail.get(k)||{};if(circuit&&e.circuit==null)e.circuit=circuit;S.epDetail.set(k,e);};
    for(let t=0;t<keys.length;t++){
      const key=keys[t];
      const [fid,sheetName]=key.split(KEYSEP);
      const rec=getAoa(key),{aoa,headerRow}=rec,cols=resolveCols(key);
      const label=`Tab ${t+1} of ${keys.length}`;
      const sMap={name:'__root__',kids:new Map()};
      const seenS=new Set(),ssmRows=[];
      for(let i=headerRow+1;i<aoa.length;i++){
        const pending=tick(label);if(pending)await pending;
        let {segs,hasId,idName,loadDesc,finalSource,bridgedGaps}=rowToPath(aoa[i],cols,rec,i,loadTags);
        const sourceSegs=segs.slice();
        for(let j=1;j<sourceSegs.length;j++)recordSourceParentClaim('easyPower',sourceSegs[j],sourceSegs[j-1],{file:fileById(fid).name,sheet:sheetName,row:i+1});
        if(loadDesc){
          const sourceRelation=loadSsmRelation(idName,finalSource,loadDesc);
          if(sourceRelation.parent)recordSourceParentClaim('easyPower',loadDesc,sourceRelation.parent,{file:fileById(fid).name,sheet:sheetName,row:i+1,field:idName?'ID Name':'Final Source'});
        }
        const topologySegs=profileWorkflow().gisBusCompaction===false?segs:gisBusCut(segs);
        segs=applyMelParentCorrections(topologySegs,loadDesc,true).map(canonSpelling); // also correct MEL-backed LV transformer parents
        if(!segs.length)continue;
        loadDesc=canonSpelling(loadDesc);
        for(const gap of bridgedGaps)seedReviewFlag({branchName:canonSpelling(gap.child),originalParent:canonSpelling(gap.parent),
          currentParent:canonSpelling(gap.parent),suggestedParent:'',status:'bridged-gap',source:'Hierarchy columns',
          reason:'A blank downstream column sits above this tag, so it was filed under the nearest populated level'});
        rowsRead++;
        const deepest=segs[segs.length-1];
        const circuit=cols.circuit>=0?clean(aoa[i][cols.circuit]):'';
        if(circuit)noteEP(deepest,circuit);
        const lcDeep=insertPath(combined,segs,hasId), lsDeep=insertPath(sMap,segs,hasId);
        // SSM rows in spreadsheet (row) order; each unique node once (keyed by full path)
        let acc='';
        for(let j=0;j<segs.length;j++){
          acc=j?acc+KEYSEP+segs[j]:segs[j];
          const equip=segs[j],parent=j?segs[j-1]:'';
          const isLoadRole=loadTags.has(tagKey(equip));
          if(!isLoadRole&&!seenC.has(acc)){seenC.add(acc);ssmCombined.push([equip,parent]);}
          if(!isLoadRole&&!seenS.has(acc)){seenS.add(acc);ssmRows.push([equip,parent]);}
        }
        // Load Description register relationships come from ID Name or Final Source;
        // a matching ID Name uses Final Source as parent with no dependency.
        if(validLoad(loadDesc,deepest)){
          const rawRel=melCorrectLoadRelation(loadDesc,loadSsmRelation(idName,finalSource,loadDesc));
          /* A load row parent/dependency names other tags, so it takes the same
             canonical spelling -- otherwise the register could point at a spelling
             no tree node carries. */
          const rel={...rawRel,parent:canonSpelling(rawRel.parent),dep:canonSpelling(rawRel.dep)};
          const meta=rel.keepDuplicateDep?{keepDuplicateDep:true}:null,lkey=acc+KEYSEP+'\u0006'+loadDesc;
          addLoadChild(lcDeep,loadDesc,rel.dep);addLoadChild(lsDeep,loadDesc,rel.dep);
          if(circuit)noteEP(loadDesc,circuit);
          const loadRow=meta?[loadDesc,rel.parent,rel.dep,meta]:[loadDesc,rel.parent,rel.dep];
          if(!seenC.has(lkey)){seenC.add(lkey);ssmCombined.push(loadRow);loadCount++;}
          if(!seenS.has(lkey)){seenS.add(lkey);ssmRows.push(meta?[...loadRow.slice(0,3),{...meta}]:[...loadRow]);}
        }
      }
      sheets.push({key,sheetName,fileName:fileById(fid).name,_sMap:sMap,ssmRows}); // tree built lazily on export
    }
    const sheetPhase=async(start,end,label,index)=>{
      await maybeYield(report,start+(end-start)*((index+1)/Math.max(1,sheets.length)),`${label} · Tab ${index+1} of ${sheets.length}`);
    };
    report(.75,'Repairing MEL transformer branches');await raf();
    repairMelTransformerBranches(combined);
    for(let i=0;i<sheets.length;i++){repairMelTransformerBranches(sheets[i]._sMap);await sheetPhase(.75,.77,'Repairing MEL transformer branches',i);}
    report(.77,'Applying MEL synthetic parent rules');await raf();
    repairEasyPowerHierarchyParents(combined);
    for(let i=0;i<sheets.length;i++){repairEasyPowerHierarchyParents(sheets[i]._sMap);await sheetPhase(.77,.79,'Applying MEL synthetic parent rules',i);}
    report(.79,'Applying Cable Schedule parent chains');await raf();
    const workflow=profileWorkflow(),preparedCombined=repairEasyPowerSsmRows(repairMelSsmRows(ssmCombined));
    const combinedCablePlan=buildCableParentPlan(workflow.cableParentChains===false?[]:preparedCombined);
    if(workflow.cableParentChains!==false){
      for(const relation of combinedCablePlan.relations.values())recordSourceParentClaim('cable',relation.equip,relation.parent,{status:'validated-chain'});
      if(activeProfile().hierarchy.cableConflictPolicy!=='first-silent')registerCablePlacementIssues(combined,combinedCablePlan);
      repairCableHierarchyParents(combined,combinedCablePlan);
    }
    let finalCombinedRows=workflow.cableParentChains===false?preparedCombined:repairCableSsmRows(preparedCombined,combinedCablePlan);
    for(let i=0;i<sheets.length;i++){
      const sh=sheets[i],prepared=repairEasyPowerSsmRows(repairMelSsmRows(sh.ssmRows)),plan=buildCableParentPlan(workflow.cableParentChains===false?[]:prepared);
      if(workflow.cableParentChains!==false)repairCableHierarchyParents(sh._sMap,plan);
      sh.ssmRows=workflow.cableParentChains===false?prepared:repairCableSsmRows(prepared,plan);
      await sheetPhase(.79,.81,'Applying Cable Schedule parent chains',i);
    }
    report(.81,'Applying MEL UPN parent rules');await raf();
    const combinedMelSystemPlan=buildMelSystemParentPlan(workflow.melUpnParents===false?[]:finalCombinedRows);
    if(workflow.melUpnParents!==false){
      for(const correction of combinedMelSystemPlan.corrections.values())recordSourceParentClaim('mel',correction.equip,correction.newParent,{status:'validated-upn',previousParent:correction.currentParent});
      repairMelSystemParentHierarchy(combined,combinedMelSystemPlan);
    }
    /* Claims only -- deliberately no tree mutation. The UPN path above rewrites
       the raw Eagle tree because that is the frozen behavior it reproduces;
       this records evidence for the canonical resolver and leaves the raw tree
       alone, which is why it cannot move Eagle even if it were switched on. */
    S.melDependencyClaims=workflow.melSystemParentClaims===true
      ? recordMelSystemParentClaims(finalCombinedRows)
      : new Map();
    S.melParentChecks=combinedMelSystemPlan.checks;
    if(workflow.melUpnParents!==false)finalCombinedRows=repairMelSystemParentSsmRows(finalCombinedRows,combinedMelSystemPlan);
    for(let i=0;i<sheets.length;i++){
      const sh=sheets[i];
      const melSystemPlan=buildMelSystemParentPlan(workflow.melUpnParents===false?[]:sh.ssmRows);
      if(workflow.melUpnParents!==false){repairMelSystemParentHierarchy(sh._sMap,melSystemPlan);sh.ssmRows=repairMelSystemParentSsmRows(sh.ssmRows,melSystemPlan);}
      await sheetPhase(.81,.83,'Applying MEL UPN parent rules',i);
    }
    report(.83,'Normalizing MAH parent tags');await raf();
    repairMahHierarchyParents(combined);finalCombinedRows=repairMahSsmRows(finalCombinedRows);
    for(let i=0;i<sheets.length;i++){
      const sh=sheets[i];repairMahHierarchyParents(sh._sMap);sh.ssmRows=repairMahSsmRows(sh.ssmRows);
      await sheetPhase(.83,.845,'Normalizing MAH parent tags',i);
    }
    report(.845,'Linking PMD instruments');await raf();
    const instrumentCount=workflow.pmdInstrumentAttachment===false?0:attachPmdInstruments(combined);
    if(workflow.pmdInstrumentAttachment===false){S.pmdLinks=[];S.pmdMatchedPanels=new Set();}
    for(const link of S.pmdLinks)for(const instrument of link.instruments)recordSourceParentClaim('pmd',pmdExportTag(instrument.tag,link.building),link.loadName,{panel:link.panel,building:link.building||''});
    if(S.pmdPanels.length)for(let i=0;i<sheets.length;i++)await sheetPhase(.845,.86,'Deferring per-tab PMD instruments',i);
    report(.86,'Preparing placement review');await raf();
    const needsPlacementIndex=S._melPlacementSeeds.size||combinedMelSystemPlan.warnings.length;
    const placementIndex=needsPlacementIndex?buildRawHierarchyIndex(combined):null;
    bindMelPlacementSeeds(combined,placementIndex);
    registerMelSystemParentIssues(combined,combinedMelSystemPlan,placementIndex);
    if(workflow.enforceSystemRoot!==false){enforceSystemRoots(combined,true);for(const sh of sheets)enforceSystemRoots(sh._sMap,false);}
    report(.87,'Preparing SSM registers');await raf();
    const combinedRegisterRows=workflow.pmdInstrumentAttachment===false?finalCombinedRows:appendPmdSsmRows(finalCombinedRows,true);
    if(activeProfile().hierarchy.duplicateParentReviewPolicy!=='first-silent')flagDuplicateRegisterParents(combinedRegisterRows); // must see rows before dedupe drops the losers
    // bind last: every seed source must have run, including the duplicate-parent scan above
    bindReviewFlagSeeds(combined,placementIndex);
    S.sheets=sheets;S.ssmCombined=uniqueSsmRows(combinedRegisterRows);
    report(.88,'Finalizing tree');await raf();
    S.rawCombined=combined;S.roots=finalize(combined); // call last so nodeById matches the displayed combined tree
    // every equipment name in the Easy Power hierarchy (for cable cross-check)
    report(.90,'Indexing equipment');await raf();
    if(S.hasCable){report(.91,'Cross-checking cable schedule');await raf();}
    await buildReview(report);
    report(.955,'Resolving site profile');await raf();superseded();rebuildProfileProjections();
    if(S.wcRows){report(.96,'Comparing working copy');await raf();await buildComparison(report);}
    S.stats=computeStats(S.roots);
    S.stats.rowsRead=rowsRead;S.stats.tabs=keys.length;
    S.stats.files=new Set(keys.map(k=>k.split(KEYSEP)[0])).size;
    S.stats.deps=countTreeDependencies(S.roots);S.stats.loads=loadCount;S.stats.instruments=instrumentCount;S.stats.review=S.review.length+activePlacements().length;
    report(.99,'Finalizing hierarchy views');await raf();superseded();
    S.profileNeedsRebuild=false;S.builtProfileSignature=profileExecutionSignature(activeProfile());
    report(1,'Done');
    });
  }catch(error){
    const latestRevision=S.profileBuildRevision;
    Object.assign(S,previous);
    if(error&&error.code==='profile_build_superseded'){
      S.profileBuildRevision=latestRevision;S.profileNeedsRebuild=true;return false;
    }
    console.error('Hierarchy build failed',error);
    toast('Build stopped safely. Your previous hierarchy is still available.');
    return false;
  }
  if(!S.roots.length){toast('No hierarchy rows found in the selected tabs');return;}
  S.search='';S.idOnly=false;S.showSpares=true;S.showSpaces=true;S.showDeps=!!(S.stats&&S.stats.deps);S.showPmdMatches=true;
  S.cmpFilter='all';S.cmpSearch='';S.cmpDiff='all';S.cmpSort=null;S.tab='tree';go('result');return true;
}
/* Cable Schedule loads with no exact match in Easy Power. Uses normalized-separator
   and prefix-bucket indexes so the fuzzy step stays cheap even on 75k+ names. */
export async function buildReview(report){
  S.review=[];if(!S.hasCable)return;
  const epPref=S._reviewEpPref||new Map();
  resetYield();const seen=new Set();
  let totalCable=0;for(const k of S.cableSel){const ci=cableInfo(k);if(ci)totalCable+=Math.max(0,getAoa(k).aoa.length-ci.headerRow-1);}
  totalCable=Math.max(1,totalCable);let cdone=0;
  for(const key of S.cableSel){
    const [fid]=key.split(KEYSEP);if(!fileById(fid))continue;
    const ci=cableInfo(key);if(!ci)continue;
    const {map,headerRow}=ci,{aoa}=getAoa(key);
    const loadC=map['Load Name (To)'],panelC=map['Panel (From)'],circC=map['Circuit_Number'];
    for(let i=headerRow+1;i<aoa.length;i++){
      cdone++;if(report)await maybeYield(report,.91+.04*(cdone/totalCable),'Cross-checking cable schedule');
      const load=cleanTag(aoa[i][loadC]);if(!load)continue;
      const lk=load.toLowerCase();
      if(S.epNameSet.has(lk))continue;          // exact match — fine
      if(seen.has(lk))continue;seen.add(lk);
      const matches=topFuzzy(load,epPref.get(normSep(load).slice(0,3))||[],3); // up to 3, best-first
      const rec={load,panel:cleanTag(aoa[i][panelC]),circuit:circC!=null?clean(aoa[i][circC]):'',matches};
      S.review.push({...rec,searchKey:reviewSearchKey(rec)});
    }
  }
}
export function rawSubtreeCount(node){
  const cache=S._rawSubtreeCounts||(S._rawSubtreeCounts=new WeakMap());
  if(cache.has(node))return cache.get(node);
  let count=0;const stack=[...node.kids.values()];
  while(stack.length){const child=stack.pop();count++;for(const nested of child.kids.values())stack.push(nested);}
  cache.set(node,count);return count;
}
export function rawContains(root,target){if(root===target)return true;for(const child of root.kids.values())if(rawContains(child,target))return true;return false;}
export function findRawHolderByNode(root,target){
  for(const [key,node] of root.kids){if(node===target)return {holder:root,key,node};const found=findRawHolderByNode(node,target);if(found)return found;}
  return null;
}
export function nodePath(node){const names=[];for(let cur=node;cur;cur=cur.parent)names.push(cur.name);return names.reverse();}
export function placementExpectedParentRole(branch){
  const role=equipmentRole(branch),configured=activeProfile().hierarchy&&activeProfile().hierarchy.roleParents||{};
  return clean(configured[role]).toUpperCase();
}
export function placementBlockedNodes(issue){
  if(issue._blockedRevision===S.placementRevision&&issue._blockedNodes)return issue._blockedNodes;
  const blocked=new Set(),stack=issue.node?[issue.node]:[];
  while(stack.length){const node=stack.pop();if(blocked.has(node))continue;blocked.add(node);for(const child of node.kids.values())stack.push(child);}
  issue._blockedRevision=S.placementRevision;issue._blockedNodes=blocked;return blocked;
}
export function validPlacementParent(issue,node,blocked){
  if(!issue||!issue.node||!node||!node._raw||node._raw.isInstrument||(blocked||placementBlockedNodes(issue)).has(node._raw))return false;
  const expected=placementExpectedParentRole(issue.branchName);
  if(expected==='SYSTEM')return isSystemName(node.name);
  return expected?hasEquipmentRole(node.name,expected):true;
}
export function placementCandidates(issue,query){
  const q=clean(query).toLowerCase(),cached=issue._candidateCache;
  if(cached&&cached.revision===S.placementRevision&&cached.query===q)return cached.items;
  const items=[],blocked=placementBlockedNodes(issue);
  const walk=node=>{if(validPlacementParent(issue,node,blocked)){
    const path=nodePath(node),search=(node.name+' '+path.join(' ')).toLowerCase();
    if(!q||search.includes(q)){let score=0;if(tagKey(node.name)===tagKey(issue.suggestedParent))score+=1000;if(issue.suffix&&equipmentSuffix(node.name)===issue.suffix)score+=200;score-=node.depth;items.push({node,path,score});}
  }node.children.forEach(walk);};S.roots.forEach(walk);
  const result=items.sort((a,b)=>b.score-a.score||natCmp(a.node.name,b.node.name)).slice(0,60);
  issue._candidateCache={revision:S.placementRevision,query:q,items:result};return result;
}
export function cloneSsmRows(rows){return rows.map(row=>row.map(value=>value&&typeof value==='object'&&!Array.isArray(value)?{...value}:value));}
export function setBranchRegisterParent(rows,equipment,parent){
  let found=false;const out=rows.map(row=>{if(tagKey(row&&row[0])!==tagKey(equipment))return row;found=true;const fixed=[...row];fixed[1]=parent;return fixed;});
  if(!found)out.push([equipment,parent]);return out;
}
export function ensureRawPath(root,path){let holder=root;for(const name of path){holder=ensureRawHierarchyChild(holder,name);}return holder;}
export function moveRawNode(root,node,target){
  const duplicate=rawKidEntry(target.kids,node.name);if(duplicate&&duplicate[1]!==node)return null;
  const from=findRawHolderByNode(root,node);let detachedKey='';
  if(from)from.holder.kids.delete(from.key);
  else if(root._detached){for(const [key,value] of root._detached)if(value===node){detachedKey=key;root._detached.delete(key);break;}}
  target.kids.set(node.name,node);return {root,node,target,from,detachedKey};
}
export function undoRawMove(move){
  const entry=rawKidEntry(move.target.kids,move.node.name);if(entry&&entry[1]===move.node)move.target.kids.delete(entry[0]);
  if(move.from)move.from.holder.kids.set(move.from.key,move.node);
  else if(move.detachedKey){if(!move.root._detached)move.root._detached=new Map();move.root._detached.set(move.detachedKey,move.node);}
}
export async function refreshPlacementModels(){
  S.placementRevision++;S._rawSubtreeCounts=new WeakMap();clearResultCache();
  S.roots=finalize(S.rawCombined);for(const sh of S.sheets){sh._roots=null;sh._pmdSsmRows=null;}
  await buildReview();rebuildProfileProjections();if(S.wcRows)await buildComparison();
  const previous=S.stats||{},computed=computeStats(S.roots);S.stats={...previous,...computed,review:S.review.length+activePlacements().length};
  if(S.tab==='review'&&!S.hasCable&&!activePlacements().length)S.tab='tree';
  renderResult();
}
export async function movePlacementBranch(issueId,parentNodeId){
  const issue=S.placements.find(item=>item.id===issueId&&!item.resolved),parent=S.nodeById.get(parentNodeId);if(!issue||!parent||!validPlacementParent(issue,parent))return toast('Choose a valid parent for this branch');
  if(rawKidEntry(parent._raw.kids,issue.branchName))return toast('That parent already contains this branch');
  const oldIssue={resolved:issue.resolved,currentParent:issue.currentParent,path:issue.path,placementId:issue.node.placementId,placementStatus:issue.node.placementStatus};
  const profile=activeProfile(),override={id:'placement-'+tagKey(issue.branchName),equipment:cleanTag(issue.branchName),parent:cleanRegisterTag(parent.name),savedAt:new Date().toISOString()};
  const oldSessionOverrides=S.sessionRelationshipOverrides.slice(),oldProfileOverrides=JSON.parse(JSON.stringify(profile.overrides||{relationships:[]}));
  const oldProfileRevision=profile.revision,oldProfileUpdatedAt=profile.updatedAt;
  if(profile.locked)S.sessionRelationshipOverrides=[...S.sessionRelationshipOverrides.filter(item=>tagKey(item.equipment)!==tagKey(override.equipment)),override];
  else{
    profile.overrides={...(profile.overrides||{}),relationships:[...(profile.overrides&&profile.overrides.relationships||[]).filter(item=>tagKey(item.equipment)!==tagKey(override.equipment)),override]};
    profile.revision=Math.max(1,Number(profile.revision)||1)+1;profile.updatedAt=override.savedAt;persistProfiles();
  }
  const oldCombinedRows=cloneSsmRows(S.ssmCombined),oldSheetRows=S.sheets.map(sh=>cloneSsmRows(sh.ssmRows));
  const combinedMove=moveRawNode(S.rawCombined,issue.node,parent._raw);if(!combinedMove)return toast('Unable to move that branch');
  const sheetMoves=[],parentPath=nodePath(parent);
  for(const sh of S.sheets){
    let branch=rawOccurrences(sh._sMap,issue.branchName)[0]?.node;
    if(!branch&&sh._sMap._detached){for(const value of sh._sMap._detached.values())if(tagKey(value.name)===tagKey(issue.branchName)){branch=value;break;}}
    if(!branch)continue;const target=ensureRawPath(sh._sMap,parentPath),move=moveRawNode(sh._sMap,branch,target);if(move)sheetMoves.push(move);
  }
  S.ssmCombined=setBranchRegisterParent(S.ssmCombined,issue.branchName,parent.name);
  S.sheets.forEach(sh=>{sh.ssmRows=setBranchRegisterParent(sh.ssmRows,issue.branchName,parent.name);});
  issue.resolved=true;issue.currentParent=parent.name;issue.path=[...parentPath,issue.branchName];issue.node.placementId='';issue.node.placementStatus='';
  S.lastPlacementMove={type:'move',issue,oldIssue,combinedMove,sheetMoves,oldCombinedRows,oldSheetRows,profile,oldSessionOverrides,oldProfileOverrides,oldProfileRevision,oldProfileUpdatedAt};
  closeDrawer();await refreshPlacementModels();toast('Branch moved under '+parent.name+(profile.locked?' for this session':' and saved to this profile'));
}
export async function acceptPlacement(issueId){
  const issue=S.placements.find(item=>item.id===issueId&&!item.resolved);if(!issue)return;
  const wasWarning=issue.status!=='suggested'; // everything except a suggested move is a warning being cleared
  const oldIssue={resolved:issue.resolved,placementId:issue.node&&issue.node.placementId,placementStatus:issue.node&&issue.node.placementStatus};
  issue.resolved=true;if(issue.node){issue.node.placementId='';issue.node.placementStatus='';}
  S.lastPlacementMove={type:'accept',issue,oldIssue};closeDrawer();await refreshPlacementModels();toast(wasWarning?'Warning acknowledged':'Placement accepted');
}
export async function undoPlacement(){
  const action=S.lastPlacementMove;if(!action)return;
  if(action.type==='move'){
    undoRawMove(action.combinedMove);action.sheetMoves.forEach(undoRawMove);S.ssmCombined=action.oldCombinedRows;S.sheets.forEach((sh,i)=>{sh.ssmRows=action.oldSheetRows[i];});
    S.sessionRelationshipOverrides=action.oldSessionOverrides;
    if(action.profile&&!action.profile.locked){action.profile.overrides=action.oldProfileOverrides;action.profile.revision=action.oldProfileRevision;action.profile.updatedAt=action.oldProfileUpdatedAt;persistProfiles();}
    Object.assign(action.issue,action.oldIssue);action.issue.node.placementId=action.oldIssue.placementId;action.issue.node.placementStatus=action.oldIssue.placementStatus;
  }else{Object.assign(action.issue,action.oldIssue);if(action.issue.node){action.issue.node.placementId=action.oldIssue.placementId;action.issue.node.placementStatus=action.oldIssue.placementStatus;}}
  S.lastPlacementMove=null;await refreshPlacementModels();toast('Placement change undone');
}
/* Resolve a stored SSM row [equip, parent, depOverride, metadata] to display values. */
export function ssmResolve(r){
  const e=cleanRegisterTag(r[0]),par=cleanRegisterTag(r[1]||''),dep=r[2]!=null?cleanRegisterTag(r[2]):(depOf(e)||''),meta=r[3]||{};
  return {equip:e,parent:par,dep,keepDuplicateDep:!!meta.keepDuplicateDep};
}
export function registerCompareKey(value){const v=cleanTag(value).toLowerCase();return (!v||v==='n/a'||v==='-'||v==='—')?'':v;}
export function workingRegisterCompareKey(value){return registerCompareKey(cleanTag(clean(value).replace(/(?:\s*\[[^\]]*\])+\s*$/,'')));}
export function registerDisplayValue(value){return registerCompareKey(value)===''?'N/A':clean(value);}
export function sameRegisterValue(a,b){return registerCompareKey(a)===registerCompareKey(b);}
export function sameWorkingRegisterValue(extracted,working){return registerCompareKey(extracted)===workingRegisterCompareKey(working);}
export function sameWorkingDependencyValue(extracted,working){
  const parts=clean(working).split(';').map(clean).filter(Boolean);
  return (parts.length?parts:[working]).some(value=>sameWorkingRegisterValue(extracted,value));
}
export function isAcceptedMissingWorkingDependency(curParent,curDep,wcParent,wcDep){
  return registerCompareKey(curParent)!==''&&sameWorkingRegisterValue(curParent,wcParent)&&!sameWorkingDependencyValue(curDep,wcDep)
    &&sameRegisterValue(curDep,curParent)&&sameWorkingRegisterValue(curDep,wcParent)&&workingRegisterCompareKey(wcDep)==='';
}
export function comparisonValuesMatch(curParent,curDep,wcParent,wcDep){
  return sameWorkingRegisterValue(curParent,wcParent)&&(sameWorkingDependencyValue(curDep,wcDep)||isAcceptedMissingWorkingDependency(curParent,curDep,wcParent,wcDep));
}
export function registerDepValue(parent,dep,keepDuplicate){
  const d=clean(dep);
  return d&&!keepDuplicate&&sameRegisterValue(parent,d)?'N/A':d;
}
export function ssmRegisterResolve(r){const o=ssmResolve(r);return {...o,dep:registerDepValue(o.parent,o.dep,o.keepDuplicateDep)};}
/* Compare the current SSM register against an imported "Current Working Copy". */
export async function buildComparison(report){
  S.compare=[];S.compareBuckets={all:[],off:[],nohit:[],match:[]};if(!S.wcRows)return;
  resetYield();
  const total=Math.max(1,S.ssmCombined.length+S.wcRows.length+S.ssmCombined.length);let cdone=0;
  const cur=new Map();for(const r of S.ssmCombined){const o=ssmResolve(r);cur.set(registerCompareKey(o.equip),o);cdone++;if(report)await maybeYield(report,.96+.03*(cdone/total),'Comparing working copy');}
  const wc=new Map();for(const o of S.wcRows)wc.set(workingRegisterCompareKey(o.equip),o);
  const keys=new Set([...cur.keys(),...wc.keys()]);
  for(const k of keys){
    cdone++;if(report)await maybeYield(report,.96+.03*(cdone/total),'Comparing working copy');
    const a=cur.get(k),b=wc.get(k);let status;
    const curParent=a?a.parent:'';
    const curDep=a?registerDepValue(a.parent,a.dep,a.keepDuplicateDep):'';
    const wcParent=b?b.parent:'';
    const wcDep=b?registerDepValue(b.parent,b.dep,!!(a&&a.keepDuplicateDep)):'';
    const acceptedDepMismatch=!!(a&&b&&isAcceptedMissingWorkingDependency(curParent,curDep,wcParent,wcDep));
    if(a&&b)status=comparisonValuesMatch(curParent,curDep,wcParent,wcDep)?'match':'off';
    else status='nohit';
    const rec={equip:a?a.equip:b.equip,
      curParent,curDep,wcParent,wcDep,
      inCur:!!a,inWc:!!b,status,acceptedDepMismatch};
    S.compare.push({...rec,searchKey:compareSearchKey(rec)});
  }
  S.compare.sort((x,y)=>({off:0,nohit:1,match:2}[x.status]-{off:0,nohit:1,match:2}[y.status])||natCmp(x.equip,y.equip));
  S.compareBuckets={all:S.compare,off:S.compare.filter(r=>r.status==='off'),nohit:S.compare.filter(r=>r.status==='nohit'),match:S.compare.filter(r=>r.status==='match')};
}
