import { $, KEYSEP, clean, esc, raf } from '../core/text.js'
import { S, _uid, fileById, invalidateHierarchyBuild } from '../state.js'
import { ic } from './icons.js'
import { toast, withLoading } from './progress.js'
import { PMD_SHEET_NAME, cableInfo, cableRowCount, isCableSheet, isMelSheet, isPmdFile, isPmdSheet, melInfo, melRowCount, normH, parseWorkCopy, pmdInfo, pmdRowCount, resolveCols } from '../io/detect.js'
import { extractStrikeCells, getAoa, getAoaAsync, readArrayBuffer, sheetRowCount } from '../io/workbook.js'
import { isP6Sheet, parseXer } from '../io/p6.js'
import { isLineListSheet } from '../io/linelist.js'
import { isExtoRegistrySheet, isItemMasterTemplateSheet } from '../io/exto.js'
import { buildHierarchy } from '../hierarchy/build.js'





/* ---- steps / routing ---- */
export function renderSteps(){
  const order=['upload','sheets','result'],labels={upload:'Files',sheets:'Sheets',result:'Hierarchy'};
  const current=S.screen==='profile'?(S.profileUi.returnScreen||'upload'):S.screen,cur=order.indexOf(current);
  $('#steps').innerHTML=order.map((k,i)=>{
    const cls=i<cur?'done':i===cur?'active':'';
    return `<span class="step ${cls}"><span class="num">${i<cur?ic('check'):i+1}</span>${labels[k]}</span>`+(i<order.length-1?'<span class="step-sep"></span>':'');
  }).join('');
}
export function go(screen){
  if(screen!=='result'&&S.resultFullscreen){S.resultFullscreen=false;document.body.classList.remove('result-fullscreen');}
  if(screen!=='profile'&&S.profileUi.previewFullscreen){S.profileUi.previewFullscreen=false;document.body.classList.remove('profile-preview-fullscreen');}
  S.screen=screen;render();try{window.scrollTo({top:0,behavior:'instant'});}catch(e){window.scrollTo(0,0);}
}
export function render(){
  renderSteps();const view=$('#view');view.classList.toggle('profile-view',S.screen==='profile'||S.screen==='legendWizard');
  if(S.screen==='legendWizard'){renderLegendWizard();return;}
  if(S.screen==='profile'){renderProfile();return;}
  if(S.screen==='upload')renderUpload();else if(S.screen==='sheets')renderSheets();else if(S.screen==='result')renderResult();
  injectProfileContext();
}

