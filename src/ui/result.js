import { $, $$, clean, esc, raf } from '../core/text.js'
import { normSep } from '../core/tags.js'
import { S, _virtualTok, clearResultCache, isPanelCacheLive, panelScroll, rememberPanelCache, rememberTreePanel, restoreTreePanel, tagKey } from '../state.js'
import { ic } from './icons.js'
import { copyTagListHtml, copyText, copyableTag, wireCopyTags } from './progress.js'
import { DEFAULT_DETAIL_LAYOUT, PROFILE_DETAIL_FIELDS, activeProfile } from '../profile/schema.js'
import { kidsOf, nodeDep, nodeHidden } from '../profile/classify.js'
import { activeModes, modeById } from '../hierarchy/modes.js'
import { activeHierarchyNodeMap, activeHierarchyRoots, activeHierarchyStats } from '../hierarchy/tree.js'
import { canonicalRecord } from '../hierarchy/projection.js'
import { acceptPlacement, activePlacements, equipmentRole, firstSystemParentTag, melResolvedRecord, movePlacementBranch, nodePath, placementCandidates, placementExpectedParentRole, rawSubtreeCount, resetSourceParentClaims, undoPlacement } from '../hierarchy/build.js'
import { comparePanelCacheKey, placementState, refreshCompare, refreshReview, renderComparePanel, renderReviewPanel, reviewPanelCacheKey } from '../review/panels.js'
import { exportExtoSSMXlsx, exportHierarchyXlsx, exportOutlineTxt, exportSSMXlsx } from '../export/xlsx.js'
import { go, render } from './screens.js'
import { injectProfileContext, openProfileStudio } from './studio.js'

/* ---- result screen ---- */
export function statCard(icon,label,val,muted){return `<div class="stat ${muted?'muted':''}"><div class="sl">${ic(icon)}${label}</div><div class="sv">${val}</div></div>`;}

/* The toggle, the caption and the drawer crosslink are built from the profile's
   mode list, so a profile declaring one mode or three renders correctly. */
export function hierarchyModeLabel(mode){return clean(mode&&mode.name)||clean(mode&&mode.id)||'Hierarchy';}
export function renderHierarchyModeToggle(){
  const modes=activeModes(activeProfile()),current=modeById(activeProfile(),S.hierarchyMode);
  return modes.map(mode=>`<button type="button" class="${clean(mode.id)===clean(current.id)?'on':''}" data-hierarchy-mode="${esc(mode.id)}">${ic(mode.icon||'folder-tree')}${esc(hierarchyModeLabel(mode))}</button>`).join('');
}
export function hierarchyModeCaption(){return modeById(activeProfile(),S.hierarchyMode).caption||'';}
/* The next mode to offer, wrapping at the end; null when there is nowhere to go.
   modeById may return a mode object rebuilt by the example fallback, so the
   position is found by id -- object identity would miss. */
