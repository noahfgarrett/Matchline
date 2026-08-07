import { $, clean, esc, KEYSEP, natCmp } from '../core/text.js'
import { downloadBlob } from '../core/download.js'
import { S, fileById, tagKey } from '../state.js'
import { ic } from './icons.js'
import { toast } from './progress.js'
import { PROFILE_DETAIL_FIELDS, PROFILE_FIELD_SETS, PROFILE_SOURCE_LABELS, PROFILE_STORE, activeProfile, clearProfileDetectionCaches, invalidateProfileEvaluation, normalizeProfile, persistProfiles, profileClone, profileCore, profileExecutionSignature, profileFieldLabel, profileHistorySnapshot, profileId, profileKindForKey, ruleSelection } from '../profile/schema.js'
import { clearLegendProvenance, legendRuleOrigin, legendRuleState, legendSourceById } from '../profile/legend.js'
import { RULES_SCHEMA_VERSION, emptyLegendTraining } from '../rules/schema.js'
import { compileRuleProfile } from '../rules/profile-compiler.js'
import { parsePortableProfileEnvelope, serializePortableProfileEnvelope } from '../profile/durable-storage.js'
import { ensureProfileAutoMapping } from '../io/detect.js'
import { getAoa } from '../io/workbook.js'
import { buildHierarchy } from '../hierarchy/build.js'
import { rebuildProfileProjections, resolveRecordContext } from '../hierarchy/projection.js'
import { visualEvaluationSignature, visualTrainerData, visualTrainerEvaluateParents, visualTrainerIsDescendant, visualTrainerRelationshipRule, visualTrainerRelationshipImpact, visualTrainerGroupingRules, visualTrainerGroupingImpact, visualTrainerDraftSlice, visualTrainerRestoreDraftSlice, visualTrainerEnableResolvedFlow, VISUAL_TRAINER_GROUP_ATTRIBUTES } from '../profile/visual-trainer.js'
import { legendSessionRelease, openCreateProfileWizard, renderLegendTrainerTab, wireLegendTrainerTab } from './legend-trainer.js'
import { allKeys, go } from './screens.js'

/* ---- profile workspace ---- */
let _profileRebuildPromise=null;
let _profilePreviewEscapeBound=false;
const PROFILE_PREVIEW_ROW_HEIGHT=34;
const PROFILE_PREVIEW_WINDOW_ROWS=96;
const PROFILE_PREVIEW_BATCH_ROWS=24;
const PROFILE_PREVIEW_MAX_COLS=60;
const _profilePreviewColumns=new WeakMap();
export function injectProfileContext(){
  const view=$('#view'),profile=activeProfile();if(!view||!profile)return;
  if(view.querySelector(':scope > .profilebar'))return;
  view.insertAdjacentHTML('afterbegin',`<div class="profilebar">
    ${ic('sliders-horizontal')}<span class="profile-name">${esc(profile.name)}</span><span class="profile-rev">rev ${profile.revision}</span>
    ${S.profileNeedsRebuild?`<span class="profile-status">${ic('triangle-alert')}Rebuild required</span>`:''}
    ${S.profileStorage==='session'?`<span class="profile-status">${ic('triangle-alert')}Session storage</span>`:''}
    ${S.profileStorage==='recovery'?`<span class="profile-status">${ic('triangle-alert')}Storage recovery needed</span>`:''}
    <span class="spacer"></span>
    ${S.profileNeedsRebuild?`<button class="btn primary sm" id="rebuildProfileHierarchy">${ic('rotate-ccw')}Rebuild hierarchy</button>`:''}
    <button class="btn sm" id="manageProfile">${ic('sliders-horizontal')}Site profile</button>
  </div>`);
  const rebuild=$('#rebuildProfileHierarchy');if(rebuild)rebuild.onclick=rebuildActiveProfileHierarchy;
  $('#manageProfile').onclick=()=>openProfileStudio('overview');
}
export async function rebuildActiveProfileHierarchy(){
  if(_profileRebuildPromise)return _profileRebuildPromise;
  _profileRebuildPromise=(async()=>{
    while(S.profileNeedsRebuild){
      const revision=S.profileBuildRevision;
      if(!S.roots.length){S.profileNeedsRebuild=false;return true;}
      if(!S.selected.size){go('sheets');toast('Select at least one hierarchy tab, then build the hierarchy');return false;}
      const rebuilt=await buildHierarchy(revision);
      if(S.profileBuildRevision!==revision){S.profileNeedsRebuild=true;continue;}
      if(!rebuilt&&S.screen==='profile')renderProfile();
      return rebuilt===true;
    }
    return true;
  })();
  try{return await _profileRebuildPromise;}finally{_profileRebuildPromise=null;}
}
export async function applyProfileExecutionChange(executionChanged){
  if(executionChanged)S.profileBuildRevision++;
  S.profileNeedsRebuild=!!S.roots.length&&(S.profileNeedsRebuild||executionChanged);
  clearProfileDetectionCaches();
  if(S.roots.length&&!S.profileNeedsRebuild)rebuildProfileProjections();
  if(S.screen==='profile')renderProfile();
  if(!S.profileNeedsRebuild)return {required:false,rebuilt:false};
  return {required:true,rebuilt:await rebuildActiveProfileHierarchy()};
}
export function openProfileStudio(section){
  if(S.screen!=='profile')S.profileUi.returnScreen=S.screen;
  S.profileUi.section=section||'overview';S.profileDraft=profileClone(activeProfile());S.profileDirty=false;
  S.profileUi.visualSourceKey='';S.profileUi.visualProposal=null;S.profileUi.visualHistory=[];S.profileUi.visualFuture=[];
  S.profileUi.visualBase=null;
  ensureProfilePreview();go('profile');
}
export function closeProfileStudio(){
  if(S.profileDirty&&!confirm('Discard unpublished profile changes?'))return;
  S.profileDraft=null;S.profileDirty=false;S.profileUi.previewFullscreen=false;
  S.profileUi.visualFullscreen=false;
  document.body.classList.remove('profile-preview-fullscreen','visual-trainer-fullscreen');go(S.profileUi.returnScreen||'upload');
}
export function markProfileDirty(){
  if(S.profileDraft&&S.profileDraft.locked){
    S.profileDraft=profileClone(activeProfile());S.profileDirty=false;toast('Clone Eagle before changing its rules');renderProfile();return;
  }
  invalidateProfileEvaluation(S.profileDraft);
  invalidateVisualTreeCache();
  if(S.profileUi.section!=='visual'){S.profileUi.visualHistory=[];S.profileUi.visualFuture=[];}
  S.profileDirty=true;
  const state=$('#profileDraftState');if(state)state.textContent='Draft changes';
  const save=$('#publishProfile');if(save)save.disabled=false;
}
export function profilePreviewKeys(){
  const keys=allKeys();
  if(S.profileUi.returnScreen!=='result')return keys;
  const active=new Set([...S.selected,...S.cableSel,...S.melSel,...S.pmdSel]);
  const selected=keys.filter(key=>active.has(key));
  return selected.length?selected:keys;
}
export function resetProfilePreviewViewport(){
  S.profileUi.previewStartRow=0;S.profileUi.previewScrollTop=0;S.profileUi.previewScrollLeft=0;
}
export function ensureProfilePreview(){
  const keys=profilePreviewKeys(),current=S.profileUi.previewKey;
  if(!current||!keys.includes(current)){
    S.profileUi.previewKey=keys[0]||'';
    resetProfilePreviewViewport();
    if(S.profileUi.previewKey)getAoa(S.profileUi.previewKey);
    S.profileUi.sourceKind=S.profileUi.previewKey?profileKindForKey(S.profileUi.previewKey):'easyPower';
  }
  else if(S.profileUi.previewKey&&!S.profileUi.sourceKind)S.profileUi.sourceKind=profileKindForKey(S.profileUi.previewKey);
}
export function profileOptions(){
  return PROFILE_STORE.profiles.map(profile=>`<option value="${esc(profile.id)}" ${profile.id===PROFILE_STORE.activeId?'selected':''}>${esc(profile.name)}${profile.locked?' · built-in':''} · rev ${profile.revision}</option>`).join('');
}
export function profileNavButton(section,label,icon){
  const selected=S.profileUi.section===section;
  return `<button class="profile-tab ${selected?'on':''}" data-profile-section="${section}" role="tab" aria-selected="${selected}" aria-controls="profileSection">${ic(icon)}${esc(label)}</button>`;
}
export function renderProfile(){
  const livePreview=$('#profileSheetPreview');
  if(livePreview){
    S.profileUi.previewScrollTop=livePreview.scrollTop;
    S.profileUi.previewScrollLeft=livePreview.scrollLeft;
  }
  const visualTree=$('#visualTreeScroll');if(visualTree)S.profileUi.visualScrollTop=visualTree.scrollTop;
  /* The affected list can run to hundreds of rows, and toggling one checkbox
     re-renders the whole studio -- without this the panel snaps back to the top
     on every deselection. */
  const visualInspector=$('#visualInspectorBody');if(visualInspector)S.profileUi.visualInspectorScrollTop=visualInspector.scrollTop;
  const draft=S.profileDraft||(S.profileDraft=profileClone(activeProfile()));
  if(S.profileUi.section==='mapping'&&!draft.locked){
    ensureProfilePreview();
    const result=ensureProfileAutoMapping(draft,S.profileUi.previewKey,S.profileUi.sourceKind);
    S.profileUi.autoMapCount=result.count;
    if(result.changed)S.profileDirty=true;
  }
  $('#view').innerHTML=`<section class="profile-shell">
    <header class="profile-head">
      <div class="profile-head-main"><h2 class="profile-title">Site Profile Studio</h2><div class="profile-sub" id="profileDraftState">${S.profileDirty?'Draft changes':'Published revision '+draft.revision}</div></div>
      <select class="profile-select" id="profileSelect" aria-label="Active site profile">${profileOptions()}</select>
      <button class="profile-icon-btn icon-btn" id="duplicateProfile" type="button" title="Create a site profile" aria-label="Create a site profile">${ic('plus')}</button>
      <button class="btn primary sm" id="publishProfile" ${S.profileDirty&&!draft.locked?'':'disabled'}>${ic('check')}Save &amp; apply</button>
      ${S.profileNeedsRebuild?`<button class="btn sm" id="rebuildProfileNow">${ic('rotate-ccw')}Rebuild hierarchy</button>`:''}
      <button class="profile-icon-btn icon-btn" id="closeProfile" type="button" title="Close profile studio" aria-label="Close profile studio">${ic('x')}</button>
    </header>
    <nav class="profile-tabs" aria-label="Profile sections" role="tablist">
      ${profileNavButton('overview','Overview','info')}
      ${profileNavButton('legend','Legend Trainer','file-text')}
      ${profileNavButton('mapping','Data Mapping','table-2')}
      ${profileNavButton('trainer','Tag Trainer','tag')}
      ${profileNavButton('relationships','Relationships','git-branch')}
      ${profileNavButton('visual','Visual Trainer','move')}
      ${profileNavButton('hierarchy','Hierarchy','folder-tree')}
      ${profileNavButton('details','Details Panel','panel-left-close')}
      ${profileNavButton('test','Test & Publish','circle-check')}
    </nav>
    <main class="profile-body" id="profileSection" role="tabpanel">${renderProfileSection(draft)}</main>
  </section>`;
  wireProfile();
  document.body.classList.toggle('visual-trainer-fullscreen',S.profileUi.section==='visual'&&S.profileUi.visualFullscreen);
}
export function renderProfileSection(draft){
  if(S.profileUi.section==='legend')return renderLegendTrainerTab(draft);
  if(S.profileUi.section==='mapping')return renderProfileMapping(draft);
  if(S.profileUi.section==='trainer')return renderTagTrainer(draft);
  if(S.profileUi.section==='relationships')return renderRelationshipsProfile(draft);
  if(S.profileUi.section==='visual')return renderVisualTrainer(draft);
  if(S.profileUi.section==='hierarchy')return renderHierarchyProfile(draft);
  if(S.profileUi.section==='details')return renderDetailsBuilder(draft);
  if(S.profileUi.section==='test')return renderProfileTest(draft);
  return renderProfileOverview(draft);
}
/* Eagle is a locked reference, so it can never be the last profile standing --
   deleting down to it alone would leave nowhere to work. */
