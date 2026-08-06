import { clean, esc, natCmp, KEYSEP } from '../core/text.js'
import { idleFrame } from '../core/async.js'
import { ic } from '../ui/icons.js'
import { S, cacheGet, cacheSet, isPanelCacheLive, markPanelCachePending, markPanelCacheReady, rememberPanelCache, restorePanelCache } from '../state.js'
import { copyTagHtml, copyTagListHtml, wireCopyTags } from '../ui/progress.js'
import { activePlacements, placementReviewSearchKey, rawSubtreeCount, registerDisplayValue, sameWorkingDependencyValue, sameWorkingRegisterValue, undoPlacement } from '../hierarchy/build.js'

/* ---- Review panel (cable not in Easy Power) ---- */
export function reviewMakeRow(r){
  const pm=r.matches.length
    ? `<div class="pmcell">${r.matches.map((m,i)=>`<span class="pm copy-tag ${i===0?'best':''}" data-copy-tag="${esc(m.match)}" title="Copy ${esc(m.match)}">${esc(m.match)}<span class="pmpct">${m.pct}%</span></span>`).join('')}</div>`
    : '<span class="muted">—</span>';
  const best=r.matches[0];
  const pct=best?`<span class="pct ${best.pct>=95?'hi':''}">${best.pct}%</span>`:'';
  return `<tr><td class="mono">${copyTagHtml(r.load)}</td><td class="mono">${copyTagHtml(r.panel||'—')}</td><td class="mono">${esc(r.circuit||'—')}</td><td>${pm}</td><td>${pct}</td></tr>`;
}
export function sortReviewList(rows){
  const s=S.revSort;if(!s)return rows;
  const dir=s.dir==='desc'?-1:1;
  const val=r=>s.col==='load'?r.load:s.col==='panel'?r.panel:s.col==='circuit'?r.circuit
    :s.col==='possible'?(r.matches[0]?r.matches[0].match:'')
    :(r.matches[0]?r.matches[0].pct:-1);
  return [...rows].sort((a,b)=>{const va=val(a),vb=val(b);return (s.col==='pct'?(va-vb):natCmp(va,vb))*dir;});
}
export function reviewSearchKey(r){return [r.load,r.panel,r.circuit,...r.matches.map(m=>m.match)].map(clean).join(' ').toLowerCase();}
export function reviewRows(){
  return getReviewRowsCache().rows;
}
export function reviewPanelCacheKey(){
  const sort=S.revSort?S.revSort.col+':'+S.revSort.dir:'';
  return ['review',S.reviewMode,S.review.length,activePlacements().length,S.placementRevision,S.revSearch,S.revMinPct==null?'':S.revMinPct,sort,S.reviewMode==='placement'?S.placementQuery:''].join(KEYSEP);
}
export function reviewRowsCacheKey(){return reviewPanelCacheKey();}
export function getReviewRowsCache(){
  const key=reviewRowsCacheKey(),hit=cacheGet(S.viewCache.reviewRows,key);
  if(hit)return hit;
  const q=clean(S.revSearch).toLowerCase(),minP=S.revMinPct;
  const rows=sortReviewList(S.review.filter(r=>{
    if(q&&!r.searchKey.includes(q))return false;
    if(minP!=null){const b=r.matches[0];if(!b||b.pct<minP)return false;}
    return true;
  }));
  const rec={key,rows,total:rows.length,html:[]};
  cacheSet(S.viewCache.reviewRows,key,rec);
  return rec;
}
export function renderReviewRowsVirtual(rec,key,el){
  mountVirtualRows('#revBody',rec.rows,reviewMakeRow,`<tr><td colspan="5" class="empty">No rows match the filter.</td></tr>`,{card:'#revCard',ind:'#revInd',colspan:5,cacheName:'review',key,panel:el,scrollSel:'#revCard',htmlCache:rec.html});
}
export function refreshReview(){
  if(S.reviewMode!=='cross'||!S.review.length)return;
  const el=$('#panel-review'),key=reviewPanelCacheKey();
  markPanelCachePending(el,key);
  const rec=getReviewRowsCache(),rows=rec.rows;
  $$('#panel-review th.sortable').forEach(th=>{th.classList.remove('sort-asc','sort-desc');const s=S.revSort;if(s&&s.col===th.dataset.sort)th.classList.add(s.dir==='asc'?'sort-asc':'sort-desc');});
  const cnt=$('#revCnt');if(cnt)cnt.textContent=`${S.review.length} unmatched${rows.length!==S.review.length?` · ${rows.length} shown`:''}`;
  renderReviewRowsVirtual(rec,key,el);
}
export function wireReviewPanel(){
  wireCopyTags($('#panel-review'));
  $$('#panel-review [data-review-mode]').forEach(btn=>btn.onclick=()=>{if(S.reviewMode===btn.dataset.reviewMode)return;S.reviewMode=btn.dataset.reviewMode;renderReviewPanel();});
  const rq=$('#rq');if(rq){let d;rq.oninput=()=>{clearTimeout(d);d=setTimeout(()=>{S.revSearch=rq.value;refreshReview();},220);};}
  const rqx=$('#rqx');if(rqx)rqx.onclick=()=>{S.revSearch='';const i=$('#rq');if(i){i.value='';i.focus();}$('#rqx').classList.remove('show');refreshReview();};
  const rp=$('#rpct');if(rp){let d;rp.addEventListener('input',()=>{clearTimeout(d);d=setTimeout(()=>{const v=parseFloat(rp.value);S.revMinPct=(rp.value===''||isNaN(v))?null:Math.max(0,Math.min(100,v));refreshReview();},220);});}
  $$('#panel-review th.sortable').forEach(th=>th.onclick=()=>{
    const col=th.dataset.sort,s=S.revSort;
    S.revSort=(!s||s.col!==col)?{col,dir:'asc'}:(s.dir==='asc'?{col,dir:'desc'}:null);
    refreshReview();
  });
}
export function reviewModesHtml(placementCount){const placements=placementCount==null?activePlacements().length:placementCount;return `<div class="review-modes" role="tablist" aria-label="Review type">
  <button class="review-mode ${S.reviewMode==='cross'?'on':''}" data-review-mode="cross" role="tab" aria-selected="${S.reviewMode==='cross'}">${ic('table-2')}Cross-Sheet Tag Review <span class="review-mode-count">${S.review.length}</span></button>
  <button class="review-mode ${S.reviewMode==='placement'?'on':''}" data-review-mode="placement" role="tab" aria-selected="${S.reviewMode==='placement'}">${ic('git-branch')}Placement Review <span class="review-mode-count">${placements}</span></button>
  </div>`;}