/* ---- upload screen ---- */
export function fileKindIcon(ext){return ext==='csv'?{cls:'csv',name:'file-text'}:{cls:'',name:'file-spreadsheet'};}
export function fmtSize(b){if(b<1024)return b+' B';if(b<1048576)return (b/1024).toFixed(0)+' KB';return (b/1048576).toFixed(1)+' MB';}
export const GUIDE_SECTIONS=[
  ['start','Getting started','info'],
  ['files','Files and inputs','upload'],
  ['sheets','Sheet selection','table-2'],
  ['hierarchy','Hierarchy','folder-tree'],
  ['review','Review and compare','triangle-alert'],
  ['exports','SSM exports','file-down'],
  ['studio','Site Profile Studio','sliders-horizontal'],
  ['profiles','Profiles and updates','rotate-ccw']
];
let _guideOpener=null;
export function importRequirementsMarkup(){
  return `<section class="import-guide" aria-label="Files used to build an SSM">
    <div class="import-guide-head"><div><span class="eyebrow">Import map</span><b>Files used to build an SSM</b></div><span>Column mapping can adapt names that differ at your site.</span></div>
    <div class="import-guide-grid">
      <div class="import-kind"><span class="import-kind-icon easy">${ic('git-branch')}</span><div><div class="import-kind-title">Easy Power <small>Primary</small></div><p>Electrical spine</p><code>Starting Source · Downstream · ID Name · Load Description</code></div></div>
      <div class="import-kind"><span class="import-kind-icon cable">${ic('spline')}</span><div><div class="import-kind-title">Cable Schedule <small>Recommended</small></div><p>Feed and parent verification</p><code>Load Name (To) · Panel (From) · Circuit Number</code></div></div>
      <div class="import-kind"><span class="import-kind-icon mel">${ic('tag')}</span><div><div class="import-kind-title">Master Equipment List <small>Recommended</small></div><p>UPN and equipment context</p><code>Equipment_List · Equipment Tag · System Parent</code></div></div>
      <div class="import-kind"><span class="import-kind-icon pmd">${ic('database')}</span><div><div class="import-kind-title">Point Master Database <small>Optional</small></div><p>Instrument attachment</p><code>INSTALL PMD · PANEL · INSTRUMENT TAG</code></div></div>
    </div>
  </section>`;
}
export function guideSectionMarkup(section){
  if(section==='files')return `<div class="guide-copy"><span class="guide-kicker">Files and inputs</span><h2>Bring the project sources together</h2><p>Upload one or many Excel or CSV files. SSManagement identifies source types from sheet names and headers, then lets you confirm every choice before building.</p>
    ${importRequirementsMarkup()}
    <h3>Working copy</h3><p>Add an existing SSM register separately when you need a side-by-side comparison. It does not change the hierarchy being built.</p></div>`;
  if(section==='sheets')return `<div class="guide-copy"><span class="guide-kicker">Sheet selection</span><h2>Choose exactly what participates</h2><p>The Sheets screen groups detected tabs by purpose. Select hierarchy tabs for the electrical tree, then confirm Cable Schedule, MEL, and PMD tabs independently.</p>
    <ol><li>Review the detected source and downstream columns.</li><li>Use <b>Map data</b> when a project uses different headers.</li><li>Leave unrelated workbook tabs unselected.</li><li>Build after the selection summary matches the intended scope.</li></ol>
    <div class="guide-note">${ic('info')}Only selected tabs appear in Studio previews when Studio is opened from a built hierarchy.</div></div>`;
  if(section==='hierarchy')return `<div class="guide-copy"><span class="guide-kicker">Hierarchy</span><h2>Inspect the assembled structure</h2><p>Electrical Flow follows source-to-load relationships. SSM Hierarchy organizes the same equipment through Building, Discipline, and System levels defined by the active profile.</p>
    <h3>Useful controls</h3><ul><li>Search keeps matched branches visible with their surrounding context.</li><li>Fullscreen expands the current table or hierarchy without losing its state.</li><li>Click any equipment tag to copy it.</li><li>Open the information button to review source metadata and provenance.</li></ul></div>`;
  if(section==='review')return `<div class="guide-copy"><span class="guide-kicker">Review and compare</span><h2>Resolve uncertainty before export</h2><p><b>Cross-Sheet Tag Review</b> shows Cable Schedule and Easy Power evidence together. <b>Placement Review</b> collects ambiguous, missing, or conflicting parent decisions without silently discarding them.</p>
    <p>The Comparison tab checks the extracted register against an uploaded working copy. Filter, sort, and search large comparisons to focus on mismatches, missing tags, or confirmed matches.</p>
    <div class="guide-note">${ic('triangle-alert')}A review flag is a request for a decision, not a failed hierarchy build.</div></div>`;
  if(section==='exports')return `<div class="guide-copy"><span class="guide-kicker">SSM exports</span><h2>Download the resolved register</h2><p>Export the combined SSM, separate source registers, or Exto format after reviewing the hierarchy. The active profile controls parent resolution, dependencies, hierarchy modes, and detail fields.</p>
    <ol><li>Confirm the desired hierarchy/export mode.</li><li>Resolve material placement flags.</li><li>Review comparison mismatches when a working copy is present.</li><li>Download the required workbook format.</li></ol></div>`;
  if(section==='studio')return `<div class="guide-copy"><span class="guide-kicker">Site Profile Studio</span><h2>Teach SSManagement how this project works</h2><p>Site profiles replace project-specific hard coding with local, reusable rules. Use the plus button to create one; the protected Eagle profile is a useful reference to start from.</p>
    <div class="guide-workflow">
      <div><b>1</b><span><strong>Legend Trainer</strong>Add the design legend, abbreviations page, or tag-identification sheet. SSManagement reads it, shows every extracted entry for review, and proposes ordinary editable rules. Nothing is published automatically.</span></div>
      <div><b>2</b><span><strong>Data Mapping</strong>Connect uploaded columns to their meaning. Detected mappings can be changed immediately.</span></div>
      <div><b>3</b><span><strong>Tag Trainer</strong>Select a spreadsheet cell, then select the characters that identify a building, discipline, system, or equipment type.</span></div>
      <div><b>4</b><span><strong>Relationships</strong>Define how closest parents are found, constructed, or looked up across sources.</span></div>
      <div><b>5</b><span><strong>Visual Trainer</strong>Move a real hierarchy tag, preview the affected equipment, and add either an exact placement or reusable rule to the draft.</span></div>
      <div><b>6</b><span><strong>Hierarchy and Details</strong>Choose the level order, root behavior, source priority, and information shown in the side panel.</span></div>
      <div><b>7</b><span><strong>Test and Publish</strong>Validate the profile, inspect its impact, then save and apply it. A loaded or changed profile automatically rebuilds an existing hierarchy.</span></div>
    </div>
    <h3>Design legends stay on this machine</h3><p>An uploaded legend is read in the browser and never leaves it. No page image, page text, or document file is stored in the profile — only the compact entries you reviewed, and a note of which document and page each generated rule came from. Spreadsheet, CSV, and pasted text are supported in this build.</p>
    <p>Rules proposed from a legend are ordinary rules. They can be edited, reordered, disabled, or deleted like any other, and a rule you change by hand is never overwritten when the same document is analysed again. Proposals are only selected for you when the project's real tags confirm them; with no spreadsheets loaded they are marked <strong>Unverified</strong> and left unselected.</p>
    <div class="guide-note">${ic('file-json')}Export profile JSON as the portable project rules backup. Spreadsheet rows are never included.</div></div>`;
  if(section==='profiles')return `<div class="guide-copy"><span class="guide-kicker">Profiles and updates</span><h2>Keep project logic durable</h2><p>Profiles are stored locally with recovery copies and can be exported as JSON. The built-in Eagle profile stays locked; clone it before tailoring rules to a project.</p>
    <h3>App updates</h3><p>SSManagement makes one anonymous version check when opened or refreshed. The app remains offline during normal use. Downloaded replacement HTML carries the local profile handoff so project rules survive version changes.</p>
    <div class="guide-note">${ic('rotate-ccw')}The version number in the lower-left corner opens the changelog at any time.</div></div>`;
  return `<div class="guide-copy"><span class="guide-kicker">Getting started</span><h2>From source sheets to a reviewed SSM</h2><p>SSManagement combines electrical, cable, equipment, and instrument sources into one traceable hierarchy while keeping project-specific logic in a reusable Site Profile.</p>
    <div class="guide-journey">
      <div><span>1</span><b>Upload</b><p>Add the project spreadsheets and an optional working copy.</p></div>
      <div><span>2</span><b>Select</b><p>Confirm the tabs and detected source types that belong in the build.</p></div>
      <div><span>3</span><b>Build</b><p>Generate Electrical Flow and SSM hierarchy views from the active profile.</p></div>
      <div><span>4</span><b>Review</b><p>Resolve placement flags and compare against the current register.</p></div>
      <div><span>5</span><b>Export</b><p>Download the combined SSM or the required delivery format.</p></div>
    </div>
    <div class="guide-note">${ic('sliders-horizontal')}Open Site Profile Studio to teach the app a site's columns, tag anatomy, parent rules, hierarchy levels, and details panel.</div></div>`;
}
export function guideModalMarkup(){
  return `<div id="guideModal" class="modal-back guide-back" role="dialog" aria-modal="true" aria-labelledby="guideTitle" aria-hidden="true" hidden>
    <div class="guide-shell">
      <aside class="guide-nav"><div class="guide-brand">${ic('book-open')}<div><b id="guideTitle">SSManagement Guide</b><span>Offline reference</span></div></div>
        <nav aria-label="Guide sections">${GUIDE_SECTIONS.map(([id,label,icon])=>`<button type="button" data-guide-section="${id}">${ic(icon)}<span>${label}</span></button>`).join('')}</nav>
      </aside>
      <section class="guide-main"><header class="guide-main-head"><span id="guideCurrent"></span><button class="xbtn icon-btn" id="closeGuide" type="button" aria-label="Close guide">${ic('x')}</button></header><div class="guide-panel" id="guidePanel"></div></section>
    </div>
  </div>`;
}
export function renderGuideSection(){
  const active=GUIDE_SECTIONS.some(([id])=>id===S.guideSection)?S.guideSection:'start';
  S.guideSection=active;
  const current=GUIDE_SECTIONS.find(([id])=>id===active),panel=$('#guidePanel');
  if(panel)panel.innerHTML=guideSectionMarkup(active);
  const label=$('#guideCurrent');if(label)label.textContent=current[1];
  $$('[data-guide-section]').forEach(button=>button.classList.toggle('on',button.dataset.guideSection===active));
}
export function closeGuide(){
  const modal=$('#guideModal');if(!modal)return;
  modal.classList.remove('show');modal.hidden=true;modal.setAttribute('aria-hidden','true');
  if(_guideOpener&&_guideOpener.isConnected)_guideOpener.focus();
}
export function openGuide(section){
  let modal=$('#guideModal');
  if(!modal){
    document.body.insertAdjacentHTML('beforeend',guideModalMarkup());modal=$('#guideModal');
    $('#closeGuide').onclick=closeGuide;
    modal.addEventListener('click',event=>{if(event.target===modal)closeGuide();});
    document.addEventListener('keydown',event=>{if(event.key==='Escape'&&!modal.hidden)closeGuide();});
    $$('[data-guide-section]').forEach(button=>button.onclick=()=>{S.guideSection=button.dataset.guideSection;renderGuideSection();});
  }
  _guideOpener=document.activeElement;S.guideSection=section||S.guideSection||'start';renderGuideSection();
  modal.hidden=false;modal.setAttribute('aria-hidden','false');modal.classList.add('show');
  $('#closeGuide').focus();
}
export function renderUpload(){
  $('#view').innerHTML=`
  <section class="card pad">
    <div class="upload-intro">
      <div><div class="eyebrow">Step 1 — Source files</div><h2 class="lead">Add your spreadsheets</h2>
      <p class="sub">Bring the available project sources together. You will choose the active tabs and confirm their mappings before the hierarchy is built.</p></div>
      <button class="btn sm" id="openGuide" type="button">${ic('book-open')}Guide</button>
    </div>
    ${importRequirementsMarkup()}
    <div class="dz" id="dz" tabindex="0" role="button" aria-label="Add files by browsing or dropping" style="margin-top:18px">
      <div class="dzicon">${ic('upload')}</div>
      <h2>Drop spreadsheets here</h2>
      <p>Select one or many — or <button type="button" class="btn-link" id="browse">browse files</button></p>
      <div class="fmt"><span>.xlsx</span><span>.xls</span><span>.csv</span></div>
      <input id="file" type="file" accept=".xlsx,.xls,.csv" multiple hidden>
    </div>
    <div id="filelist"></div>
    <div class="wc-import">
      <div class="wc-head">${ic('git-branch')}<div><div class="wc-t">Current Working Copy <span class="opt">optional</span></div><div class="wc-s">Compare your build against an existing register — Equipment ID, Closest Parent &amp; Dependencies.</div></div></div>
      <div id="wcslot"></div>
    </div>
    <div class="actions">
      <button class="btn ghost" id="clearall" style="display:none">${ic('trash-2')}Clear all</button>
      <span class="hint spacer" id="uphint"></span>
      <button class="btn primary" id="toSheets" disabled>Choose sheets ${ic('chevron-right')}</button>
    </div>
  </section>`;
  wireUpload();renderFileList();renderWorkCopy();
}
export function renderWorkCopy(){
  const slot=$('#wcslot');if(!slot)return;
  if(S.workCopy){
    const n=S.wcRows?S.wcRows.length:0,ok=n>0;
    slot.innerHTML=`<div class="frow ${ok?'':'err'}"><span class="ficon cable">${ic('git-branch')}</span>
      <div class="fmeta"><div class="fname">${esc(S.workCopy.name)}</div><span class="fsub ${ok?'':'warn'}">${ok?n+' rows · Equipment ID / Parent / Dependency detected':'No Equipment ID column found'}</span></div>
      <button class="xbtn icon-btn" id="wcremove" type="button" aria-label="Remove working copy">${ic('x')}</button></div>`;
    $('#wcremove').onclick=()=>{S.workCopy=null;S.wcRows=null;invalidateHierarchyBuild();renderWorkCopy();};
  }else{
    slot.innerHTML=`<button type="button" class="btn sm" id="wcbrowse">${ic('upload')}Add working copy</button><input id="wcfile" type="file" accept=".xlsx,.xls,.csv" hidden>`;
    const inp=$('#wcfile');
    $('#wcbrowse').onclick=()=>inp.click();
    inp.onchange=()=>{const f=inp.files[0];inp.value='';if(f)addWorkCopy(f);};
  }
}
export async function addWorkCopy(file){
  if(!/\.(xlsx|xls|csv)$/i.test(file.name)){toast('Only .xlsx, .xls or .csv files');return;}
  const slot=$('#wcslot');
  if(slot)slot.innerHTML=`<div class="frow"><span class="wc-spin">${ic('loader-circle')}</span><div class="fmeta"><div class="fname">${esc(file.name)}</div><span class="fsub">Reading…</span></div></div>`;
  await raf();
  try{
    const buf=await readArrayBuffer(file);await raf();
    const bytes=new Uint8Array(buf),wb=XLSX.read(bytes,{type:'array',dense:true});S.workCopy={name:file.name,wb};
    await raf();parseWorkCopy();invalidateHierarchyBuild();
  }catch(e){S.workCopy=null;S.wcRows=null;toast('Could not read working copy');}
  renderWorkCopy();
}
export function renderFileList(){
  const list=$('#filelist');if(!list)return;
  list.innerHTML=S.files.map(f=>{
    const k=fileKindIcon(f.ext);
    const sub=f.error?`<span class="fsub warn">${esc(f.error)}</span>`:`<span class="fsub">${f.sheets.length} tab${f.sheets.length!==1?'s':''} · ${fmtSize(f.size)}</span>`;
    return `<div class="frow ${f.error?'err':''}"><span class="ficon ${k.cls}">${ic(k.name)}</span>
      <div class="fmeta"><div class="fname">${esc(f.name)}</div>${sub}</div>
      <button class="xbtn icon-btn" type="button" data-id="${f.id}" aria-label="Remove ${esc(f.name)}">${ic('x')}</button></div>`;
  }).join('');
  const okFiles=S.files.filter(f=>!f.error&&f.sheets.length);
  const tabs=okFiles.reduce((a,f)=>a+f.sheets.length,0);
  const hint=$('#uphint');if(hint)hint.textContent=okFiles.length?`${okFiles.length} file${okFiles.length!==1?'s':''} · ${tabs} tab${tabs!==1?'s':''} ready`:'';
  const cont=$('#toSheets');if(cont)cont.disabled=okFiles.length===0;
  const clr=$('#clearall');if(clr)clr.style.display=S.files.length?'':'none';
  $$('#filelist .xbtn').forEach(b=>b.onclick=()=>{const id=b.dataset.id;S.files=S.files.filter(f=>f.id!==id);[...S.selected,...S.cableSel,...S.pmdSel,...S.melSel,...S.p6Sel,...S.lineSel].forEach(k=>{if(k.split(KEYSEP)[0]===id){S.selected.delete(k);S.cableSel.delete(k);S.pmdSel.delete(k);S.melSel.delete(k);S.p6Sel.delete(k);S.lineSel.delete(k);}});invalidateHierarchyBuild();renderFileList();});
}
export function wireUpload(){
  const dz=$('#dz'),input=$('#file');
  $('#openGuide').onclick=()=>openGuide('start');
  $('#browse').onclick=e=>{e.stopPropagation();input.click();};
  dz.onclick=()=>input.click();
  dz.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();input.click();}};
  input.onchange=()=>{const fs=[...input.files];input.value='';addFiles(fs);};
  ['dragenter','dragover'].forEach(ev=>dz.addEventListener(ev,e=>{e.preventDefault();dz.classList.add('drag');}));
  ['dragleave','dragend'].forEach(ev=>dz.addEventListener(ev,e=>{if(e.target===dz)dz.classList.remove('drag');}));
  dz.addEventListener('drop',e=>{e.preventDefault();dz.classList.remove('drag');addFiles([...e.dataTransfer.files]);});
  $('#clearall').onclick=()=>{S.files=[];S.aoaCache.clear();S.selected.clear();S.cableSel.clear();S.pmdSel.clear();S.melSel.clear();S.p6Sel.clear();S.lineSel.clear();S.override={};S.workCopy=null;S.wcRows=null;invalidateHierarchyBuild();renderFileList();renderWorkCopy();};
  $('#toSheets').onclick=async()=>{if($('#toSheets').disabled)return;await prewarmSheets();go('sheets');};
}
export async function addFiles(fileObjs){
  const accepted=fileObjs.filter(f=>/\.(xlsx|xls|csv)$/i.test(f.name));
  if(!accepted.length){toast('Only .xlsx, .xls or .csv files');return;}
  await withLoading('Reading files',accepted.length>1?accepted.length+' files':accepted[0].name,async(report)=>{
    for(let i=0;i<accepted.length;i++){
      const file=accepted[i];
      report(i/accepted.length,`File ${i+1} of ${accepted.length}`);await raf();
      const ext=(file.name.split('.').pop()||'').toLowerCase();
      const rec={id:'f'+(_uid++),name:file.name,ext,size:file.size,wb:null,sheets:[],strikes:new Map(),error:null};
      try{const buf=await readArrayBuffer(file),bytes=new Uint8Array(buf);
        if(ext==='xer'){
          /* P6's native export is plain tab-delimited text, not a workbook. */
          rec.p6=parseXer(new TextDecoder().decode(bytes));
          if(!rec.p6.tasks.length)rec.error='No TASK rows found in this XER file';
        }else{
          const wb=XLSX.read(bytes,{type:'array',dense:true});
          rec.wb=wb;rec.strikes=extractStrikeCells(bytes);rec.sheets=wb.SheetNames.slice();if(!rec.sheets.length)rec.error='No readable tabs found';
        }
      }catch(err){rec.error='Could not read this file';}
      S.files.push(rec);
    }
    report(1,`${accepted.length} file${accepted.length!==1?'s':''} read`);
  });
  invalidateHierarchyBuild();
  renderFileList();
}
export async function prewarmSheets(){
  await withLoading('Scanning tabs','detecting columns',async(report)=>{
    const keys=[];S.files.forEach(f=>{if(!f.error)f.sheets.forEach(s=>keys.push(f.id+KEYSEP+s));});
    for(let i=0;i<keys.length;i++){
      report(i/keys.length,`Tab ${i+1} of ${keys.length}`);await raf();
      // yield inside the sheet too, so one very large tab cannot block the ring
      await getAoaAsync(keys[i],async(done,total)=>{report((i+done/total)/keys.length,`Tab ${i+1} of ${keys.length}`);await raf();});
    }
    report(1,`${keys.length} tab${keys.length!==1?'s':''} scanned`);
  });
  // default: use every detected Cable Schedule tab for dependencies
  allKeys().forEach(k=>{if(!isPmdSheet(k)&&!isMelSheet(k)&&isCableSheet(k))S.cableSel.add(k);});
  S.files.forEach(f=>{if(isPmdFile(f))f.sheets.forEach(s=>{const key=f.id+KEYSEP+s;if(normH(s)===PMD_SHEET_NAME)S.pmdSel.add(key);});});
  allKeys().forEach(k=>{if(isMelSheet(k))S.melSel.add(k);});
  allKeys().forEach(k=>{if(!isMelSheet(k)&&!isCableSheet(k)&&!isPmdSheet(k)&&isP6Sheet(k))S.p6Sel.add(k);});
  allKeys().forEach(k=>{if(!isMelSheet(k)&&!isCableSheet(k)&&!isPmdSheet(k)&&!S.p6Sel.has(k)&&isLineListSheet(k))S.lineSel.add(k);});
  /* Optional EXTO-layer inputs. Registry detection runs before the MEL guard
     dilemma never arises: a registry sheet has an Item Master column no MEL
     carries, and detectExtoRegistry requires it. */
  allKeys().forEach(k=>{if(!isCableSheet(k)&&!isPmdSheet(k)&&isExtoRegistrySheet(k))S.extoSel.add(k);});
  allKeys().forEach(k=>{if(isItemMasterTemplateSheet(k)&&!S.extoSel.has(k))S.imSel.add(k);});
}