export function nextHierarchyMode(){
  const modes=activeModes(activeProfile());if(modes.length<2)return null;
  const current=modeById(activeProfile(),S.hierarchyMode);
  const at=Math.max(0,modes.findIndex(mode=>clean(mode.id)===clean(current.id)));
  return modes[(at+1)%modes.length];
}
export function hierarchyCrosslinkHtml(){
  const next=nextHierarchyMode();if(!next)return '';
  return `<button class="btn view-crosslink" id="switchDetailView">${ic(next.icon||'folder-tree')}Show in ${esc(hierarchyModeLabel(next))}</button>`;
}
export function renderResult(){
  const st=activeHierarchyStats()||S.stats,placementCount=activePlacements().length;
  const tab=(t,label,icon,count)=>`<button class="tabbtn ${S.tab===t?'on':''}" data-tab="${t}">${ic(icon)}${esc(label)}${count!=null?`<span class="tabcount">${count}</span>`:''}</button>`;
  $('#view').innerHTML=`
  <section id="resultShell" class="${S.resultFullscreen?'fullscreen':''}">
    <div class="statwrap ${S.showStats?'':'collapsed'}" id="statwrap"><div class="statbar">
      ${statCard('network','Nodes',st.nodes)}
      ${statCard('tag','ID Names',st.idCount)}
      ${st.loads?statCard('corner-down-right','Loads',st.loads):''}
      ${st.instruments?statCard('database','Instruments',st.instruments):''}
      ${statCard('layers','Levels',st.maxDepth)}
      ${st.deps?statCard('spline','Deps',st.deps):''}
    </div></div>
    <div class="tabbar">
      ${tab('tree','Hierarchy','list-tree')}
      ${(S.hasCable||placementCount)?tab('review','Review','triangle-alert',st.review):''}
      ${S.wcRows?tab('compare','Comparison','git-branch',S.compare.length):''}
      <button class="statstoggle" id="statsToggle" aria-pressed="${S.showStats}" title="${S.showStats?'Hide stats':'Show stats'}">${ic(S.showStats?'chevrons-up':'chevrons-down')}<span>${S.showStats?'Hide stats':'Show stats'}</span></button>
      <button class="btn icon-btn fullbtn" id="fullscreenToggle" title="${S.resultFullscreen?'Exit full screen':'Full screen'}" aria-label="${S.resultFullscreen?'Exit full screen':'Full screen'}">${ic(S.resultFullscreen?'minimize-2':'maximize-2')}</button>
    </div>
    <div id="panel-tree" class="panel" ${S.tab!=='tree'?'hidden':''}>
      <div class="toolbar">
        <div class="hierarchy-mode" role="group" aria-label="Hierarchy view">
          ${renderHierarchyModeToggle()}
        </div>
        <span class="hierarchy-caption">${esc(hierarchyModeCaption())}</span>
        <button class="btn sm" id="resultProfile" style="margin-left:auto">${ic('sliders-horizontal')}Profile</button>
      </div>
      <div class="toolbar">
        <div class="search">${ic('search')}<input id="q" type="text" placeholder="Search by ID Name or tag…" autocomplete="off" spellcheck="false"><button class="qx icon-btn" id="qx" type="button" aria-label="Clear search">${ic('x')}</button></div>
        <button class="chip ${S.idOnly?'on':''}" id="idOnly" aria-pressed="${S.idOnly}" title="Match only ID Names (final loads)">${ic('tag')}ID Names only</button>
        <button class="chip ${S.showSpares?'on':''}" id="tgSpares" aria-pressed="${S.showSpares}" title="Show spares (SP- prefix)">${ic('square-stack')}Spares</button>
        <button class="chip ${S.showSpaces?'on':''}" id="tgSpaces" aria-pressed="${S.showSpaces}" title="Show spaces (&quot;Space&quot;)">${ic('minus')}Spaces</button>
        ${st.deps?`<button class="chip ${S.showDeps?'on':''}" id="tgDeps" aria-pressed="${S.showDeps}" title="Show dependencies">${ic('spline')}Dependencies</button>`:''}
        ${st.instruments?`<button class="chip ${S.showPmdMatches?'on':''}" id="tgPmd" aria-pressed="${S.showPmdMatches}" title="Show matched PMD panels">${ic('database')}PMD panels</button>`:''}
      </div>
      <div class="toolbar">
        <button class="btn sm" id="expandAll">${ic('chevrons-down')}Expand all</button>
        <button class="btn sm" id="collapseAll">${ic('chevrons-up')}Collapse</button>
        <div class="exp"><span class="lab">Export</span>
          <label class="selectctl" title="Hierarchy view for hierarchy and outline exports"><select id="hierarchyExportMode" aria-label="Hierarchy export view">
            ${activeModes(activeProfile()).map(mode=>`<option value="${esc(mode.id)}" ${S.hierarchyExportMode===mode.id?'selected':''}>${esc(mode.name)}</option>`).join('')}
          </select></label>
          <button class="btn sm" id="expHier" title="Indented tree — depth becomes column (dependency next to ID Name)">${ic('file-down')}Hierarchy</button>
          <button class="btn sm" id="expExto" title="Exto SSM — Equipment ID (K), Closest Parent (P), Dependencies (AM) + Review/Comparison tabs">${ic('file-down')}Exto SSM</button>
          <button class="btn sm" id="expSSM" title="SSM — Equipment ID, Closest Parent, Dependencies + Review/Comparison tabs">${ic('file-down')}SSM</button>
          <button class="btn sm" id="expTxt" title="Plain-text outline">${ic('file-text')}Outline</button>
        </div>
      </div>
      <div id="qinfo"></div>
      <div class="treecard"><div id="tree" role="tree" aria-label="${esc(hierarchyModeLabel(modeById(activeProfile(),S.hierarchyMode)))}"></div></div>
    </div>
    <div id="panel-review" class="panel" ${S.tab!=='review'?'hidden':''}></div>
    <div id="panel-compare" class="panel" ${S.tab!=='compare'?'hidden':''}></div>
    <div class="result-foot">
      <button class="btn ghost" id="backSheets">${ic('arrow-left')}Back to sheets</button>
      <button class="btn spacer" id="startover">${ic('rotate-ccw')}Start over</button>
    </div>
  </section>`;
  const treeRestored=restoreTreePanel();
  wireResult();
  if(!treeRestored)renderTreeCollapsed();
  if(S.tab==='review')renderReviewPanel();else if(S.tab==='compare')renderComparePanel();
  injectProfileContext();
}
export function wireResult(){
  $('#backSheets').onclick=()=>go('sheets');
  $('#startover').onclick=()=>{S.roots=[];S.stats=null;S.workCopy=null;S.wcRows=null;S.canonicalModel=new Map();S.projections={};S.profileNeedsRebuild=false;resetSourceParentClaims();clearResultCache();go('upload');};
  $('#expandAll').onclick=()=>expandAll();
  $('#collapseAll').onclick=()=>collapseAll();
  $('#expHier').onclick=exportHierarchyXlsx;
  $('#expExto').onclick=exportExtoSSMXlsx;
  $('#expSSM').onclick=exportSSMXlsx;
  $('#expTxt').onclick=exportOutlineTxt;
  $('#fullscreenToggle').onclick=()=>setResultFullscreen(!S.resultFullscreen);
  $('#resultProfile').onclick=()=>openProfileStudio('overview');
  $$('[data-hierarchy-mode]').forEach(button=>button.onclick=()=>setHierarchyMode(button.dataset.hierarchyMode));
  const exportMode=$('#hierarchyExportMode');if(exportMode)exportMode.onchange=()=>{S.hierarchyExportMode=exportMode.value;};
  $$('.tabbtn').forEach(b=>b.onclick=()=>setTab(b.dataset.tab));
  const stg=$('#statsToggle');
  if(stg)stg.onclick=()=>{
    S.showStats=!S.showStats;
    const bar=$('#statwrap');if(bar)bar.classList.toggle('collapsed',!S.showStats);
    stg.setAttribute('aria-pressed',S.showStats);
    stg.title=S.showStats?'Hide stats':'Show stats';
    stg.innerHTML=`${ic(S.showStats?'chevrons-up':'chevrons-down')}<span>${S.showStats?'Hide stats':'Show stats'}</span>`;
  };
  const q=$('#q'),qx=$('#qx');let dt;
  q.addEventListener('input',()=>{qx.classList.toggle('show',!!q.value);clearTimeout(dt);dt=setTimeout(()=>{S.search=q.value.trim();runSearch();},300);});
  qx.onclick=()=>{q.value='';qx.classList.remove('show');S.search='';runSearch();q.focus();};
  const togChip=(id,get,set,after)=>{const el=$('#'+id);if(!el)return;el.onclick=()=>{const v=!get();set(v);el.classList.toggle('on',v);el.setAttribute('aria-pressed',v);after();};};
  const reflow=()=>{if(S.search)runSearch();else renderTreeCollapsed();};
  togChip('idOnly',()=>S.idOnly,v=>S.idOnly=v,reflow);
  togChip('tgSpares',()=>S.showSpares,v=>S.showSpares=v,reflow);
  togChip('tgSpaces',()=>S.showSpaces,v=>S.showSpaces=v,reflow);
  togChip('tgDeps',()=>S.showDeps,v=>S.showDeps=v,()=>$('#tree').classList.toggle('hide-deps',!S.showDeps));
  togChip('tgPmd',()=>S.showPmdMatches,v=>S.showPmdMatches=v,()=>$('#tree').classList.toggle('hide-pmd',!S.showPmdMatches));
}
export function setHierarchyMode(mode){
  const modes=activeModes(activeProfile());
  if(!modes.some(item=>clean(item.id)===clean(mode))||mode===S.hierarchyMode)return;
  rememberTreePanel();S.hierarchyMode=mode;clearResultCache();renderResult();
  if(S.selectedEquipmentKey)requestAnimationFrame(()=>{
    const key=S.selectedEquipmentKey;
    revealCanonicalRecord(key);
    const node=[...activeHierarchyNodeMap().values()].find(item=>item.canonicalKey===key);
    if(node&&$('#drawer').classList.contains('show'))openDetail(node.id);
  });
}
export function revealCanonicalRecord(key){
  const node=[...activeHierarchyNodeMap().values()].find(item=>item.canonicalKey===key);if(!node)return;
  if(S.search){S.search='';const q=$('#q');if(q)q.value='';}
  renderTreeCollapsed();
  const path=[];for(let current=node.parent;current;current=current.parent)path.unshift(current);
  for(const ancestor of path){
    const row=$(`#tree .row[data-id="${ancestor.id}"]`);if(row&&kidsOf(ancestor).length&&!row.classList.contains('open'))expandNode(row,ancestor);
  }
  const row=$(`#tree .row[data-id="${node.id}"]`);if(row){row.scrollIntoView({block:'center',behavior:'smooth'});row.focus({preventScroll:true});}
}
export function setResultFullscreen(on){
  on=!!on;S.resultFullscreen=on;
  const resultShell=$('#resultShell');if(!resultShell)return;
  resultShell.classList.toggle('fullscreen',on);
  document.body.classList.toggle('result-fullscreen',on);
  const btn=$('#fullscreenToggle');if(btn){btn.title=on?'Exit full screen':'Full screen';btn.setAttribute('aria-label',btn.title);btn.innerHTML=ic(on?'minimize-2':'maximize-2');}
  requestAnimationFrame(()=>{if(S.tab==='review')refreshReview();else if(S.tab==='compare')refreshCompare();});
}
export function setTab(t){
  if(t===S.tab)return;
  cacheActiveResultPanel();
  S.tab=t;bumpRender();
  $$('.tabbtn').forEach(b=>b.classList.toggle('on',b.dataset.tab===t));
  [['tree','#panel-tree'],['review','#panel-review'],['compare','#panel-compare']].forEach(([k,sel])=>{const el=$(sel);if(el)el.hidden=k!==t;});
  if(t==='review')renderReviewPanel();
  else if(t==='compare')renderComparePanel();
}
export function cacheActiveResultPanel(){
  if(S.tab==='tree')rememberTreePanel();
  else if(S.tab==='review'){
    const el=$('#panel-review'),key=reviewPanelCacheKey();
    if(isPanelCacheLive(el,key))rememberPanelCache('review',key,el,'#revCard');
  }else if(S.tab==='compare'){
    const el=$('#panel-compare'),key=comparePanelCacheKey();
    if(isPanelCacheLive(el,key))rememberPanelCache('compare',key,el,'#cmpCard');
  }
}
export function setQInfo(html){const e=$('#qinfo');if(e)e.innerHTML=html||'';}