export function editableProfileCount(){
  return PROFILE_STORE.profiles.filter(profile=>!profile.locked).length;
}
export function renderProfileOverview(draft){
  const mappingCount=Object.values(draft.mappings||{}).filter(mapping=>Object.keys(mapping.fields||{}).length).length;
  const enabledRules=['normalize','classify','relate'].reduce((count,family)=>count+((draft.rules&&draft.rules[family])||[]).filter(rule=>rule.enabled!==false).length,0);
  return `<section class="profile-section">
    <div class="profile-section-head">${ic('sliders-horizontal')}<div><h2>Profile identity</h2><p>Local configuration · schema ${RULES_SCHEMA_VERSION}</p></div></div>
    <div class="profile-grid">
      <div class="profile-band">
        <div class="profile-band-head">${ic('tag')}Profile</div>
        <div class="profile-band-body profile-fields">
          ${draft.locked?`<div class="note info wide">${ic('lock')}Eagle is the protected SSM Builder compatibility profile. Clone it to create project-specific rules.</div>`:''}
          <div class="profile-field wide"><label for="profileName">Name</label><input class="profile-input" id="profileName" value="${esc(draft.name)}" ${draft.locked?'disabled':''}></div>
          <div class="profile-field wide"><label for="profileSite">Site code</label><input class="profile-input" id="profileSite" value="${esc(draft.siteCode||'')}" ${draft.locked?'disabled':''}></div>
          <div class="profile-field wide"><label for="profileDescription">Notes</label><textarea class="profile-textarea" id="profileDescription" ${draft.locked?'disabled':''}>${esc(draft.description||'')}</textarea></div>
        </div>
      </div>
      <div>
        <div class="profile-kpis">
          <div class="profile-kpi"><b>${draft.revision}</b><span>Published revision</span></div>
          <div class="profile-kpi"><b>${mappingCount}</b><span>Mapped sources</span></div>
          <div class="profile-kpi"><b>${enabledRules}</b><span>Active tag rules</span></div>
          <div class="profile-kpi"><b>${draft.details.layout.length}</b><span>Detail fields</span></div>
        </div>
        <div class="profile-band" style="margin-top:14px">
          <div class="profile-band-head">${ic('file-json')}Portable profile <span class="spacer"></span><span class="profile-rev">${S.profileStorage==='local'?'Two recovery copies saved':S.profileStorage==='recovery'?'Recovery needed':'Session only'}</span></div>
          <div class="profile-band-body">
            <div class="profile-actions">
              <button class="btn sm" id="duplicateProfileNow">${ic('square-stack')}Duplicate</button>
              <button class="btn sm" id="exportProfile">${ic('file-down')}Export JSON</button>
              <button class="btn sm" id="importProfile">${ic('upload')}Import JSON</button>
              <input id="profileImportFile" type="file" accept=".json,.ssmanagement-profile.json" hidden>
              <span class="spacer"></span>
              <button class="btn ghost sm" id="deleteProfile" ${editableProfileCount()<2||draft.locked?'disabled':''}>${ic('trash-2')}Delete</button>
            </div>
            <p class="profile-hint">${draft.locked
              ? 'Eagle is a locked worked example. Duplicate it to start a project from its rules.'
              : 'Duplicate copies this profile\'s rules and mappings into a new editable profile. The plus button above starts a new profile from a design legend instead.'}</p>
          </div>
        </div>
      </div>
    </div>
  </section>`;
}
export function previewSheetOptions(){
  return profilePreviewKeys().map(key=>{const [fid,sheet]=key.split(KEYSEP),file=fileById(fid);return `<option value="${esc(key)}" ${key===S.profileUi.previewKey?'selected':''}>${esc((file?file.name:'File')+' / '+sheet)}</option>`;}).join('');
}
export function profilePreviewHeader(draft){
  const kind=S.profileUi.sourceKind||'easyPower',mapping=(draft.mappings||{})[kind]||{};
  const preview=S.profileUi.previewKey?getAoa(S.profileUi.previewKey):null;
  const headerRow=mapping.headerRow!=null?mapping.headerRow:(preview?preview.headerRow:0);
  return `<div class="preview-toolbar">
    <label class="profile-field"><span class="profile-label">Preview sheet</span><select class="profile-select" id="profilePreviewSheet">${previewSheetOptions()}</select></label>
    <label class="profile-field"><span class="profile-label">Source type</span><select class="profile-select" id="profileSourceKind">
      ${[['easyPower','Easy Power'],['cable','Cable Schedule'],['mel','MEL'],['pmd','PMD']].map(([id,label])=>`<option value="${id}" ${kind===id?'selected':''}>${label}</option>`).join('')}
    </select></label>
    <label class="profile-field"><span class="profile-label">Header row</span><input class="profile-input" id="profileHeaderRow" type="number" min="1" value="${Number(headerRow)+1}" ${draft.locked?'disabled':''}></label>
  </div>`;
}
export function profilePreviewData(draft){
  ensureProfilePreview();const key=S.profileUi.previewKey;if(!key)return null;
  const rec=getAoa(key),kind=S.profileUi.sourceKind||profileKindForKey(key),mapping=(draft.mappings||{})[kind]||{};
  const headerRow=mapping.headerRow!=null?+mapping.headerRow:rec.headerRow;
  const fields=mapping.fields||{},mappedCols=new Set(Object.values(fields).map(Number));
  return {key,rec,kind,mapping,headerRow,fields,mappedCols};
}
export function profilePreviewColumnCount(rec){
  if(_profilePreviewColumns.has(rec))return _profilePreviewColumns.get(rec);
  let count=1;
  for(const row of rec.aoa||[]){
    count=Math.max(count,Math.min(PROFILE_PREVIEW_MAX_COLS,(row||[]).length));
    if(count===PROFILE_PREVIEW_MAX_COLS)break;
  }
  _profilePreviewColumns.set(rec,count);return count;
}
export function profilePreviewWindowStart(scrollTop,totalRows){
  const visible=Math.max(0,Math.floor((Number(scrollTop)||0)/PROFILE_PREVIEW_ROW_HEIGHT));
  const batched=Math.floor(visible/PROFILE_PREVIEW_BATCH_ROWS)*PROFILE_PREVIEW_BATCH_ROWS-PROFILE_PREVIEW_BATCH_ROWS;
  return Math.max(0,Math.min(Math.max(0,totalRows-PROFILE_PREVIEW_WINDOW_ROWS),batched));
}
export function previewRowsMarkup(data,start,maxCols){
  const {rec,headerRow,mappedCols}=data,aoa=rec.aoa,totalRows=aoa.length;
  const first=Math.max(0,Math.min(start,totalRows)),end=Math.min(totalRows,first+PROFILE_PREVIEW_WINDOW_ROWS);
  const selected=S.profileUi.selectedCell,colspan=maxCols+1;
  let html=first?`<tr class="preview-spacer" aria-hidden="true"><td colspan="${colspan}" style="height:${first*PROFILE_PREVIEW_ROW_HEIGHT}px"></td></tr>`:'';
  for(let row=first;row<end;row++){
    const rowNum=rec.rowNums&&rec.rowNums[row]!=null?rec.rowNums[row]+1:row+1;
    html+=`<tr data-preview-table-row="${row}" class="${row===headerRow?'header-candidate':''}"><td class="rownum">${rowNum}</td>`;
    for(let col=0;col<maxCols;col++){
      const value=clean((aoa[row]||[])[col]),isSelected=selected&&selected.row===row&&selected.col===col;
      html+=`<td class="${isSelected?'selected ':''}${mappedCols.has(col)?'mapped':''}"><button class="preview-cell" data-preview-row="${row}" data-preview-col="${col}" title="${esc(value)}">${esc(value||' ')}</button></td>`;
    }
    html+='</tr>';
  }
  if(end<totalRows)html+=`<tr class="preview-spacer" aria-hidden="true"><td colspan="${colspan}" style="height:${(totalRows-end)*PROFILE_PREVIEW_ROW_HEIGHT}px"></td></tr>`;
  return html;
}
export function renderSheetPreview(draft){
  const data=profilePreviewData(draft);if(!data)return `<div class="profile-empty">${ic('upload')}<div>No uploaded sheets</div></div>`;
  const {rec}=data,totalRows=rec.aoa.length,maxCols=profilePreviewColumnCount(rec);
  const start=profilePreviewWindowStart(S.profileUi.previewScrollTop,totalRows);
  S.profileUi.previewStartRow=start;
  const fullscreen=!!S.profileUi.previewFullscreen;
  let html=`<div class="sheet-preview-frame ${fullscreen?'fullscreen':''}">
    <div class="sheet-preview-head"><div><b>Spreadsheet preview</b><span>${totalRows.toLocaleString()} row${totalRows===1?'':'s'} · scroll to view the full sheet</span></div>
      <button class="profile-icon-btn icon-btn" id="toggleProfilePreview" type="button" title="${fullscreen?'Return to compact view':'View spreadsheet fullscreen'}" aria-label="${fullscreen?'Return spreadsheet to compact view':'View spreadsheet fullscreen'}">${ic(fullscreen?'minimize-2':'maximize-2')}</button>
    </div>
    <div class="sheet-preview" id="profileSheetPreview"><table class="preview-table" aria-rowcount="${totalRows}"><thead><tr><th class="rownum">#</th>`;
  for(let col=0;col<maxCols;col++)html+=`<th>${XLSX.utils.encode_col(col)}</th>`;
  return html+`</tr></thead><tbody id="profilePreviewRows">${previewRowsMarkup(data,start,maxCols)}</tbody></table></div></div>`;
}
export function selectedPreviewValue(){
  const key=S.profileUi.previewKey,cell=S.profileUi.selectedCell;if(!key||!cell)return '';
  const rec=getAoa(key);return clean((rec.aoa[cell.row]||[])[cell.col]);
}
export function mappingRowsMarkup(kind,mapping){
  const fields=mapping&&mapping.fields||{},autoFields=new Set(mapping&&mapping.autoFields||[]);
  const mapped=Object.entries(fields).sort((a,b)=>a[1]-b[1]);
  return mapped.length?mapped.map(([id,col])=>`<div class="profile-list-row"><div class="profile-list-main"><div class="profile-list-title">${esc(profileFieldLabel(kind,id))}</div><div class="profile-list-sub">${XLSX.utils.encode_col(+col)} · column ${+col+1}${autoFields.has(id)?' · detected':''}</div></div><button class="profile-icon-btn icon-btn" data-remove-map="${esc(id)}" ${S.profileDraft&&S.profileDraft.locked?'disabled':''} title="Remove mapping" aria-label="Remove ${esc(profileFieldLabel(kind,id))} mapping">${ic('x')}</button></div>`).join(''):'<div class="profile-empty">No mapped fields</div>';
}
export function renderProfileMapping(draft){
  const data=profilePreviewData(draft),cell=S.profileUi.selectedCell,kind=S.profileUi.sourceKind||'easyPower';
  const mapping=data?data.mapping:{},fields=data?data.fields:{},mapped=Object.entries(fields).sort((a,b)=>a[1]-b[1]);
  const currentField=cell?Object.keys(fields).find(id=>+fields[id]===cell.col)||'':'';
  return `<section class="profile-section">
    <div class="profile-section-head">${ic('table-2')}<div><h2>Data Mapping</h2><p>Canonical columns for ${esc(PROFILE_SOURCE_LABELS[kind]||kind)}${S.profileUi.autoMapCount?' · '+S.profileUi.autoMapCount+' detected':''}</p></div></div>
    ${profilePreviewHeader(draft)}
    <div class="profile-grid mapping-grid">
      <div class="mapping-inspector">
        <div class="profile-band">
          <div class="profile-band-head">${ic('sliders-horizontal')}Selected column</div>
          <div class="profile-band-body">
            <div class="mapping-selected" id="mappingSelected">${cell?`${XLSX.utils.encode_col(cell.col)} · ${esc(selectedPreviewValue()||'Blank cell')}`:'No cell selected'}</div>
            <div class="profile-field" style="margin-top:11px"><label for="mappingField">Semantic field</label>
              <select id="mappingField" ${draft.locked?'disabled':''}><option value="">Choose field</option>${(PROFILE_FIELD_SETS[kind]||[]).map(([id,label])=>`<option value="${id}" ${id===currentField?'selected':''}>${esc(label)}</option>`).join('')}</select>
            </div>
            <div class="profile-actions" style="margin-top:11px">
              <button class="btn primary sm" id="applyMapping" disabled>${ic('check')}${cell&&currentField?'Mapped':'Map column'}</button>
              <button class="btn ghost sm" id="useHeaderRow" ${cell&&!draft.locked?'':'disabled'}>Use row ${cell?cell.row+1:''} as header</button>
            </div>
          </div>
        </div>
        <div class="profile-band">
          <div class="profile-band-head">${ic('list-tree')}Mapped fields <span class="spacer"></span><span class="profile-rev" id="mappingCount">${mapped.length}</span><button class="profile-icon-btn icon-btn" id="autoMapColumns" ${draft.locked?'disabled':''} title="Reset to detected columns" aria-label="Reset to detected columns">${ic('rotate-ccw')}</button></div>
          <div class="profile-list" id="mappingList">${mappingRowsMarkup(kind,mapping)}</div>
        </div>
      </div>
      ${renderSheetPreview(draft)}
    </div>
  </section>`;
}
export function trainerSelection(){
  const value=selectedPreviewValue();if(!value)return {value:'',start:0,end:0,text:''};
  const start=Math.max(0,Math.min(S.profileUi.rangeStart==null?0:S.profileUi.rangeStart,S.profileUi.rangeEnd==null?S.profileUi.rangeStart||0:S.profileUi.rangeEnd));
  const end=Math.min(value.length-1,Math.max(S.profileUi.rangeStart==null?0:S.profileUi.rangeStart,S.profileUi.rangeEnd==null?S.profileUi.rangeStart||0:S.profileUi.rangeEnd));
  return {value,start,end,text:value.slice(start,end+1)};
}
export function trainerCandidate(){
  const selection=trainerSelection(),target=S.profileUi.ruleTarget||'equipmentType',mode=S.profileUi.ruleMode||'contains';
  let segmentIndex=0;if(selection.value){const before=selection.value.slice(0,selection.start);segmentIndex=(before.match(/-/g)||[]).length;}
  return {id:'preview',name:clean(S.profileUi.ruleName)||`${target} · ${selection.text}`,target,mode,needle:selection.text,start:selection.start,end:selection.end+1,
    segmentIndex,value:clean(S.profileUi.ruleValue),sourceKind:S.profileUi.ruleScope==='all'?'':(S.profileUi.sourceKind||''),enabled:true,strict:S.profileUi.ruleStrict!==false,example:selection.value,exclusions:[]};
}
export function trainerMatchPreview(rule,draft){
  const data=profilePreviewData(draft),cell=S.profileUi.selectedCell;if(!data||!cell)return {count:0,values:[]};
  const values=[],seen=new Set(),aoa=data.rec.aoa;
  for(let row=0;row<aoa.length&&values.length<5000;row++){
    const value=clean((aoa[row]||[])[cell.col]);if(!value||seen.has(value))continue;seen.add(value);
    const output=ruleSelection(rule,value);if(output!=null)values.push({tag:value,output});
  }
  return {count:values.length,values:values.slice(0,6)};
}
export function profileEngineRuleSummary(rule){
  if(rule.kind==='stripSuffix'){
    const separators=(rule.separators||[]).join(' / ')||'-';
    return `${rule.stage==='matching'?'Matching only':'Tag identity'} · remove ${(rule.suffixes||[]).join(', ')} after ${separators}${rule.repeat?' · repeat':''}`;
  }
  if(rule.kind==='pattern')return `${rule.target||'attribute'} = ${rule.value||'matched text'} when ${rule.source==='raw'?'original':'normalized'} tag matches /${rule.pattern||''}/i`;
  if(rule.kind==='slice')return `${rule.target||'attribute'} from ${Number(rule.start)<0?'the final '+Math.abs(Number(rule.start))+' characters':'character '+(Number(rule.start)+1)}${rule.lowercase?' · lowercase':''}`;
  if(rule.kind==='segment')return `${rule.target||'attribute'} from ${rule.segment?'“'+rule.segment+'”':'hyphen segment '+(Number(rule.segmentIndex)+1)}`;
  return clean(rule.kind)||'Engine rule';
}
export function profileEngineRuleEditor(draft){
  const [family,id]=profileRuleRef(S.profileUi.engineRuleRef),list=draft.rules&&draft.rules[family]||[];
  return {family,id,rule:list.find(item=>item.id===id)||null};
}
export function profileEngineRuleFields(draft){
  const {family,rule}=profileEngineRuleEditor(draft);if(!rule)return '';
  const disabled=draft.locked?'disabled':'',scope=rule.sourceKind||'all';
  const common=`<div class="profile-field wide"><label for="engineRuleName">Rule name</label><input class="profile-input" id="engineRuleName" value="${esc(rule.name||'')}" ${disabled}></div>
    <div class="profile-field"><label>Rule family</label><input class="profile-input" value="${esc(family)} · ${esc(rule.kind)}" disabled></div>
    <div class="profile-field"><label for="engineRuleScope">Import scope</label><select id="engineRuleScope" ${disabled}>
      ${[['all','All imports'],['easyPower','Easy Power'],['cable','Cable Schedule'],['mel','MEL'],['pmd','PMD']].map(([id,label])=>`<option value="${id}" ${scope===id?'selected':''}>${label}</option>`).join('')}
    </select></div>`;
  let fields='';
  if(family==='normalize'){
    fields=`<div class="profile-field"><label for="engineNormalizeStage">Normalization stage</label><select id="engineNormalizeStage" ${disabled}><option value="identity" ${rule.stage!=='matching'?'selected':''}>Tag identity</option><option value="matching" ${rule.stage==='matching'?'selected':''}>Matching only</option></select></div>
      <div class="profile-field"><label for="engineSeparators">Separators</label><input class="profile-input" id="engineSeparators" value="${esc((rule.separators||[]).join(', '))}" ${disabled}></div>
      <div class="profile-field wide"><label for="engineSuffixes">Suffixes to remove</label><input class="profile-input" id="engineSuffixes" value="${esc((rule.suffixes||[]).join(', '))}" ${disabled}></div>
      <label class="profile-check wide"><input type="checkbox" id="engineRepeat" ${rule.repeat?'checked':''} ${disabled}><span>Repeat until no listed suffix remains</span></label>`;
  }else{
    fields=`<div class="profile-field"><label for="engineTarget">Assigned field</label><input class="profile-input" id="engineTarget" value="${esc(rule.target||'')}" list="engineTargetSuggestions" ${disabled}></div>
      <div class="profile-field"><label for="engineTagSource">Read from</label><select id="engineTagSource" ${disabled}><option value="canonical" ${rule.source!=='raw'?'selected':''}>Normalized tag</option><option value="raw" ${rule.source==='raw'?'selected':''}>Original tag</option></select></div>
      <datalist id="engineTargetSuggestions"><option value="building"><option value="discipline"><option value="system"><option value="equipmentType"><option value="gisMarker"><option value="busMarker"><option value="placeholder"><option value="matchKey"></datalist>`;
    if(rule.kind==='pattern')fields+=`<div class="profile-field wide"><label for="enginePattern">Match pattern</label><input class="profile-input" id="enginePattern" value="${esc(rule.pattern||'')}" ${disabled}></div>
      <div class="profile-field wide"><label for="engineValue">Assigned value</label><input class="profile-input" id="engineValue" value="${esc(rule.value||'')}" ${disabled}></div>`;
    else if(rule.kind==='slice')fields+=`<div class="profile-field"><label for="engineSliceStart">Start index</label><input class="profile-input" type="number" id="engineSliceStart" value="${esc(rule.start==null?'':rule.start)}" ${disabled}></div>
      <div class="profile-field"><label for="engineSliceEnd">End index</label><input class="profile-input" type="number" id="engineSliceEnd" value="${esc(rule.end==null?'':rule.end)}" placeholder="To tag end" ${disabled}></div>
      <div class="profile-field"><label for="engineMinLength">Minimum tag length</label><input class="profile-input" type="number" min="0" id="engineMinLength" value="${esc(rule.minLength==null?'':rule.minLength)}" ${disabled}></div>
      <div class="profile-field"><label for="engineValue">Fixed value</label><input class="profile-input" id="engineValue" value="${esc(rule.value||'')}" placeholder="Use selected characters" ${disabled}></div>
      <label class="profile-check wide"><input type="checkbox" id="engineLowercase" ${rule.lowercase?'checked':''} ${disabled}><span>Convert the result to lowercase</span></label>`;
    else fields+=`<div class="profile-field"><label for="engineSegment">Named anatomy segment</label><input class="profile-input" id="engineSegment" value="${esc(rule.segment||'')}" ${disabled}></div>
      <div class="profile-field"><label for="engineSegmentIndex">Hyphen segment index</label><input class="profile-input" type="number" min="0" id="engineSegmentIndex" value="${esc(rule.segmentIndex==null?'':rule.segmentIndex)}" ${disabled}></div>
      <div class="profile-field"><label for="engineExpected">Required text</label><input class="profile-input" id="engineExpected" value="${esc(rule.expected||'')}" ${disabled}></div>
      <div class="profile-field"><label for="engineValue">Assigned value</label><input class="profile-input" id="engineValue" value="${esc(rule.value||'')}" ${disabled}></div>`;
  }
  /* Both families carry a per-tag opt-out, under different names -- excludeTags
     on Normalize and Classify, exclusions on Relate. They were writable only by
     the Visual Trainer's deselect flow; surfacing them here means an engineer
     can see which tags a rule has been told to skip, and undo it. */
  const exclusions=(family==='relate'?rule.exclusions:rule.excludeTags)||[];
  fields+=`<div class="profile-field wide"><label for="engineExclusions">Tags this rule must skip</label>
    <input class="profile-input" id="engineExclusions" value="${esc(exclusions.join(', '))}" placeholder="Comma separated" ${disabled}>
    ${exclusions.length?`<span class="profile-hint">${exclusions.length} tag${exclusions.length===1?'':'s'} excluded</span>`:''}</div>`;
  return `<div class="profile-band profile-rule-editor">
    <div class="profile-band-head">${ic('sliders-horizontal')}Rule definition <span class="spacer"></span><span class="profile-rev">${esc(rule.id)}</span></div>
    <div class="profile-band-body profile-fields">${common}${fields}
      ${profileRuleOriginBadge(draft,rule.id)}
      <div class="profile-field wide"><label for="engineRuleNote">Why this rule exists</label><textarea class="profile-textarea" id="engineRuleNote" ${disabled}>${esc(rule.note||'')}</textarea></div>
      <div class="profile-actions wide"><button class="btn primary sm" id="saveEngineRule" ${draft.locked?'disabled':''}>${ic('check')}Update rule</button><button class="btn ghost sm" id="closeEngineRule">${ic('x')}Close</button></div>
    </div>
  </div>`;
}
/**
 * Tag Anatomy list and editor.
 *
 * Anatomy was previously visible only as a name referenced by segment rules,
 * with no way to see or change the pattern, the delimiter, or which segments
 * carry identity -- and dropping a segment from identity silently rewrites the
 * canonical tag of everything the anatomy matches, so it is exactly the thing
 * that most needs to be inspectable.
 */
export function renderProfileAnatomies(draft){
  const anatomies=draft.anatomies||[],disabled=draft.locked?'disabled':'';
  return `<div class="profile-band" style="margin-top:12px">
    <div class="profile-band-head">${ic('layers')}Tag Anatomy <span class="spacer"></span><span class="profile-rev">${anatomies.length}</span></div>
    <div class="profile-list">${anatomies.length?anatomies.map((anatomy,index)=>`<div class="profile-list-row anatomy-row">
      <div class="profile-list-main">
        <div class="profile-field wide"><label for="anatomyName${index}">Name</label>
          <input class="profile-input" id="anatomyName${index}" data-anatomy-name="${index}" value="${esc(anatomy.name||'')}" ${disabled}></div>
        <div class="profile-field"><label for="anatomyPattern${index}">Match pattern</label>
          <input class="profile-input" id="anatomyPattern${index}" data-anatomy-pattern="${index}" value="${esc(anatomy.pattern||'')}" ${disabled}></div>
        <div class="profile-field"><label for="anatomyDelimiter${index}">Delimiter</label>
          <input class="profile-input" id="anatomyDelimiter${index}" data-anatomy-delimiter="${index}" value="${esc(anatomy.delimiter||'-')}" ${disabled}></div>
        <div class="anatomy-segments">${(anatomy.segments||[]).map((segment,segIndex)=>`<div class="anatomy-segment">
          <input class="profile-input" data-anatomy-segment-name="${index}:${segIndex}" value="${esc(segment.name||'')}" aria-label="Segment name" ${disabled}>
          <input class="profile-input" type="number" min="0" data-anatomy-segment-index="${index}:${segIndex}" value="${esc(segment.index==null?'':segment.index)}" aria-label="Segment index" ${disabled}>
          <label class="profile-check"><input type="checkbox" data-anatomy-segment-identity="${index}:${segIndex}" ${segment.identity===false?'':'checked'} ${disabled}><span>Part of identity</span></label>
          <button class="profile-icon-btn icon-btn" data-anatomy-segment-delete="${index}:${segIndex}" ${disabled} title="Remove segment" aria-label="Remove segment ${esc(segment.name||'')}">${ic('x')}</button>
        </div>`).join('')}
          <button class="btn ghost sm" data-anatomy-segment-add="${index}" ${disabled}>${ic('plus')}Add segment</button>
        </div>
        ${profileRuleOriginBadge(draft,anatomy.id)}
      </div>
      <div class="profile-row-actions">
        <button class="profile-icon-btn icon-btn" data-anatomy-up="${index}" ${draft.locked||index===0?'disabled':''} title="Move up" aria-label="Move anatomy up">${ic('chevrons-up')}</button>
        <button class="profile-icon-btn icon-btn" data-anatomy-down="${index}" ${draft.locked||index===anatomies.length-1?'disabled':''} title="Move down" aria-label="Move anatomy down">${ic('chevrons-down')}</button>
        <button class="profile-icon-btn icon-btn" data-anatomy-delete="${index}" ${disabled} title="Delete anatomy" aria-label="Delete anatomy">${ic('trash-2')}</button>
      </div>
    </div>`).join(''):'<div class="profile-empty">No tag anatomy is defined</div>'}</div>
    <div class="profile-band-body"><button class="btn sm" id="addAnatomy" ${disabled}>${ic('plus')}Add anatomy</button></div>
  </div>`;
}
export function wireProfileAnatomies(){
  const draft=S.profileDraft;if(!draft||draft.locked)return;
  const anatomies=draft.anatomies||(draft.anatomies=[]);
  const at=value=>anatomies[+value];
  const seg=(value)=>{const [a,s]=String(value).split(':');return (anatomies[+a]&&anatomies[+a].segments||[])[+s];};
  $$('[data-anatomy-name]').forEach(input=>input.onchange=()=>{const item=at(input.dataset.anatomyName);if(item){item.name=input.value;markProfileDirty();}});
  $$('[data-anatomy-pattern]').forEach(input=>input.onchange=()=>{const item=at(input.dataset.anatomyPattern);if(item){item.pattern=input.value;markProfileDirty();}});
  $$('[data-anatomy-delimiter]').forEach(input=>input.onchange=()=>{const item=at(input.dataset.anatomyDelimiter);if(item){item.delimiter=input.value||'-';markProfileDirty();}});
  $$('[data-anatomy-segment-name]').forEach(input=>input.onchange=()=>{const item=seg(input.dataset.anatomySegmentName);if(item){item.name=input.value;markProfileDirty();}});
  $$('[data-anatomy-segment-index]').forEach(input=>input.onchange=()=>{const item=seg(input.dataset.anatomySegmentIndex);if(item){item.index=Math.max(0,+input.value||0);markProfileDirty();}});
  $$('[data-anatomy-segment-identity]').forEach(input=>input.onchange=()=>{const item=seg(input.dataset.anatomySegmentIdentity);if(item){item.identity=input.checked;markProfileDirty();renderProfile();}});
  $$('[data-anatomy-segment-delete]').forEach(button=>button.onclick=()=>{
    const [a,s]=button.dataset.anatomySegmentDelete.split(':'),item=anatomies[+a];
    if(!item)return;item.segments.splice(+s,1);markProfileDirty();renderProfile();
  });
  $$('[data-anatomy-segment-add]').forEach(button=>button.onclick=()=>{
    const item=at(button.dataset.anatomySegmentAdd);if(!item)return;
    item.segments=item.segments||[];
    item.segments.push({name:'segment'+(item.segments.length+1),index:item.segments.length,identity:true});
    markProfileDirty();renderProfile();
  });
  const move=(selector,key,delta)=>$$(selector).forEach(button=>button.onclick=()=>{
    const index=+button.dataset[key],next=index+delta;
    if(next<0||next>=anatomies.length)return;
    [anatomies[index],anatomies[next]]=[anatomies[next],anatomies[index]];
    markProfileDirty();renderProfile();
  });
  move('[data-anatomy-up]','anatomyUp',-1);
  move('[data-anatomy-down]','anatomyDown',1);
  $$('[data-anatomy-delete]').forEach(button=>button.onclick=()=>{
    if(!confirm('Delete this tag anatomy? Segment rules that name its segments will stop resolving.'))return;
    anatomies.splice(+button.dataset.anatomyDelete,1);markProfileDirty();renderProfile();
  });
  const add=$('#addAnatomy');if(add)add.onclick=()=>{
    anatomies.push({id:'anatomy-'+Math.random().toString(36).slice(2,9),name:'New anatomy',pattern:'^.+$',delimiter:'-',
      segments:[{name:'segment1',index:0,identity:true}]});
    markProfileDirty();renderProfile();
  };
}
/* Where a rule came from, when it came from a document. Provenance is stored
   in legendTraining.ruleOrigins rather than on the rule, so this reads across
   rather than out of the rule object. "edited" means someone has since changed
   what the rule DOES -- renaming it does not count. */