/* ---- sheets screen ---- */
export function detailHtml(cols){
  if(cols.ok)return `<span>Source <b>${esc(cols.headers[cols.source]||'—')}</b></span>·<span><b>${cols.downstream.length}</b> downstream</span>·<span>ID <b>${esc(cols.headers[cols.idName]||'—')}</b></span><span class="pill ok">${ic('check')}detected</span>`;
  return `<span>Guess — Source <b>${esc(cols.headers[cols.source]||'col 1')}</b>, ID <b>${esc(cols.headers[cols.idName]||'last col')}</b></span><span class="pill warn">${ic('triangle-alert')}set columns</span>`;
}
export function renderSheets(){
  const okFiles=S.files.filter(f=>!f.error&&f.sheets.length);
  $('#view').innerHTML=`
  <section class="card">
    <div class="card-head">
      <button class="btn ghost sm" id="backUp">${ic('arrow-left')}Files</button>
      <div class="ttl spacer">${ic('table-2')}Select tabs to include</div>
      <button class="btn sm" id="openMapper">${ic('sliders-horizontal')}Map data</button>
      <button class="btn ghost sm" id="selAll">Select all</button>
      <button class="btn ghost sm" id="selNone">Clear</button>
    </div>
    <div class="card-body">
      <div class="note info" style="margin-bottom:14px">${ic('info')}<div>Hierarchy tabs build the tree (use <b>Edit columns</b> if a tab is flagged). Cable Schedule tabs attach dependencies. <b>INSTALL PMD</b> and <b>Equipment_List</b> tabs are selected automatically for instrument and MEL data.</div></div>
      <div id="sheetgroups"></div>
    </div>
    <div class="actions" style="margin:0;padding:18px 22px">
      <span class="hint" id="selinfo"></span>
      <button class="btn primary spacer" id="build" disabled>Build hierarchy ${ic('chevron-right')}</button>
    </div>
  </section>`;
  const cableKeys=[],pmdKeys=[],melKeys=[];
  const groups=okFiles.map(f=>{
    const k=fileKindIcon(f.ext);
    const hierSheets=f.sheets.filter(s=>{const key=f.id+KEYSEP+s;return !isMelSheet(key)&&!isPmdSheet(key)&&!isCableSheet(key);});
    f.sheets.forEach(s=>{const key=f.id+KEYSEP+s;if(isMelSheet(key))melKeys.push(key);else if(isPmdSheet(key))pmdKeys.push(key);else if(isCableSheet(key))cableKeys.push(key);});
    if(!hierSheets.length)return '';
    const rows=hierSheets.map(sheet=>{
      const key=f.id+KEYSEP+sheet,cols=resolveCols(key),sel=S.selected.has(key);
      return `<div class="srow ${sel?'on':''}" data-key="${esc(key)}">
        <label class="chk"><input type="checkbox" ${sel?'checked':''}><span class="box">${ic('check')}</span></label>
        <div class="sinfo"><div class="sname">${ic('table-2')}${esc(sheet)} <span class="srows">${sheetRowCount(key)} rows</span></div>
        <div class="sdet">${detailHtml(cols)}</div></div>
        <button class="editcols">${ic('sliders-horizontal')}Edit columns</button></div>
        <div class="editpanel" hidden></div>`;
    }).join('');
    return `<div class="grp"><div class="grp-h"><span class="ficon ${k.cls}">${ic(k.name)}</span><span class="gname">${esc(f.name)}</span><span class="gcount">${hierSheets.length} tab${hierSheets.length!==1?'s':''}</span></div><div class="sheets">${rows}</div></div>`;
  }).join('');
  let melGroup='';
  if(melKeys.length){
    const rows=melKeys.map(key=>{
      const [fid,sheet]=key.split(KEYSEP),mi=melInfo(key),sel=S.melSel.has(key);
      const det=mi
        ? `<span>Equipment Tag → UPN</span><span class="pill ok">${ic('check')}MEL columns detected</span>`
        : `<span>Master Equipment List tab</span><span class="pill warn">${ic('triangle-alert')}Equipment Tag / UPN not found</span>`;
      return `<div class="srow mel ${sel?'on':''}" data-mel="${esc(key)}">
        <label class="chk"><input type="checkbox" ${sel?'checked':''}><span class="box">${ic('check')}</span></label>
        <div class="sinfo"><div class="sname">${ic('tag')}${esc(sheet)} <span class="srows">${melRowCount(key)} rows · ${esc(fileById(fid).name)}</span></div>
        <div class="sdet">${det}</div></div></div>`;
    }).join('');
    melGroup=`<div class="grp melgrp"><div class="grp-h"><span class="ficon mel">${ic('tag')}</span><span class="gname">Master Equipment List</span><span class="gcount">${melKeys.length} tab${melKeys.length!==1?'s':''}</span></div><div class="sheets">${rows}</div></div>`;
  }
  let pmdGroup='';
  if(pmdKeys.length){
    const rows=pmdKeys.map(key=>{
      const [fid,sheet]=key.split(KEYSEP),pi=pmdInfo(key),sel=S.pmdSel.has(key);
      const det=pi
        ? `<span>PANEL → INSTRUMENT TAG</span>·<span><b>${Math.max(0,Object.keys(pi.map).length-2)}</b> detail columns</span><span class="pill ok">${ic('check')}PMD columns detected</span>`
        : `<span>PMD workbook tab</span><span class="pill warn">${ic('triangle-alert')}PANEL / INSTRUMENT TAG not found</span>`;
      return `<div class="srow pmd ${sel?'on':''}" data-pmd="${esc(key)}">
        <label class="chk"><input type="checkbox" ${sel?'checked':''}><span class="box">${ic('check')}</span></label>
        <div class="sinfo"><div class="sname">${ic('database')}${esc(sheet)} <span class="srows">${pmdRowCount(key)} rows · ${esc(fileById(fid).name)}</span></div>
        <div class="sdet">${det}</div></div></div>`;
    }).join('');
    pmdGroup=`<div class="grp pmdgrp"><div class="grp-h"><span class="ficon pmd">${ic('database')}</span><span class="gname">Point Master Database — instruments</span><span class="gcount">${pmdKeys.length} tab${pmdKeys.length!==1?'s':''}</span></div><div class="sheets">${rows}</div></div>`;
  }
  let cableGroup='';
  if(cableKeys.length){
    const rows=cableKeys.map(key=>{
      const [fid,sheet]=key.split(KEYSEP),ci=cableInfo(key),sel=S.cableSel.has(key);
      const det=ci
        ? `<span>Load Name (To) → Panel (From)</span>·<span><b>${Object.keys(ci.map).length-2}</b> detail columns</span><span class="pill ok">${ic('check')}cable schedule</span>`
        : `<span>Named “Cable Schedule”</span><span class="pill warn">${ic('triangle-alert')}Load Name (To) / Panel (From) not found</span>`;
      return `<div class="srow cable ${sel?'on':''}" data-cable="${esc(key)}">
        <label class="chk"><input type="checkbox" ${sel?'checked':''}><span class="box">${ic('check')}</span></label>
        <div class="sinfo"><div class="sname">${ic('spline')}${esc(sheet)} <span class="srows">${cableRowCount(key)} rows · ${esc(fileById(fid).name)}</span></div>
        <div class="sdet">${det}</div></div></div>`;
    }).join('');
    cableGroup=`<div class="grp cablegrp"><div class="grp-h"><span class="ficon cable">${ic('spline')}</span><span class="gname">Cable Schedule — dependencies</span><span class="gcount">${cableKeys.length} tab${cableKeys.length!==1?'s':''}</span></div><div class="sheets">${rows}</div></div>`;
  }
  $('#sheetgroups').innerHTML=groups+melGroup+pmdGroup+cableGroup;
  wireSheets();updateSelInfo();
}
export function wireSheets(){
  $('#backUp').onclick=()=>go('upload');
  $('#build').onclick=()=>{if(!$('#build').disabled)buildHierarchy();};
  $('#openMapper').onclick=()=>openProfileStudio('mapping');
  $('#selAll').onclick=()=>{const before=S.selected.size;allHierKeys().forEach(k=>S.selected.add(k));if(S.selected.size!==before)invalidateHierarchyBuild();renderSheets();};
  $('#selNone').onclick=()=>{if(S.selected.size){S.selected.clear();invalidateHierarchyBuild();}renderSheets();};
  $$('.srow[data-key]').forEach(row=>{
    const key=row.dataset.key,cb=row.querySelector('input');
    const set=on=>{const changed=on?!S.selected.has(key):S.selected.has(key);if(on)S.selected.add(key);else S.selected.delete(key);if(changed)invalidateHierarchyBuild();cb.checked=on;row.classList.toggle('on',on);updateSelInfo();};
    row.addEventListener('click',e=>{if(e.target.closest('.editcols')||e.target.closest('.chk'))return;set(!S.selected.has(key));});
    cb.addEventListener('change',()=>set(cb.checked));
    row.querySelector('.editcols').addEventListener('click',e=>{e.stopPropagation();toggleEditPanel(key,row);});
  });
  $$('.srow[data-cable]').forEach(row=>{
    const key=row.dataset.cable,cb=row.querySelector('input');
    const set=on=>{const changed=on?!S.cableSel.has(key):S.cableSel.has(key);if(on)S.cableSel.add(key);else S.cableSel.delete(key);if(changed)invalidateHierarchyBuild();cb.checked=on;row.classList.toggle('on',on);updateSelInfo();};
    row.addEventListener('click',e=>{if(e.target.closest('.chk'))return;set(!S.cableSel.has(key));});
    cb.addEventListener('change',()=>set(cb.checked));
  });
  $$('.srow[data-pmd]').forEach(row=>{
    const key=row.dataset.pmd,cb=row.querySelector('input');
    const set=on=>{const changed=on?!S.pmdSel.has(key):S.pmdSel.has(key);if(on)S.pmdSel.add(key);else S.pmdSel.delete(key);if(changed)invalidateHierarchyBuild();cb.checked=on;row.classList.toggle('on',on);updateSelInfo();};
    row.addEventListener('click',e=>{if(e.target.closest('.chk'))return;set(!S.pmdSel.has(key));});
    cb.addEventListener('change',()=>set(cb.checked));
  });
  $$('.srow[data-mel]').forEach(row=>{
    const key=row.dataset.mel,cb=row.querySelector('input');
    const set=on=>{const changed=on?!S.melSel.has(key):S.melSel.has(key);if(on)S.melSel.add(key);else S.melSel.delete(key);if(changed)invalidateHierarchyBuild();cb.checked=on;row.classList.toggle('on',on);updateSelInfo();};
    row.addEventListener('click',e=>{if(e.target.closest('.chk'))return;set(!S.melSel.has(key));});
    cb.addEventListener('change',()=>set(cb.checked));
  });
}
export function allHierKeys(){return S.files.filter(f=>!f.error).flatMap(f=>f.sheets.map(s=>f.id+KEYSEP+s)).filter(k=>!isMelSheet(k)&&!isPmdSheet(k)&&!isCableSheet(k)&&!isP6Sheet(k)&&!isLineListSheet(k)&&!isExtoRegistrySheet(k)&&!isItemMasterTemplateSheet(k));}
export function allKeys(){return S.files.filter(f=>!f.error).flatMap(f=>f.sheets.map(s=>f.id+KEYSEP+s));}
export function toggleEditPanel(key,row){
  const panel=row.nextElementSibling;
  if(!panel.dataset.built){
    const {headers}=getAoa(key),cols=resolveCols(key);
    const opts=sel=>headers.map((h,i)=>`<option value="${i}" ${i===sel?'selected':''}>${esc(h||('Column '+(i+1)))}</option>`).join('');
    panel.innerHTML=`<div class="fld"><label>Starting Source column</label><select data-role="source">${opts(cols.source)}</select></div>
      <div class="fld"><label>ID Name column</label><select data-role="idName">${opts(cols.idName)}</select></div>
      <div class="editnote">${ic('info')}Columns between these two are read as Downstream levels, left to right.</div>`;
    const ss=panel.querySelector('[data-role=source]'),is=panel.querySelector('[data-role=idName]');
    const apply=()=>{S.override[key]={source:+ss.value,idName:+is.value};invalidateHierarchyBuild();row.querySelector('.sdet').innerHTML=detailHtml(resolveCols(key));};
    ss.onchange=apply;is.onchange=apply;panel.dataset.built='1';
  }
  panel.hidden=!panel.hidden;
}
export function updateSelInfo(){
  const n=S.selected.size,c=S.cableSel.size,p=S.pmdSel.size,m=S.melSel.size,info=$('#selinfo');
  if(info)info.textContent=(n?`${n} hierarchy tab${n!==1?'s':''}`:'No hierarchy tabs')+(c?` · ${c} cable schedule`:'')+(p?` · ${p} PMD tab${p!==1?'s':''}`:'')+(m?` · ${m} MEL tab${m!==1?'s':''}`:'');
  const b=$('#build');if(b)b.disabled=n===0&&m===0;
}