/* Progressively fill a <tbody> WITHOUT a blocking overlay: the first rows show
   immediately and the rest stream in over animation frames, so the page stays
   navigable. A render token cancels an in-flight stream if the view changes. */
export let _renderTok=0;
export function bumpRender(){_renderTok++;}
export async function streamRows(sel,items,makeRow,emptyHtml,ui){
  const tok=++_renderTok;
  let tb=$(sel);if(!tb)return;
  const card=ui&&ui.card?$(ui.card):null;
  const setInd=t=>{if(ui&&ui.ind){const e=$(ui.ind);if(e)e.textContent=t||'';}};
  const stop=()=>{if(card)card.classList.remove('loading');setInd('');};
  if(!items.length){tb.innerHTML=emptyHtml;if(ui&&ui.onDone)ui.onDone();stop();return;}
  const N=items.length,FIRST=Math.min(N,200),CHUNK=600;
  let i=0,buf='';
  for(;i<FIRST;i++)buf+=makeRow(items[i]);
  tb.innerHTML=buf;                         // instant, usable table
  if(i>=N){if(ui&&ui.onDone)ui.onDone();stop();return;}
  if(card)card.classList.add('loading');setInd(`${i.toLocaleString()} / ${N.toLocaleString()}`);
  while(i<N){
    await raf();
    if(tok!==_renderTok)return;             // superseded by a newer render -> abandon
    const end=Math.min(N,i+CHUNK);let frag='';
    for(;i<end;i++)frag+=makeRow(items[i]);
    tb=$(sel);if(!tb||tok!==_renderTok)return;
    tb.insertAdjacentHTML('beforeend',frag);
    setInd(`${i.toLocaleString()} / ${N.toLocaleString()}`);
  }
  if(ui&&ui.onDone)ui.onDone();
  stop();
}
export const VIRTUAL_ROW_HEIGHT=44;
export const VIRTUAL_OVERSCAN=16;
export const VIRTUAL_MAX_DOM_ROWS=180;
export function virtualSpacerRow(height,colspan){
  return height>0?`<tr class="v-spacer" aria-hidden="true"><td colspan="${colspan}" style="height:${Math.max(0,Math.round(height))}px"></td></tr>`:'';
}
export function virtualRowsHtml(rows,makeRow,start,end,cache){
  let html='';
  for(let i=start;i<end;i++)html+=cache?(cache[i]||(cache[i]=makeRow(rows[i]))):makeRow(rows[i]);
  return html;
}
export function mountVirtualRows(tbodySel,rows,makeRow,emptyHtml,opts){
  const tb=$(tbodySel),card=opts&&opts.card?$(opts.card):null,ind=opts&&opts.ind?$(opts.ind):null;
  if(!tb||!card)return;
  const token=++_virtualTok,colspan=opts.colspan||1,cache=opts.htmlCache||null;
  let frame=0;
  const setInd=t=>{if(ind)ind.textContent=t||'';};
  const remember=()=>{if(opts.cacheName&&opts.key&&opts.panel)rememberPanelCache(opts.cacheName,opts.key,opts.panel,opts.scrollSel);};
  const rememberScroll=()=>{
    const map=opts.cacheName&&S.viewCache[opts.cacheName],hit=map&&map.get(opts.key);
    if(hit)hit.scroll=panelScroll(opts.scrollSel);
  };
  const render=fromScroll=>{
    if(token!==_virtualTok)return;
    if(!rows.length){
      tb.innerHTML=emptyHtml;tb.dataset.virtualStart='0';tb.dataset.virtualRows='0';
      card.classList.remove('loading');setInd('');remember();return;
    }
    const visible=Math.min(VIRTUAL_MAX_DOM_ROWS,Math.max(24,Math.ceil(card.clientHeight/VIRTUAL_ROW_HEIGHT)+VIRTUAL_OVERSCAN*2));
    const start=Math.min(Math.max(0,rows.length-visible),Math.max(0,Math.floor(card.scrollTop/VIRTUAL_ROW_HEIGHT)-VIRTUAL_OVERSCAN));
    const end=Math.min(rows.length,start+visible);
    tb.innerHTML=virtualSpacerRow(start*VIRTUAL_ROW_HEIGHT,colspan)+virtualRowsHtml(rows,makeRow,start,end,cache)+virtualSpacerRow((rows.length-end)*VIRTUAL_ROW_HEIGHT,colspan);
    tb.dataset.virtualStart=String(start);
    tb.dataset.virtualRows=String(end-start);
    const virtualized=rows.length>end-start;
    card.classList.toggle('loading',virtualized);
    setInd(virtualized?`${(start+1).toLocaleString()}-${end.toLocaleString()} / ${rows.length.toLocaleString()}`:'');
    if(fromScroll)rememberScroll();else remember();
  };
  const onScroll=()=>{if(token!==_virtualTok)return;if(frame)return;frame=requestAnimationFrame(()=>{frame=0;render(true);});};
  if(card._virtualScrollHandler)card.removeEventListener('scroll',card._virtualScrollHandler);
  card._virtualScrollHandler=onScroll;
  card.addEventListener('scroll',onScroll,{passive:true});
  render(false);
  requestAnimationFrame(()=>{if(token===_virtualTok)render(false);});
}
export const PLACEMENT_ROW_HEIGHT=84;
export const PLACEMENT_ROW_HEIGHT_NARROW=120;
export const PLACEMENT_OVERSCAN=8;
export const PLACEMENT_MAX_DOM_ROWS=80;
export function mountVirtualPlacementRows(list,items,makeRow,ind){
  if(!list)return;
  const token=++_virtualTok,track=$('.placement-track',list),windowEl=$('.placement-window',list);
  let frame=0,rowHeight=window.matchMedia('(max-width:820px)').matches?PLACEMENT_ROW_HEIGHT_NARROW:PLACEMENT_ROW_HEIGHT;
  const setSize=()=>{
    rowHeight=window.matchMedia('(max-width:820px)').matches?PLACEMENT_ROW_HEIGHT_NARROW:PLACEMENT_ROW_HEIGHT;
    const totalHeight=items.length*rowHeight;
    list.style.setProperty('--placement-row-height',rowHeight+'px');
    list.style.setProperty('--placement-total-height',totalHeight+'px');
    track.style.height=totalHeight+'px';
  };
  const render=()=>{
    if(token!==_virtualTok||!list.isConnected)return;
    const visible=Math.min(PLACEMENT_MAX_DOM_ROWS,Math.max(12,Math.ceil(list.clientHeight/rowHeight)+PLACEMENT_OVERSCAN*2));
    const start=Math.min(Math.max(0,items.length-visible),Math.max(0,Math.floor(list.scrollTop/rowHeight)-PLACEMENT_OVERSCAN));
    const end=Math.min(items.length,start+visible);
    let html='';for(let i=start;i<end;i++)html+=makeRow(items[i]);
    windowEl.innerHTML=html;windowEl.style.transform=`translateY(${start*rowHeight}px)`;
    list.dataset.virtualStart=String(start);list.dataset.virtualRows=String(end-start);
    if(ind)ind.textContent=items.length>end-start?`${(start+1).toLocaleString()}-${end.toLocaleString()} / ${items.length.toLocaleString()}`:`${items.length.toLocaleString()} shown`;
  };
  const onScroll=()=>{S.placementScrollTop=list.scrollTop;if(frame)return;frame=requestAnimationFrame(()=>{frame=0;render();});};
  list.addEventListener('scroll',onScroll,{passive:true});
  list.addEventListener('click',e=>{const btn=e.target.closest&&e.target.closest('[data-placement]');if(btn&&list.contains(btn))openPlacementDrawer(btn.dataset.placement);});
  if(_placementResizeObserver)_placementResizeObserver.disconnect();
  if(window.ResizeObserver){
    _placementResizeObserver=new ResizeObserver(()=>{if(token!==_virtualTok)return;const old=rowHeight;setSize();if(old!==rowHeight)list.scrollTop=Math.floor(list.scrollTop/old)*rowHeight;render();});
    _placementResizeObserver.observe(list);
  }
  setSize();
  list.scrollTop=Math.min(S.placementScrollTop||0,Math.max(0,items.length*rowHeight-list.clientHeight));
  render();
  requestAnimationFrame(()=>{if(token===_virtualTok)render();});
}

