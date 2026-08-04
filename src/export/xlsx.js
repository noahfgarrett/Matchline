import { clean, raf, sleep } from '../core/text.js'
import { downloadBlob } from '../core/download.js'
import { S, tagKey } from '../state.js'
import { ic } from '../ui/icons.js'
import { activeProfile } from '../profile/schema.js'
import { isSpaceName, isSpareName, kidsOf, nodeDep, nodeHidden } from '../profile/classify.js'
import { hideOverlay, showOverlay, toast } from '../ui/progress.js'
import { modeById } from '../hierarchy/modes.js'
import { sheetRoots, sheetSsmRows } from '../hierarchy/tree.js'
import { canonicalRecord, recordAttribute, resolvedRegisterRowsFor } from '../hierarchy/projection.js'
import { activePlacements, isSystemName, melUpn, rawSubtreeCount, registerDisplayValue, sameWorkingDependencyValue, sameWorkingRegisterValue, ssmRegisterResolve, uniqueSsmRows } from '../hierarchy/build.js'
import { placementState, sortReviewList } from '../review/panels.js'

/* ---- exports ---- */
export let _freeze={};
export const _unescapeXml=s=>s.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&apos;/g,"'");
export function _injectPane(xml,ySplit){
  const pane=`<pane ySplit="${ySplit}" topLeftCell="A${ySplit+1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/>`;
  if(/<sheetView\b[^>]*\/>/.test(xml))return xml.replace(/<sheetView\b([^>]*)\/>/,`<sheetView$1>${pane}</sheetView>`);
  return xml.replace(/(<sheetView\b[^>]*>)/,`$1${pane}`);
}
/* xlsx-js-style can't emit frozen panes, so inject them into the finished file:
   unzip, add <pane> to each sheet's <sheetView>, re-zip. Any failure -> original
   bytes (still a valid workbook). Re-zipping also compresses better than the writer. */
