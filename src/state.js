import { $, KEYSEP } from './core/text.js'
import { cleanTag } from './core/tags.js'
import { ruleEngineGeneration } from './rules/provider.js'

export const S={screen:'upload',files:[],selected:new Set(),cableSel:new Set(),pmdSel:new Set(),melSel:new Set(),p6Sel:new Set(),lineSel:new Set(),extoSel:new Set(),imSel:new Set(),override:{},aoaCache:new Map(),massageUndo:[],massageRedo:[],
  roots:[],rawCombined:null,sheets:[],ssmCombined:[],nodeById:new Map(),stats:null,search:'',idOnly:false,
  showSpares:true,showSpaces:true,showDeps:true,showPmdMatches:true,deps:new Map(),depDetail:new Map(),hasCable:false,
  cableStruckTags:new Set(),
  pmdRows:[],pmdPanels:[],pmdLinks:[],pmdPanelMap:new Map(),pmdSuffixMap:new Map(),pmdDetail:new Map(),pmdMatchedPanels:new Set(),
  melRows:[],melByTag:new Map(),melByNorm:new Map(),melBySuffix:new Map(),melByGram:new Map(),melLookupCache:new Map(),melContainingCache:new Map(),melParentChecks:new Map(),melDependencyClaims:new Map(),melLookup:null,
  epDetail:new Map(),epNameSet:new Set(),review:[],placements:[],_placementByKey:new Map(),_rawSubtreeCounts:new WeakMap(),reviewMode:'cross',placementRevision:0,placementQuery:'',placementScrollTop:0,lastPlacementMove:null,
  workCopy:null,wcRows:null,compare:[],compareBuckets:{all:[],off:[],nohit:[],match:[]},tab:'tree',
  cmpFilter:'all',cmpSearch:'',cmpDiff:'all',cmpSort:null,revSearch:'',revSort:null,revMinPct:null,showStats:true,
  resultFullscreen:false,
  hierarchyMode:'electrical-flow',hierarchyExportMode:'electrical-flow',canonicalModel:new Map(),resolvedSnapshot:null,resolutionIssues:[],
  sourceParentClaims:{easyPower:new Map(),cable:new Map(),mel:new Map(),pmd:new Map()},
  sessionRelationshipOverrides:[],
  projections:{},selectedEquipmentKey:'',
  profileDraft:null,profileDirty:false,profileNeedsRebuild:false,profileBuildRevision:0,builtProfileSignature:'',profileStorage:'local',profileStorageIssue:null,
  profileUi:{returnScreen:'upload',section:'overview',previewKey:'',sourceKind:'easyPower',selectedCell:null,rangeStart:null,rangeEnd:null,ruleScope:'all',
    previewStartRow:0,previewScrollTop:0,previewScrollLeft:0,previewFullscreen:false,
    relationKind:'constant',relationRuleId:'',engineRuleRef:'',
    visualMode:'flow',visualQuery:'',visualExpanded:[],visualSourceKey:'',visualProposal:null,visualScope:'similar',
    visualScrollTop:0,visualInspectorScrollTop:0,visualFullscreen:false,visualSeedMode:'',visualHistory:[],visualFuture:[],visualBase:null,visualTreeCache:null},
  guideSection:'start',
  viewCache:{tree:null,review:new Map(),reviewRows:new Map(),placementRows:new Map(),compare:new Map(),compareRows:new Map()}};
export let _uid=0,_nid=0;
export const fileById=id=>S.files.find(f=>f.id===id);
/* tagKey sits under every canonical-map access; the toLowerCase allocation on
   millions of repeat calls dominated build profiles at scale, so it memoizes
   by raw input and follows cleanTag's engine-generation invalidation. */
let tagKeyGeneration=-1;
const tagKeyMemo=new Map();
export const tagKey=value=>{
  const key=typeof value==='string'?value:String(value==null?'':value);
  const generation=ruleEngineGeneration();
  if(generation!==tagKeyGeneration){tagKeyGeneration=generation;tagKeyMemo.clear();}
  let out=tagKeyMemo.get(key);
  if(out===undefined){
    out=cleanTag(key).toLowerCase();
    if(tagKeyMemo.size>1500000)tagKeyMemo.clear();
    tagKeyMemo.set(key,out);
  }
  return out;
};
export function invalidateHierarchyBuild(){
  S.profileBuildRevision++;
  S.profileNeedsRebuild=!!S.roots.length;
  clearResultCache();
}

export const RESULT_PANEL_CACHE_LIMIT=24;
export let _virtualTok=0,_cmpPrewarmTok=0,_placementResizeObserver=null;
export function clearResultCache(){_virtualTok++;_cmpPrewarmTok++;S.viewCache={tree:null,review:new Map(),reviewRows:new Map(),placementRows:new Map(),compare:new Map(),compareRows:new Map()};}
export function panelScroll(scrollSel){
  const el=scrollSel?$(scrollSel):null;
  return el?{top:el.scrollTop,left:el.scrollLeft}:null;
}
export function restoreScroll(scrollSel,scroll){
  if(!scrollSel||!scroll)return;
  requestAnimationFrame(()=>{const el=$(scrollSel);if(el){el.scrollTop=scroll.top||0;el.scrollLeft=scroll.left||0;}});
}
export function cacheSet(map,key,value){
  if(map.has(key))map.delete(key);
  map.set(key,value);
  while(map.size>RESULT_PANEL_CACHE_LIMIT)map.delete(map.keys().next().value);
}
export function cacheGet(map,key){
  if(!map.has(key))return null;
  const value=map.get(key);
  map.delete(key);map.set(key,value);
  return value;
}
export function markPanelCachePending(el,key){if(el){el.dataset.cacheKey=key;el.dataset.cacheReady='0';}}
export function markPanelCacheReady(el,key){if(el){el.dataset.cacheKey=key;el.dataset.cacheReady='1';}}
export function isPanelCacheLive(el,key){return !!(el&&el.dataset.cacheReady==='1'&&el.dataset.cacheKey===key&&el.innerHTML);}
export function rememberPanelCache(name,key,el,scrollSel){
  const map=S.viewCache[name];if(!map||!el)return;
  markPanelCacheReady(el,key);
  cacheSet(map,key,{html:el.innerHTML,scroll:panelScroll(scrollSel)});
}
export function restorePanelCache(name,key,el,scrollSel){
  const map=S.viewCache[name],hit=map&&cacheGet(map,key);
  if(!hit||!el)return false;
  el.innerHTML=hit.html;
  markPanelCacheReady(el,key);
  restoreScroll(scrollSel,hit.scroll);
  return true;
}
export function treePanelCacheKey(){const roots=activeHierarchyRoots(),projection=S.projections[S.hierarchyMode]||{};return ['tree',S.hierarchyMode,activeProfileRevision(),S.search,S.idOnly,S.showSpares,S.showSpaces,S.showDeps,S.showPmdMatches,roots.length,projection.revision||0].join(KEYSEP);}
export function rememberTreePanel(){
  const el=$('#panel-tree');if(!el)return;
  S.viewCache.tree={key:treePanelCacheKey(),html:el.innerHTML,scroll:panelScroll('.treecard')};
}
export function restoreTreePanel(){
  const el=$('#panel-tree'),hit=S.viewCache.tree;
  if(!el||!hit||hit.key!==treePanelCacheKey())return false;
  el.innerHTML=hit.html;
  restoreScroll('.treecard',hit.scroll);
  wireTree($('#tree'));
  return true;
}