/* ---- tree rendering ---- */
export function gutterHtml(prefixArr,isLast){
  let h='';for(const cont of prefixArr)h+=`<span class="g ${cont?'g-v':''}"></span>`;
  h+=`<span class="g ${isLast?'g-l':'g-t'}"></span>`;return h;
}
export function lblHtml(name,hl){
  if(!hl)return esc(name);
  const i=name.toLowerCase().indexOf(hl.toLowerCase());
  if(i<0)return esc(name);
  return esc(name.slice(0,i))+'<mark>'+esc(name.slice(i,i+hl.length))+'</mark>'+esc(name.slice(i+hl.length));
}
export function rowInner(node,prefixArr,isLast,isRoot,hl){
  const kids=kidsOf(node),hasKids=kids.length>0;
  const dep=nodeDep(node);
  const depLabel=node.isLoad?'Dependency · equipment above':'Dependency · Panel (From)';
  const depBadge=dep?`<span class="dep copy-tag ${node.isLoad?'dep-load':''}" data-copy-tag="${esc(dep)}" title="${esc(depLabel+' · Copy '+dep)}">${ic('spline')}${esc(dep)}</span>`:'';
  const pmdBadge=node.pmdPanel?`<span class="dep copy-tag pmd-link" data-copy-tag="${esc(node.pmdPanel)}" title="${esc('Matched PMD panel · Copy '+node.pmdPanel)}">${ic('database')}${esc(node.pmdPanel)}</span>`:'';
  const labelTitle=node.isInstrument&&node.description?` title="${esc(node.description)}"`:` title="${esc('Copy '+node.name)}"`;
  const nk=clean(node.name).toLowerCase();
  const infoBtn=(node.kind&&node.kind!=='equipment'||S.depDetail.has(nk)||S.epDetail.has(nk)||S.cableStruckTags.has(tagKey(node.name))||melResolvedRecord(node.name)||S.melParentChecks.has(tagKey(node.name))||node.pmdKey||node.pmdPanel||canonicalRecord(node.name))?`<button class="rowinfo icon-btn" type="button" data-detail="${node.id}" title="Details" aria-label="Details for ${esc(node.name)}">${ic('info')}</button>`:'';
  /* No mode-id check: a projected node always carries placementId:'' (see
     src/hierarchy/projection.js), so the id compare was redundant for the shipped
     modes and wrong for a profile whose raw mode is named anything else -- it
     suppressed every placement flag in a view that legitimately has them. */
  const placementBtn=node.placementId?`<button class="placement-flag icon-btn" type="button" data-placement="${node.placementId}" title="Review this branch placement" aria-label="Review placement for ${esc(node.name)}">${ic('triangle-alert')}</button>`:'';
  const kindClass=node.kind?' kind-'+node.kind:'';
  if(isRoot){
    return `<div class="row root${kindClass} ${hasKids?'':'leafrow'}" data-id="${node.id}" ${hasKids?'data-exp="1"':''} tabindex="0" role="treeitem" aria-expanded="${hasKids?'false':''}">
      ${hasKids?`<span class="twist">${ic('chevron-right')}</span>`:'<span class="twist"></span>'}
      <span class="badge-root">${ic(node.kind==='building'?'folder-tree':'zap')}</span>
      <span class="lbl copy-tag" data-copy-tag="${esc(node.name)}"${labelTitle}>${lblHtml(node.name,hl)}</span>
      ${depBadge}${pmdBadge}${hasKids?`<span class="cnt">${kids.length}</span>`:''}${placementBtn}${infoBtn}</div>`;
  }
  const marker=hasKids?'<span class="marker branch"></span>':(node.isInstrument?`<span class="marker instrument">${ic('database')}</span>`:node.isLoad?`<span class="marker load">${ic('corner-down-right')}</span>`:node.isId?`<span class="marker leaf">${ic('tag')}</span>`:'<span class="marker dot"></span>');
  return `<div class="row${kindClass} ${hasKids?'':'leafrow'} ${node.isLoad?'is-load':''} ${node.isInstrument?'is-instrument':''} ${node.isSpare?'is-spare':''} ${node.isSpace?'is-space':''}" data-id="${node.id}" ${hasKids?'data-exp="1"':''} tabindex="0" role="treeitem" aria-expanded="${hasKids?'false':''}">
    <span class="gut">${gutterHtml(prefixArr,isLast)}</span>
    ${hasKids?`<span class="twist">${ic('chevron-right')}</span>`:'<span class="twist"></span>'}
    ${marker}<span class="lbl copy-tag ${hasKids?'':'lbl-leaf'}" data-copy-tag="${esc(node.name)}"${labelTitle}>${lblHtml(node.name,hl)}</span>
    ${depBadge}${pmdBadge}${hasKids?`<span class="cnt">${kids.length}</span>`:''}${placementBtn}${infoBtn}</div>`;
}
export function makeNode(node,prefixArr,isLast,isRoot){
  node._prefix=prefixArr;node._isLast=isLast;node._isRoot=isRoot;node._built=false;
  const wrap=document.createElement('div');wrap.className='node';
  wrap.innerHTML=rowInner(node,prefixArr,isLast,isRoot,'')+'<div class="kids" hidden></div>';
  return wrap;
}
export function wireTree(tree){
  if(!tree||tree._wired)return;
  wireCopyTags(tree);tree.addEventListener('click',onTreeClick);tree.addEventListener('keydown',onTreeKey);tree._wired=true;
}
export function renderTreeCollapsed(){
  cancelExpand();
  const tree=$('#tree');tree.innerHTML='';
  const roots=activeHierarchyRoots().filter(r=>!nodeHidden(r));
  const frag=document.createDocumentFragment();
  roots.forEach((r,i)=>frag.appendChild(makeNode(r,[],i===roots.length-1,true)));
  tree.appendChild(frag);
  tree.classList.toggle('hide-deps',!S.showDeps);
  tree.classList.toggle('hide-pmd',!S.showPmdMatches);
  if(!roots.length)tree.innerHTML=`<div class="note info" style="margin:6px">${ic('info')}<div>Nothing to show with the current Spares/Spaces toggles.</div></div>`;
  wireTree(tree);
  rememberTreePanel();
}
export function childPrefix(node){return node._isRoot?[]:node._prefix.concat(!node._isLast);}
export function expandNode(row,node){
  const wrap=row.parentElement,kids=wrap.querySelector(':scope > .kids');
  if(!node._built){
    kids.innerHTML='';
    const vis=kidsOf(node),cp=childPrefix(node),last=vis.length-1,frag=document.createDocumentFragment();
    vis.forEach((c,i)=>frag.appendChild(makeNode(c,cp,i===last,false)));
    kids.appendChild(frag);node._built=true;
  }
  kids.hidden=false;row.classList.add('open');row.setAttribute('aria-expanded','true');
}
export function collapseNode(row){const kids=row.parentElement.querySelector(':scope > .kids');kids.hidden=true;row.classList.remove('open');row.setAttribute('aria-expanded','false');}
export function toggleNode(row,node){if(row.classList.contains('open'))collapseNode(row);else expandNode(row,node);}
export function onTreeClick(e){
  const placement=e.target.closest('.placement-flag');
  if(placement){e.stopPropagation();openPlacementDrawer(placement.dataset.placement);return;}
  const info=e.target.closest('.rowinfo');
  if(info){e.stopPropagation();openDetail(info.dataset.detail);return;}
  const row=e.target.closest('.row');if(!row)return;
  const node=activeHierarchyNodeMap().get(row.dataset.id);if(!node)return;
  if(!kidsOf(node).length){copyText(node.name);return;}
  if((e.metaKey||e.ctrlKey)){copyText(node.name);return;}
  toggleNode(row,node);
}
export function onTreeKey(e){
  const row=e.target.closest('.row');if(!row)return;
  const node=activeHierarchyNodeMap().get(row.dataset.id);if(!node)return;
  const has=kidsOf(node).length>0;
  if(e.key==='Enter'||e.key===' '){e.preventDefault();if(has)toggleNode(row,node);else copyText(node.name);}
  else if(e.key==='ArrowRight'&&has&&!row.classList.contains('open'))expandNode(row,node);
  else if(e.key==='ArrowLeft'&&has&&row.classList.contains('open'))collapseNode(row);
}
export let _expandTok=0,_expanding=false;
export function expandBtnHTML(busy,info){
  return busy?`<span class="spin-ic">${ic('loader-circle')}</span>Stop${info?` <span class="ecount">${info}</span>`:''}`
    :`${ic('chevrons-down')}Expand all`;
}
export function cancelExpand(){if(!_expanding)return;_expandTok++;_expanding=false;const b=$('#expandAll');if(b)b.innerHTML=expandBtnHTML(false);}
/* Expand the whole tree top-to-bottom (document order). Renders on a ~12ms/frame
   budget with no overlay, so the user can scroll and click while it fills in.
   Click the button again to stop. Any tree re-render (collapse, search, toggles)
   cancels it. */