export function placementState(item,detail){
  if(item.status==='suggested')return detail?'Auto-placed · review recommended':'Suggested';
  if(item.status==='missing-data')return detail?'MEL data missing · relationship unchanged':'Missing MEL data';
  if(item.status==='duplicate-parent')return detail?'Listed under more than one parent · first kept':'Two parents';
  if(item.status==='bridged-gap')return detail?'Blank downstream level skipped · parent may be wrong':'Skipped level';
  if(item.status==='cable-conflict')return detail?'Fed from more than one panel · first kept':'Two feeds';
  return detail?'Needs a parent':'Needs parent';
}
export function placementRowsCacheKey(){return ['placement',S.placements.length,S.placementRevision,clean(S.placementQuery).toLowerCase()].join(KEYSEP);}
export function getPlacementRowsCache(){
  const key=placementRowsCacheKey(),hit=cacheGet(S.viewCache.placementRows,key);if(hit)return hit;
  const q=clean(S.placementQuery).toLowerCase(),items=[];let total=0;
  for(const item of S.placements){
    if(item.resolved)continue;total++;
    if(!item.searchKey)item.searchKey=placementReviewSearchKey(item);
    if(!q||item.searchKey.includes(q))items.push(item);
  }
  const rec={key,items,total};cacheSet(S.viewCache.placementRows,key,rec);return rec;
}
export function placementItemHtml(item){
  if(item._reviewHtmlRevision===S.placementRevision&&item._reviewHtml)return item._reviewHtml;
  const descendants=item.node?rawSubtreeCount(item.node):0,path=item.path&&item.path.length?item.path:[item.currentParent,item.branchName].filter(Boolean);
  /* Only claim a descendant count when there is a node to count. Entries raised
     before the display tree exists carry no node, and reporting "0 descendants"
     for a tag that visibly has children reads as fact rather than absence. */
  const meta=item.node?`${descendants} descendant${descendants===1?'':'s'} · ${esc(item.source)}`:esc(item.source);
  const pathHtml=path.length?path.map(tag=>copyTagHtml(tag)).join('<span class="tag-sep"> / </span>'):'Not currently placed';
  item._reviewHtml=`<button class="placement-item" data-placement="${item.id}"><div><div class="placement-name">${copyTagHtml(item.branchName)}</div><div class="placement-meta">${meta}</div></div>
    <div class="placement-reason"><span class="placement-reason-text">${esc(item.reason)}</span><span class="placement-path">${pathHtml}</span></div>
    <span class="placement-state">${ic(item.status==='suggested'?'circle-check':'triangle-alert')}${placementState(item,false)}</span></button>`;
  item._reviewHtmlRevision=S.placementRevision;return item._reviewHtml;
}
export function refreshPlacementReview(rec){
  const el=$('#panel-review'),host=$('#placementResults');if(!el||!host)return;
  rec=rec||getPlacementRowsCache();
  const count=$('#placementCnt');if(count)count.textContent=`${rec.total.toLocaleString()} to review${rec.items.length!==rec.total?` · ${rec.items.length.toLocaleString()} shown`:''}`;
  const ind=$('#placementInd');
  if(!rec.items.length){
    host.innerHTML=`<div class="note info">${ic('circle-check')}<div>${rec.total?'No placement items match this filter.':'No branches are waiting for placement review.'}</div></div>`;
    if(ind)ind.textContent='';markPanelCacheReady(el,reviewPanelCacheKey());return;
  }
  host.innerHTML='<div class="placement-list" id="placementList" aria-label="Branches awaiting placement review"><div class="placement-track"><div class="placement-window"></div></div></div>';
  mountVirtualPlacementRows($('#placementList'),rec.items,placementItemHtml,ind);
  markPanelCacheReady(el,reviewPanelCacheKey());
}
export function renderPlacementReviewPanel(el){
  const rec=getPlacementRowsCache();
  el.innerHTML=reviewModesHtml(rec.total)+`<div class="note warn" style="margin-bottom:12px">${ic('triangle-alert')}<div>Review branches that were auto-placed, could not be anchored safely, or could not complete a MEL parent check. Moving a branch keeps its full subtree together.</div></div>
    <div class="toolbar"><div class="search">${ic('search')}<input id="placementFilter" type="text" placeholder="Filter branches…" value="${esc(S.placementQuery)}" autocomplete="off"><button class="qx icon-btn ${S.placementQuery?'show':''}" id="placementFilterX" type="button" aria-label="Clear placement filter">${ic('x')}</button></div>
    <span class="placement-range" id="placementInd"></span><span class="hint" id="placementCnt"></span>
    ${S.lastPlacementMove?`<button class="btn sm spacer" id="placementUndo">${ic('rotate-ccw')}Undo last change</button>`:''}</div><div id="placementResults"></div>`;
  wireReviewPanel();
  refreshPlacementReview(rec);
  const input=$('#placementFilter');if(input){let timer;input.oninput=()=>{clearTimeout(timer);timer=setTimeout(()=>{S.placementQuery=input.value;S.placementScrollTop=0;$('#placementFilterX').classList.toggle('show',!!input.value);refreshPlacementReview();},160);};}
  const clear=$('#placementFilterX');if(clear)clear.onclick=()=>{S.placementQuery='';S.placementScrollTop=0;input.value='';clear.classList.remove('show');refreshPlacementReview();input.focus();};
  const undo=$('#placementUndo');if(undo)undo.onclick=undoPlacement;
}
export function renderReviewPanel(){
  const el=$('#panel-review');if(!el)return;
  const key=reviewPanelCacheKey();
  if(S.reviewMode==='placement'){bumpRender();renderPlacementReviewPanel(el);return;}
  if(isPanelCacheLive(el,key)){wireReviewPanel();renderReviewRowsVirtual(getReviewRowsCache(),key,el);return;}
  if(restorePanelCache('review',key,el,'#revCard')){wireReviewPanel();renderReviewRowsVirtual(getReviewRowsCache(),key,el);return;}
  bumpRender();
  markPanelCachePending(el,key);
  if(!S.review.length){
    el.innerHTML=reviewModesHtml()+`<div class="note info">${ic('circle-check')}<div>${S.hasCable?'Every Cable Schedule load has an exact match in the Easy Power import.':'No Cable Schedule was included for cross-sheet review.'}</div></div>`;
    wireReviewPanel();
    rememberPanelCache('review',key,el,null);return;
  }
  const sc=col=>S.revSort&&S.revSort.col===col?(S.revSort.dir==='asc'?'sort-asc':'sort-desc'):'';
  el.innerHTML=reviewModesHtml()+`
    <div class="note warn" style="margin-bottom:12px">${ic('triangle-alert')}<div>Cable Schedule loads with <b>no exact match</b> in the Easy Power hierarchy. Up to <b>3 possible matches</b> (best first) via strict near-matching — e.g. a <code>-</code> swapped for <code>_</code>. Click a column to sort; set a minimum % to filter weak matches.</div></div>
    <div class="toolbar">
      <div class="search">${ic('search')}<input id="rq" type="text" placeholder="Filter review…" value="${esc(S.revSearch)}" autocomplete="off"><button class="qx icon-btn ${S.revSearch?'show':''}" id="rqx" type="button" aria-label="Clear review filter">${ic('x')}</button></div>
      <label class="pctmin">${ic('filter')}<span>match ≥</span><input id="rpct" type="number" min="0" max="100" step="1" placeholder="—" value="${S.revMinPct!=null?S.revMinPct:''}"><span>%</span></label>
      <span class="stream-ind" id="revInd"></span>
      <span class="hint spacer" id="revCnt"></span>
    </div>
    <div class="tablecard" id="revCard"><table class="dtable review"><thead><tr>
      <th colspan="3" class="source-head cable"><span>Cable Schedule</span></th>
      <th colspan="2" class="source-head ep"><span>Easy Power</span></th>
    </tr><tr>
      <th class="sortable sub ${sc('load')}" data-sort="load">Load Name (To)</th>
      <th class="sortable sub ${sc('panel')}" data-sort="panel">Panel (From)</th>
      <th class="sortable sub ${sc('circuit')}" data-sort="circuit">Circuit_Number</th>
      <th class="sortable sub ${sc('possible')}" data-sort="possible">Possible Matches</th>
      <th class="sortable sub ${sc('pct')}" data-sort="pct">Best %</th>
    </tr></thead><tbody id="revBody"></tbody></table></div>`;
  wireReviewPanel();
  refreshReview();
}