export function profileRuleOriginBadge(draft,ruleId){
  const state=legendRuleState(draft,ruleId);
  if(!state)return '';
  const origin=legendRuleOrigin(draft,ruleId),source=legendSourceById(draft,origin&&origin.sourceId);
  const where=esc((source&&source.name)||'document')+(origin&&origin.page?' · p. '+origin.page:'');
  return `<span class="legend-origin ${state==='edited'?'edited':''}">${ic('file-text')}Legend · ${where}${state==='edited'?' · edited':''}</span>`;
}
export function renderProfileEngineRules(draft){
  const rows=[];
  for(const family of ['normalize','classify']){
    const rules=(draft.rules&&draft.rules[family]||[]).filter(rule=>!rule.legacyTagRuleId);
    rules.forEach((rule,index)=>rows.push({family,rule,index,length:rules.length}));
  }
  return `<div class="profile-band" style="margin-top:12px">
    <div class="profile-band-head">${ic('sliders-horizontal')}Normalize &amp; Classify Rules <span class="spacer"></span><span class="profile-rev">${rows.length}</span></div>
    <div class="profile-list profile-rule-list">${rows.length?rows.map(({family,rule,index,length})=>`<div class="profile-list-row ${rule.enabled===false?'rule-off':''}">
      <input type="checkbox" data-engine-rule-toggle="${esc(family)}:${esc(rule.id)}" ${rule.enabled===false?'':'checked'} ${draft.locked?'disabled':''} aria-label="Enable ${esc(rule.name)}">
      <div class="profile-list-main"><div class="profile-list-title"><span class="rule-target">${esc(family)}</span> ${esc(rule.name)}</div>
      <div class="profile-list-sub">${esc(profileEngineRuleSummary(rule))}</div>
      ${profileRuleOriginBadge(draft,rule.id)}${rule.note?`<div class="profile-rule-note">${esc(rule.note)}</div>`:''}</div>
      <div class="profile-row-actions">
        <button class="profile-icon-btn icon-btn" data-engine-rule-edit="${esc(family)}:${esc(rule.id)}" title="Inspect rule" aria-label="Inspect ${esc(rule.name)}">${ic('sliders-horizontal')}</button>
        <button class="profile-icon-btn icon-btn" data-engine-rule-up="${esc(family)}:${esc(rule.id)}" ${draft.locked||index===0?'disabled':''} title="Move up" aria-label="Move ${esc(rule.name)} up">${ic('chevrons-up')}</button>
        <button class="profile-icon-btn icon-btn" data-engine-rule-down="${esc(family)}:${esc(rule.id)}" ${draft.locked||index===length-1?'disabled':''} title="Move down" aria-label="Move ${esc(rule.name)} down">${ic('chevrons-down')}</button>
        <button class="profile-icon-btn icon-btn" data-engine-rule-delete="${esc(family)}:${esc(rule.id)}" ${draft.locked?'disabled':''} title="Delete rule" aria-label="Delete ${esc(rule.name)}">${ic('trash-2')}</button>
      </div></div>`).join(''):'<div class="profile-empty">No Normalize or Classify rules</div>'}</div>
  </div>${renderProfileAnatomies(draft)}${profileEngineRuleFields(draft)}`;
}
export function renderTagTrainer(draft){
  const selection=trainerSelection(),candidate=trainerCandidate(),preview=trainerMatchPreview(candidate,draft),rules=draft.tagRules||[];
  const currentSample=selectedPreviewValue();
  const chars=selection.value?[...selection.value].map((char,index)=>`<button class="char-btn ${index>=selection.start&&index<=selection.end?'on':''}" data-char-index="${index}" data-pos="${index+1}" title="Character ${index+1}">${esc(char===' '?'·':char)}</button>`).join(''):'';
  const target=S.profileUi.ruleTarget||'equipmentType',mode=S.profileUi.ruleMode||'contains';
  return `<section class="profile-section">
    <div class="profile-section-head">${ic('tag')}<div><h2>Tag Trainer</h2><p>${esc(selectedPreviewValue()||'Select a tag cell')}</p></div></div>
    ${profilePreviewHeader(draft)}
    <div class="profile-grid">
      <div class="mapping-inspector">
        <div class="profile-band">
          <div class="profile-band-head">${ic('tag')}Character selection <span class="spacer"></span><span class="profile-rev">${selection.text?`${selection.start+1}-${selection.end+1}`:''}</span></div>
          <div class="profile-band-body">${chars?`<div class="char-strip">${chars}</div>`:'<div class="profile-empty">Select a tag cell in the preview</div>'}</div>
        </div>
        <div class="profile-band">
          <div class="profile-band-head">${ic('sliders-horizontal')}Rule</div>
          <div class="profile-band-body profile-fields">
            <div class="profile-field"><label for="ruleTarget">Meaning</label><select id="ruleTarget">
              ${[['building','Building'],['discipline','Discipline'],['system','System'],['equipmentType','Equipment Type'],['gisMarker','GIS Topology Marker'],['busMarker','BUS Topology Marker'],['matchKey','Match Key'],['ignoreSuffix','Ignored Suffix']].map(([id,label])=>`<option value="${id}" ${target===id?'selected':''}>${label}</option>`).join('')}
            </select></div>
            <div class="profile-field"><label for="ruleMode">Behavior</label><select id="ruleMode">
              ${[['contains','Text appears'],['prefix','Tag starts with'],['suffix','Tag ends with'],['slice','Character positions'],['segment','Hyphen segment']].map(([id,label])=>`<option value="${id}" ${mode===id?'selected':''}>${label}</option>`).join('')}
            </select></div>
            <div class="profile-field"><label for="ruleValue">Assigned value</label><input class="profile-input" id="ruleValue" value="${esc(S.profileUi.ruleValue||'')}" placeholder="${esc(selection.text||'Value')}"></div>
            <div class="profile-field"><label for="ruleScope">Scope</label><select id="ruleScope"><option value="all" ${S.profileUi.ruleScope==='all'?'selected':''}>All imports</option><option value="sheet" ${S.profileUi.ruleScope!=='all'?'selected':''}>${esc(PROFILE_SOURCE_LABELS[S.profileUi.sourceKind]||'Current source')} only</option></select></div>
            <div class="profile-field wide"><label for="ruleName">Rule name</label><input class="profile-input" id="ruleName" value="${esc(S.profileUi.ruleName||'')}" placeholder="${esc(target+' · '+selection.text)}"></div>
            <div class="profile-actions wide"><button class="btn primary sm" id="addTagRule" ${selection.text&&!draft.locked?'':'disabled'}>${ic('plus')}Add rule</button><span class="spacer"></span><span class="hint">${preview.count} matching sample${preview.count===1?'':'s'}</span></div>
          </div>
          ${preview.values.length?`<div class="rule-preview" style="padding:0 13px 13px">${preview.values.map(item=>`<div class="rule-example" title="${esc(item.tag)}">${esc(item.tag)} → <b>${esc(item.output)}</b></div>`).join('')}</div>`:''}
        </div>
      </div>
      <div>
        ${renderSheetPreview(draft)}
        <div class="profile-band" style="margin-top:12px">
          <div class="profile-band-head">${ic('list-tree')}Rules <span class="spacer"></span><span class="profile-rev">first match wins · ${rules.length}</span></div>
          <div class="profile-list">${rules.length?rules.map((rule,index)=>{
            const exclusions=rule.exclusions||[],excluded=currentSample&&exclusions.some(value=>tagKey(value)===tagKey(currentSample));
            const canExclude=currentSample&&ruleSelection({...rule,exclusions:[]},currentSample)!=null;
            return `<div class="profile-list-row ${rule.enabled===false?'rule-off':''}">
            <input type="checkbox" data-rule-toggle="${esc(rule.id)}" ${rule.enabled===false?'':'checked'} ${draft.locked?'disabled':''} aria-label="Enable ${esc(rule.name)}">
            <div class="profile-list-main"><div class="profile-list-title"><span class="rule-target">${esc(rule.target)}</span> ${esc(rule.name)}</div>
            <div class="profile-list-sub">${esc(rule.mode)} · ${esc(rule.needle||'position')} → ${esc(rule.value||'selected text')}${rule.sourceKind?' · '+esc(PROFILE_SOURCE_LABELS[rule.sourceKind]||rule.sourceKind):''}${exclusions.length?' · '+exclusions.length+' excluded':''}</div></div>
            <div class="profile-row-actions">
              ${canExclude?`<button class="profile-icon-btn icon-btn" data-rule-exclude="${esc(rule.id)}" ${draft.locked?'disabled':''} title="${excluded?'Include':'Exclude'} selected tag" aria-label="${excluded?'Include':'Exclude'} ${esc(currentSample)}">${ic(excluded?'rotate-ccw':'minus')}</button>`:''}
              <button class="profile-icon-btn icon-btn" data-rule-up="${esc(rule.id)}" ${draft.locked||index===0?'disabled':''} title="Move up" aria-label="Move rule up">${ic('chevrons-up')}</button>
              <button class="profile-icon-btn icon-btn" data-rule-down="${esc(rule.id)}" ${draft.locked||index===rules.length-1?'disabled':''} title="Move down" aria-label="Move rule down">${ic('chevrons-down')}</button>
              <button class="profile-icon-btn icon-btn" data-rule-delete="${esc(rule.id)}" ${draft.locked?'disabled':''} title="Delete rule" aria-label="Delete ${esc(rule.name)}">${ic('trash-2')}</button>
            </div></div>`;
          }).join(''):'<div class="profile-empty">No trained rules</div>'}</div>
        </div>
        ${renderProfileEngineRules(draft)}
      </div>
    </div>
  </section>`;
}
export const PROFILE_RELATION_KINDS=[
  ['constant','Fixed parent'],
  ['prefixSplit','Parent inside a tag'],
  ['attributeMatch','Match another equipment tag'],
  ['fragmentLookup','Build parent from MEL']
];
export function profileLiteralPattern(value,mode){
  const escaped=String(value||'').replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  if(mode==='prefix')return '^'+escaped;
  if(mode==='suffix')return escaped+'$';
  if(mode==='exact')return '^'+escaped+'$';
  return mode==='regex'?String(value||''):escaped;
}
export function profileRelationMatchMode(rule){
  const stored=clean(rule&&rule.ui&&rule.ui.matchMode);
  if(['contains','prefix','suffix','exact','regex'].includes(stored))return stored;
  const pattern=clean(rule&&rule.pattern);
  return /^[A-Za-z0-9 _-]+$/.test(pattern)?'contains':'regex';
}
export function profileRelationSummary(rule){
  if(rule.kind==='constant')return `Matching ${rule.pattern||'tag'} -> ${rule.parent||'parent not set'}`;
  if(rule.kind==='prefixSplit')return `Parent before "${rule.delimiter||'_'}" when tag contains ${rule.pattern||'marker'}`;
  if(rule.kind==='attributeMatch'){
    const own=Object.entries(rule.when||{})[0]||[],match=Object.entries(rule.match||{})[0]||[];
    const source=rule.source==='canonical'?'hierarchy':'MEL';
    return `${own[0]||'equipment'} = ${own[1]||'any'} -> ${source} ${match[0]||'attribute'} = ${match[1]||'current value'}`;
  }
  if(rule.kind==='fragmentLookup')return `${(rule.markers||[]).join(', ')||'Tag fragment'} -> ${rule.source||'MEL'} lookup`;
  return clean(rule.kind)||'Relationship rule';
}
export function profileRelationAttributes(draft){
  const fields=[
    ['equipmentType','Equipment Type'],['gisMarker','GIS Topology Marker'],['busMarker','BUS Topology Marker'],['matchKey','Match Key'],['building','Building'],
    ['discipline','Discipline'],['system','System'],['placeholder','Placeholder']
  ];
  for(const attribute of draft.attributes||[]){
    const id=clean(attribute&&attribute.id);if(id&&!fields.some(([key])=>key===id))fields.push([id,clean(attribute.label)||id]);
  }
  return fields;
}
export function profileRelationEditorRule(draft){
  const found=(draft.rules&&draft.rules.relate||[]).find(rule=>rule.id===S.profileUi.relationRuleId);
  if(found)return profileClone(found);
  const kind=S.profileUi.relationKind||'constant',selected=trainerSelection().text;
  if(kind==='prefixSplit')return {kind,name:'Parent from tag prefix',delimiter:'_',pattern:selected,tagSource:'raw',cleanPrefix:true,enabled:true};
  if(kind==='attributeMatch')return {kind,name:'Match parent in MEL',source:'mel',when:{equipmentType:'LVS'},whenParent:{equipmentType:'XFM'},
    match:{equipmentType:'XFM',matchKey:'@matchKey'},whenDiffers:'matchKey',preferExactTag:{attribute:'matchKey'},enabled:true};
  if(kind==='fragmentLookup')return {kind,name:'Parent from MEL match',markers:selected?[selected]:[],source:'mel',mode:'containing',
    onMultiple:'review',
    buildingFrom:'tagBeforeFirst',buildingDelimiter:'-',unitFrom:'fragmentBeforeFirst',unitDelimiter:'_',
    parent:[{kind:'part',name:'building'},{kind:'literal',text:'-'},{kind:'part',name:'unit'}],enabled:true};
  return {kind:'constant',name:'Fixed parent rule',pattern:selected,parent:'',requiresNoParent:false,enabled:true,ui:{matchMode:'contains'}};
}
export function profileRelationPartRows(rule,disabled){
  const parts=Array.isArray(rule.parent)?rule.parent:[];
  return [0,1,2,3].map(index=>{
    const part=parts[index]||{kind:'none'},value=part.kind==='literal'?part.text:part.name||'';
    return `<div class="relation-part">
      <span class="relation-part-index">${index+1}</span>
      <select data-relation-part-kind="${index}" ${disabled}>
        ${[['none','Unused'],['literal','Text'],['column','MEL column'],['part','Extracted value']].map(([id,label])=>`<option value="${id}" ${part.kind===id?'selected':''}>${label}</option>`).join('')}
      </select>
      <input class="profile-input" data-relation-part-value="${index}" value="${esc(value)}" placeholder="${part.kind==='column'?'Building, UPN...':part.kind==='part'?'building or unit':'Text'}" ${part.kind==='none'?'disabled':disabled} list="relationPartSuggestions">
    </div>`;
  }).join('');
}
export function renderProfileRelationFields(rule,draft){
  const disabled=draft.locked?'disabled':'',kind=rule.kind,attributes=profileRelationAttributes(draft);
  const attributeOptions=selected=>attributes.map(([id,label])=>`<option value="${esc(id)}" ${id===selected?'selected':''}>${esc(label)}</option>`).join('');
  const note=`<div class="profile-field wide"><label for="relRuleNote">Why this rule exists</label><textarea class="profile-textarea" id="relRuleNote" ${disabled}>${esc(rule.note||'')}</textarea></div>`;
  if(kind==='constant'){
    const matchMode=profileRelationMatchMode(rule);
    const needle=matchMode==='regex'?rule.pattern:clean(rule.ui&&rule.ui.needle)||rule.pattern;
    return `<div class="profile-field"><label for="relMatchMode">Tag match</label><select id="relMatchMode" ${disabled}>
        ${[['contains','Contains text'],['prefix','Starts with'],['suffix','Ends with'],['exact','Exact tag'],['regex','Advanced pattern']].map(([id,label])=>`<option value="${id}" ${id===matchMode?'selected':''}>${label}</option>`).join('')}
      </select></div>
      <div class="profile-field"><label for="relNeedle">Text</label><input class="profile-input" id="relNeedle" value="${esc(needle||'')}" ${disabled}></div>
      <div class="profile-field wide"><label for="relParent">Closest parent</label><input class="profile-input" id="relParent" value="${esc(rule.parent||'')}" ${disabled}></div>
      <label class="profile-check wide"><input type="checkbox" id="relRequiresNoParent" ${rule.requiresNoParent?'checked':''} ${disabled}><span>Apply only when no source supplied a parent</span></label>${note}`;
  }
  if(kind==='prefixSplit'){
    const marker=clean(rule.ui&&rule.ui.markerNeedle)||rule.pattern;
    return `<div class="profile-field"><label for="relNeedle">Required marker</label><input class="profile-input" id="relNeedle" value="${esc(marker||'')}" ${disabled}></div>
      <div class="profile-field"><label for="relDelimiter">Parent ends before</label><input class="profile-input" id="relDelimiter" value="${esc(rule.delimiter||'_')}" maxlength="4" ${disabled}></div>
      <div class="profile-field"><label for="relTagSource">Read from</label><select id="relTagSource" ${disabled}><option value="canonical" ${rule.tagSource!=='raw'?'selected':''}>Canonical equipment tag</option><option value="raw" ${rule.tagSource==='raw'?'selected':''}>Original equipment tag</option></select></div>
      <label class="profile-check"><input type="checkbox" id="relCleanPrefix" ${rule.cleanPrefix?'checked':''} ${disabled}><span>Normalize the extracted parent</span></label>
      <label class="profile-check wide"><input type="checkbox" id="relAlsoParent" ${rule.alsoCurrentParent?'checked':''} ${disabled}><span>Also inspect the current parent and preserve its full tag as a dependency</span></label>${note}`;
  }
  if(kind==='attributeMatch'){
    const own=Object.entries(rule.when||{})[0]||['equipmentType',''],parent=Object.entries(rule.whenParent||{})[0]||['equipmentType',''];
    const matchEntries=Object.entries(rule.match||{}),target=matchEntries.find(([,value])=>!String(value).startsWith('@'))||matchEntries[0]||['equipmentType',''];
    const sharedEntries=matchEntries.filter(([,value])=>String(value).startsWith('@'));
    const shared=sharedEntries[0]||['matchKey','@matchKey'],sharedOwn=String(shared[1]||'').replace(/^@/,'')||shared[0];
    const extra=sharedEntries[1]||['',''],extraOwn=String(extra[1]||'').replace(/^@/,'');
    const source=rule.source==='canonical'?'canonical':'mel',sourceLabel=source==='canonical'?'hierarchy':'MEL';
    const optionalAttributes=selected=>`<option value="">None</option>${attributeOptions(selected)}`;
    return `<div class="profile-field wide"><label for="relLookupSource">Find the parent in</label><select id="relLookupSource" ${disabled}><option value="mel" ${source==='mel'?'selected':''}>Master Equipment List</option><option value="canonical" ${source==='canonical'?'selected':''}>Built hierarchy equipment</option></select></div>
      <div class="profile-field"><label for="relOwnAttribute">Equipment field</label><select id="relOwnAttribute" ${disabled}>${attributeOptions(own[0])}</select></div>
      <div class="profile-field"><label for="relOwnValue">Equipment value</label><input class="profile-input" id="relOwnValue" value="${esc(own[1]||'')}" ${disabled}></div>
      <div class="profile-field"><label for="relParentAttribute">Current parent field</label><select id="relParentAttribute" ${disabled}>${attributeOptions(parent[0])}</select></div>
      <div class="profile-field"><label for="relParentValue">Current parent value</label><input class="profile-input" id="relParentValue" value="${esc(parent[1]||'')}" ${disabled}></div>
      <div class="profile-field"><label for="relTargetAttribute">${sourceLabel} parent field</label><select id="relTargetAttribute" ${disabled}>${attributeOptions(target[0])}</select></div>
      <div class="profile-field"><label for="relTargetValue">${sourceLabel} parent value</label><input class="profile-input" id="relTargetValue" value="${esc(target[1]||'')}" ${disabled}></div>
      <div class="profile-field"><label for="relSharedAttribute">Shared ${sourceLabel} field</label><select id="relSharedAttribute" ${disabled}>${attributeOptions(shared[0])}</select></div>
      <div class="profile-field"><label for="relSharedOwnAttribute">Read value from equipment</label><select id="relSharedOwnAttribute" ${disabled}>${attributeOptions(sharedOwn)}</select></div>
      <div class="profile-field"><label for="relExtraSharedAttribute">Second shared field</label><select id="relExtraSharedAttribute" ${disabled}>${optionalAttributes(extra[0])}</select></div>
      <div class="profile-field"><label for="relExtraSharedOwnAttribute">Read second value from</label><select id="relExtraSharedOwnAttribute" ${disabled}>${optionalAttributes(extraOwn)}</select></div>
      <label class="profile-check"><input type="checkbox" id="relExcludeSelf" ${rule.excludeSelf?'checked':''} ${disabled}><span>Exclude the equipment itself from parent matches</span></label>
      <label class="profile-check"><input type="checkbox" id="relWhenDiffers" ${rule.whenDiffers?'checked':''} ${disabled}><span>Run only when equipment and current parent differ</span></label>
      <label class="profile-check"><input type="checkbox" id="relPreferExact" ${rule.preferExactTag?'checked':''} ${disabled}><span>Prefer the exact reconstructed MEL tag</span></label>${note}`;
  }
  const marker=(rule.markers||[]).join(', ');
  return `<div class="profile-field wide"><label for="relMarkers">Tag markers</label><input class="profile-input" id="relMarkers" value="${esc(marker)}" placeholder="SCR-, SCC-" ${disabled}></div>
    <div class="profile-field"><label for="relLookupMode">MEL match</label><select id="relLookupMode" ${disabled}><option value="containing" ${rule.mode!=='exact'?'selected':''}>Contains fragment</option><option value="exact" ${rule.mode==='exact'?'selected':''}>Exact tag</option></select></div>
    <div class="profile-field"><label for="relFragmentFrom">Search with</label><select id="relFragmentFrom" ${disabled}><option value="marker" ${rule.fragmentFrom!=='wholeTag'?'selected':''}>Marker through tag end</option><option value="wholeTag" ${rule.fragmentFrom==='wholeTag'?'selected':''}>Whole equipment tag</option></select></div>
    <div class="profile-field"><label for="relOnMultiple">Multiple MEL matches</label><select id="relOnMultiple" ${disabled}><option value="first" ${rule.onMultiple==='first'?'selected':''}>Use first row (legacy)</option><option value="review" ${rule.onMultiple!=='first'?'selected':''}>Flag for review</option></select></div>
    <label class="profile-check"><input type="checkbox" id="relExtractBuilding" ${rule.buildingFrom==='tagBeforeFirst'?'checked':''} ${disabled}><span>Extract building before first delimiter</span></label>
    <div class="profile-field"><label for="relBuildingDelimiter">Building delimiter</label><input class="profile-input" id="relBuildingDelimiter" value="${esc(rule.buildingDelimiter||'-')}" maxlength="4" ${disabled}></div>
    <label class="profile-check"><input type="checkbox" id="relExtractUnit" ${rule.unitFrom==='fragmentBeforeFirst'?'checked':''} ${disabled}><span>Extract unit before first delimiter</span></label>
    <div class="profile-field"><label for="relUnitDelimiter">Unit delimiter</label><input class="profile-input" id="relUnitDelimiter" value="${esc(rule.unitDelimiter||'_')}" maxlength="4" ${disabled}></div>
    <div class="profile-field wide"><label>Closest parent recipe</label><div class="relation-parts">${profileRelationPartRows(rule,disabled)}</div>
      <datalist id="relationPartSuggestions"><option value="Building"><option value="UPN"><option value="SystemParent"><option value="Discipline"><option value="SystemDescription"><option value="building"><option value="unit"></datalist>
    </div>${note}`;
}
export function renderRelationshipsProfile(draft){
  const rules=draft.rules&&draft.rules.relate||[],editor=profileRelationEditorRule(draft),editing=!!S.profileUi.relationRuleId;
  const selection=trainerSelection(),chars=selection.value?[...selection.value].map((char,index)=>`<button class="char-btn ${index>=selection.start&&index<=selection.end?'on':''}" data-rel-char-index="${index}" data-pos="${index+1}" title="Character ${index+1}">${esc(char===' '?'·':char)}</button>`).join(''):'';
  return `<section class="profile-section">
    <div class="profile-section-head">${ic('git-branch')}<div><h2>Relationships</h2><p>${rules.filter(rule=>rule.enabled!==false).length} active parent rules · first resolved rule wins</p></div></div>
    ${profilePreviewHeader(draft)}
    <div class="profile-grid relationship-grid">
      <div class="mapping-inspector">
        <div class="profile-band">
          <div class="profile-band-head">${ic('tag')}Example selection <span class="spacer"></span><span class="profile-rev">${selection.text?`${selection.start+1}-${selection.end+1}`:''}</span></div>
          <div class="profile-band-body">${chars?`<div class="char-strip">${chars}</div>`:'<div class="profile-empty">Select an equipment tag in the preview</div>'}</div>
        </div>
        <div class="profile-band">
          <div class="profile-band-head">${ic('git-branch')}${editing?'Edit relationship':'New relationship'}</div>
          <div class="profile-band-body profile-fields">
            ${draft.locked?`<div class="note info wide">${ic('lock')}Clone Eagle to change relationship rules.</div>`:''}
            <div class="profile-field wide"><label for="relRuleName">Rule name</label><input class="profile-input" id="relRuleName" value="${esc(editor.name||'')}" ${draft.locked?'disabled':''}></div>
            <div class="profile-field wide"><label for="relRuleKind">Method</label><select id="relRuleKind" ${draft.locked||editing?'disabled':''}>${PROFILE_RELATION_KINDS.map(([id,label])=>`<option value="${id}" ${editor.kind===id?'selected':''}>${label}</option>`).join('')}</select></div>
            ${renderProfileRelationFields(editor,draft)}
            <div class="profile-actions wide">
              <button class="btn primary sm" id="saveRelationRule" ${draft.locked?'disabled':''}>${ic('check')}${editing?'Update rule':'Add rule'}</button>
              ${editing?`<button class="btn ghost sm" id="cancelRelationRule">${ic('x')}Cancel</button>`:''}
              ${selection.text&&['constant','prefixSplit','fragmentLookup'].includes(editor.kind)?`<button class="btn ghost sm" id="useRelationSelection">${ic('tag')}Use selection</button>`:''}
            </div>
          </div>
        </div>
      </div>
      <div>
        ${renderSheetPreview(draft)}
        <div class="profile-band" style="margin-top:12px">
          <div class="profile-band-head">${ic('list-tree')}Relationship order <span class="spacer"></span><span class="profile-rev">${rules.length}</span></div>
          <div class="profile-list profile-rule-list">${rules.length?rules.map((rule,index)=>`<div class="profile-list-row ${rule.enabled===false?'rule-off':''}">
            <input type="checkbox" data-relation-toggle="${esc(rule.id)}" ${rule.enabled===false?'':'checked'} ${draft.locked?'disabled':''} aria-label="Enable ${esc(rule.name)}">
            <div class="profile-list-main"><div class="profile-list-title"><span class="rule-target">${esc(PROFILE_RELATION_KINDS.find(([id])=>id===rule.kind)?.[1]||rule.kind)}</span> ${esc(rule.name)}</div>
            <div class="profile-list-sub">${esc(profileRelationSummary(rule))}</div>${rule.note?`<div class="profile-rule-note">${esc(rule.note)}</div>`:''}</div>
            <div class="profile-row-actions">
              <button class="profile-icon-btn icon-btn" data-relation-edit="${esc(rule.id)}" title="Inspect rule" aria-label="Inspect ${esc(rule.name)}">${ic('sliders-horizontal')}</button>
              <button class="profile-icon-btn icon-btn" data-relation-up="${esc(rule.id)}" ${draft.locked||index===0?'disabled':''} title="Move up" aria-label="Move ${esc(rule.name)} up">${ic('chevrons-up')}</button>
              <button class="profile-icon-btn icon-btn" data-relation-down="${esc(rule.id)}" ${draft.locked||index===rules.length-1?'disabled':''} title="Move down" aria-label="Move ${esc(rule.name)} down">${ic('chevrons-down')}</button>
              <button class="profile-icon-btn icon-btn" data-relation-delete="${esc(rule.id)}" ${draft.locked?'disabled':''} title="Delete rule" aria-label="Delete ${esc(rule.name)}">${ic('trash-2')}</button>
            </div></div>`).join(''):'<div class="profile-empty">No relationship rules</div>'}</div>
        </div>
      </div>
    </div>
  </section>`;
}