export async function expandAll(){
  if(S.search)return;
  if(_expanding){cancelExpand();return;}              // second click = stop
  const tree=$('#tree'),btn=$('#expandAll');
  const tok=++_expandTok;_expanding=true;
  if(btn)btn.innerHTML=expandBtnHTML(true,'');
  // pre-order stack: push roots reversed so the first (top) root is processed first
  const roots=activeHierarchyRoots().filter(r=>!nodeHidden(r)),stack=[];
  for(let i=roots.length-1;i>=0;i--){const row=tree.querySelector(`:scope > .node > .row[data-id="${roots[i].id}"]`);if(row)stack.push([roots[i],row]);}
  let done=0;const BUDGET=12;
  while(stack.length){
    const t0=performance.now();
    while(stack.length&&performance.now()-t0<BUDGET){
      const [node,row]=stack.pop();
      const vis=kidsOf(node);
      if(vis.length){
        if(!row.classList.contains('open'))expandNode(row,node);
        const kc=row.parentElement.querySelector(':scope > .kids').children; // child .node wrappers, in order
        for(let i=vis.length-1;i>=0;i--){const w=kc[i];if(w)stack.push([vis[i],w.firstElementChild]);} // reversed -> top-to-bottom
      }
      done++;
    }
    if(btn)btn.innerHTML=expandBtnHTML(true,done.toLocaleString());
    await raf();
    if(tok!==_expandTok)return;                        // superseded / cancelled
  }
  _expanding=false;if(btn)btn.innerHTML=expandBtnHTML(false);
}
export function collapseAll(){
  cancelExpand();
  S.search='';const q=$('#q');if(q)q.value='';const qx=$('#qx');if(qx)qx.classList.remove('show');setQInfo('');
  renderTreeCollapsed();                               // bulk clear + rebuild roots (fast, no overlay)
}