/* ---- Comparison panel (vs Current Working Copy) ---- */
export const CMP_FILTERS=['all','off','gap','match','extra'];
export const CMP_LABEL={match:'Matching',off:'Non-Matching',nohit:'No Comparison',gap:'Missing from Extracted',extra:'Not in Working Copy'};
export const CMP_ICON={match:'check-check',off:'triangle-alert',nohit:'minus'};
export function cmpCounts(){const b=S.compareBuckets||{};return {off:(b.off||[]).length,nohit:(b.nohit||[]).length,match:(b.match||[]).length,gap:(b.gap||[]).length,extra:(b.extra||[]).length};}
export function compareSearchKey(r){return [r.equip,r.curParent,r.wcParent,r.curDep,r.wcDep].map(registerDisplayValue).join(' ').toLowerCase();}
export function compareSortKey(sort){return sort?sort.col+':'+sort.dir:'';}
export function comparePanelCacheKeyFor(filter,search,diff,sort){return ['compare',S.compare.length,filter,search,diff,compareSortKey(sort)].join(KEYSEP);}
export function comparePanelCacheKey(){return comparePanelCacheKeyFor(S.cmpFilter,S.cmpSearch,S.cmpDiff,S.cmpSort);}
export function compareRowsCacheKey(filter,search,diff,sort){return ['compareRows',S.compare.length,filter,search,diff,compareSortKey(sort)].join(KEYSEP);}
export function compareDiffMatch(r,diff){
  if(diff==='all')return true;
  const parent=!sameWorkingRegisterValue(r.curParent,r.wcParent),dep=!r.acceptedDepMismatch&&!sameWorkingDependencyValue(r.curDep,r.wcDep);
  return diff==='parent'?parent:diff==='dep'?dep:parent&&dep;
}
export function sortCompareList(rows,sort){
  if(!sort)return rows;
  const dir=sort.dir==='desc'?-1:1,statusOrder={off:0,nohit:1,match:2};
  const val=r=>sort.col==='equip'?r.equip:sort.col==='status'?statusOrder[r.status]
    :sort.col==='curParent'?r.curParent:sort.col==='wcParent'?r.wcParent
    :sort.col==='curDep'?r.curDep:r.wcDep;
  return [...rows].sort((a,b)=>{
    const av=val(a),bv=val(b),n=sort.col==='status'?(av-bv):natCmp(av,bv);
    return n*dir||natCmp(a.equip,b.equip);
  });
}
/* Default ordering for the combined view: discrepancies, then working-copy
   rows this build failed to produce, then confirmations — and only then the
   register rows the working copy never had, which flood the list by
   construction once the MEL seeds the register. */
