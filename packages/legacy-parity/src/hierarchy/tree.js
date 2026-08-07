import { clean, natCmp } from '../core/text.js'
import { cleanTag, normSep } from '../core/tags.js'
import { S, tagKey } from '../state.js'
import { activeProfile } from '../profile/schema.js'
import { isSpareName, isSpaceName, dedupRoots, nodeDep } from '../profile/classify.js'
import { modeById } from './modes.js'
import { rowTag } from '../io/workbook.js'
import { uniqueSsmRows, appendPmdSsmRows, _attachPmdInstruments } from './build.js'

/* ---- hierarchy build (no collapse, except: an ID Name equal to the farthest
   downstream tag is dropped so the branch stops at that downstream tag) ---- */
export function rowToPath(row,cols,rec,rowIndex,loadTags){
  const segs=[];let hasId=false;
  const source=rowTag(row,cols.source,rec,rowIndex);
  /* A blank downstream column used to `break`, discarding every populated level
     after it -- equipment that appears nowhere else simply vanished from the
     hierarchy, with nothing recorded. Blanks are skipped instead, so the later
     levels survive; a gap that was actually bridged is reported back so the
     caller can flag it, because the bridged tag's parent is a guess: the blank
     may mean "no level here" (bridging is right) or "level unknown" (it is not).
     Keeping it visible and reviewable beats dropping it invisibly -- Placement
     Review can re-parent a node, it cannot recover one that was never built. */
  const downstream=[];let pendingGap=false;const bridgedGaps=[];
  const gapPolicy=activeProfile().hierarchy&&activeProfile().hierarchy.downstreamGapPolicy||'bridge-review';
  for(const col of cols.downstream){
    const value=rowTag(row,col,rec,rowIndex);
    if(!value){
      if(gapPolicy==='truncate')break;
      pendingGap=true;continue;
    }
    if(pendingGap)bridgedGaps.push({parent:downstream.length?downstream[downstream.length-1]:source,child:value});
    pendingGap=false;downstream.push(value);
  }
  const finalSource=rowTag(row,cols.finalSource,rec,rowIndex);
  const id=rowTag(row,cols.idName,rec,rowIndex);
  const loadDesc=rowTag(row,cols.loadDesc,rec,rowIndex);
  const push=value=>{
    if(!value)return;
    if(!segs.length||tagKey(segs[segs.length-1])!==tagKey(value))segs.push(value);
  };
  push(source);downstream.forEach(push);if(!downstream.length)push(finalSource);
  if(id&&(!segs.length||tagKey(id)!==tagKey(segs[segs.length-1]))&&!(loadTags&&loadTags.has(tagKey(id)))){segs.push(id);hasId=true;}
  return {segs,hasId,idName:id,loadDesc,finalSource,bridgedGaps};
}
export function loadSsmRelation(idName,finalSource,loadDesc){
  const id=cleanTag(idName),final=cleanTag(finalSource),load=cleanTag(loadDesc);
  if(id&&tagKey(id)===tagKey(load))return {parent:final,dep:'',keepDuplicateDep:false};
  const relation=id||final;
  return {parent:relation,dep:relation,keepDuplicateDep:!!relation};
}
export function insertPath(root,p,hasId){
  let n=root;
  for(let i=0;i<p.length;i++){
    const seg=p[i];
    if(!n.kids.has(seg))n.kids.set(seg,{name:seg,kids:new Map(),isId:false});
    n=n.kids.get(seg);
    if(i===p.length-1&&hasId)n.isId=true;
  }
  return n; // deepest node
}
export function addLoadChild(deepNode,loadName,dependency){
  if(!deepNode.kids.has(loadName))deepNode.kids.set(loadName,{name:loadName,kids:new Map(),isId:false,isLoad:true,loadDependency:dependency||''});
  else deepNode.kids.get(loadName).isLoad=true;
}
export function buildRoots(root){
  let id=0;
  const conv=(m,depth,parent)=>{
    const node={id:'n'+(id++),name:m.name,depth,isId:m.isId,isLoad:!!m.isLoad,loadDependency:m.loadDependency||'',dependencyOverride:m.dependencyOverride||'',parent,children:[],_raw:m,
      isInstrument:!!m.isInstrument,description:m.description||'',pmdKey:m.pmdKey||'',pmdPanel:m.pmdPanel||'',pmdBuilding:m.pmdBuilding||'',
      placementId:m.placementId||'',placementStatus:m.placementStatus||'',
      isSpare:isSpareName(m.name),isSpace:isSpaceName(m.name)};
    node.children=[...m.kids.values()].sort((a,b)=>natCmp(a.name,b.name)).map(k=>conv(k,depth+1,node));
    return node;
  };
  return dedupRoots([...root.kids.values()].sort((a,b)=>natCmp(a.name,b.name)).map(k=>conv(k,0,null)));
}
export function finalize(root){ // combined tree: build, then index nodeById for click/drawer
  const roots=buildRoots(root);
  S.nodeById=new Map();S.epNameSet=new Set();
  const prefMaps=new Map();
  let nodes=0,leaves=0,maxDepth=0,idCount=0,deps=0;
  const stack=[...roots];
  while(stack.length){
    const node=stack.pop(),name=clean(node.name),nameKey=name.toLowerCase();
    S.nodeById.set(node.id,node);if(nameKey)S.epNameSet.add(nameKey);
    nodes++;if(node.depth>maxDepth)maxDepth=node.depth;if(node.isId)idCount++;if(!node.children.length)leaves++;if(nodeDep(node))deps++;
    if(S.hasCable&&name){const prefix=normSep(name).slice(0,3);let bucket=prefMaps.get(prefix);if(!bucket){bucket=new Map();prefMaps.set(prefix,bucket);}if(!bucket.has(normSep(name)))bucket.set(normSep(name),name);}
    for(let i=node.children.length-1;i>=0;i--)stack.push(node.children[i]);
  }
  S._treeStats={nodes,leaves,maxDepth:maxDepth+1,idCount,sources:roots.length,deps};
  S._reviewEpPref=new Map([...prefMaps].map(([key,bucket])=>[key,[...bucket.values()]]));
  return roots;
}
/* per-sheet tree is only needed for the "separate" Hierarchy export — build it lazily */
export function sheetRoots(sh){
  if(!sh._roots){
    if(!sh._pmdAttached&&S.pmdPanels.length){_attachPmdInstruments(sh._sMap,null);sh._pmdAttached=true;}
    sh._roots=buildRoots(sh._sMap);
  }
  return sh._roots;
}
export function sheetSsmRows(sh){
  if(!sh._pmdSsmRows)sh._pmdSsmRows=uniqueSsmRows(appendPmdSsmRows(sh.ssmRows,false));
  return sh._pmdSsmRows;
}
export function computeStats(roots){
  if(roots===S.roots&&S._treeStats)return {...S._treeStats};
  let nodes=0,leaves=0,maxDepth=0,idCount=0;
  const walk=n=>{nodes++;if(n.depth>maxDepth)maxDepth=n.depth;if(n.isId)idCount++;
    if(!n.children.length)leaves++;n.children.forEach(walk);};
  roots.forEach(walk);
  return {nodes,leaves,maxDepth:maxDepth+1,idCount,sources:roots.length};
}
export function countTreeDependencies(roots){
  if(roots===S.roots&&S._treeStats)return S._treeStats.deps||0;
  let count=0;
  const walk=node=>{if(nodeDep(node))count++;node.children.forEach(walk);};
  roots.forEach(walk);return count;
}

/* Every active view reads a named projection. An occurrence-preserving `raw`
   mode points at the fully rebuilt electrical tree; grouped/projected modes use
   the canonical one-parent register model. Both are profile-authored choices. */
function activeMode(){return modeById(activeProfile(),S.hierarchyMode);}
function activeProjection(){return S.projections[activeMode().id]||{roots:[],nodeById:new Map(),stats:null};}
export function activeHierarchyRoots(){return activeProjection().roots;}
export function activeHierarchyNodeMap(){return activeProjection().nodeById;}
export function activeHierarchyStats(){
  const projection=activeProjection();return projection.stats||computeStats(projection.roots);
}