/* ---- search (filtered render) ---- */
export function computeFilter(q,idOnly){
  const ql=q.toLowerCase();
  const walk=n=>{let any=false;n.children.forEach(c=>{if(walk(c))any=true;});
    n._self=!nodeHidden(n)&&n.name.toLowerCase().includes(ql)&&(!idOnly||n.isId);
    n._show=n._self||any;return n._show;};
  activeHierarchyRoots().forEach(walk);
}
export function countSelf(){let c=0;const w=n=>{if(n._self)c++;n.children.forEach(w);};activeHierarchyRoots().forEach(w);return c;}
export function runSearch(){
  cancelExpand();
  const q=S.search.trim();
  if(!q){renderTreeCollapsed();setQInfo('');return;}
  computeFilter(q,S.idOnly);
  const m=countSelf();
  renderFiltered(q);
  setQInfo(m?`<b>${m}</b> match${m!==1?'es':''}${S.idOnly?' in ID Names':''} for “${esc(q)}”`:`No matches for “${esc(q)}”${S.idOnly?' in ID Names':''}`);
}
export function renderFiltered(hl){
  const tree=$('#tree');tree.innerHTML='';
  const build=(node,prefixArr,isLast,isRoot)=>{
    const fullKids=kidsOf(node),shown=fullKids.filter(c=>c._show&&!nodeHidden(c));
    const showContext=node._self||shown.some(c=>c._self);
    const visible=showContext?fullKids:shown;
    node._prefix=prefixArr;node._isLast=isLast;node._isRoot=isRoot;node._built=true;
    const wrap=document.createElement('div');wrap.className='node';
    wrap.innerHTML=rowInner(node,prefixArr,isLast,isRoot,node._self?hl:'')+'<div class="kids"></div>';
    const kids=wrap.querySelector('.kids');
    const cp=isRoot?[]:prefixArr.concat(!isLast);
    visible.forEach((c,i)=>{
      const childLast=i===visible.length-1;
      if(c._show)kids.appendChild(build(c,cp,childLast,false));
      else{const extra=makeNode(c,cp,childLast,false);extra.classList.add('search-extra');kids.appendChild(extra);}
    });
    if(visible.length){const r=wrap.querySelector('.row');r.classList.add('open');r.setAttribute('aria-expanded','true');}
    return wrap;
  };
  const roots=activeHierarchyRoots().filter(r=>r._show&&!nodeHidden(r));
  const frag=document.createDocumentFragment();
  roots.forEach((r,i)=>frag.appendChild(build(r,[],i===roots.length-1,true)));
  tree.appendChild(frag);
  tree.classList.toggle('hide-deps',!S.showDeps);
  tree.classList.toggle('hide-pmd',!S.showPmdMatches);
  if(!roots.length)tree.innerHTML=`<div class="note info" style="margin:6px">${ic('search')}<div>Nothing matched. Try a different tag, or turn off <b>ID Names only</b>.</div></div>`;
}