/* ---- visual hierarchy trainer ---- */
/* Module-level, deliberately OUTSIDE profileUi: the evaluation walks every
   canonical record through the draft's engine, which costs seconds at scale,
   and profileUi is rebuilt on every studio open — so the old cache made every
   studio visit pay that cost again. The signature covers everything the
   evaluation reads (draft execution content, build revision, model size), so
   a stale entry can never be served. */
let VISUAL_TREE_CACHE=null;
export function invalidateVisualTreeCache(){VISUAL_TREE_CACHE=null;}
let STUDIO_PREWARM_REVISION=-1;
/* Called after a build settles: pays the visual evaluation while the user is
   still reading the result tree, so the first Visual Trainer click is warm. */
export function prewarmStudioCaches(){
  if(!S.canonicalModel.size||S.profileBuildRevision===STUDIO_PREWARM_REVISION)return;
  STUDIO_PREWARM_REVISION=S.profileBuildRevision;
  try{
    const profile=S.profileDraft||activeProfile();
    profileVisualCache(profile);
    profileVisualBuildTree(profile,'ssm');
    profileVisualBuildTree(profile,'flow');
  }catch(_){/* prewarm is best-effort */}
}
export function profileVisualCache(draft){
  const signature=visualEvaluationSignature(draft)+'|'+S.profileBuildRevision+'|'+S.canonicalModel.size;
  if(VISUAL_TREE_CACHE&&VISUAL_TREE_CACHE.signature===signature)return VISUAL_TREE_CACHE;
  const evaluation=visualTrainerEvaluateParents(draft,S.canonicalModel);
  VISUAL_TREE_CACHE={signature,evaluation,trees:{}};
  return VISUAL_TREE_CACHE;
}
export function profileVisualGroupingLevels(draft){
  const mode=(draft.modes||[]).find(item=>item.executor==='projected'&&(item.levels||[]).some(level=>level.kind==='grouping'));
  const levels=(mode&&mode.levels||[]).filter(level=>level.kind==='grouping').map(level=>clean(level.attribute)).filter(Boolean);
  return levels.length?levels:[...VISUAL_TRAINER_GROUP_ATTRIBUTES];
}
export function profileVisualBuildTree(draft,mode){
  const cache=profileVisualCache(draft);if(cache.trees[mode])return cache.trees[mode];
  const evaluation=cache.evaluation,nodes=new Map(),roots=[],records=evaluation.records.filter(record=>record.includeInHierarchy);
  const levels=mode==='ssm'?profileVisualGroupingLevels(draft):[];
  const equipment=new Map(),groups=new Map();
  const make=(id,name,kind,record,groupValues)=>{
    const node={id,name,kind,recordKey:record&&(record.key||tagKey(record.tag))||'',record,groupValues:groupValues||{},parent:null,children:[],depth:0};
    nodes.set(id,node);return node;
  };
  for(const record of records){
    const key=record.key||tagKey(record.tag),context=evaluation.contexts.get(key);
    if(levels.some(level=>tagKey(record.tag)===tagKey(context&&context[level])))continue;
    equipment.set(key,make('equipment:'+key,record.tag,'equipment',record,{}));
  }
  const groupFor=record=>{
    if(!levels.length)return null;
    const key=record.key||tagKey(record.tag),context=evaluation.contexts.get(key);let parent=null,path='',values={};
    for(const level of levels){
      const value=clean(context&&context[level])||'Unassigned';
      values={...values,[level]:value};path+=KEYSEP+level+KEYSEP+tagKey(value);
      let node=groups.get(path);
      if(!node){
        node=make('group:'+path,value,level,null,values);groups.set(path,node);
        node.parent=parent;if(parent)parent.children.push(node);else roots.push(node);
      }
      parent=node;
    }
    return parent;
  };
  const groupedKey=record=>{
    const key=record.key||tagKey(record.tag),context=evaluation.contexts.get(key);
    return levels.map(level=>tagKey(context&&context[level])).join(KEYSEP);
  };
  for(const record of records){
    const key=record.key||tagKey(record.tag),node=equipment.get(key);if(!node)continue;
    const parentKey=tagKey(evaluation.parents.get(key)),parentRecord=evaluation.byKey.get(parentKey),parentNode=equipment.get(parentKey);
    const canNest=parentNode&&parentRecord&&groupedKey(record)===groupedKey(parentRecord)&&!visualTrainerIsDescendant(key,parentKey,evaluation.parents);
    if(canNest){node.parent=parentNode;parentNode.children.push(node);}
    else{
      const group=groupFor(record);node.parent=group;
      if(group)group.children.push(node);else roots.push(node);
    }
  }
  const sortAndDepth=(node,depth)=>{
    node.depth=depth;node.children.sort((a,b)=>natCmp(a.name,b.name));
    node.children.forEach(child=>sortAndDepth(child,depth+1));
  };
  roots.sort((a,b)=>natCmp(a.name,b.name));roots.forEach(root=>sortAndDepth(root,0));
  const tree={roots,nodes,evaluation,mode,levels};
  cache.trees[mode]=tree;return tree;
}
export function profileVisualNodePath(node){
  const path=[];for(let current=node;current;current=current.parent)path.unshift(current.name);return path;
}
export function profileVisualExpandedSet(){return new Set(S.profileUi.visualExpanded||[]);}
export function profileVisualVisibleRows(tree,query){
  if(S.profileUi.visualSeedMode!==tree.mode){
    S.profileUi.visualSeedMode=tree.mode;
    S.profileUi.visualExpanded=tree.roots.slice(0,30).map(node=>node.id);
  }
  const expanded=profileVisualExpandedSet(),rows=[],limit=800,q=clean(query).toLowerCase();
  if(q){
    const included=new Set(),matched=new Set();
    for(const node of tree.nodes.values())if(node.name.toLowerCase().includes(q)){
      matched.add(node.id);for(let current=node;current;current=current.parent)included.add(current.id);
      node.children.slice(0,24).forEach(child=>included.add(child.id));
    }
    const walk=node=>{
      if(rows.length>=limit||!included.has(node.id))return;
      rows.push({node,match:matched.has(node.id),context:!matched.has(node.id)});
      node.children.forEach(walk);
    };
    tree.roots.forEach(walk);
    return {rows,total:included.size,truncated:included.size>rows.length,matches:matched.size};
  }
  const walk=node=>{
    if(rows.length>=limit)return;
    rows.push({node,match:false,context:false});
    if(expanded.has(node.id))node.children.forEach(walk);
  };
  tree.roots.forEach(walk);
  return {rows,total:tree.nodes.size,truncated:rows.length>=limit,matches:0};
}
export function profileVisualRowMarkup(item,tree){
  const node=item.node,sourceKey=S.profileUi.visualSourceKey,source=sourceKey&&tree.evaluation.byKey.get(sourceKey);
  const selected=node.recordKey&&node.recordKey===sourceKey,targetMode=!!source;
  const descendant=node.recordKey&&sourceKey?visualTrainerIsDescendant(sourceKey,node.recordKey,tree.evaluation.parents):false;
  const validTarget=targetMode&&!selected&&(node.kind!=='equipment'||(!descendant&&!!node.recordKey));
  const icon=node.kind==='building'?'folder-tree':node.kind==='discipline'?'layers':node.kind==='system'?'network':'tag';
  const hasKids=node.children.length>0,open=profileVisualExpandedSet().has(node.id);
  return `<div class="visual-tree-row ${selected?'selected':''} ${validTarget?'valid-target':''} ${item.context?'search-context':''}" role="treeitem" aria-level="${node.depth+1}" aria-expanded="${hasKids?String(open):''}"
      data-visual-node="${esc(node.id)}" data-visual-target="${validTarget?'true':'false'}" style="--visual-depth:${Math.min(node.depth,18)}">
    <button class="visual-twist icon-btn" type="button" data-visual-expand="${esc(node.id)}" ${hasKids?'':'disabled'} title="${open?'Collapse':'Expand'}" aria-label="${open?'Collapse':'Expand'} ${esc(node.name)}">${hasKids?ic(open?'chevron-down':'chevron-right'):''}</button>
    ${node.kind==='equipment'?`<button class="visual-grip icon-btn" type="button" data-visual-grip="${esc(node.recordKey)}" title="Move ${esc(node.name)}" aria-label="Move ${esc(node.name)}">${ic('grip-vertical')}</button>`:'<span class="visual-grip-spacer"></span>'}
    <span class="visual-node-icon kind-${esc(node.kind)}">${ic(icon)}</span>
    <button class="visual-node-label" type="button" data-visual-choose="${esc(node.id)}" ${targetMode&&!validTarget&&!selected?'disabled':''}>
      <span>${esc(node.name)}</span>${item.match?`<small>match</small>`:''}
    </button>
    ${node.kind==='equipment'?`<span class="visual-node-type">${esc(clean(tree.evaluation.contexts.get(node.recordKey)&&tree.evaluation.contexts.get(node.recordKey).equipmentType)||'Equipment')}</span>`:''}
    ${node.children.length?`<span class="visual-child-count">${node.children.length.toLocaleString()}</span>`:''}
    ${node.kind==='equipment'?(selected
      ?`<button class="btn sm visual-move-btn" type="button" data-visual-move="${esc(node.recordKey)}">${ic('x')}Cancel</button>`
      :validTarget
        ?`<button class="btn sm visual-move-btn" type="button" data-visual-choose="${esc(node.id)}">${ic('corner-down-right')}Place</button>`
        :targetMode?'':`<button class="btn sm visual-move-btn" type="button" data-visual-move="${esc(node.recordKey)}">${ic('move')}Move</button>`):''}
  </div>`;
}
export function profileVisualImpactForProposal(proposal){
  if(!proposal)return null;
  return proposal.impacts[S.profileUi.visualScope]||proposal.impacts.single;
}
/* A "Matching Equipment tags" rule claims every tag its attributes match, so the
   panel lists all of them -- not a sample -- with a checkbox each. Clearing one
   writes an exclusion onto the pending rule (see profileVisualToggleAffected),
   which is why the list has to be complete: a capped list can only ever offer an
   opt-out for the tags that happened to fit in the cap. Every other case keeps
   the read-only sample, since an exact placement affects exactly one tag and a
   grouping proposal carries no relate rule to hang an exclusion on. */
export function profileVisualAffectedMarkup(proposal,impact,scope){
  /* An impact can be the short {valid,reason} refusal, which carries neither
     list, so neither is assumed present. */
  if(!proposal||!impact)return '';
  const affected=proposal.kind==='relationship'&&scope==='similar'&&Array.isArray(impact.affected)?impact.affected:null;
  if(!affected||!affected.length){
    const examples=Array.isArray(impact.examples)?impact.examples:[];
    if(!examples.length)return '';
    return `<div class="visual-examples"><div class="visual-examples-head">Affected examples</div>${examples.map(example=>`<div><b>${esc(example.tag)}</b><span>${esc(example.before||'Top level')} ${ic('corner-down-right')} ${esc(example.after||'Top level')}</span></div>`).join('')}</div>`;
  }
  const kept=affected.filter(item=>!item.excluded).length;
  return `<div class="visual-examples visual-affected"><div class="visual-examples-head">Affected tags<span>${kept.toLocaleString()} of ${affected.length.toLocaleString()} kept</span></div>${affected.map(item=>{
    /* The dragged tag is the rule's own worked example -- excluding it would
       leave a rule that no longer reproduces the move it was inferred from. */
    const anchor=tagKey(item.tag)===proposal.sourceKey,flags=[item.excluded?'':'checked',anchor?'disabled':''].filter(Boolean).join(' ');
    return `<label class="visual-affect ${item.excluded?'off':''}" title="${anchor?'The dragged tag defines this rule and cannot be excluded':esc(item.excluded?'Include '+item.tag:'Exclude '+item.tag)}">
      <input type="checkbox" data-visual-affect="${esc(item.tag)}" ${flags}>
      <div><b>${esc(item.tag)}</b><small>${item.excluded?'Left where it is':`${esc(item.before||'Top level')} ${ic('corner-down-right')} ${esc(item.after||'Top level')}`}</small></div>
    </label>`;
  }).join('')}</div>`;
}
export function profileVisualProposalMarkup(draft,tree){
  const proposal=S.profileUi.visualProposal,sourceKey=S.profileUi.visualSourceKey;
  if(!proposal){
    const source=sourceKey&&tree.evaluation.byKey.get(sourceKey);
    return `<div class="visual-inspector-empty">${ic(source?'corner-down-right':'move')}<h3>${source?'Choose a new parent':'Select a tag to move'}</h3>
      <p>${source?esc(source.tag)+' is ready to place. Search or navigate, then choose a destination.':'Use a tag’s move button or drag handle.'}</p>
      ${source?`<button class="btn ghost sm" id="cancelVisualMove">${ic('x')}Cancel move</button>`:''}</div>`;
  }
  const scope=S.profileUi.visualScope,impact=profileVisualImpactForProposal(proposal),similar=proposal.impacts.similar;
  const exactLabel=proposal.kind==='grouping'?'Only this tag':'Only this tag';
  const similarLabel=proposal.kind==='grouping'
    ?`All tags classified as ${esc(proposal.sourceType||'this type')}`
    :`Matching ${esc(proposal.sourceType||'similar')} tags`;
  const valid=impact&&impact.valid;
  const sentence=proposal.kind==='grouping'
    ?`Place ${esc(proposal.sourceTag)} in ${esc(Object.values(proposal.groupValues).join(' / '))}.`
    :`Make ${esc(proposal.targetTag)} the closest parent of ${esc(proposal.sourceTag)}.`;
  return `<div class="visual-proposal">
    <div class="visual-proposal-head"><span class="visual-proposal-icon">${ic(proposal.kind==='grouping'?'folder-tree':'git-branch')}</span><div><span>Proposed rule</span><h3>${sentence}</h3></div></div>
    <div class="visual-paths">
      <div><span>Current</span><code>${esc(proposal.sourcePath.join(' / '))}</code></div>
      <div><span>Proposed</span><code>${esc(proposal.targetPath.concat(proposal.sourceTag).join(' / '))}</code></div>
    </div>
    <fieldset class="visual-scope"><legend>Apply to</legend>
      <label><input type="radio" name="visualScope" value="single" ${scope!=='similar'?'checked':''}><span>${exactLabel}<small>Creates a precise override</small></span></label>
      <label class="${similar?'':'disabled'}"><input type="radio" name="visualScope" value="similar" ${scope==='similar'?'checked':''} ${similar?'':'disabled'}><span>${similarLabel}<small>${proposal.similarSummary||'Uses trained tag attributes'}</small></span></label>
    </fieldset>
    ${impact?`<div class="visual-impact-grid">
      <div><b>${impact.moved||0}</b><span>Will move</span></div>
      <div><b>${impact.alreadyCorrect||0}</b><span>Already correct</span></div>
      <div class="${impact.ambiguous?'warn':''}"><b>${impact.ambiguous||0}</b><span>Ambiguous</span></div>
      <div class="${impact.pinned?'warn':''}"><b>${impact.pinned||0}</b><span>Pinned</span></div>
      <div class="${impact.invalid?'bad':''}"><b>${impact.invalid||0}</b><span>Invalid</span></div>
      <div><b>0</b><span>Dependencies changed</span></div>
    </div>`:''}
    ${impact&&impact.boundaryWarnings?`<div class="note warn">${ic('triangle-alert')}<div>${impact.boundaryWarnings.toLocaleString()} relationship${impact.boundaryWarnings===1?' crosses':'s cross'} a grouping boundary and will restart beneath the destination folder.</div></div>`:''}
    ${proposal.kind==='relationship'&&(draft.hierarchy.resolutionStrategy==='legacy-register'||(draft.modes||[]).some(mode=>mode.executor==='raw'))?`<div class="note info">${ic('info')}<div>This parent rule will enable resolved Electrical Flow and register output for this editable profile. Eagle remains unchanged.</div></div>`:''}
    ${impact&&!valid?`<div class="note warn">${ic('triangle-alert')}<div>${esc(impact.reason||'Review this proposal before applying it.')}</div></div>`:''}
    ${profileVisualAffectedMarkup(proposal,impact,scope)}
    <div class="profile-actions visual-proposal-actions">
      <button class="btn ghost" id="cancelVisualProposal">${ic('x')}Cancel</button>
      <span class="spacer"></span>
      <button class="btn primary" id="applyVisualProposal" ${valid?'':'disabled'}>${ic('check')}${draft.locked?'Clone Eagle & add to draft':'Add to draft'}</button>
    </div>
  </div>`;
}
export function renderVisualTrainer(draft){
  if(!S.canonicalModel.size)return `<section class="profile-section">
    <div class="profile-section-head">${ic('move')}<div><h2>Visual Trainer</h2><p>No built hierarchy</p></div></div>
    <div class="note info">${ic('info')}<div>Build a hierarchy first, then return here to train placements from real tags.</div></div>
  </section>`;
  const mode=S.profileUi.visualMode==='ssm'?'ssm':'flow',tree=profileVisualBuildTree(draft,mode),visible=profileVisualVisibleRows(tree,S.profileUi.visualQuery);
  const source=S.profileUi.visualSourceKey&&tree.evaluation.byKey.get(S.profileUi.visualSourceKey);
  const rows=visible.rows.map(item=>profileVisualRowMarkup(item,tree)).join('');
  return `<section class="profile-section visual-trainer ${S.profileUi.visualFullscreen?'fullscreen':''}">
    <div class="profile-section-head">${ic('move')}<div><h2>Visual Trainer</h2><p>${tree.nodes.size.toLocaleString()} hierarchy items · ${draft.locked?'simulation only until Eagle is cloned':'changes stay in the draft until saved'}</p></div></div>
    ${draft.locked?`<div class="note info visual-lock-note">${ic('lock')}<div>Eagle remains protected. You can simulate a move, then clone it when the proposal is ready.</div></div>`:''}
    <div class="visual-toolbar">
      <div class="hierarchy-mode" role="group" aria-label="Visual hierarchy view">
        <button type="button" data-visual-mode="flow" class="${mode==='flow'?'on':''}">${ic('zap')}Electrical Flow</button>
        <button type="button" data-visual-mode="ssm" class="${mode==='ssm'?'on':''}">${ic('folder-tree')}SSM Hierarchy</button>
      </div>
      <div class="search visual-search">${ic('search')}<input id="visualSearch" value="${esc(S.profileUi.visualQuery)}" placeholder="${source?'Find a destination parent…':'Find a tag…'}" autocomplete="off" spellcheck="false"><button class="qx icon-btn ${S.profileUi.visualQuery?'show':''}" id="clearVisualSearch" type="button" aria-label="Clear search">${ic('x')}</button></div>
      <button class="profile-icon-btn icon-btn" id="undoVisualRule" ${S.profileUi.visualHistory.length?'':'disabled'} title="Undo visual training" aria-label="Undo visual training">${ic('undo-2')}</button>
      <button class="profile-icon-btn icon-btn" id="redoVisualRule" ${S.profileUi.visualFuture.length?'':'disabled'} title="Redo visual training" aria-label="Redo visual training">${ic('redo-2')}</button>
      <button class="profile-icon-btn icon-btn" id="toggleVisualFullscreen" title="${S.profileUi.visualFullscreen?'Exit full screen':'Full screen'}" aria-label="${S.profileUi.visualFullscreen?'Exit full screen':'Full screen'}">${ic(S.profileUi.visualFullscreen?'minimize-2':'maximize-2')}</button>
    </div>
    <div class="visual-workspace">
      <div class="visual-canvas profile-band">
        <div class="profile-band-head">${ic(mode==='ssm'?'folder-tree':'zap')}Hierarchy canvas <span class="spacer"></span><span class="profile-rev">${visible.matches?visible.matches.toLocaleString()+' matches':visible.rows.length.toLocaleString()+' visible'}${visible.truncated?' · refine search':''}</span></div>
        ${source?`<div class="visual-move-banner">${ic('move')}<span><b>${esc(source.tag)}</b> is being moved</span><button class="btn ghost sm" id="cancelVisualMove">${ic('x')}Cancel</button></div>`:''}
        <div class="visual-tree-scroll" id="visualTreeScroll"><div class="visual-tree" role="tree" aria-label="${mode==='ssm'?'SSM hierarchy':'Electrical flow hierarchy'}">${rows||`<div class="profile-empty">No hierarchy items match this search</div>`}</div></div>
      </div>
      <aside class="visual-inspector profile-band">
        <div class="profile-band-head">${ic('sliders-horizontal')}Rule proposal</div>
        <div class="visual-inspector-body" id="visualInspectorBody">${profileVisualProposalMarkup(draft,tree)}</div>
      </aside>
    </div>
    <div class="sr-only" id="visualTrainerLive" aria-live="polite"></div>
  </section>`;
}
export function profileVisualProposal(sourceKey,targetId){
  const draft=S.profileDraft,tree=profileVisualBuildTree(draft,S.profileUi.visualMode==='ssm'?'ssm':'flow');
  const sourceRecord=tree.evaluation.byKey.get(tagKey(sourceKey)),target=tree.nodes.get(targetId);
  if(!sourceRecord||!target||target.recordKey===sourceRecord.key)return;
  const sourceNode=tree.nodes.get('equipment:'+sourceRecord.key),sourcePath=sourceNode?profileVisualNodePath(sourceNode):[sourceRecord.tag];
  let proposal=null;
  if(target.kind==='equipment'){
    const targetRecord=tree.evaluation.byKey.get(target.recordKey);if(!targetRecord)return;
    const rule=visualTrainerRelationshipRule(sourceRecord,targetRecord,draft,S.canonicalModel);
    /* tree.evaluation IS the unchanged draft's evaluation, already cached --
       pass it so each impact stops re-deriving the same baseline. */
    const single=visualTrainerRelationshipImpact(draft,sourceRecord,targetRecord,'single',S.canonicalModel,null,tree.evaluation);
    const similar=rule?visualTrainerRelationshipImpact(draft,sourceRecord,targetRecord,'similar',S.canonicalModel,rule,tree.evaluation):null;
    const sourceContext=tree.evaluation.contexts.get(sourceRecord.key),targetContext=tree.evaluation.contexts.get(targetRecord.key);
    proposal={kind:'relationship',sourceKey:sourceRecord.key,targetKey:targetRecord.key,sourceTag:sourceRecord.tag,targetTag:targetRecord.tag,
      sourceType:sourceContext&&sourceContext.equipmentType,targetType:targetContext&&targetContext.equipmentType,
      sourcePath,targetPath:profileVisualNodePath(target),similarSummary:rule?Object.entries(rule.match).map(([key,value])=>`${key} ${String(value).startsWith('@')?'matches':'is '+value}`).join(' · '):'',
      impacts:{single,similar}};
  }else{
    const groupValues={...target.groupValues},rules=visualTrainerGroupingRules(sourceRecord,groupValues,draft,S.canonicalModel);
    const single=visualTrainerGroupingImpact(draft,sourceRecord,groupValues,'single',S.canonicalModel,null,tree.evaluation);
    const similar=rules.length?visualTrainerGroupingImpact(draft,sourceRecord,groupValues,'similar',S.canonicalModel,rules,tree.evaluation):null;
    const context=tree.evaluation.contexts.get(sourceRecord.key);
    proposal={kind:'grouping',sourceKey:sourceRecord.key,targetId:target.id,sourceTag:sourceRecord.tag,sourceType:context&&context.equipmentType,
      groupValues,sourcePath,targetPath:profileVisualNodePath(target),similarSummary:rules.length?`Reuses the ${clean(context&&context.equipmentType)||'equipment'} classifier`:'',
      impacts:{single,similar}};
  }
  S.profileUi.visualProposal=proposal;
  S.profileUi.visualScope=proposal.impacts.similar&&proposal.impacts.similar.valid?'similar':'single';
  renderProfile();
}
/* Deselecting a tag in the affected list writes an exclusion onto the PENDING
   rule object -- the very object visualTrainerRelationshipImpact was handed and
   returns as impact.rule, and the one profileVisualApplyProposal clones into the
   draft -- so the opt-out reaches the saved rule with no separate plumbing. The
   similar impact is then recomputed from that same rule so the stats row counts
   what is actually still selected. */