export const CMP_BUCKET_ORDER={off:0,gap:1,match:2,extra:3};
export function compareBucketOf(r){return r.status==='nohit'?(r.inWc?'gap':'extra'):r.status;}
export function compareRowsFor(filter,search,diff,sort){
  const q=clean(search).toLowerCase();
  const base=(S.compareBuckets&&S.compareBuckets[filter])||S.compare;
  let rows=base;
  if(q)rows=rows.filter(r=>r.searchKey.includes(q));
  if(diff!=='all')rows=rows.filter(r=>compareDiffMatch(r,diff));
  if(!sort)return [...rows].sort((a,b)=>CMP_BUCKET_ORDER[compareBucketOf(a)]-CMP_BUCKET_ORDER[compareBucketOf(b)]||natCmp(a.equip,b.equip));
  return sortCompareList(rows,sort);
}
export function compareRows(){return compareRowsFor(S.cmpFilter,S.cmpSearch,S.cmpDiff,S.cmpSort);}
export function compareMakeCell(a,b,accepted){const diff=!accepted&&!sameWorkingRegisterValue(a,b),av=registerDisplayValue(a),bv=registerDisplayValue(b);return `<td class="mono ${diff?'diff':''}">${copyTagListHtml(av)}</td><td class="mono ${diff?'diff':''}">${copyTagListHtml(bv)}</td>`;}
export function compareMakeRow(r){
  const sub=r.status==='nohit'?`<span class="subtle">${r.inCur?'only in extracted':'only in working copy'}</span>`:'';
  return `<tr class="r-${r.status}"><td class="mono">${copyTagHtml(r.equip)}</td><td><span class="cbadge ${r.status}">${ic(CMP_ICON[r.status])}${CMP_LABEL[r.status]}</span>${sub}</td>${compareMakeCell(r.curParent,r.wcParent)}${compareMakeCell(r.curDep,r.wcDep,r.acceptedDepMismatch||sameWorkingDependencyValue(r.curDep,r.wcDep))}</tr>`;
}
export function getCompareRowsCache(filter,search,diff,sort){
  const key=compareRowsCacheKey(filter,search,diff,sort),hit=cacheGet(S.viewCache.compareRows,key);
  if(hit)return hit;
  const rows=compareRowsFor(filter,search,diff,sort),rec={key,filter,search,diff,sort,rows,total:rows.length,html:[],prewarmed:false};
  cacheSet(S.viewCache.compareRows,key,rec);
  return rec;
}
export function renderCompareRowsVirtual(rec,key,el){
  mountVirtualRows('#cmpBody',rec.rows,compareMakeRow,`<tr><td colspan="6" class="empty">No rows match.</td></tr>`,{card:'#cmpCard',ind:'#cmpInd',colspan:6,cacheName:'compare',key,panel:el,scrollSel:'#cmpCard',htmlCache:rec.html});
}
export async function prewarmCompareRows(filter,search,diff,sort,token){
  const rec=getCompareRowsCache(filter,search,diff,sort);
  if(rec.prewarmed)return;
  const end=Math.min(rec.rows.length,VIRTUAL_MAX_DOM_ROWS);
  for(let i=0;i<end;i++){
    if(token!==_cmpPrewarmTok)return;
    if(!rec.html[i])rec.html[i]=compareMakeRow(rec.rows[i]);
    if(i&&i%40===0)await idleFrame();
  }
  rec.prewarmed=true;
}
export function scheduleComparePrewarm(activeFilter,search,diff,sort){
  if(!S.wcRows||!S.compare.length)return;
  const token=++_cmpPrewarmTok;
  const order=[activeFilter,...CMP_FILTERS.filter(f=>f!==activeFilter)];
  (async()=>{
    for(const filter of order){
      if(token!==_cmpPrewarmTok)return;
      getCompareRowsCache(filter,search,diff,sort);
      await idleFrame();
    }
    for(const filter of order){
      if(token!==_cmpPrewarmTok)return;
      await prewarmCompareRows(filter,search,diff,sort,token);
      await idleFrame();
    }
  })();
}
export function refreshCompare(){
  if(!S.wcRows)return;
  const el=$('#panel-compare'),key=comparePanelCacheKey();
  markPanelCachePending(el,key);
  const rec=getCompareRowsCache(S.cmpFilter,S.cmpSearch,S.cmpDiff,S.cmpSort);
  $$('#panel-compare th.sortable').forEach(th=>{th.classList.remove('sort-asc','sort-desc');const s=S.cmpSort;if(s&&s.col===th.dataset.sort)th.classList.add(s.dir==='asc'?'sort-asc':'sort-desc');});
  const cnt=$('#cmpCnt');if(cnt)cnt.textContent=`${rec.rows.length.toLocaleString()} shown`;
  renderCompareRowsVirtual(rec,key,el);
  scheduleComparePrewarm(S.cmpFilter,S.cmpSearch,S.cmpDiff,S.cmpSort);
}
export function wireComparePanel(){
  wireCopyTags($('#panel-compare'));
  $$('[data-cf]').forEach(b=>b.onclick=()=>{S.cmpFilter=b.dataset.cf;renderComparePanel();});
  const cq=$('#cq');if(cq){let d;cq.oninput=()=>{clearTimeout(d);d=setTimeout(()=>{S.cmpSearch=cq.value;renderComparePanel();},250);};}
  const cqx=$('#cqx');if(cqx)cqx.onclick=()=>{S.cmpSearch='';renderComparePanel();};
  const diff=$('#cmpDiff');if(diff)diff.onchange=()=>{S.cmpDiff=diff.value;const card=$('#cmpCard');if(card)card.scrollTop=0;refreshCompare();};
  $$('#panel-compare th.sortable').forEach(th=>th.onclick=()=>{
    const col=th.dataset.sort,s=S.cmpSort;
    S.cmpSort=(!s||s.col!==col)?{col,dir:'asc'}:(s.dir==='asc'?{col,dir:'desc'}:null);
    const card=$('#cmpCard');if(card)card.scrollTop=0;refreshCompare();
  });
}
export function renderComparePanel(){
  const el=$('#panel-compare');if(!el)return;
  const key=comparePanelCacheKey();
  if(isPanelCacheLive(el,key)){wireComparePanel();renderCompareRowsVirtual(getCompareRowsCache(S.cmpFilter,S.cmpSearch,S.cmpDiff,S.cmpSort),key,el);scheduleComparePrewarm(S.cmpFilter,S.cmpSearch,S.cmpDiff,S.cmpSort);return;}
  if(restorePanelCache('compare',key,el,'#cmpCard')){wireComparePanel();renderCompareRowsVirtual(getCompareRowsCache(S.cmpFilter,S.cmpSearch,S.cmpDiff,S.cmpSort),key,el);scheduleComparePrewarm(S.cmpFilter,S.cmpSearch,S.cmpDiff,S.cmpSort);return;}
  bumpRender();
  markPanelCachePending(el,key);
  if(!S.wcRows){
    el.innerHTML=`<div class="note info">${ic('info')}<div>Import a <b>Current Working Copy</b> on the first screen to compare Equipment ID, Closest Parent and Dependency.</div></div>`;
    rememberPanelCache('compare',key,el,null);return;
  }
  const c=cmpCounts();
  const fchip=(k,label,n)=>`<button class="chip sm ${S.cmpFilter===k?'on':''}" data-cf="${k}">${esc(label)}${n!=null?` <span class="tabcount">${n}</span>`:''}</button>`;
  const dopt=(value,label)=>`<option value="${value}" ${S.cmpDiff===value?'selected':''}>${label}</option>`;
  const sc=col=>S.cmpSort&&S.cmpSort.col===col?(S.cmpSort.dir==='asc'?'sort-asc':'sort-desc'):'';
  el.innerHTML=`
    <div class="note info cmp-legend" style="margin-bottom:12px">${ic('git-branch')}<div>Comparing the <b>extracted</b> register against <b>${esc(S.workCopy?S.workCopy.name:'working copy')}</b>.
      <span class="lg"><span class="cbadge match">${ic('check-check')}Matching</span> parent &amp; dependency agree</span>
      <span class="lg"><span class="cbadge off">${ic('triangle-alert')}Non-Matching</span> a value differs (highlighted)</span>
      <span class="lg"><span class="cbadge nohit">${ic('minus')}No Comparison</span> present on only one side — <b>Missing from Extracted</b> is a working-copy row this build did not produce; <b>Not in Working Copy</b> is expected once the MEL seeds the full register</span></div></div>
    <div class="toolbar">
      ${fchip('all','All',S.compare.length)}${fchip('off','Non-Matching',c.off)}${fchip('gap','Missing from Extracted',c.gap)}${fchip('match','Matching',c.match)}${fchip('extra','Not in Working Copy',c.extra)}
      <label class="selectctl" title="Filter by changed field">${ic('filter')}<select id="cmpDiff" aria-label="Filter comparison differences">${dopt('all','All fields')}${dopt('parent','Parent differs')}${dopt('dep','Dependency differs')}${dopt('both','Both differ')}</select></label>
      <span class="stream-ind" id="cmpInd"></span>
      <span class="hint" id="cmpCnt"></span>
      <div class="search" style="margin-left:auto">${ic('search')}<input id="cq" type="text" placeholder="Find equipment…" value="${esc(S.cmpSearch)}" autocomplete="off"><button class="qx icon-btn ${S.cmpSearch?'show':''}" id="cqx" type="button" aria-label="Clear comparison filter">${ic('x')}</button></div>
    </div>
    <div class="tablecard" id="cmpCard"><table class="dtable cmp"><colgroup><col style="width:18%"><col style="width:14%"><col style="width:17%"><col style="width:17%"><col style="width:17%"><col style="width:17%"></colgroup><thead><tr><th rowspan="2" class="sortable ${sc('equip')}" data-sort="equip">Equipment ID</th><th rowspan="2" class="sortable ${sc('status')}" data-sort="status">Status</th><th colspan="2">Closest Parent</th><th colspan="2">Dependency</th></tr><tr><th class="sortable sub ${sc('curParent')}" data-sort="curParent">Extracted</th><th class="sortable sub ${sc('wcParent')}" data-sort="wcParent">Working copy</th><th class="sortable sub ${sc('curDep')}" data-sort="curDep">Extracted</th><th class="sortable sub ${sc('wcDep')}" data-sort="wcDep">Working copy</th></tr></thead><tbody id="cmpBody"></tbody></table></div>`;
  wireComparePanel();
  refreshCompare();
}