/* Statuses the engineer resolves by reading them rather than by moving a
   branch. Every one of these reports a decision the build already made -- a
   parent kept over another, a feed kept over another, a blank level bridged --
   so the drawer must offer a way to clear it. Without this the entry could only
   ever be dismissed by rebuilding, which is why they read as dead ends. */
const ACKNOWLEDGEABLE=new Set(['missing-data','duplicate-parent','bridged-gap','cable-conflict']);
export function isAcknowledgeableIssue(issue){return !!issue&&(issue.status==='suggested'||ACKNOWLEDGEABLE.has(issue.status));}

/* ---- detail drawer ---- */
export function openPlacementDrawer(issueId){
  const issue=S.placements.find(item=>item.id===issueId&&!item.resolved);if(!issue)return;
  const expected=placementExpectedParentRole(issue.branchName),all=placementCandidates(issue,'');
  let selected=S.nodeById.get(issue._selectedNodeId)||all.find(item=>tagKey(item.node.name)===tagKey(issue.suggestedParent))?.node||null;
  $('#drawer').setAttribute('aria-label','Hierarchy placement review');
  $('#drawerTitle').innerHTML=`${ic('git-branch')}<span>${esc(issue.branchName)}</span>`;
  const field=(label,value)=>`<div class="dfield"><div class="dlabel">${esc(label)}</div><div class="dval ${value?'':'empty'}">${esc(value||'—')}</div></div>`;
  $('#drawerBody').innerHTML=`
    ${field('Status',placementState(issue,true))}
    ${field('Source',issue.source)}${field('Reason',issue.reason)}
    ${field('Original parent',issue.originalParent||issue.currentParent)}${field('Current parent',issue.currentParent)}
    ${issue.suggestedParent?field('Suggested parent',issue.suggestedParent):''}
    ${issue.node?field('Branch size',rawSubtreeCount(issue.node)+' descendants'):''}
    <div class="dfield"><div class="dlabel">Choose a ${esc(expected||'valid')} parent</div>
      <div class="search placement-search">${ic('search')}<input id="placementParentSearch" type="text" placeholder="Search hierarchy parents…" autocomplete="off" spellcheck="false"></div>
      <div class="candidate-list" id="placementCandidates"></div>
      <div class="placement-preview" id="placementPreview" hidden></div>
    </div>
    <div class="placement-actions">
      ${isAcknowledgeableIssue(issue)?`<button class="btn" id="acceptPlacement">${ic('check')}${issue.status==='suggested'?'Accept placement':'Acknowledge warning'}</button>`:''}
      ${S.lastPlacementMove?`<button class="btn ghost" id="drawerPlacementUndo">${ic('rotate-ccw')}Undo</button>`:''}
      <button class="btn primary spacer" id="movePlacement" disabled>${ic('git-branch')}Move branch</button>
    </div>`;
  const list=$('#placementCandidates'),preview=$('#placementPreview'),move=$('#movePlacement'),search=$('#placementParentSearch');
  const paint=()=>{
    const candidates=placementCandidates(issue,search.value);
    list.innerHTML=candidates.length?candidates.map(item=>`<button class="candidate ${selected&&selected.id===item.node.id?'on':''}" data-parent="${item.node.id}">${ic(selected&&selected.id===item.node.id?'circle-check':'corner-down-right')}<span class="candidate-main"><span class="candidate-name">${esc(item.node.name)}</span><span class="candidate-path">${esc(item.path.join(' / '))}</span></span></button>`).join('')
      :`<div class="note info">${ic('info')}<div>No valid parents match this search.</div></div>`;
    $$('#placementCandidates [data-parent]').forEach(btn=>btn.onclick=()=>{selected=S.nodeById.get(btn.dataset.parent);issue._selectedNodeId=selected&&selected.id;paint();});
    if(selected){const path=[...nodePath(selected),issue.branchName].join(' / ');preview.hidden=false;preview.innerHTML=`Branch will move with all descendants:<code>${esc(path)}</code>`;move.disabled=false;}
    else{preview.hidden=true;move.disabled=true;}
  };
  let searchTimer;search.oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(paint,140);};move.onclick=()=>selected&&movePlacementBranch(issue.id,selected.id);
  const accept=$('#acceptPlacement');if(accept)accept.onclick=()=>acceptPlacement(issue.id);
  const undo=$('#drawerPlacementUndo');if(undo)undo.onclick=async()=>{closeDrawer();await undoPlacement();};
  paint();$('#drawer').classList.add('show');
}
export function openDetail(nodeId){
  const node=activeHierarchyNodeMap().get(nodeId);if(!node)return;
  $('#drawer').setAttribute('aria-label','Equipment details');
  if(node.kind&&node.kind!=='equipment'){
    const path=nodePath(node),kind=node.kind[0].toUpperCase()+node.kind.slice(1);
    $('#drawerTitle').innerHTML=`${ic(node.kind==='building'?'folder-tree':node.kind==='discipline'?'layers':'network')}<span>${esc(node.name)}</span>`;
    $('#drawerBody').innerHTML=`<div class="dfield"><div class="dlabel">Hierarchy level</div><div class="dval">${esc(kind)}</div></div>
      <div class="dfield"><div class="dlabel">Path</div><div class="context-path">${path.map(esc).join(' / ')}</div></div>
      <div class="dfield"><div class="dlabel">Direct children</div><div class="dval">${node.children.length.toLocaleString()}</div></div>
      <button class="btn view-crosslink" id="editContextRules">${ic('sliders-horizontal')}Edit site profile</button>`;
    $('#editContextRules').onclick=()=>{closeDrawer();openProfileStudio('hierarchy');};
    $('#drawer').classList.add('show');return;
  }
  const nk=clean(node.name).toLowerCase();
  const d=S.depDetail.get(nk),ep=S.epDetail.get(nk);
  const pmd=node.pmdKey?S.pmdDetail.get(node.pmdKey):null,mel=melResolvedRecord(node.name);
  const melCheck=S.melParentChecks.get(tagKey(node.name));
  const placement=node.placementId?S.placements.find(item=>item.id===node.placementId&&!item.resolved):null;
  const record=node.canonicalKey?S.canonicalModel.get(node.canonicalKey):canonicalRecord(node.name);
  if(record)S.selectedEquipmentKey=record.key;
  $('#drawerTitle').innerHTML=`${ic(node.isInstrument?'database':node.isLoad?'corner-down-right':'spline')}<span>${esc(node.name)}</span>`;
  const melResult=melCheck?(melCheck.status==='corrected'?`Corrected · Equipment UPN ${melCheck.equipmentUpn} / previous parent UPN ${melCheck.parentUpn}`
      :melCheck.status==='matched'?`No change · matching UPN ${melCheck.equipmentUpn}`
      :melCheck.status==='warning'?`Skipped · ${melCheck.reason}`:`Not evaluated · ${melCheck.reason}`)
    :(placement&&placement.status==='missing-data'?placement.reason:'');
  const values={
    equipmentTag:node.name,equipmentType:record&&record.equipmentType||equipmentRole(node.name)||(node.isInstrument?'Instrument':node.isLoad?'Load':'Equipment'),
    building:record&&record.building||node.pmdBuilding||mel&&mel.building||'',discipline:record&&record.discipline||'',
    system:record&&record.system||'',flowParent:record&&[...record.flowParents][0]||'',ssmParent:record&&record.ssmParentTag||'',
    dependency:record&&[...record.dependencies][0]||nodeDep(node),upn:mel&&mel.upn||'',
    melSystemParent:mel&&mel.systemParent?firstSystemParentTag(mel.systemParent):'',melParentCheck:melResult,
    cableStatus:S.cableStruckTags.has(tagKey(node.name))?'Struck through in source':'',pmdPanel:node.pmdPanel||'',pmdBuilding:node.pmdBuilding||'',
    easyCircuit:ep&&ep.circuit?clean(ep.circuit):'',cableCircuit:d&&d['Circuit_Number']?clean(d['Circuit_Number']):'',
    cableLoadName:d&&d['Load Name (To)']||'',cablePanel:d&&d['Panel (From)']||'',cableTag:d&&d['Cable Tag']||'',
    cableLoadRating:d&&d['Load kVA/HP/Amps']||'',cableReference:d&&d['Cable (ref table)']||'',
    cablePackageRevision:d&&d['Package/Revision']||'',cableRfi:d&&d['RFI Number']||'',cableLength:d&&d['Cable Length [ft]']||'',
    cableRaceway:d&&d.Raceway||'',pmdCard:pmd&&pmd.fields.CARD||'',pmdPointPosition:pmd&&pmd.fields['POINT POSITION']||'',
    pmdPointType:pmd&&pmd.fields['POINT TYPE']||'',pmdPid:pmd&&pmd.fields['P&ID']||'',pmdLocation:pmd&&pmd.fields.Location||'',
    pmdRelease:pmd&&pmd.fields.RELEASE||'',description:node.description||pmd&&pmd.description||'',
    provenance:record&&record.provenance.length?record.provenance.join(' · '):''
  };
  const fieldById=new Map(PROFILE_DETAIL_FIELDS.map(field=>[field.id,field]));
  const fld=(field,val)=>{
    const circuitDiff=(field.id==='easyCircuit'||field.id==='cableCircuit')&&values.easyCircuit&&values.cableCircuit&&normSep(values.easyCircuit)!==normSep(values.cableCircuit);
    return `<div class="dfield"><div class="dlabel">${esc(field.label)} <span class="detail-source">${esc(field.source)}</span>${circuitDiff?`<span class="flag-diff">${ic('triangle-alert')}differ</span>`:''}</div><div class="dval">${copyableTag(val)&&['equipmentTag','flowParent','ssmParent','dependency','melSystemParent','pmdPanel'].includes(field.id)?copyTagListHtml(val):esc(val)}</div></div>`;
  };
  let html='';
  for(const id of activeProfile().details.layout||DEFAULT_DETAIL_LAYOUT){
    const field=fieldById.get(id),value=clean(values[id]);if(!field||!value)continue;html+=fld(field,value);
  }
  if(!html)html=`<div class="note info">${ic('info')}<div>No cable schedule, Easy Power, PMD, or MEL detail for this tag.</div></div>`;
  /* Only a record carries the canonical key setHierarchyMode follows to reveal
     the same equipment in the mode it switches to. */
  if(record)html+=hierarchyCrosslinkHtml();
  $('#drawerBody').innerHTML=html;
  wireCopyTags($('#drawerBody'));
  const switcher=$('#switchDetailView');if(switcher)switcher.onclick=()=>{const next=nextHierarchyMode();if(next)setHierarchyMode(next.id);};
  $('#drawer').classList.add('show');
}
export function closeDrawer(){$('#drawer').classList.remove('show');S.selectedEquipmentKey='';}