export function applyFreeze(bytes,freezeMap){
  if(typeof fflate==='undefined'||!freezeMap||!Object.keys(freezeMap).length)return bytes;
  try{
    const files=fflate.unzipSync(bytes),dec=new TextDecoder(),enc=new TextEncoder(),rels={};
    dec.decode(files['xl/_rels/workbook.xml.rels']||new Uint8Array()).replace(/<Relationship\b[^>]*>/g,m=>{const id=(m.match(/Id="([^"]+)"/)||[])[1],t=(m.match(/Target="([^"]+)"/)||[])[1];if(id&&t)rels[id]=t;return m;});
    const nameToFile={};
    dec.decode(files['xl/workbook.xml']||new Uint8Array()).replace(/<sheet\b[^>]*?\/?>/g,m=>{const nm=(m.match(/name="([^"]+)"/)||[])[1],rid=(m.match(/r:id="([^"]+)"/)||[])[1];if(nm&&rid&&rels[rid]){let t=rels[rid].replace(/^\//,'');if(!t.startsWith('xl/'))t='xl/'+t;nameToFile[_unescapeXml(nm)]=t;}return m;});
    for(const [name,rows] of Object.entries(freezeMap)){const f=nameToFile[name];if(f&&files[f])files[f]=enc.encode(_injectPane(dec.decode(files[f]),rows));}
    return fflate.zipSync(files,{level:6});
  }catch(e){return bytes;}
}
export function wbBlob(wb){
  let out=XLSX.write(wb,{bookType:'xlsx',type:'array'});
  out=applyFreeze(new Uint8Array(out),_freeze);_freeze={};
  return new Blob([out],{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
}
/* append a sheet + remember how many header rows to freeze (0 = none) */
export function addSheet(wb,ws,base,used,freezeRows){
  const nm=safeSheetName(base,used);
  XLSX.utils.book_append_sheet(wb,ws,nm);
  if(freezeRows)_freeze[nm]=freezeRows;
  return nm;
}
export function visDepth(roots){let m=0;const w=n=>{if(n.depth>m)m=n.depth;kidsOf(n).forEach(w);};roots.forEach(w);return m+1;}
export function filterSsm(rows){return uniqueSsmRows(rows).filter(([e])=>!((isSpareName(e)&&!S.showSpares)||(isSpaceName(e)&&!S.showSpaces)));}
export function safeSheetName(base,used){
  let name=String(base).replace(/[\\\/\?\*\[\]:]/g,' ').replace(/\s+/g,' ').trim().slice(0,31)||'Sheet';
  if(!used.has(name.toLowerCase())){used.add(name.toLowerCase());return name;}
  let i=2,cand;do{const suf=' ('+i+')';cand=name.slice(0,31-suf.length)+suf;i++;}while(used.has(cand.toLowerCase()));
  used.add(cand.toLowerCase());return cand;
}
/* in-app dialog: combine vs separate. Resolves 'combined' | 'separate' | null */
export function askExportMode(kind){
  return new Promise(resolve=>{
    const back=$('#modal');
    $('#modalTitle').textContent='Export '+kind;
    $('#modalMsg').textContent='You have '+S.sheets.length+' tabs selected. Combine them into one sheet, or keep one sheet per source tab?';
    const acts=$('#modalActions');
    acts.innerHTML=`<button class="btn ghost" data-v="cancel">Cancel</button>
      <button class="btn" data-v="separate">${ic('square-stack')}One per tab</button>
      <button class="btn primary" data-v="combined">${ic('layers')}Combine</button>`;
    const close=v=>{back.classList.remove('show');document.removeEventListener('keydown',onKey);back.onclick=null;resolve(v);};
    acts.querySelectorAll('button').forEach(b=>b.onclick=()=>close(b.dataset.v==='cancel'?null:b.dataset.v));
    const onKey=e=>{if(e.key==='Escape')close(null);};
    back.onclick=e=>{if(e.target===back)close(null);};
    document.addEventListener('keydown',onKey);
    back.classList.add('show');
  });
}
/* ---- professional worksheet styling (xlsx-js-style) ---- */
export const XL_HEAD={font:{bold:true,sz:11,color:{rgb:'FFFFFF'}},fill:{patternType:'solid',fgColor:{rgb:'1F2937'}},alignment:{vertical:'center',horizontal:'left'},border:{bottom:{style:'medium',color:{rgb:'0F172A'}}}};
export const XL_ROOT={font:{bold:true,color:{rgb:'0F172A'}}};
export const XL_PCT={alignment:{horizontal:'center'}};
export const XL_DIFF={font:{bold:true,color:{rgb:'9A3412'}}};
export const CMP_STYLE={
  'Matching':{fill:{patternType:'solid',fgColor:{rgb:'DCFCE7'}},font:{bold:true,color:{rgb:'166534'}},alignment:{horizontal:'center'}},
  'Non-Matching':{fill:{patternType:'solid',fgColor:{rgb:'FEF3C7'}},font:{bold:true,color:{rgb:'92400E'}},alignment:{horizontal:'center'}},
  'No Comparison':{fill:{patternType:'solid',fgColor:{rgb:'F1F5F9'}},font:{bold:true,color:{rgb:'475569'}},alignment:{horizontal:'center'}}
};
export function styleHeaderRow(ws,rowIdx){
  const rng=XLSX.utils.decode_range(ws['!ref']);
  for(let c=rng.s.c;c<=rng.e.c;c++){const ad=XLSX.utils.encode_cell({r:rowIdx,c});const cell=ws[ad];if(cell&&clean(cell.v)!=='')cell.s=XL_HEAD;}
  const rows=ws['!rows']||[];rows[rowIdx]={hpt:20};ws['!rows']=rows;
}
export function setFilter(ws,headerRow){
  const rng=XLSX.utils.decode_range(ws['!ref']);
  ws['!autofilter']={ref:XLSX.utils.encode_range({s:{r:headerRow,c:rng.s.c},e:{r:rng.e.r,c:rng.e.c}})};
}
/* Indented hierarchy; depth -> column. Dependency sits in the cell right after the
   node's name (one column over), per request. Spares/Spaces honor the view toggles. */
export function addHierSheet(wb,name,roots,used){
  const vr=roots.filter(r=>!nodeHidden(r)),levels=visDepth(vr),width=S.hasCable?levels+1:levels,aoa=[];
  const walk=n=>{const row=new Array(width).fill('');row[n.depth]=n.name;
    if(S.hasCable){const d=nodeDep(n);if(d)row[n.depth+1]=d;}
    aoa.push(row);kidsOf(n).forEach(walk);};
  vr.forEach(walk);
  const ws=XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols']=Array.from({length:width},()=>({wch:22}));
  const rng=XLSX.utils.decode_range(ws['!ref']);            // bold the top-level (root) rows
  for(let R=0;R<=rng.e.r;R++){const ad=XLSX.utils.encode_cell({r:R,c:0});const cell=ws[ad];if(cell&&clean(cell.v)!=='')cell.s=XL_ROOT;}
  addSheet(wb,ws,name,used,0);
}
/* Exto SSM: UPN -> G, Equipment ID -> K, Closest Parent -> P, Dependencies -> AM (header row 2, data row 3).
   Load Description rows: Closest Parent blank, Dependency = equipment above. */
export function extoLayerEnabled(){
  const exto=activeProfile().hierarchy&&activeProfile().hierarchy.exto;
  return !exto||exto.enabled!==false;
}
export function addExtoSheet(wb,name,rows,used){
  /* The EXTO layer is optional (spec §8.1): sites on other Cx software disable
     it and only the plain SSM outputs are produced. Column layout is profile
     data per Standardized Upload Template Rev21, so a template revision never
     requires code. Rev21 conventions honored here: roots attach to their own
     System Name (not blank), and header names match the template exactly. */
  if(!extoLayerEnabled())return;
  const cfg=activeProfile().hierarchy&&activeProfile().hierarchy.extoColumns||{};
  const G=cfg.upn??6,K=cfg.equipmentId??10,P=cfg.closestParent??15,AN=cfg.dependencies??39,MS=cfg.milestone??24,IM=cfg.itemMaster??26,CL=cfg.classification??35;
  const W=Math.max(G,K,P,AN,MS,IM,CL)+1,aoa=[];
  aoa.push(new Array(W).fill(''));
  const head=new Array(W).fill('');head[G]='UPN';head[K]='Equipment ID';head[P]='Closest Parent';head[AN]='Dependencies';
  if(MS>=0)head[MS]='Milestone';if(IM>=0)head[IM]='Item Master Unique Identifier';if(CL>=0)head[CL]='Equipment Classification';aoa.push(head);
  const hierarchyCfg=activeProfile().hierarchy||{};
  const rootsAttachToSystem=hierarchyCfg.melSeed&&hierarchyCfg.melSeed.enabled!==false;
  for(const r of filterSsm(rows)){
    const {equip,parent,dep}=ssmRegisterResolve(r),record=canonicalRecord(equip);
    const row=new Array(W).fill('');row[G]=melUpn(equip);row[K]=equip;
    const parentValue=clean(parent);
    /* Rev21 registry convention: a root's Closest Parent is its own System
       Name. Legacy (Eagle) keeps the frozen N/A rendering. */
    row[P]=parentValue?registerDisplayValue(parentValue)
      :(rootsAttachToSystem&&record&&recordAttribute(record,'system'))||registerDisplayValue(parentValue);
    row[AN]=registerDisplayValue(dep);
    if(MS>=0)row[MS]=record&&record.milestone?record.milestone.label:'';
    if(IM>=0)row[IM]=record&&record.itemMaster?record.itemMaster.name:'';
    if(CL>=0)row[CL]=record&&record.attributes&&record.attributes.equipmentClassification||'';
    aoa.push(row);
  }
  const ws=XLSX.utils.aoa_to_sheet(aoa);
  const cols=new Array(W).fill(0).map(()=>({wch:9}));cols[G]={wch:12};cols[K]={wch:26};cols[P]={wch:26};cols[AN]={wch:24};if(MS>=0)cols[MS]={wch:34};if(IM>=0)cols[IM]={wch:28};ws['!cols']=cols;
  styleHeaderRow(ws,1);                                     // only the mapped header cells are non-empty
  addSheet(wb,ws,name,used,2);
}
/* Plain SSM register: Equipment ID, Closest Parent, Dependencies, UPN, then the
   partition columns the Compiler groups by (spec §8.1). */
export function addSsm3Sheet(wb,name,rows,used){
  const aoa=[['Equipment ID','Closest Parent','Dependencies','UPN','System','Building','Discipline','L2 Milestone','Sequence']];
  for(const r of filterSsm(rows)){
    const {equip,parent,dep}=ssmRegisterResolve(r),record=canonicalRecord(equip);
    aoa.push([equip,registerDisplayValue(parent),registerDisplayValue(dep),melUpn(equip),
      record?recordAttribute(record,'system'):'',record?recordAttribute(record,'building'):'',record?recordAttribute(record,'discipline'):'',
      record&&record.milestone?record.milestone.label:'',record&&record.sequence!=null?record.sequence:'']);
  }
  const ws=XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols']=[{wch:28},{wch:28},{wch:24},{wch:12},{wch:24},{wch:14},{wch:14},{wch:34},{wch:10}];
  styleHeaderRow(ws,0);setFilter(ws,0);
  addSheet(wb,ws,name,used,1);
}
/* UPN predecessor matrix (spec §8.3) — the contract "one pager", derived. */
export function addPredecessorMatrixSheet(wb,used){
  const precedence=S.upnPrecedence;
  if(!precedence||(!precedence.edges.length&&!precedence.order.length))return;
  const edgeAoa=[['Predecessor UPN','Successor UPN','Via']];
  for(const edge of precedence.edges)edgeAoa.push([edge.from,edge.to,edge.via.join('; ')]);
  if(precedence.cycles.length)edgeAoa.push(['CYCLE — review required',precedence.cycles.join(', '),'']);
  const edgeWs=XLSX.utils.aoa_to_sheet(edgeAoa);
  edgeWs['!cols']=[{wch:18},{wch:18},{wch:60}];styleHeaderRow(edgeWs,0);setFilter(edgeWs,0);
  addSheet(wb,edgeWs,'UPN Predecessors',used,1);
  const upns=[...new Set([...precedence.order,...precedence.cycles])];
  const matrixAoa=[['Pred \\ Succ',...upns]];
  for(const from of upns)matrixAoa.push([from,...upns.map(to=>precedence.edges.some(e=>e.from===from&&e.to===to)?'X':'')]);
  const matrixWs=XLSX.utils.aoa_to_sheet(matrixAoa);
  matrixWs['!cols']=[{wch:14},...upns.map(()=>({wch:8}))];styleHeaderRow(matrixWs,0);
  addSheet(wb,matrixWs,'UPN Matrix',used,1);
}
/* QA scorecard + exceptions (spec §8.4): the acceptance-criteria KPIs computed
   locally, so an upload arrives pre-green — or arrives with a precise list of
   what is missing and which document unlocks it. */
export function addQaSheets(wb,used){
  const records=[...S.canonicalModel.values()].filter(record=>record.includeInRegister&&!record.isSyntheticRollup);
  if(!records.length)return;
  const total=records.length;
  const withMel=records.filter(record=>record.mel).length;
  const withParent=records.filter(record=>record.ssmParentTag).length;
  const withDeps=records.filter(record=>record.dependencies.size).length;
  const rungs=[1,2,3,4].map(rung=>records.filter(record=>record.milestone&&record.milestone.rung===rung).length);
  /* An orphan is disconnected, not merely a root: system roots with children
     (a GIS, an MAH with its VFDs) are legitimate tops of their blocks. */
  const parentTags=new Set(records.map(record=>tagKey(record.ssmParentTag)).filter(Boolean));
  const orphans=records.filter(record=>!record.ssmParentTag&&!record.dependencies.size
    &&!parentTags.has(record.key)&&!isSystemName(record.tag));
  const contradictions=[],cableMissing=[];
  for(const row of S.melRows||[]){
    const record=canonicalRecord(row.tag),asserted=clean(row.systemParent);
    const derived=record&&record.ssmParentTag||'';
    if(asserted&&derived&&tagKey(asserted)!==tagKey(derived))contradictions.push({tag:row.tag,asserted,derived});
  }
  for(const [loadLower,panel] of S.deps||[]){
    const record=canonicalRecord(loadLower);
    if(!record||!record.mel)cableMissing.push({load:loadLower,panel});
  }
  const cycles=S.upnPrecedence&&S.upnPrecedence.cycles||[];
  const pct=count=>total?Math.round(count/total*1000)/10+'%':'—';
  const scoreAoa=[['KPI','Value'],
    ['Register rows (non-synthetic)',total],
    ['Tag vs MEL validation',pct(withMel)],
    ['Records with structural parent',pct(withParent)],
    ['Records with dependencies',pct(withDeps)],
    ['Milestone rung 1 (direct P6 equipment match)',rungs[0]],
    ['Milestone rung 2 (explicit UPN column)',rungs[1]],
    ['Milestone rung 3 (milestone-name pattern)',rungs[2]],
    ['Milestone rung 4 (building-ready default)',rungs[3]],
    ['Orphans (no parent, no dependencies)',orphans.length],
    ['MEL assertions contradicting the wiring',contradictions.length],
    ['Cable loads absent from the MEL',cableMissing.length],
    ['UPN precedence cycles',cycles.length]];
  const imAssigned=records.filter(record=>record.itemMaster).length;
  const imReview=records.filter(record=>record.itemMasterReview).length;
  const imAudit=S.imAudit||[];
  if(imAssigned||imReview||imAudit.length){
    scoreAoa.push(['Item masters auto-assigned',imAssigned],
      ['Item masters needing review',imReview],
      ['Registry item-master audit findings',imAudit.length]);
  }
  const scoreWs=XLSX.utils.aoa_to_sheet(scoreAoa);
  scoreWs['!cols']=[{wch:44},{wch:14}];styleHeaderRow(scoreWs,0);
  addSheet(wb,scoreWs,'QA Scorecard',used,1);
  const exceptionsAoa=[['Type','Subject','Detail']];
  for(const upn of cycles)exceptionsAoa.push(['UPN cycle',upn,'Part of a precedence cycle — review dependencies']);
  for(const record of orphans)exceptionsAoa.push(['Orphan',record.tag,'No parent and no dependencies resolved']);
  for(const item of contradictions)exceptionsAoa.push(['MEL contradiction',item.tag,`wiring derives ${item.derived}; MEL asserts ${item.asserted}`]);
  for(const item of cableMissing)exceptionsAoa.push(['Cable load absent from MEL',item.load,`fed from ${item.panel}`]);
  for(const record of records)if(record.itemMasterReview)
    exceptionsAoa.push(['Item master needs review',record.tag,`candidates: ${record.itemMasterReview.join(' / ')}`]);
  for(const item of S.imAudit||[])
    exceptionsAoa.push(['Registry item-master audit',item.equipmentId,`${item.itemMaster||'(blank)'} on ${item.discipline}: ${item.reason}`]);
  if(exceptionsAoa.length>1){
    const exWs=XLSX.utils.aoa_to_sheet(exceptionsAoa);
    exWs['!cols']=[{wch:26},{wch:28},{wch:60}];styleHeaderRow(exWs,0);setFilter(exWs,0);
    addSheet(wb,exWs,'QA Exceptions',used,1);
  }
}
/* Completed MEL (spec §8.2) — the flywheel sheet: the MEL columns as imported,
   plus derived proposals with provenance. A blank System Parent cell gets the
   derived parent proposed; a filled one is reproduced untouched, and a
   disagreement with the wiring is flagged in the Contradiction column. */
export function addCompletedMelSheet(wb,used){
  if(!(S.melRows||[]).length)return;
  const aoa=[['Equipment Tag','Equipment Description','Building','Discipline','UPN','System Description',
    'System Parent Equipment Tag(s)','Proposed System Parent','Proposed Dependencies','Provenance','Contradiction']];
  for(const row of S.melRows){
    const record=canonicalRecord(row.tag),asserted=clean(row.systemParent);
    const derived=record&&record.ssmParentTag||'';
    const contradiction=asserted&&derived&&tagKey(asserted)!==tagKey(derived)
      ?`wiring derives ${derived}; MEL asserts ${asserted}`:'';
    aoa.push([row.tag,clean(row.description),clean(row.building),clean(row.discipline),clean(row.upn),clean(row.systemDescription),
      asserted,asserted?'':derived,
      record&&record.dependencies.size?[...record.dependencies].join('; '):'',
      record&&record.provenance.length?record.provenance.join(' | '):'',contradiction]);
  }
  const ws=XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols']=[{wch:26},{wch:28},{wch:12},{wch:14},{wch:10},{wch:22},{wch:26},{wch:26},{wch:26},{wch:30},{wch:40}];
  styleHeaderRow(ws,0);setFilter(ws,0);
  addSheet(wb,ws,'Completed MEL',used,1);
}
/* Change control (spec §8.5): the SOP requires approval to break a dependency,
   so a compile is diffed against the imported working copy and every broken
   dependency is called out separately from ordinary moves. */
export function addChangeControlSheet(wb,used){
  if(!S.wcRows||!S.wcRows.length)return;
  const splitList=value=>clean(value)?clean(value).split(/[;,]/).map(clean).filter(v=>v&&v.toLowerCase()!=='n/a'):[];
  const current=new Map();
  for(const r of S.ssmCombined){
    const {equip,parent,dep}=ssmRegisterResolve(r),key=tagKey(equip);
    if(!current.has(key))current.set(key,{parent:clean(parent),deps:new Set(splitList(dep).map(tagKey))});
  }
  const rows=[['Change','Equipment','Detail']];
  for(const wc of S.wcRows){
    const key=tagKey(wc.equip),now=current.get(key);
    if(!now){rows.push(['Removed from register',wc.equip,'Present in the working copy, absent from this compile']);continue;}
    for(const dep of splitList(wc.dep))if(!now.deps.has(tagKey(dep)))
      rows.push(['Broken dependency (requires approval)',wc.equip,`working copy depends on ${dep}; this compile does not`]);
    const wcParent=clean(wc.parent),nowParent=clean(now.parent);
    if(wcParent&&wcParent.toLowerCase()!=='n/a'&&tagKey(wcParent)!==tagKey(nowParent))
      rows.push(['Parent moved',wc.equip,`working copy under ${wcParent}; this compile under ${nowParent||'(root)'}`]);
  }
  if(rows.length===1)return;
  const ws=XLSX.utils.aoa_to_sheet(rows);
  ws['!cols']=[{wch:34},{wch:28},{wch:60}];styleHeaderRow(ws,0);setFilter(ws,0);
  addSheet(wb,ws,'Change Control',used,1);
}
/* Cross-Sheet Tag Review — Cable Schedule loads with no exact match in Easy Power. */
export function addReviewSheet(wb,used){
  if(!S.review.length)return;
  const src=(typeof sortReviewList==='function')?sortReviewList(S.review):S.review; // all unmatched, in display sort order
  const aoa=[['Load Name (To)','Panel (From)','Circuit_Number','Match 1','% 1','Match 2','% 2','Match 3','% 3']];
  for(const r of src){
    const m=r.matches;
    aoa.push([r.load,r.panel,r.circuit,
      m[0]?m[0].match:'',m[0]?m[0].pct:'',
      m[1]?m[1].match:'',m[1]?m[1].pct:'',
      m[2]?m[2].match:'',m[2]?m[2].pct:'']);
  }
  const ws=XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols']=[{wch:28},{wch:20},{wch:16},{wch:26},{wch:7},{wch:26},{wch:7},{wch:26},{wch:7}];
  const rng=XLSX.utils.decode_range(ws['!ref']);            // show % as "86%", centered, numeric-sortable
  for(let R=1;R<=rng.e.r;R++)for(const C of [4,6,8]){const cell=ws[XLSX.utils.encode_cell({r:R,c:C})];if(cell&&typeof cell.v==='number'){cell.z='0"%"';cell.s=XL_PCT;}}
  styleHeaderRow(ws,0);setFilter(ws,0);
  addSheet(wb,ws,'Cross-Sheet Tag Review',used,1);
}
export function addPlacementReviewSheet(wb,used){
  const rows=activePlacements();if(!rows.length)return;
  const aoa=[['Branch','Status','Source','Original Parent','Current Parent','Suggested Parent','Descendants','Reason']];
  for(const item of rows)aoa.push([item.branchName,placementState(item,false),item.source,item.originalParent||'',item.currentParent||'',item.suggestedParent||'',item.node?rawSubtreeCount(item.node):0,item.reason]);
  const ws=XLSX.utils.aoa_to_sheet(aoa);ws['!cols']=[{wch:28},{wch:14},{wch:22},{wch:25},{wch:25},{wch:25},{wch:12},{wch:54}];
  styleHeaderRow(ws,0);setFilter(ws,0);addSheet(wb,ws,'Placement Review',used,1);
}
/* Comparison — current register vs imported Current Working Copy. Honors the
   Spares/Spaces view toggles so it matches the register in the same workbook. */
export function addCompareSheet(wb,used){
  if(!S.wcRows||!S.compare.length)return;
  const rows=S.compare.filter(r=>!((isSpareName(r.equip)&&!S.showSpares)||(isSpaceName(r.equip)&&!S.showSpaces)));
  if(!rows.length)return;
  const label={off:'Non-Matching',nohit:'No Comparison',match:'Matching'};
  const aoa=[['Equipment ID','Status','Extracted Parent','Working Copy Parent','Extracted Dependency','Working Copy Dependency']];
  for(const r of rows)aoa.push([r.equip,label[r.status],registerDisplayValue(r.curParent),registerDisplayValue(r.wcParent),registerDisplayValue(r.curDep),registerDisplayValue(r.wcDep)]);
  const ws=XLSX.utils.aoa_to_sheet(aoa);ws['!cols']=[{wch:26},{wch:15},{wch:22},{wch:22},{wch:22},{wch:22}];
  rows.forEach((r,i)=>{
    const R=i+1;
    const st=ws[XLSX.utils.encode_cell({r:R,c:1})];if(st&&CMP_STYLE[st.v])st.s=CMP_STYLE[st.v];
    if(r.status==='off'){                                    // highlight the values that differ
      if(!sameWorkingRegisterValue(r.curParent,r.wcParent)){for(const C of[2,3]){const c=ws[XLSX.utils.encode_cell({r:R,c:C})];if(c)c.s=XL_DIFF;}}
      if(!sameWorkingDependencyValue(r.curDep,r.wcDep)){for(const C of[4,5]){const c=ws[XLSX.utils.encode_cell({r:R,c:C})];if(c)c.s=XL_DIFF;}}
    }
  });
  styleHeaderRow(ws,0);setFilter(ws,0);
  addSheet(wb,ws,'Comparison',used,1);
}
/* Show the spinning ring for exports likely to run past ~500ms. XLSX.write is a
   single synchronous call a timer can't preempt, so we gate on row count and show
   the ring up-front — its animation runs on the compositor, so it keeps spinning
   smoothly even while the write blocks the main thread. Small exports skip it. */
export const EXPORT_HEAVY_ROWS=6000;
export async function runExport(sub,estRows,work){
  const heavy=estRows>=EXPORT_HEAVY_ROWS;
  if(heavy){showOverlay('Preparing export',sub);await raf();await raf();}
  try{work();return true;}
  catch(e){console.error('export failed',e);toast('Export failed — please try again');return false;}
  finally{if(heavy){await sleep(160);hideOverlay();}}
}
export const ssmExportRows=()=>S.ssmCombined.length+S.review.length+activePlacements().length+(S.wcRows?S.compare.length:0);
export function hierarchyExportMode(){return modeById(activeProfile(),S.hierarchyExportMode);}
export function hierarchyExportProjection(){return S.projections[hierarchyExportMode().id]||{roots:[],stats:null};}
export function hierarchyExportRoots(){return hierarchyExportProjection().roots;}
export function hierarchyExportSlug(){return (clean(hierarchyExportMode().name)||'hierarchy').toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'')||'hierarchy';}
export async function exportHierarchyXlsx(){
  if(S.profileNeedsRebuild){toast('Rebuild the hierarchy before exporting');return;}
  const roots=hierarchyExportRoots();if(!roots.length){toast('Nothing to export');return;}
  const selectedMode=hierarchyExportMode(),stats=hierarchyExportProjection().stats;
  if(await runExport(selectedMode.name,stats?stats.nodes:0,()=>{
    const wb=XLSX.utils.book_new(),used=new Set();
    addHierSheet(wb,selectedMode.name,roots,used);downloadBlob(hierarchyExportSlug()+'.xlsx',wbBlob(wb));
  }))toast(selectedMode.name+' exported');
}
export async function exportExtoSSMXlsx(){
  if(!extoLayerEnabled()){toast('EXTO export is disabled in this profile');return;}
  if(S.profileNeedsRebuild){toast('Rebuild the hierarchy before exporting');return;}
  if(!S.ssmCombined.length){toast('Nothing to export');return;}
  let mode='combined';
  if(S.sheets.length>1){mode=await askExportMode('Exto SSM');if(!mode)return;}
  if(await runExport('Exto SSM',ssmExportRows(),()=>{
    const wb=XLSX.utils.book_new(),used=new Set();
    if(mode==='separate')S.sheets.forEach(sh=>addExtoSheet(wb,'SSM-'+sh.sheetName,resolvedRegisterRowsFor(sheetSsmRows(sh)),used));
    else addExtoSheet(wb,'Exto SSM',S.ssmCombined,used);
    addReviewSheet(wb,used);addPlacementReviewSheet(wb,used);addCompareSheet(wb,used);
    downloadBlob('exto-ssm-export.xlsx',wbBlob(wb));
  }))toast(mode==='separate'?S.sheets.length+' Exto SSM tabs exported':'Exto SSM exported');
}
export async function exportSSMXlsx(){
  if(S.profileNeedsRebuild){toast('Rebuild the hierarchy before exporting');return;}
  if(!S.ssmCombined.length){toast('Nothing to export');return;}
  let mode='combined';
  if(S.sheets.length>1){mode=await askExportMode('SSM');if(!mode)return;}
  if(await runExport('SSM',ssmExportRows(),()=>{
    const wb=XLSX.utils.book_new(),used=new Set();
    if(mode==='separate')S.sheets.forEach(sh=>addSsm3Sheet(wb,'SSM-'+sh.sheetName,resolvedRegisterRowsFor(sheetSsmRows(sh)),used));
    else addSsm3Sheet(wb,'SSM',S.ssmCombined,used);
    addCompletedMelSheet(wb,used);addPredecessorMatrixSheet(wb,used);addQaSheets(wb,used);addChangeControlSheet(wb,used);
    addReviewSheet(wb,used);addPlacementReviewSheet(wb,used);addCompareSheet(wb,used);
    downloadBlob('ssm-export.xlsx',wbBlob(wb));
  }))toast(mode==='separate'?S.sheets.length+' SSM tabs exported':'SSM exported');
}
export function exportOutlineTxt(){
  if(S.profileNeedsRebuild){toast('Rebuild the hierarchy before exporting');return;}
  const lines=[];
  const rec=(n,prefix,isLast,isRoot)=>{
    const d=nodeDep(n);
    lines.push((isRoot?n.name:prefix+(isLast?'└── ':'├── ')+n.name)+(d?'   ← '+d:''));
    const cp=isRoot?'':prefix+(isLast?'    ':'│   ');
    const vis=kidsOf(n);
    vis.forEach((c,i)=>rec(c,cp,i===vis.length-1,false));
  };
  const roots=hierarchyExportRoots().filter(r=>!nodeHidden(r));
  roots.forEach((r,i)=>{rec(r,'',true,true);if(i<roots.length-1)lines.push('');});
  const name=hierarchyExportSlug()+'.txt';
  downloadBlob(name,new Blob([lines.join('\n')],{type:'text/plain'}));toast('Outline exported');
}