export function profileVisualToggleAffected(tag){
  const proposal=S.profileUi.visualProposal;if(!proposal||proposal.kind!=='relationship')return;
  const impact=proposal.impacts.similar,rule=impact&&impact.rule;if(!rule||tagKey(tag)===proposal.sourceKey)return;
  const exclusions=Array.isArray(rule.exclusions)?rule.exclusions:(rule.exclusions=[]);
  const index=exclusions.findIndex(value=>tagKey(value)===tagKey(tag));
  if(index>=0)exclusions.splice(index,1);else exclusions.push(tag);
  const draft=S.profileDraft,tree=profileVisualBuildTree(draft,S.profileUi.visualMode==='ssm'?'ssm':'flow');
  const sourceRecord=tree.evaluation.byKey.get(proposal.sourceKey),targetRecord=tree.evaluation.byKey.get(proposal.targetKey);
  if(!sourceRecord||!targetRecord)return;
  proposal.impacts.similar=visualTrainerRelationshipImpact(draft,sourceRecord,targetRecord,'similar',S.canonicalModel,rule,tree.evaluation);
  renderProfile();
}
export function profileVisualNodeValid(tree,sourceKey,target){
  if(!target||target.recordKey===tagKey(sourceKey))return false;
  return target.kind!=='equipment'||(!!target.recordKey&&!visualTrainerIsDescendant(sourceKey,target.recordKey,tree.evaluation.parents));
}
export function profileVisualTargetValid(sourceKey,targetId){
  const tree=profileVisualBuildTree(S.profileDraft,S.profileUi.visualMode==='ssm'?'ssm':'flow');
  return profileVisualNodeValid(tree,sourceKey,tree.nodes.get(targetId));
}
/* A drop always proposes a NEW PARENT, never an ordering slot -- children sort by
   name -- so the two zones differ only in which node they aim at: the child zone
   nests under the hovered row, the sibling zone re-aims at that row's own parent
   so the tag lands beside it. Some rows have no parent node to re-aim at: a root
   row in Electrical Flow (no grouping folders exist) and a top-level SSM folder
   both hang off the tree itself. Those fall back to the child zone -- and paint
   the child highlight, so the fallback is what the user sees -- rather than
   inventing a placement the proposal cannot express. */
export function profileVisualResolveDrop(tree,sourceKey,nodeId,zone){
  const node=tree&&tree.nodes.get(nodeId),key=tagKey(sourceKey);
  if(!node||!key||node.recordKey===key)return null;
  if(zone==='sibling'&&node.parent&&profileVisualNodeValid(tree,key,node.parent))
    return {targetId:node.parent.id,zone:'sibling',depth:node.depth,rowId:node.id};
  return profileVisualNodeValid(tree,key,node)?{targetId:node.id,zone:'child',depth:node.depth+1,rowId:node.id}:null;
}
export function profileVisualApplyProposal(){
  const proposal=S.profileUi.visualProposal,impact=profileVisualImpactForProposal(proposal);
  if(!proposal||!impact||!impact.valid)return;
  if(S.profileDraft.locked)duplicateProfile();
  S.profileUi.visualHistory.push({slice:visualTrainerDraftSlice(S.profileDraft),dirty:S.profileDirty});
  S.profileUi.visualHistory=S.profileUi.visualHistory.slice(-30);S.profileUi.visualFuture=[];
  const draft=S.profileDraft;
  draft.overrides=draft.overrides||{relationships:[],attributes:[]};
  draft.overrides.relationships=draft.overrides.relationships||[];draft.overrides.attributes=draft.overrides.attributes||[];
  if(proposal.kind==='relationship'){
    visualTrainerEnableResolvedFlow(draft);
    if(S.profileUi.visualScope==='similar')draft.rules.relate=[profileClone(impact.rule),...(draft.rules.relate||[])];
    else{
      draft.overrides.relationships=draft.overrides.relationships.filter(item=>tagKey(item.equipment)!==proposal.sourceKey);
      draft.overrides.relationships.push(profileClone(impact.override));
    }
  }else if(S.profileUi.visualScope==='similar')draft.rules.classify=[...profileClone(impact.rules),...(draft.rules.classify||[])];
  else{
    draft.overrides.attributes=draft.overrides.attributes.filter(item=>tagKey(item.equipment)!==proposal.sourceKey);
    draft.overrides.attributes.push(profileClone(impact.override));
  }
  S.profileUi.visualProposal=null;S.profileUi.visualSourceKey='';
  markProfileDirty();toast('Visual rule added to the profile draft');renderProfile();
}
export function profileVisualUndoRedo(direction){
  const from=direction==='undo'?S.profileUi.visualHistory:S.profileUi.visualFuture;
  const to=direction==='undo'?S.profileUi.visualFuture:S.profileUi.visualHistory;
  const entry=from.pop();if(!entry)return;
  to.push({slice:visualTrainerDraftSlice(S.profileDraft),dirty:S.profileDirty});
  S.profileDraft=visualTrainerRestoreDraftSlice(S.profileDraft,entry.slice);
  invalidateProfileEvaluation(S.profileDraft);S.profileDirty=!!entry.dirty;invalidateVisualTreeCache();S.profileUi.visualProposal=null;S.profileUi.visualSourceKey='';
  renderProfile();
}
export function wireVisualTrainer(){
  const scroll=$('#visualTreeScroll');if(scroll)scroll.scrollTop=S.profileUi.visualScrollTop||0;
  $$('[data-visual-mode]').forEach(button=>button.onclick=()=>{
    if(S.profileUi.visualMode===button.dataset.visualMode)return;
    S.profileUi.visualMode=button.dataset.visualMode;S.profileUi.visualExpanded=[];S.profileUi.visualSeedMode='';
    S.profileUi.visualProposal=null;S.profileUi.visualSourceKey='';S.profileUi.visualScrollTop=0;renderProfile();
  });
  let searchTimer;const search=$('#visualSearch');
  if(search)search.oninput=()=>{
    S.profileUi.visualQuery=search.value;clearTimeout(searchTimer);
    const position=search.selectionStart;
    searchTimer=setTimeout(()=>{renderProfile();requestAnimationFrame(()=>{const next=$('#visualSearch');if(next){next.focus();next.setSelectionRange(position,position);}});},140);
  };
  const clear=$('#clearVisualSearch');if(clear)clear.onclick=()=>{S.profileUi.visualQuery='';renderProfile();requestAnimationFrame(()=>$('#visualSearch')&&$('#visualSearch').focus());};
  $$('[data-visual-expand]').forEach(button=>button.onclick=event=>{
    event.stopPropagation();const id=button.dataset.visualExpand,expanded=profileVisualExpandedSet();
    if(expanded.has(id))expanded.delete(id);else expanded.add(id);
    S.profileUi.visualExpanded=[...expanded];renderProfile();
  });
  $$('[data-visual-move]').forEach(button=>button.onclick=()=>{
    const key=button.dataset.visualMove;
    if(S.profileUi.visualSourceKey===key){S.profileUi.visualSourceKey='';S.profileUi.visualProposal=null;}
    else{S.profileUi.visualSourceKey=key;S.profileUi.visualProposal=null;}
    renderProfile();
  });
  $$('[data-visual-choose]').forEach(button=>button.onclick=()=>{
    const id=button.dataset.visualChoose;
    if(S.profileUi.visualSourceKey)profileVisualProposal(S.profileUi.visualSourceKey,id);
    else{
      const node=profileVisualBuildTree(S.profileDraft,S.profileUi.visualMode==='ssm'?'ssm':'flow').nodes.get(id);
      if(node&&node.recordKey){S.profileUi.visualSourceKey=node.recordKey;S.profileUi.visualProposal=null;renderProfile();}
      else if(node&&node.children.length){const expanded=profileVisualExpandedSet();expanded.add(id);S.profileUi.visualExpanded=[...expanded];renderProfile();}
    }
  });
  $$('input[name="visualScope"]').forEach(input=>input.onchange=()=>{S.profileUi.visualScope=input.value;renderProfile();});
  const inspector=$('#visualInspectorBody');if(inspector)inspector.scrollTop=S.profileUi.visualInspectorScrollTop||0;
  $$('[data-visual-affect]').forEach(input=>input.onchange=()=>profileVisualToggleAffected(input.dataset.visualAffect));
  const cancel=()=>{S.profileUi.visualProposal=null;S.profileUi.visualSourceKey='';renderProfile();};
  const cancelMove=$('#cancelVisualMove');if(cancelMove)cancelMove.onclick=cancel;
  const cancelProposal=$('#cancelVisualProposal');if(cancelProposal)cancelProposal.onclick=()=>{S.profileUi.visualProposal=null;renderProfile();};
  const apply=$('#applyVisualProposal');if(apply)apply.onclick=profileVisualApplyProposal;
  const undo=$('#undoVisualRule');if(undo)undo.onclick=()=>profileVisualUndoRedo('undo');
  const redo=$('#redoVisualRule');if(redo)redo.onclick=()=>profileVisualUndoRedo('redo');
  const fullscreen=$('#toggleVisualFullscreen');if(fullscreen)fullscreen.onclick=()=>{S.profileUi.visualFullscreen=!S.profileUi.visualFullscreen;renderProfile();};
  wireVisualTrainerPointerDrag(scroll);
}
export const VISUAL_DRAG_BAND=68;
export const VISUAL_DRAG_MAX_SPEED=1250;
/* Edge auto-scroll speed in px/sec. Ease-in on how far past the band's threshold
   the pointer is: a crawl where the band starts, a sprint at the very edge. The
   .05 floor keeps the first few pixels of the band from being a dead zone, and
   the squared term is what makes it "slow at first, then a lot faster". */
export function visualDragScrollSpeed(distance,band,max){
  const past=(band-distance)/band;if(!(past>0))return 0;
  const t=past>1?1:past;return max*(.05+.95*t*t);
}
export function wireVisualTrainerPointerDrag(scroll){
  if(!scroll)return;
  const canvas=scroll.querySelector('.visual-tree');
  let drag=null,ghost=null,line=null,frame=0;
  const stopScroll=()=>{if(frame)cancelAnimationFrame(frame);frame=0;if(drag){drag.speed=0;drag.stamp=0;}};
  const unpaint=()=>{
    if(drag&&drag.marked){drag.marked.classList.remove('drop-hover','drop-blocked');drag.marked=null;}
    if(line)line.classList.remove('show');
  };
  const paint=()=>{
    unpaint();
    const row=drag.row,drop=drag.drop;if(!row||row===drag.origin)return;
    if(!drop||drop.zone==='child'){row.classList.add(drop?'drop-hover':'drop-blocked');drag.marked=row;return;}
    if(!line)return;
    /* offsetTop is measured inside the scrolled content, so the line rides the
       list instead of needing a reposition on every auto-scroll frame. */
    line.style.setProperty('--visual-depth',Math.min(drop.depth,18));
    line.style.transform='translateY('+(row.offsetTop+row.offsetHeight)+'px)';
    line.classList.add('show');
  };
  const track=()=>{
    const hit=document.elementFromPoint(drag.x,drag.y),row=hit&&hit.closest?hit.closest('[data-visual-node]'):null;
    if(row&&drag.splitRow!==row){
      const icon=row.querySelector('.visual-node-icon');
      drag.splitRow=row;drag.splitX=icon?icon.getBoundingClientRect().left:row.getBoundingClientRect().left+66;
    }
    const zone=row?(drag.x<drag.splitX?'sibling':'child'):'';
    if(row===drag.row&&zone===drag.zone)return;
    drag.row=row;drag.zone=zone;
    drag.drop=row?profileVisualResolveDrop(drag.tree,drag.key,row.dataset.visualNode,zone):null;
    paint();
  };
  const step=stamp=>{
    frame=0;if(!drag||!drag.active||!drag.speed)return;
    const delta=drag.stamp?Math.min(64,stamp-drag.stamp):16;drag.stamp=stamp;
    const before=scroll.scrollTop;scroll.scrollTop=before+drag.speed*delta/1000;
    if(scroll.scrollTop!==before)track();
    frame=requestAnimationFrame(step);
  };
  /* Velocity is derived from the pointer alone, so a wheel scroll mid-drag is
     never fought: away from the bands the speed is zero and the loop stops. */
  const aim=()=>{
    const rect=scroll.getBoundingClientRect();
    const inside=drag.x>=rect.left&&drag.x<=rect.right&&drag.y>=rect.top&&drag.y<=rect.bottom;
    const up=inside?visualDragScrollSpeed(drag.y-rect.top,VISUAL_DRAG_BAND,VISUAL_DRAG_MAX_SPEED):0;
    const down=inside?visualDragScrollSpeed(rect.bottom-drag.y,VISUAL_DRAG_BAND,VISUAL_DRAG_MAX_SPEED):0;
    drag.speed=down-up;
    if(!drag.speed)stopScroll();else if(!frame){drag.stamp=0;frame=requestAnimationFrame(step);}
  };
  const activate=()=>{
    drag.active=true;document.body.classList.add('visual-dragging');
    /* Resolved once: nothing re-renders until the drop, and profileVisualBuildTree's
       cache key is a JSON signature of the whole draft -- far too heavy to rebuild
       per pointer move, let alone per auto-scroll frame. */
    drag.tree=profileVisualBuildTree(S.profileDraft,S.profileUi.visualMode==='ssm'?'ssm':'flow');
    const record=S.canonicalModel.get(drag.key);
    ghost=document.createElement('div');ghost.className='visual-drag-ghost';
    ghost.innerHTML=`<div class="visual-drag-card">${ic('grip-vertical')}<span>${esc(record&&record.tag||'Move tag')}</span></div>`;
    document.body.appendChild(ghost);
    if(drag.origin)drag.origin.classList.add('drag-source');
    /* First child, not last: .visual-tree-row:last-child drops its bottom border,
       and appending would hand that rule to the indicator instead. */
    if(canvas){line=document.createElement('div');line.className='visual-drop-line';canvas.insertBefore(line,canvas.firstChild);}
  };
  const cleanup=()=>{
    stopScroll();
    if(drag){unpaint();if(drag.origin)drag.origin.classList.remove('drag-source');}
    if(ghost)ghost.remove();if(line)line.remove();
    ghost=null;line=null;drag=null;document.body.classList.remove('visual-dragging');
  };
  scroll.onpointerdown=event=>{
    /* First pointer wins: a second finger landing mid-drag would otherwise replace
       the drag record and orphan the ghost, line and faded row it left behind. */
    if(drag)return;
    const grip=event.target.closest&&event.target.closest('[data-visual-grip]');if(!grip)return;
    event.preventDefault();grip.setPointerCapture&&grip.setPointerCapture(event.pointerId);
    drag={pointerId:event.pointerId,key:grip.dataset.visualGrip,x:event.clientX,y:event.clientY,startX:event.clientX,startY:event.clientY,
      active:false,grip,origin:grip.closest('[data-visual-node]'),tree:null,row:null,zone:'',drop:null,marked:null,
      splitRow:null,splitX:0,speed:0,stamp:0};
  };
  scroll.onpointermove=event=>{
    if(!drag||event.pointerId!==drag.pointerId)return;
    drag.x=event.clientX;drag.y=event.clientY;
    if(!drag.active&&Math.hypot(drag.x-drag.startX,drag.y-drag.startY)<7)return;
    if(!drag.active)activate();
    event.preventDefault();
    ghost.style.transform=`translate(${drag.x+16}px,${drag.y}px) translateY(-50%)`;
    track();aim();
  };
  scroll.onpointerup=event=>{
    if(!drag||event.pointerId!==drag.pointerId)return;
    const key=drag.key,drop=drag.drop,active=drag.active;cleanup();
    if(active&&drop){S.profileUi.visualSourceKey=key;profileVisualProposal(key,drop.targetId);}
    else{S.profileUi.visualSourceKey=S.profileUi.visualSourceKey===key?'':key;S.profileUi.visualProposal=null;renderProfile();}
  };
  scroll.onpointercancel=cleanup;
}
export function renderHierarchyModes(draft){
  const disabled=draft.locked?'disabled':'',modes=draft.modes||[];
  return `<div class="profile-band" style="margin-top:16px">
    <div class="profile-band-head">${ic('layers')}Hierarchy views <span class="spacer"></span><span class="profile-rev">${modes.length}</span></div>
    <div class="mode-definitions">${modes.map((mode,modeIndex)=>{
      const policy=mode.rootPolicy||{},levels=mode.levels||[];
      return `<section class="mode-definition">
        <div class="mode-definition-head"><div><b>${esc(mode.name||mode.id)}</b><span>${esc(mode.id)} · ${esc(mode.executor||'projected')}</span></div></div>
        <div class="profile-fields mode-fields">
          <div class="profile-field"><label>View name</label><input class="profile-input" data-mode-index="${modeIndex}" data-mode-field="name" value="${esc(mode.name||'')}" ${disabled}></div>
          <div class="profile-field"><label>Short description</label><input class="profile-input" data-mode-index="${modeIndex}" data-mode-field="caption" value="${esc(mode.caption||'')}" ${disabled}></div>
          <div class="profile-field"><label>Tree model</label><select data-mode-index="${modeIndex}" data-mode-field="executor" ${disabled}><option value="raw" ${mode.executor==='raw'?'selected':''} ${levels.some(level=>level.kind==='grouping')?'disabled':''}>Preserve source occurrences</option><option value="projected" ${mode.executor!=='raw'?'selected':''}>Canonical resolved equipment</option></select></div>
          <div class="profile-field"><label>Required top-level tag</label><input class="profile-input" data-mode-index="${modeIndex}" data-mode-field="requireRoot" value="${esc(policy.requireRoot||'')}" placeholder="No fixed root" ${disabled}></div>
          <div class="profile-field"><label>Fallback parent</label><input class="profile-input" data-mode-index="${modeIndex}" data-mode-field="fallbackParent" value="${esc(policy.fallbackParent||'')}" placeholder="No fallback parent" ${disabled}></div>
        </div>
        <div class="mode-levels">${levels.map((level,levelIndex)=>{
          if(level.kind==='flow')return `<div class="mode-level"><span class="source-rank">${levelIndex+1}</span>${ic('git-branch')}<div class="profile-list-main"><div class="profile-list-title">Electrical relationship flow</div><div class="profile-list-sub">Expand the resolved closest-parent chain at this level</div></div></div>`;
          return `<div class="mode-level">
            <span class="source-rank">${levelIndex+1}</span>${ic('folder-tree')}
            <div class="profile-field mode-level-field"><label>Group by field</label><input class="profile-input" data-mode-index="${modeIndex}" data-mode-level="${levelIndex}" data-mode-level-field="attribute" value="${esc(level.attribute||'')}" list="modeAttributeSuggestions" ${disabled}></div>
            <div class="profile-field mode-level-field"><label>Blank value label</label><input class="profile-input" data-mode-index="${modeIndex}" data-mode-level="${levelIndex}" data-mode-level-field="fallback" value="${esc(level.fallback||'')}" ${disabled}></div>
            <div class="profile-row-actions">
              <button class="profile-icon-btn icon-btn" data-mode-level-up="${modeIndex}:${levelIndex}" ${draft.locked||levelIndex===0?'disabled':''} title="Move level up" aria-label="Move ${esc(level.attribute||'group')} up">${ic('chevrons-up')}</button>
              <button class="profile-icon-btn icon-btn" data-mode-level-down="${modeIndex}:${levelIndex}" ${draft.locked||levelIndex>=levels.length-2?'disabled':''} title="Move level down" aria-label="Move ${esc(level.attribute||'group')} down">${ic('chevrons-down')}</button>
            </div>
          </div>`;
        }).join('')}</div>
      </section>`;
    }).join('')}</div>
    <datalist id="modeAttributeSuggestions"><option value="building"><option value="discipline"><option value="system"><option value="equipmentType"><option value="placeholder"><option value="matchKey"></datalist>
  </div>`;
}
/**
 * How many parents each source actually won, after the ranking above resolved.
 *
 * The ordering and the workflow toggles are two separate controls in two
 * separate bands, and the thing that matters -- "MEL only parents what the
 * Cable Schedule does not" -- is a consequence of both that nobody infers from
 * looking at either. Showing the outcome means reordering the list has a
 * visible effect instead of an implied one.
 *
 * Read from the resolved snapshot rather than recomputed, so it reports what
 * the build actually did.
 */
/* Candidate ids are built as `parent:<source>:<subject>:<target>` and
   `manual:<id>` (src/hierarchy/projection.js), so the winning id names the
   source that actually won. Read from the resolved snapshot rather than
   recomputed, so this reports what the build did rather than what it should
   have done. */
export function resolvedParentSourceLabel(candidateId){
  const [kind,source]=String(candidateId||'').split(':');
  if(kind==='manual')return 'Placement Review';
  if(!source)return '';
  if(PROFILE_SOURCE_LABELS[source])return PROFILE_SOURCE_LABELS[source];
  if(source.startsWith('rule-'))return 'Relationship rules';
  if(source==='resolved-register')return 'Resolved register';
  if(source==='resolved-flow')return 'Resolved flow';
  return source;
}
export function sourceClaimSummary(){
  const records=S.canonicalModel;
  if(!records||!records.size)return `<p class="profile-hint source-claim-summary">Build a hierarchy to see how many parents each source resolved.</p>`;
  const counts=new Map();let unparented=0;
  for(const record of records.values()){
    /* A record invented purely to hold a parent tag is not equipment this
       build imported, so it is neither parented nor unparented. */
    if(record.isSyntheticParent&&!record.occurrences.length)continue;
    const selected=record.resolution&&record.resolution.parentResolution&&record.resolution.parentResolution.selectedCandidateId;
    const label=selected?resolvedParentSourceLabel(selected):'';
    if(!label){unparented++;continue;}
    counts.set(label,(counts.get(label)||0)+1);
  }
  const parts=[...counts.entries()]
    .sort((left,right)=>right[1]-left[1]||natCmp(left[0],right[0]))
    .map(([label,count])=>`<b>${esc(label)}</b> ${count}`);
  if(unparented)parts.push(`${unparented} unparented`);
  return `<p class="profile-hint source-claim-summary">${parts.join(' · ')||'No parents resolved'}</p>`;
}
export function renderHierarchyProfile(draft){
  const h=draft.hierarchy,order=h.parentSourcePriority||[],disabled=draft.locked?'disabled':'';
  const roleParents=Object.entries(h.roleParents||{});
  const count=target=>(draft.rules&&draft.rules.classify||[]).filter(rule=>rule.enabled!==false&&rule.target===target).length;
  const savedOverrides=draft.overrides&&draft.overrides.relationships||[],sessionOverrides=S.sessionRelationshipOverrides||[];
  const savedGroupingOverrides=draft.overrides&&draft.overrides.attributes||[];
  const overrideRows=[
    ...savedOverrides.map(override=>({...override,scope:'profile'})),
    ...sessionOverrides.map(override=>({...override,scope:'session'}))
  ];
  return `<section class="profile-section">
    <div class="profile-section-head">${ic('folder-tree')}<div><h2>SSM Hierarchy</h2><p>${count('building')} building · ${count('discipline')} discipline · ${count('system')} system rules</p></div></div>
    <div class="profile-band">
      <div class="blueprint">
        <div class="blueprint-level">${ic('folder-tree')}<b>Building</b><span>highest level</span></div>
        <div class="blueprint-level">${ic('layers')}<b>Discipline</b><span>site-defined</span></div>
        <div class="blueprint-level">${ic('network')}<b>System</b><span>discipline system</span></div>
        <div class="blueprint-level">${ic('tag')}<b>Equipment</b><span>resolved chain</span></div>
      </div>
    </div>
    <div class="profile-band" style="margin-top:16px">
      <div class="profile-band-head">${ic('sliders-horizontal')}Execution policies</div>
      <div class="profile-band-body profile-fields">
        <div class="profile-field wide"><label for="resolutionStrategy">Parent resolution</label><select id="resolutionStrategy" ${disabled}>
          <option value="legacy-register" ${h.resolutionStrategy==='legacy-register'?'selected':''}>Use the staged SSM Builder result</option>
          <option value="source-priority" ${h.resolutionStrategy!=='legacy-register'?'selected':''}>Resolve from source priority</option>
        </select></div>
        <div class="profile-field"><label for="downstreamGapPolicy">Blank downstream level</label><select id="downstreamGapPolicy" ${disabled}>
          <option value="truncate" ${h.downstreamGapPolicy==='truncate'?'selected':''}>Stop the branch (legacy)</option>
          <option value="bridge-review" ${h.downstreamGapPolicy!=='truncate'?'selected':''}>Keep later levels and flag</option>
        </select></div>
        <div class="profile-field"><label for="caseVariantPolicy">Tag capitalization</label><select id="caseVariantPolicy" ${disabled}>
          <option value="preserve" ${h.caseVariantPolicy==='preserve'?'selected':''}>Preserve each spelling (legacy)</option>
          <option value="merge" ${h.caseVariantPolicy!=='preserve'?'selected':''}>Merge case variants</option>
        </select></div>
        <div class="profile-field wide"><label for="duplicateRegisterPolicy">Duplicate register rows</label><select id="duplicateRegisterPolicy" ${disabled}>
          <option value="first" ${h.duplicateRegisterPolicy==='first'?'selected':''}>Keep first row (legacy)</option>
          <option value="prefer-parent" ${h.duplicateRegisterPolicy!=='first'?'selected':''}>Prefer a stated parent</option>
        </select></div>
        <div class="profile-field"><label for="cableConflictPolicy">Multiple Cable feeds</label><select id="cableConflictPolicy" ${disabled}>
          <option value="legacy-chain-review" ${h.cableConflictPolicy==='legacy-chain-review'?'selected':''}>Legacy: flag invalid chains only</option>
          <option value="first-silent" ${h.cableConflictPolicy==='first-silent'?'selected':''}>Suppress all Cable review</option>
          <option value="first-review" ${h.cableConflictPolicy==='first-review'?'selected':''}>Keep first and flag all conflicts</option>
        </select></div>
        <div class="profile-field"><label for="duplicateParentReviewPolicy">Multiple extracted parents</label><select id="duplicateParentReviewPolicy" ${disabled}>
          <option value="first-silent" ${h.duplicateParentReviewPolicy==='first-silent'?'selected':''}>Keep first silently (legacy)</option>
          <option value="first-review" ${h.duplicateParentReviewPolicy!=='first-silent'?'selected':''}>Keep first and flag</option>
        </select></div>
      </div>
    </div>
    <div class="profile-band" style="margin-top:16px">
      <div class="profile-band-head">${ic('list-tree')}Processing sequence</div>
      <div class="profile-list profile-rule-list">
        ${[
          ['gisBusCompaction','Compact GIS / BUS / GIS hops','Uses the GIS and BUS Tag Trainer classifications before building each Easy Power path'],
          ['cableParentChains','Apply Cable Schedule parent chains','Uses Load Name (To) and Panel (From) to repair missing or conflicting electrical parents'],
          ['melUpnParents','Apply MEL UPN parent corrections','When equipment and its parent have different UPNs, uses System Parent Equipment Tag(s)'],
          ['melSystemParentClaims','Nest from MEL System Parent','Parents equipment from System Parent Equipment Tag(s) wherever the Cable Schedule has no parent for it. Additional tags in that column become dependencies'],
          ['pmdInstrumentAttachment','Attach PMD instruments','Matches PMD PANEL values to Easy Power loads and repeats instruments beneath every matching load occurrence'],
          ['enforceSystemRoot','Enforce the required system root','Keeps the configured System Name at the top of the Electrical Flow tree']
        ].map(([key,title,description])=>`<label class="profile-list-row">
          <input type="checkbox" data-workflow-policy="${key}" ${h.workflow&&h.workflow[key]===false?'':'checked'} ${disabled}>
          <div class="profile-list-main"><div class="profile-list-title">${title}</div><div class="profile-list-sub">${description}</div></div>
        </label>`).join('')}
      </div>
    </div>
    ${renderHierarchyModes(draft)}
    <div class="profile-grid" style="margin-top:16px">
      <div class="profile-band">
        <div class="profile-band-head">${ic('sliders-horizontal')}Fallbacks</div>
        <div class="profile-band-body profile-fields">
          <div class="profile-field wide"><label for="fallbackBuilding">Building</label><input class="profile-input" id="fallbackBuilding" value="${esc(h.unassignedBuilding)}" ${disabled}></div>
          <div class="profile-field wide"><label for="fallbackElectrical">Electrical system</label><input class="profile-input" id="fallbackElectrical" value="${esc(h.systemFallbacks.Electrical||'')}" ${disabled}></div>
          <div class="profile-field wide"><label for="fallbackIc">I&amp;C system</label><input class="profile-input" id="fallbackIc" value="${esc(h.systemFallbacks['I&C']||'')}" ${disabled}></div>
          <div class="profile-field wide"><label for="fallbackDefaultSystem">Other disciplines</label><input class="profile-input" id="fallbackDefaultSystem" value="${esc(h.systemFallbacks.default||'')}" ${disabled}></div>
          <div class="profile-field"><label for="fallbackInstrumentDiscipline">PMD discipline</label><input class="profile-input" id="fallbackInstrumentDiscipline" value="${esc(h.disciplineFallbacks.instrument||'')}" ${disabled}></div>
          <div class="profile-field"><label for="fallbackDefaultDiscipline">Default discipline</label><input class="profile-input" id="fallbackDefaultDiscipline" value="${esc(h.disciplineFallbacks.default||'')}" ${disabled}></div>
        </div>
      </div>
      <div class="profile-band">
        <div class="profile-band-head">${ic('git-branch')}SSM parent source order</div>
        <div class="source-order">${order.map((source,index)=>`<div class="source-order-row"><span class="source-rank">${index+1}</span><div class="profile-list-main"><div class="profile-list-title">${esc(PROFILE_SOURCE_LABELS[source])}</div></div>
          <button class="profile-icon-btn icon-btn" data-source-up="${source}" ${draft.locked||index===0?'disabled':''} title="Move up" aria-label="Move ${esc(PROFILE_SOURCE_LABELS[source])} up">${ic('chevrons-up')}</button>
          <button class="profile-icon-btn icon-btn" data-source-down="${source}" ${draft.locked||index===order.length-1?'disabled':''} title="Move down" aria-label="Move ${esc(PROFILE_SOURCE_LABELS[source])} down">${ic('chevrons-down')}</button></div>`).join('')}</div>
        ${sourceClaimSummary()}
      </div>
    </div>
    <div class="profile-band" style="margin-top:16px">
      <div class="profile-band-head">${ic('network')}Placement parent types <span class="spacer"></span><span class="profile-rev">${roleParents.length}</span></div>
      <div class="source-order">${roleParents.map(([child,parent])=>`<div class="source-order-row">
        <span class="rule-target">${esc(child)}</span><div class="profile-list-main"><div class="profile-list-title">Expected parent type</div><div class="profile-list-sub">Used to validate and rank Placement Review choices</div></div>
        <input class="profile-input role-parent-input" data-role-parent="${esc(child)}" value="${esc(parent)}" list="roleParentSuggestions" ${disabled}>
        <button class="profile-icon-btn icon-btn" data-role-parent-delete="${esc(child)}" ${draft.locked?'disabled':''} title="Remove parent type rule" aria-label="Remove ${esc(child)} parent type rule">${ic('trash-2')}</button>
      </div>`).join('')}
      ${draft.locked?'':`<div class="source-order-row"><input class="profile-input role-parent-input" id="newRoleChild" placeholder="Equipment type"><span class="relation-arrow">-></span><input class="profile-input role-parent-input" id="newRoleParent" placeholder="Parent type" list="roleParentSuggestions"><button class="btn sm" id="addRoleParent">${ic('plus')}Add</button></div>`}</div>
      <datalist id="roleParentSuggestions"><option value="SYSTEM"><option value="GIS"><option value="XFM"><option value="LVS"></datalist>
    </div>
    <div class="profile-band" style="margin-top:16px">
      <div class="profile-band-head">${ic('git-branch')}Manual branch placements <span class="spacer"></span><span class="profile-rev">${overrideRows.length}</span></div>
      <div class="profile-list profile-rule-list">${overrideRows.length?overrideRows.map(override=>`<div class="profile-list-row">
        <div class="profile-list-main"><div class="profile-list-title">${esc(override.equipment)} <span class="relation-arrow">-></span> ${esc(override.parent)}</div>
        <div class="profile-list-sub">${override.scope==='session'?'This session':'Saved in profile'}${override.savedAt?' · '+esc(override.savedAt):''}</div></div>
        <button class="profile-icon-btn icon-btn" data-override-delete="${esc(override.scope)}:${esc(override.id||override.equipment)}" ${override.scope==='profile'&&draft.locked?'disabled':''} title="Remove placement" aria-label="Remove placement for ${esc(override.equipment)}">${ic('trash-2')}</button>
      </div>`).join(''):'<div class="profile-empty">No manual branch placements</div>'}</div>
    </div>
    <div class="profile-band" style="margin-top:16px">
      <div class="profile-band-head">${ic('folder-tree')}Manual grouping placements <span class="spacer"></span><span class="profile-rev">${savedGroupingOverrides.length}</span></div>
      <div class="profile-list profile-rule-list">${savedGroupingOverrides.length?savedGroupingOverrides.map(override=>`<div class="profile-list-row">
        <div class="profile-list-main"><div class="profile-list-title">${esc(override.equipment)}</div>
        <div class="profile-list-sub">${Object.entries(override.values||{}).map(([key,value])=>`${esc(key)}: ${esc(value)}`).join(' · ')}</div></div>
        <button class="profile-icon-btn icon-btn" data-attribute-override-delete="${esc(override.id||override.equipment)}" ${draft.locked?'disabled':''} title="Remove grouping placement" aria-label="Remove grouping placement for ${esc(override.equipment)}">${ic('trash-2')}</button>
      </div>`).join(''):'<div class="profile-empty">No manual grouping placements</div>'}</div>
    </div>
  </section>`;
}
export function detailPreviewValue(field){
  const samples={equipmentTag:'F15-LVSY373B',equipmentType:'LVS',building:'F15',discipline:'Electrical',system:'602 Medium Voltage',
    flowParent:'F15-XFMY373B',ssmParent:'F15-XFMY373B',dependency:'MCC-002',upn:'133',melSystemParent:'F15-GIS-001',
    easyCircuit:'42',cableCircuit:'42',pmdPanel:'RIO650-02-1',pmdCard:'12',pmdPointPosition:'04',pmdPointType:'AI',
    pmdPid:'P-1234',pmdLocation:'Area 5',pmdRelease:'IFC',description:'Temperature element',provenance:'Building · Tag rule 2'};
  return samples[field.id]||'—';
}
export function renderDetailsBuilder(draft){
  const layout=draft.details.layout||[],ordered=[...layout,...PROFILE_DETAIL_FIELDS.map(field=>field.id).filter(id=>!layout.includes(id))];
  return `<section class="profile-section">
    <div class="profile-section-head">${ic('panel-left-close')}<div><h2>Details Panel</h2><p>${layout.length} visible fields</p></div></div>
    <div class="details-builder">
      <div class="profile-band">
        <div class="profile-band-head">${ic('list-tree')}Field order</div>
        <div class="detail-layout-list">${ordered.map(id=>{
          const field=PROFILE_DETAIL_FIELDS.find(item=>item.id===id),on=layout.includes(id),index=layout.indexOf(id);
          return `<div class="detail-layout-row ${on?'':'rule-off'}"><input type="checkbox" data-detail-toggle="${id}" ${on?'checked':''} ${draft.locked?'disabled':''} aria-label="Show ${esc(field.label)}">
            <div><div class="profile-list-title">${esc(field.label)}</div><div class="detail-source">${esc(field.source)}</div></div>
            <div class="detail-order">
              <button class="profile-icon-btn icon-btn" data-detail-up="${id}" ${draft.locked||!on||index<=0?'disabled':''} title="Move up" aria-label="Move ${esc(field.label)} up">${ic('chevrons-up')}</button>
              <button class="profile-icon-btn icon-btn" data-detail-down="${id}" ${draft.locked||!on||index===layout.length-1?'disabled':''} title="Move down" aria-label="Move ${esc(field.label)} down">${ic('chevrons-down')}</button>
            </div></div>`;
        }).join('')}</div>
      </div>
      <div class="profile-band">
        <div class="profile-band-head">${ic('panel-left-close')}Preview</div>
        <div class="details-preview">${layout.map(id=>{const field=PROFILE_DETAIL_FIELDS.find(item=>item.id===id);return `<div class="dfield"><div class="dlabel">${esc(field.label)} <span class="detail-source">${esc(field.source)}</span></div><div class="dval">${esc(detailPreviewValue(field))}</div></div>`;}).join('')}</div>
      </div>
    </div>
  </section>`;
}
let PROFILE_IMPACT_CACHE=null;
export function profileImpact(draft){
  const signature=visualEvaluationSignature(draft)+'||'+visualEvaluationSignature(activeProfile())+'|'+S.profileBuildRevision+'|'+S.canonicalModel.size;
  if(PROFILE_IMPACT_CACHE&&PROFILE_IMPACT_CACHE.signature===signature)return PROFILE_IMPACT_CACHE.impact;
  const impact={building:0,discipline:0,system:0,equipmentType:0,parents:0,ambiguities:0,total:S.canonicalModel.size};
  for(const record of S.canonicalModel.values()){
    const before=resolveRecordContext(record,activeProfile()),after=resolveRecordContext(record,draft);
    for(const key of ['building','discipline','system','equipmentType'])if(before[key]!==after[key])impact[key]++;
  }
  if(S.canonicalModel.size){
    const before=visualTrainerEvaluateParents(activeProfile(),S.canonicalModel),after=visualTrainerEvaluateParents(draft,S.canonicalModel);
    for(const record of after.records){
      const key=record.key||tagKey(record.tag);
      if(tagKey(before.parents.get(key))!==tagKey(after.parents.get(key)))impact.parents++;
      if(after.decisions.get(key)&&after.decisions.get(key).status==='ambiguous')impact.ambiguities++;
    }
  }
  PROFILE_IMPACT_CACHE={signature,impact};
  return impact;
}
export function profileValidation(draft,previous){
  return compileRuleProfile(normalizeProfile(profileClone(draft)),{previousProfile:previous||activeProfile(),allowUnmapped:true});
}
export function renderProfileTest(draft){
  const impact=profileImpact(draft),validation=profileValidation(draft),mapped=Object.entries(draft.mappings||{}).filter(([,mapping])=>Object.keys(mapping.fields||{}).length);
  const rules=draft.tagRules||[],tests=rules.filter(rule=>rule.example),passing=tests.filter(rule=>ruleSelection(rule,rule.example)!=null).length;
  const executable=['normalize','classify','relate'].flatMap(family=>draft.rules&&draft.rules[family]||[]);
  const enabledExecutable=executable.filter(rule=>rule.enabled!==false).length;
  return `<section class="profile-section">
    <div class="profile-section-head">${ic('circle-check')}<div><h2>Test &amp; Publish</h2><p>${impact.total?impact.total.toLocaleString()+' canonical tags':'No hierarchy loaded'}</p></div></div>
    <div class="impact-grid">
      <div class="profile-kpi"><b>${impact.building}</b><span>Building changes</span></div>
      <div class="profile-kpi"><b>${impact.discipline}</b><span>Discipline changes</span></div>
      <div class="profile-kpi"><b>${impact.system}</b><span>System changes</span></div>
      <div class="profile-kpi"><b>${impact.equipmentType}</b><span>Type changes</span></div>
      <div class="profile-kpi"><b>${impact.parents}</b><span>Closest-parent changes</span></div>
      <div class="profile-kpi"><b>${impact.ambiguities}</b><span>Ambiguous parent results</span></div>
    </div>
    <div class="profile-grid" style="margin-top:16px">
      <div class="profile-band">
        <div class="profile-band-head">${ic('circle-check')}Health</div>
        <div class="profile-list">
          <div class="profile-list-row"><div class="profile-list-main"><div class="profile-list-title">Column mappings</div><div class="profile-list-sub">${mapped.length} configured source${mapped.length===1?'':'s'}</div></div><span class="pill ${mapped.length?'ok':'warn'}">${ic(mapped.length?'check':'triangle-alert')}${mapped.length?'Ready':'Auto-detect'}</span></div>
          <div class="profile-list-row"><div class="profile-list-main"><div class="profile-list-title">Executable rules</div><div class="profile-list-sub">${enabledExecutable} active · ${executable.length} materialized in this profile</div></div><span class="pill ${enabledExecutable?'ok':'warn'}">${ic(enabledExecutable?'check':'triangle-alert')}${enabledExecutable?'Loaded':'None'}</span></div>
          ${tests.length?`<div class="profile-list-row"><div class="profile-list-main"><div class="profile-list-title">Saved trainer examples</div><div class="profile-list-sub">${passing} of ${tests.length} passing</div></div><span class="pill ${passing===tests.length?'ok':'warn'}">${ic(passing===tests.length?'check':'triangle-alert')}${passing===tests.length?'Checked':'Review'}</span></div>`:''}
          <div class="profile-list-row"><div class="profile-list-main"><div class="profile-list-title">Executable profile</div><div class="profile-list-sub">${validation.errors.length} errors · ${validation.warnings.length} warnings</div></div><span class="pill ${validation.ok?'ok':'warn'}">${ic(validation.ok?'check':'triangle-alert')}${validation.ok?'Valid':'Blocked'}</span></div>
          ${validation.errors.slice(0,4).map(error=>`<div class="profile-list-row"><div class="profile-list-main"><div class="profile-list-title">${esc(error.path)}</div><div class="profile-list-sub">${esc(error.message)}</div></div></div>`).join('')}
          ${S.resolutionIssues.length?`<div class="profile-list-row"><div class="profile-list-main"><div class="profile-list-title">Hierarchy resolution</div><div class="profile-list-sub">${S.resolutionIssues.length} ambiguities or cycles require review</div></div><span class="pill warn">${ic('triangle-alert')}Review</span></div>`:''}
          <div class="profile-list-row"><div class="profile-list-main"><div class="profile-list-title">Portable backup</div><div class="profile-list-sub">Site rules only · no workbook rows</div></div><button class="btn sm" id="testExportProfile">${ic('file-down')}Export</button></div>
        </div>
      </div>
      <div class="profile-band">
        <div class="profile-band-head">${ic('rotate-ccw')}Revision history <span class="spacer"></span><span class="profile-rev">${draft.history.length}</span></div>
        <div class="profile-band-body">${draft.history.length?draft.history.map((item,index)=>`<div class="history-row"><div class="profile-list-main"><div class="profile-list-title">Revision ${item.revision}</div><div class="profile-list-sub">${esc(item.savedAt||'')} · ${esc(item.name||draft.name)}</div></div><button class="btn sm" data-restore-profile="${index}">Restore</button></div>`).join(''):'<div class="profile-empty">No earlier revisions</div>'}</div>
      </div>
    </div>
    <div class="profile-actions" style="margin-top:16px"><span class="hint">${S.profileNeedsRebuild?'Profile logic changed; rebuild the hierarchy before trusting output.':'All published logic is compiled into the production rule model.'}</span><span class="spacer"></span><button class="btn primary" id="testPublishProfile" ${S.profileDirty&&validation.ok&&!draft.locked?'':'disabled'}>${ic('check')}Save &amp; apply profile</button></div>
  </section>`;
}
export function wireProfilePreview(){
  const sheet=$('#profilePreviewSheet');if(sheet)sheet.onchange=()=>{
    S.profileUi.previewKey=sheet.value;getAoa(sheet.value);S.profileUi.sourceKind=profileKindForKey(sheet.value);
    S.profileUi.selectedCell=null;S.profileUi.rangeStart=null;S.profileUi.rangeEnd=null;resetProfilePreviewViewport();renderProfile();
  };
  const kind=$('#profileSourceKind');if(kind)kind.onchange=()=>{S.profileUi.sourceKind=kind.value;S.profileUi.selectedCell=null;renderProfile();};
  const header=$('#profileHeaderRow');if(header)header.onchange=()=>{const kindId=S.profileUi.sourceKind,draft=S.profileDraft,mapping=draft.mappings[kindId]||(draft.mappings[kindId]={fields:{}});
    mapping.headerRow=Math.max(0,(+header.value||1)-1);mapping.autoHeaderRow=false;markProfileDirty();renderProfile();};
  const preview=$('#profileSheetPreview');
  if(preview){
    preview.scrollTop=S.profileUi.previewScrollTop||0;preview.scrollLeft=S.profileUi.previewScrollLeft||0;
    preview.onclick=event=>{
      const cell=event.target.closest('[data-preview-row]');if(!cell)return;
      S.profileUi.previewScrollTop=preview.scrollTop;S.profileUi.previewScrollLeft=preview.scrollLeft;
      if(S.profileUi.section==='mapping'){selectMappingPreviewCell(+cell.dataset.previewRow,+cell.dataset.previewCol);return;}
      S.profileUi.selectedCell={row:+cell.dataset.previewRow,col:+cell.dataset.previewCol};S.profileUi.rangeStart=0;S.profileUi.rangeEnd=0;renderProfile();
    };
    let frame=0;
    preview.onscroll=()=>{
      S.profileUi.previewScrollTop=preview.scrollTop;S.profileUi.previewScrollLeft=preview.scrollLeft;
      if(frame)return;
      frame=requestAnimationFrame(()=>{
        frame=0;
        const data=profilePreviewData(S.profileDraft),rows=$('#profilePreviewRows');if(!data||!rows)return;
        const start=profilePreviewWindowStart(preview.scrollTop,data.rec.aoa.length);
        if(start===S.profileUi.previewStartRow)return;
        S.profileUi.previewStartRow=start;
        rows.innerHTML=previewRowsMarkup(data,start,profilePreviewColumnCount(data.rec));
      });
    };
  }
  const toggle=$('#toggleProfilePreview');if(toggle)toggle.onclick=()=>{
    if(preview){S.profileUi.previewScrollTop=preview.scrollTop;S.profileUi.previewScrollLeft=preview.scrollLeft;}
    S.profileUi.previewFullscreen=!S.profileUi.previewFullscreen;
    document.body.classList.toggle('profile-preview-fullscreen',S.profileUi.previewFullscreen);renderProfile();
  };
  if(!_profilePreviewEscapeBound){
    _profilePreviewEscapeBound=true;
    document.addEventListener('keydown',event=>{
      if(event.key!=='Escape')return;
      if(S.profileUi.previewFullscreen){
        S.profileUi.previewFullscreen=false;document.body.classList.remove('profile-preview-fullscreen');renderProfile();return;
      }
      if(S.profileUi.visualFullscreen){
        S.profileUi.visualFullscreen=false;document.body.classList.remove('visual-trainer-fullscreen');renderProfile();
      }
    });
  }
}
export function wireProfile(){
  $('#closeProfile').onclick=closeProfileStudio;
  const rebuild=$('#rebuildProfileNow');if(rebuild)rebuild.onclick=rebuildActiveProfileHierarchy;
  $$('[data-profile-section]').forEach(button=>button.onclick=()=>{S.profileUi.section=button.dataset.profileSection;renderProfile();});
  $('#profileSelect').onchange=()=>switchProfile($('#profileSelect').value);
  /* The plus button used to call duplicateProfile(), which mutated
     PROFILE_STORE and persisted before the engineer had typed a single
     character. It now opens the transactional Create Site Profile wizard, where
     nothing is stored until Create Profile is pressed. duplicateProfile()
     survives for the Visual Trainer's clone-Eagle-on-demand path. */
  $('#duplicateProfile').onclick=openCreateProfileWizard;
  $('#publishProfile').onclick=publishProfileDraft;
  const name=$('#profileName'),site=$('#profileSite'),description=$('#profileDescription');
  if(name)name.oninput=()=>{S.profileDraft.name=name.value;markProfileDirty();};
  if(site)site.oninput=()=>{S.profileDraft.siteCode=site.value;markProfileDirty();};
  if(description)description.oninput=()=>{S.profileDraft.description=description.value;markProfileDirty();};
  /* The fast path: copy this profile's rules into a new editable one. The plus
     button starts a profile from a design legend instead; both create, but from
     different starting material. */
  const duplicateNow=$('#duplicateProfileNow');if(duplicateNow)duplicateNow.onclick=()=>duplicateProfile();
  const exportButton=$('#exportProfile');if(exportButton)exportButton.onclick=()=>exportProfileJson(S.profileDraft);
  const testExport=$('#testExportProfile');if(testExport)testExport.onclick=()=>exportProfileJson(S.profileDraft);
  const importButton=$('#importProfile'),importFile=$('#profileImportFile');
  if(importButton&&importFile){importButton.onclick=()=>importFile.click();importFile.onchange=()=>{const file=importFile.files[0];importFile.value='';if(file)importProfileJson(file);};}
  const deleteButton=$('#deleteProfile');if(deleteButton)deleteButton.onclick=deleteActiveProfile;
  wireProfilePreview();
  if(S.profileUi.section==='legend')wireLegendTrainerTab();
  if(S.profileUi.section==='mapping')wireMappingProfile();
  if(S.profileUi.section==='trainer')wireTagTrainer();
  if(S.profileUi.section==='relationships')wireRelationshipsProfile();
  if(S.profileUi.section==='visual')wireVisualTrainer();
  if(S.profileUi.section==='hierarchy')wireHierarchyProfile();
  if(S.profileUi.section==='details')wireDetailsBuilder();
  const testPublish=$('#testPublishProfile');if(testPublish)testPublish.onclick=publishProfileDraft;
  $$('[data-restore-profile]').forEach(button=>button.onclick=()=>restoreProfileRevision(+button.dataset.restoreProfile));
}
export function currentDraftMapping(){
  const kind=S.profileUi.sourceKind;
  const headerRow=S.profileUi.previewKey?getAoa(S.profileUi.previewKey).headerRow:0;
  return S.profileDraft.mappings[kind]||(S.profileDraft.mappings[kind]={headerRow,fields:{}});
}
export function mappingFieldAtColumn(mapping,col){return Object.keys(mapping&&mapping.fields||{}).find(id=>+mapping.fields[id]===+col)||'';}
export function updateMappingApplyState(){
  const apply=$('#applyMapping'),field=$('#mappingField'),cell=S.profileUi.selectedCell;if(!apply||!field)return;
  const current=cell?mappingFieldAtColumn(currentDraftMapping(),cell.col):'',ready=!!(cell&&field.value&&field.value!==current&&!S.profileDraft.locked);
  apply.disabled=!ready;apply.innerHTML=ic('check')+(cell&&field.value===current?'Mapped':'Map column');
}
export function selectMappingPreviewCell(row,col){
  S.profileUi.selectedCell={row,col};S.profileUi.rangeStart=0;S.profileUi.rangeEnd=0;
  $$('.preview-table td.selected').forEach(td=>td.classList.remove('selected'));
  const button=$(`[data-preview-row="${row}"][data-preview-col="${col}"]`);if(button&&button.closest('td'))button.closest('td').classList.add('selected');
  const selected=$('#mappingSelected');if(selected)selected.textContent=XLSX.utils.encode_col(col)+' · '+(selectedPreviewValue()||'Blank cell');
  const field=$('#mappingField');if(field)field.value=mappingFieldAtColumn(currentDraftMapping(),col);
  const header=$('#useHeaderRow');if(header){header.disabled=!!S.profileDraft.locked;header.textContent='Use row '+(row+1)+' as header';}
  updateMappingApplyState();
}
export function updateMappingCellHighlights(mapping){
  const mappedCols=new Set(Object.values(mapping&&mapping.fields||{}).map(Number));
  $$('[data-preview-col]').forEach(button=>{const td=button.closest('td');if(td)td.classList.toggle('mapped',mappedCols.has(+button.dataset.previewCol));});
}
export function wireMappingRows(){
  $$('[data-remove-map]').forEach(button=>button.onclick=()=>{
    const mapping=currentDraftMapping(),id=button.dataset.removeMap;
    if(mapping.fields)delete mapping.fields[id];
    mapping.autoFields=(mapping.autoFields||[]).filter(field=>field!==id);
    mapping.ignoredFields=[...new Set([...(mapping.ignoredFields||[]),id])];
    markProfileDirty();refreshMappingWorkspace();
  });
}
export function refreshMappingWorkspace(){
  const kind=S.profileUi.sourceKind,mapping=currentDraftMapping(),mapped=Object.keys(mapping.fields||{});
  const list=$('#mappingList');if(list)list.innerHTML=mappingRowsMarkup(kind,mapping);
  const count=$('#mappingCount');if(count)count.textContent=mapped.length;
  updateMappingCellHighlights(mapping);wireMappingRows();
  const cell=S.profileUi.selectedCell,field=$('#mappingField');if(field&&cell)field.value=mappingFieldAtColumn(mapping,cell.col);
  updateMappingApplyState();
}
export function wireMappingProfile(){
  const field=$('#mappingField');if(field)field.onchange=updateMappingApplyState;
  const apply=$('#applyMapping');if(apply)apply.onclick=()=>{
    const cell=S.profileUi.selectedCell,id=$('#mappingField').value,kind=S.profileUi.sourceKind;if(!cell||!id)return;
    const mapping=currentDraftMapping(),ignored=new Set(mapping.ignoredFields||[]),auto=new Set(mapping.autoFields||[]);
    for(const [other,col] of Object.entries(mapping.fields||{}))if(+col===cell.col&&other!==id){
      delete mapping.fields[other];ignored.add(other);auto.delete(other);
    }
    mapping.fields[id]=cell.col;mapping.sampleSheet=S.profileUi.previewKey.split(KEYSEP)[1]||'';
    ignored.delete(id);auto.delete(id);mapping.ignoredFields=[...ignored];mapping.autoFields=[...auto];
    markProfileDirty();refreshMappingWorkspace();
  };
  const useHeader=$('#useHeaderRow');if(useHeader)useHeader.onclick=()=>{
    const cell=S.profileUi.selectedCell;if(!cell)return;
    const mapping=currentDraftMapping();mapping.headerRow=cell.row;mapping.autoHeaderRow=false;markProfileDirty();
    $('#profileHeaderRow').value=cell.row+1;
    $$('.preview-table tbody tr[data-preview-table-row]').forEach(row=>row.classList.toggle('header-candidate',+row.dataset.previewTableRow===cell.row));
  };
  const auto=$('#autoMapColumns');if(auto)auto.onclick=()=>{
    const result=ensureProfileAutoMapping(S.profileDraft,S.profileUi.previewKey,S.profileUi.sourceKind,true);
    S.profileUi.autoMapCount=result.count;if(result.changed)markProfileDirty();renderProfile();
  };
  wireMappingRows();updateMappingApplyState();
}
export function wireTagTrainer(){
  wireProfileAnatomies();
  $$('[data-char-index]').forEach(button=>button.onclick=()=>{
    const index=+button.dataset.charIndex;
    if(S.profileUi.rangeStart==null||S.profileUi.rangeEnd!=null&&S.profileUi.rangeStart!==S.profileUi.rangeEnd){S.profileUi.rangeStart=index;S.profileUi.rangeEnd=index;}
    else S.profileUi.rangeEnd=index;
    renderProfile();
  });
  const setUi=(id,key,cast)=>{const el=$('#'+id);if(el)el.onchange=()=>{S.profileUi[key]=cast?cast(el.value):el.value;renderProfile();};};
  const target=$('#ruleTarget');if(target)target.onchange=()=>{
    S.profileUi.ruleTarget=target.value;
    if(target.value==='ignoreSuffix')S.profileUi.ruleMode='suffix';
    renderProfile();
  };
  setUi('ruleMode','ruleMode');setUi('ruleScope','ruleScope');
  const value=$('#ruleValue');if(value)value.oninput=()=>{S.profileUi.ruleValue=value.value;};
  const name=$('#ruleName');if(name)name.oninput=()=>{S.profileUi.ruleName=name.value;};
  const add=$('#addTagRule');if(add)add.onclick=()=>{
    const rule=trainerCandidate();if(!rule.needle)return;
    rule.id='rule-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,5);
    rule.name=clean(S.profileUi.ruleName)||`${profileFieldLabel('',rule.target)} ${rule.needle}`;
    S.profileDraft.tagRules.push(rule);S.profileUi.ruleName='';S.profileUi.ruleValue='';markProfileDirty();renderProfile();
  };
  $$('[data-rule-toggle]').forEach(input=>input.onchange=()=>{const rule=S.profileDraft.tagRules.find(item=>item.id===input.dataset.ruleToggle);if(rule)rule.enabled=input.checked;markProfileDirty();renderProfile();});
  const move=(id,delta)=>{const list=S.profileDraft.tagRules,index=list.findIndex(item=>item.id===id),next=index+delta;if(index<0||next<0||next>=list.length)return;[list[index],list[next]]=[list[next],list[index]];markProfileDirty();renderProfile();};
  $$('[data-rule-up]').forEach(button=>button.onclick=()=>move(button.dataset.ruleUp,-1));
  $$('[data-rule-down]').forEach(button=>button.onclick=()=>move(button.dataset.ruleDown,1));
  $$('[data-rule-exclude]').forEach(button=>button.onclick=()=>{
    const rule=S.profileDraft.tagRules.find(item=>item.id===button.dataset.ruleExclude),sample=selectedPreviewValue();if(!rule||!sample)return;
    const exclusions=rule.exclusions||(rule.exclusions=[]),index=exclusions.findIndex(value=>tagKey(value)===tagKey(sample));
    if(index>=0)exclusions.splice(index,1);else exclusions.push(sample);
    markProfileDirty();renderProfile();
  });
  $$('[data-rule-delete]').forEach(button=>button.onclick=()=>{S.profileDraft.tagRules=S.profileDraft.tagRules.filter(rule=>rule.id!==button.dataset.ruleDelete);markProfileDirty();renderProfile();});
  wireProfileEngineRules();
}
export function profileRuleRef(value){
  const at=String(value||'').indexOf(':');
  return at<0?['',String(value||'')]:[String(value).slice(0,at),String(value).slice(at+1)];
}
export function wireProfileEngineRules(){
  const find=value=>{const [family,id]=profileRuleRef(value),list=S.profileDraft.rules&&S.profileDraft.rules[family]||[];return {family,id,list,rule:list.find(item=>item.id===id)};};
  $$('[data-engine-rule-edit]').forEach(button=>button.onclick=()=>{
    S.profileUi.engineRuleRef=button.dataset.engineRuleEdit;renderProfile();
  });
  const close=$('#closeEngineRule');if(close)close.onclick=()=>{S.profileUi.engineRuleRef='';renderProfile();};
  const save=$('#saveEngineRule');if(save)save.onclick=()=>{
    const {family,id,list,rule}=find(S.profileUi.engineRuleRef);if(!rule||S.profileDraft.locked)return;
    const value=field=>clean($('#'+field)&&$('#'+field).value),checked=field=>!!($('#'+field)&&$('#'+field).checked);
    const csv=field=>value(field).split(',').map(clean).filter(Boolean);
    const number=field=>{const raw=value(field);return raw===''?null:Number(raw);};
    const updated={...rule,name:value('engineRuleName')||rule.name,note:value('engineRuleNote')};
    const scope=value('engineRuleScope');if(scope&&scope!=='all')updated.sourceKind=scope;else delete updated.sourceKind;
    if(family==='normalize'){
      updated.stage=value('engineNormalizeStage')||'identity';
      updated.separators=csv('engineSeparators');updated.suffixes=csv('engineSuffixes');updated.repeat=checked('engineRepeat');
    }else{
      updated.target=value('engineTarget')||rule.target;updated.source=value('engineTagSource')||'canonical';
      if(updated.kind==='pattern'){updated.pattern=value('enginePattern');updated.value=value('engineValue');}
      else if(updated.kind==='slice'){
        const start=number('engineSliceStart'),end=number('engineSliceEnd'),minLength=number('engineMinLength');
        if(start==null)delete updated.start;else updated.start=start;
        if(end==null)delete updated.end;else updated.end=end;
        if(minLength==null)delete updated.minLength;else updated.minLength=minLength;
        updated.value=value('engineValue');updated.lowercase=checked('engineLowercase');
      }else{
        updated.segment=value('engineSegment');
        const segmentIndex=number('engineSegmentIndex');if(segmentIndex==null)delete updated.segmentIndex;else updated.segmentIndex=segmentIndex;
        updated.expected=value('engineExpected');updated.value=value('engineValue');
      }
    }
    /* The per-tag opt-out, under whichever name this family uses. Cleared
       rather than left as an empty array so a rule that excludes nothing does
       not carry an empty key into the execution signature. */
    const exclusions=csv('engineExclusions'),exclusionKey=family==='relate'?'exclusions':'excludeTags';
    if(exclusions.length)updated[exclusionKey]=exclusions;else delete updated[exclusionKey];
    const candidate=profileClone(S.profileDraft),index=list.findIndex(item=>item.id===id);
    candidate.rules[family][index]=updated;
    const validation=compileRuleProfile(candidate,{allowUnmapped:true});
    const error=validation.errors.find(item=>item.path.startsWith('rules.'+family));
    if(error){toast(error.message);return;}
    S.profileDraft.rules[family][index]=updated;markProfileDirty();renderProfile();
  };
  $$('[data-engine-rule-toggle]').forEach(input=>input.onchange=()=>{
    const {rule}=find(input.dataset.engineRuleToggle);if(!rule)return;rule.enabled=input.checked;markProfileDirty();renderProfile();
  });
  const move=(value,delta)=>{
    const {list,id}=find(value),native=list.filter(rule=>!rule.legacyTagRuleId),at=native.findIndex(rule=>rule.id===id),next=at+delta;
    if(at<0||next<0||next>=native.length)return;
    const left=list.indexOf(native[at]),right=list.indexOf(native[next]);[list[left],list[right]]=[list[right],list[left]];markProfileDirty();renderProfile();
  };
  $$('[data-engine-rule-up]').forEach(button=>button.onclick=()=>move(button.dataset.engineRuleUp,-1));
  $$('[data-engine-rule-down]').forEach(button=>button.onclick=()=>move(button.dataset.engineRuleDown,1));
  $$('[data-engine-rule-delete]').forEach(button=>button.onclick=()=>{
    const {family,id,list}=find(button.dataset.engineRuleDelete);
    if(!family||!id)return;S.profileDraft.rules[family]=list.filter(rule=>rule.id!==id);markProfileDirty();renderProfile();
  });
}
export function profileRelationFormRule(existing){
  const value=id=>clean($('#'+id)&&$('#'+id).value),checked=id=>!!($('#'+id)&&$('#'+id).checked);
  const kind=existing.kind,name=value('relRuleName')||existing.name||'Relationship rule';
  const common={id:clean(existing.id)||'rel-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,6),
    name,kind,enabled:existing.enabled!==false,note:value('relRuleNote')};
  if(kind==='constant'){
    const mode=value('relMatchMode')||'contains',needle=value('relNeedle');
    return {...common,pattern:profileLiteralPattern(needle,mode),parent:value('relParent'),requiresNoParent:checked('relRequiresNoParent'),
      tagSource:existing.tagSource||'canonical',ui:{...(existing.ui||{}),matchMode:mode,needle}};
  }
  if(kind==='prefixSplit'){
    const markerNeedle=value('relNeedle');
    return {...common,delimiter:value('relDelimiter')||'_',pattern:profileLiteralPattern(markerNeedle,'contains'),
      tagSource:value('relTagSource')||'canonical',cleanPrefix:checked('relCleanPrefix'),alsoCurrentParent:checked('relAlsoParent'),
      ui:{...(existing.ui||{}),markerLiteral:true,markerNeedle}};
  }
  if(kind==='attributeMatch'){
    const ownAttribute=value('relOwnAttribute'),ownValue=value('relOwnValue'),parentAttribute=value('relParentAttribute'),parentValue=value('relParentValue');
    const targetAttribute=value('relTargetAttribute'),targetValue=value('relTargetValue'),sharedAttribute=value('relSharedAttribute'),sharedOwn=value('relSharedOwnAttribute');
    const extraSharedAttribute=value('relExtraSharedAttribute'),extraSharedOwn=value('relExtraSharedOwnAttribute');
    const match={};if(targetAttribute&&targetValue)match[targetAttribute]=targetValue;if(sharedAttribute&&sharedOwn)match[sharedAttribute]='@'+sharedOwn;
    if(extraSharedAttribute&&extraSharedOwn)match[extraSharedAttribute]='@'+extraSharedOwn;
    const result={...common,source:value('relLookupSource')||existing.source||'mel',when:ownAttribute&&ownValue?{[ownAttribute]:ownValue}:{},
      whenParent:parentAttribute&&parentValue?{[parentAttribute]:parentValue}:{},match,
      ambiguousReason:existing.ambiguousReason||'Multiple MEL equipment tags satisfy this relationship rule',
      emptyReason:existing.emptyReason||'No MEL equipment tag satisfies this relationship rule',
      excludeSelf:checked('relExcludeSelf'),ui:{...(existing.ui||{})}};
    if(checked('relWhenDiffers')&&sharedOwn)result.whenDiffers=sharedOwn;
    if(checked('relPreferExact')&&sharedOwn)result.preferExactTag={attribute:sharedOwn};
    return result;
  }
  const parts=[];
  $$('[data-relation-part-kind]').forEach(select=>{
    const index=+select.dataset.relationPartKind,partKind=select.value,input=$(`[data-relation-part-value="${index}"]`),partValue=clean(input&&input.value);
    if(partKind==='literal')parts.push({kind:'literal',text:input?input.value:''});
    else if((partKind==='column'||partKind==='part')&&partValue)parts.push({kind:partKind,name:partValue});
  });
  const markers=value('relMarkers').split(/[\n,]+/).map(clean).filter(Boolean);
  return {...common,markers,source:'mel',mode:value('relLookupMode')||'containing',
    onMultiple:value('relOnMultiple')==='first'?'first':'review',
    fragmentFrom:value('relFragmentFrom')==='wholeTag'?'wholeTag':'marker',
    buildingFrom:checked('relExtractBuilding')?'tagBeforeFirst':'',buildingDelimiter:value('relBuildingDelimiter')||'-',
    unitFrom:checked('relExtractUnit')?'fragmentBeforeFirst':'',unitDelimiter:value('relUnitDelimiter')||'_',parent:parts};
}
export function wireRelationshipsProfile(){
  $$('[data-rel-char-index]').forEach(button=>button.onclick=()=>{
    const index=+button.dataset.relCharIndex;
    if(S.profileUi.rangeStart==null||S.profileUi.rangeEnd!=null&&S.profileUi.rangeStart!==S.profileUi.rangeEnd){S.profileUi.rangeStart=index;S.profileUi.rangeEnd=index;}
    else S.profileUi.rangeEnd=index;
    renderProfile();
  });
  const kind=$('#relRuleKind');if(kind)kind.onchange=()=>{S.profileUi.relationKind=kind.value;S.profileUi.relationRuleId='';renderProfile();};
  $$('[data-relation-part-kind]').forEach(select=>select.onchange=()=>{
    const input=$(`[data-relation-part-value="${select.dataset.relationPartKind}"]`);if(!input)return;
    input.disabled=select.value==='none'||S.profileDraft.locked;
    input.placeholder=select.value==='column'?'Building, UPN...':select.value==='part'?'building or unit':'Text';
  });
  const useSelection=$('#useRelationSelection');if(useSelection)useSelection.onclick=()=>{
    const selection=trainerSelection().text,needle=$('#relNeedle'),markers=$('#relMarkers');
    if(needle)needle.value=selection;if(markers)markers.value=selection;
  };
  const save=$('#saveRelationRule');if(save)save.onclick=()=>{
    const existing=profileRelationEditorRule(S.profileDraft),rule=profileRelationFormRule(existing),list=[...(S.profileDraft.rules&&S.profileDraft.rules.relate||[])];
    const index=list.findIndex(item=>item.id===rule.id);if(index>=0)list[index]=rule;else list.push(rule);
    const candidate=profileClone(S.profileDraft);candidate.rules.relate=list;
    const validation=compileRuleProfile(candidate,{allowUnmapped:true});
    const relationError=validation.errors.find(error=>error.path.startsWith('rules.relate'));
    if(relationError){toast(relationError.message);return;}
    S.profileDraft.rules.relate=list;S.profileUi.relationRuleId='';markProfileDirty();renderProfile();
  };
  const cancel=$('#cancelRelationRule');if(cancel)cancel.onclick=()=>{S.profileUi.relationRuleId='';renderProfile();};
  $$('[data-relation-edit]').forEach(button=>button.onclick=()=>{
    const rule=S.profileDraft.rules.relate.find(item=>item.id===button.dataset.relationEdit);if(!rule)return;
    S.profileUi.relationRuleId=rule.id;S.profileUi.relationKind=rule.kind;renderProfile();
  });
  $$('[data-relation-toggle]').forEach(input=>input.onchange=()=>{
    const rule=S.profileDraft.rules.relate.find(item=>item.id===input.dataset.relationToggle);if(!rule)return;
    rule.enabled=input.checked;markProfileDirty();renderProfile();
  });
  const move=(id,delta)=>{const list=S.profileDraft.rules.relate,index=list.findIndex(rule=>rule.id===id),next=index+delta;
    if(index<0||next<0||next>=list.length)return;[list[index],list[next]]=[list[next],list[index]];markProfileDirty();renderProfile();};
  $$('[data-relation-up]').forEach(button=>button.onclick=()=>move(button.dataset.relationUp,-1));
  $$('[data-relation-down]').forEach(button=>button.onclick=()=>move(button.dataset.relationDown,1));
  $$('[data-relation-delete]').forEach(button=>button.onclick=()=>{
    S.profileDraft.rules.relate=S.profileDraft.rules.relate.filter(rule=>rule.id!==button.dataset.relationDelete);
    if(S.profileUi.relationRuleId===button.dataset.relationDelete)S.profileUi.relationRuleId='';
    markProfileDirty();renderProfile();
  });
}
export function wireHierarchyProfile(){
  const bind=(id,apply)=>{const input=$('#'+id);if(input)input.oninput=()=>{apply(input.value);markProfileDirty();};};
  bind('fallbackBuilding',value=>S.profileDraft.hierarchy.unassignedBuilding=value);
  bind('fallbackElectrical',value=>S.profileDraft.hierarchy.systemFallbacks.Electrical=value);
  bind('fallbackIc',value=>S.profileDraft.hierarchy.systemFallbacks['I&C']=value);
  bind('fallbackDefaultSystem',value=>S.profileDraft.hierarchy.systemFallbacks.default=value);
  bind('fallbackInstrumentDiscipline',value=>S.profileDraft.hierarchy.disciplineFallbacks.instrument=value);
  bind('fallbackDefaultDiscipline',value=>S.profileDraft.hierarchy.disciplineFallbacks.default=value);
  const bindSelect=(id,key)=>{const input=$('#'+id);if(input)input.onchange=()=>{S.profileDraft.hierarchy[key]=input.value;markProfileDirty();};};
  bindSelect('resolutionStrategy','resolutionStrategy');
  bindSelect('downstreamGapPolicy','downstreamGapPolicy');
  bindSelect('caseVariantPolicy','caseVariantPolicy');
  bindSelect('duplicateRegisterPolicy','duplicateRegisterPolicy');
  bindSelect('cableConflictPolicy','cableConflictPolicy');
  bindSelect('duplicateParentReviewPolicy','duplicateParentReviewPolicy');
  $$('[data-workflow-policy]').forEach(input=>input.onchange=()=>{
    S.profileDraft.hierarchy.workflow=S.profileDraft.hierarchy.workflow||{};
    S.profileDraft.hierarchy.workflow[input.dataset.workflowPolicy]=input.checked;markProfileDirty();
  });
  $$('[data-mode-field]').forEach(input=>{const update=()=>{
    const mode=S.profileDraft.modes[+input.dataset.modeIndex];if(!mode)return;
    const field=input.dataset.modeField;
    if(field==='requireRoot'||field==='fallbackParent'){
      mode.rootPolicy=mode.rootPolicy||{};
      if(clean(input.value))mode.rootPolicy[field]=input.value;else delete mode.rootPolicy[field];
    }else mode[field]=input.value;
    markProfileDirty();
  };input.oninput=update;input.onchange=update;});
  $$('[data-mode-level-field]').forEach(input=>input.oninput=()=>{
    const mode=S.profileDraft.modes[+input.dataset.modeIndex],level=mode&&mode.levels[+input.dataset.modeLevel];if(!level)return;
    level[input.dataset.modeLevelField]=input.value;markProfileDirty();
  });
  $$('[data-mode-level-up],[data-mode-level-down]').forEach(button=>button.onclick=()=>{
    const value=button.dataset.modeLevelUp||button.dataset.modeLevelDown,[modeIndex,levelIndex]=value.split(':').map(Number);
    const levels=S.profileDraft.modes[modeIndex]&&S.profileDraft.modes[modeIndex].levels;if(!levels)return;
    const delta=button.dataset.modeLevelUp? -1:1,next=levelIndex+delta;
    if(next<0||next>=levels.length||levels[next].kind==='flow')return;
    [levels[levelIndex],levels[next]]=[levels[next],levels[levelIndex]];markProfileDirty();renderProfile();
  });
  $$('[data-role-parent]').forEach(input=>input.oninput=()=>{
    S.profileDraft.hierarchy.roleParents[input.dataset.roleParent]=clean(input.value).toUpperCase();markProfileDirty();
  });
  $$('[data-role-parent-delete]').forEach(button=>button.onclick=()=>{
    delete S.profileDraft.hierarchy.roleParents[button.dataset.roleParentDelete];markProfileDirty();renderProfile();
  });
  const addRoleParent=$('#addRoleParent');if(addRoleParent)addRoleParent.onclick=()=>{
    const child=clean($('#newRoleChild').value).toUpperCase(),parent=clean($('#newRoleParent').value).toUpperCase();
    if(!child||!parent){toast('Enter both equipment and parent types');return;}
    S.profileDraft.hierarchy.roleParents[child]=parent;markProfileDirty();renderProfile();
  };
  const move=(source,delta)=>{const order=S.profileDraft.hierarchy.parentSourcePriority,index=order.indexOf(source),next=index+delta;if(index<0||next<0||next>=order.length)return;[order[index],order[next]]=[order[next],order[index]];markProfileDirty();renderProfile();};
  $$('[data-source-up]').forEach(button=>button.onclick=()=>move(button.dataset.sourceUp,-1));
  $$('[data-source-down]').forEach(button=>button.onclick=()=>move(button.dataset.sourceDown,1));
  $$('[data-override-delete]').forEach(button=>button.onclick=()=>{
    const [scope,id]=profileRuleRef(button.dataset.overrideDelete);
    if(scope==='session'){
      S.sessionRelationshipOverrides=S.sessionRelationshipOverrides.filter(override=>(override.id||override.equipment)!==id);
      if(S.roots.length)rebuildProfileProjections();renderProfile();return;
    }
    S.profileDraft.overrides.relationships=S.profileDraft.overrides.relationships.filter(override=>(override.id||override.equipment)!==id);
    markProfileDirty();renderProfile();
  });
  $$('[data-attribute-override-delete]').forEach(button=>button.onclick=()=>{
    const id=button.dataset.attributeOverrideDelete;
    S.profileDraft.overrides.attributes=(S.profileDraft.overrides.attributes||[]).filter(override=>(override.id||override.equipment)!==id);
    markProfileDirty();renderProfile();
  });
}
export function wireDetailsBuilder(){
  $$('[data-detail-toggle]').forEach(input=>input.onchange=()=>{
    const layout=S.profileDraft.details.layout,id=input.dataset.detailToggle,index=layout.indexOf(id);
    if(input.checked&&index<0)layout.push(id);else if(!input.checked&&index>=0)layout.splice(index,1);
    markProfileDirty();renderProfile();
  });
  const move=(id,delta)=>{const layout=S.profileDraft.details.layout,index=layout.indexOf(id),next=index+delta;if(index<0||next<0||next>=layout.length)return;[layout[index],layout[next]]=[layout[next],layout[index]];markProfileDirty();renderProfile();};
  $$('[data-detail-up]').forEach(button=>button.onclick=()=>move(button.dataset.detailUp,-1));
  $$('[data-detail-down]').forEach(button=>button.onclick=()=>move(button.dataset.detailDown,1));
}
export async function switchProfile(id){
  if(S.profileDirty&&!confirm('Discard unpublished profile changes?')){renderProfile();return;}
  const previous=activeProfile();PROFILE_STORE.activeId=id;persistProfiles();const next=activeProfile();
  S.profileDraft=profileClone(next);S.profileDirty=false;
  const executionChanged=profileExecutionSignature(previous)!==profileExecutionSignature(next);
  const result=await applyProfileExecutionChange(executionChanged);
  if(result.required&&result.rebuilt)toast('Profile loaded and hierarchy rebuilt');
}
export function duplicateProfile(){
  /* A copy starts with no legend history of its own. Carrying the source's
     sources, pending entries, and dismissals forward would claim the copy's
     inherited rules came from documents that were never uploaded to it. */
  const source=activeProfile(),copy=normalizeProfile(clearLegendProvenance({...profileCore(source),id:profileId(),name:source.locked?'Eagle - Project Copy':source.name+' Copy',
    builtIn:false,locked:false,revision:1,publishedAt:new Date().toISOString(),history:[]}));
  PROFILE_STORE.profiles.push(copy);PROFILE_STORE.activeId=copy.id;persistProfiles();S.profileDraft=profileClone(copy);S.profileDirty=true;renderProfile();
  toast('Copied to "'+copy.name+'" — save and apply when ready');
}
export async function deleteActiveProfile(){
  if(activeProfile().locked){toast('The Eagle compatibility profile cannot be deleted');return;}
  /* Counted over EDITABLE profiles, not all of them. Eagle is locked, so
     deleting the last project profile would leave only a profile nobody can
     work in -- and installCurrentEagle would silently create a replacement on
     the next load. */
  if(editableProfileCount()<2){toast('Create another site profile before deleting this one');return;}
  if(!confirm('Delete this site profile?'))return;
  const previous=activeProfile();
  PROFILE_STORE.profiles=PROFILE_STORE.profiles.filter(profile=>profile.id!==PROFILE_STORE.activeId);
  PROFILE_STORE.activeId=(PROFILE_STORE.profiles.find(profile=>!profile.locked)||PROFILE_STORE.profiles[0]).id;
  persistProfiles();S.profileDraft=profileClone(activeProfile());S.profileDirty=false;
  const result=await applyProfileExecutionChange(profileExecutionSignature(previous)!==profileExecutionSignature(activeProfile()));
  if(result.required&&result.rebuilt)toast('Profile deleted and hierarchy rebuilt');
  else if(!result.required)toast('Profile deleted');
}
export function exportProfileJson(profile){
  const safe={format:'SSManagement Site Profile',schemaVersion:RULES_SCHEMA_VERSION,exportedAt:new Date().toISOString(),profile:normalizeProfile(profile)};
  const name=(clean(profile.name)||'Site-Profile').replace(/[^A-Za-z0-9._-]+/g,'-').replace(/^-+|-+$/g,'')||'Site-Profile';
  downloadBlob(name+'.ssmanagement-profile.json',new Blob([serializePortableProfileEnvelope(safe)],{type:'application/json'}));toast('Profile exported with integrity check');
}
export async function importProfileJson(file){
  try{
    const text=await file.text(),raw=JSON.parse(text),envelope=parsePortableProfileEnvelope(raw);
    if(raw&&raw.kind&&!envelope.ok)throw new Error(envelope.message||envelope.error&&envelope.error.message||'Profile integrity check failed');
    const parsed=envelope.ok?envelope.value:raw,incoming=parsed.profile||parsed;
    if(!incoming||typeof incoming!=='object')throw new Error('Invalid profile');
    const currentFormat=Number(incoming.schemaVersion)===RULES_SCHEMA_VERSION&&incoming.basePreset;
    if(currentFormat){
      const preflight=compileRuleProfile({...incoming,builtIn:false,locked:false},{allowUnmapped:true});
      if(!preflight.ok)throw new Error(preflight.errors[0]&&preflight.errors[0].message||'Invalid profile');
    }
    const profile=normalizeProfile({...incoming,id:profileId(),name:clean(incoming.name)||file.name.replace(/\.[^.]+$/,''),builtIn:false,locked:false});
    const validation=compileRuleProfile(profile,{allowUnmapped:true});if(!validation.ok)throw new Error(validation.errors[0]&&validation.errors[0].message||'Invalid profile');
    Object.assign(profile,validation.compiledProfile);
    PROFILE_STORE.profiles.push(profile);PROFILE_STORE.activeId=profile.id;persistProfiles();S.profileDraft=profileClone(profile);S.profileDirty=false;
    const result=await applyProfileExecutionChange(true);
    if(result.required&&result.rebuilt)toast('Profile imported and hierarchy rebuilt');
    else if(!result.required)toast('Profile imported');
  }catch(error){toast(clean(error&&error.message)||'Could not import that profile');}
}
export function restoreProfileRevision(index){
  const item=S.profileDraft.history[index];if(!item||!item.snapshot)return;
  /* Restoring an older revision rolls back what the profile EXECUTES. It does
     not roll back what the engineer has learned about the site: sources they
     analyzed, entries still pending review, and entries they dismissed all
     survive. Only the snapshot's rule origins come back, keyed to the rule ids
     that are being restored alongside them; normalizeProfile then prunes any
     that no longer match a live rule. */
  const current=S.profileDraft.legendTraining||emptyLegendTraining();
  const snapshotOrigins=(item.snapshot.legendTraining&&item.snapshot.legendTraining.ruleOrigins)||{};
  const restored=normalizeProfile({...item.snapshot,id:S.profileDraft.id,name:S.profileDraft.name,history:S.profileDraft.history,
    legendTraining:{...current,ruleOrigins:snapshotOrigins}});
  S.profileDraft=restored;S.profileDirty=true;renderProfile();
}
export async function publishProfileDraft(){
  if(!S.profileDraft)return;
  if(S.profileDraft.locked){toast('Clone Eagle before changing its rules');return;}
  const previous=activeProfile(),now=new Date().toISOString(),draft=normalizeProfile(S.profileDraft);
  if(!clean(draft.name)){toast('Profile name is required');return;}
  const validation=compileRuleProfile(draft,{previousProfile:previous,allowUnmapped:true});
  if(!validation.ok){toast(validation.errors[0]&&validation.errors[0].message||'Profile validation failed');return;}
  Object.assign(draft,validation.compiledProfile);
  const history=[{revision:previous.revision,name:previous.name,savedAt:previous.publishedAt||previous.updatedAt,snapshot:profileHistorySnapshot(previous)},...(previous.history||[])].slice(0,8);
  draft.id=previous.id;draft.revision=previous.revision+1;draft.publishedAt=now;draft.updatedAt=now;draft.history=history;
  const executionChanged=profileExecutionSignature(previous)!==profileExecutionSignature(draft);
  PROFILE_STORE.profiles=PROFILE_STORE.profiles.map(profile=>profile.id===draft.id?draft:profile);PROFILE_STORE.activeId=draft.id;persistProfiles();
  S.profileDraft=profileClone(draft);S.profileDirty=false;
  const result=await applyProfileExecutionChange(executionChanged);
  const stored=S.profileStorage==='local'?'Profile saved':'Profile applied for this session';
  if(result.required&&result.rebuilt)toast(stored+' and hierarchy rebuilt');
  else if(!result.required)toast(stored);
}
