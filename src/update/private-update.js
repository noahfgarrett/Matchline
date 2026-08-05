import { $, $$, esc } from '../core/text.js'
import { saveUpdateHtml } from '../core/download.js'
import { portableProfileTransferBase64 } from '../profile/schema.js'

export const APP_VERSION = '0.7.0';
export const UPDATE_REPOSITORY = 'noahfgarrett/SSMCompiler-Releases';
export const UPDATE_RELEASE_API = 'https://api.github.com/repos/'+UPDATE_REPOSITORY+'/releases/latest';
export const UPDATE_API_VERSION = '2026-03-10';
export const UPDATE_TIMEOUT_MS = 5000;
export const LEGACY_UPDATE_CREDENTIAL_KEY = 'ssmanagement.private-update-token.v1';
export let pendingUpdateInfo=null;
export let activeUpdateTab='update';
export let updateModalDismissed=false;

export function isNewerVersion(remote,local){
  const r=String(remote||'').replace(/^v/i,'').split('.').map(Number);
  const l=String(local||'').replace(/^v/i,'').split('.').map(Number);
  const len=Math.max(r.length,l.length);
  for(let i=0;i<len;i++){
    const rv=Number.isFinite(r[i])?r[i]:0,lv=Number.isFinite(l[i])?l[i]:0;
    if(rv>lv)return true;
    if(rv<lv)return false;
  }
  return false;
}
export function selectUpdateAsset(assets){
  const htmlAsset=assets&&assets.find(asset=>String(asset.name||'').toLowerCase().endsWith('.html'));
  if(!htmlAsset)return null;
  const gzipAsset=assets.find(asset=>String(asset.name||'').toLowerCase().endsWith('.html.gz'));
  if(!gzipAsset)return {downloadUrl:htmlAsset.browser_download_url,assetApiUrl:htmlAsset.url,assetName:htmlAsset.name,downloadKind:'html'};
  return {
    downloadUrl:gzipAsset.browser_download_url,
    assetApiUrl:gzipAsset.url,
    assetName:gzipAsset.name,
    downloadKind:'gzip-html',
    fallbackDownloadUrl:htmlAsset.browser_download_url,
    fallbackAssetApiUrl:htmlAsset.url,
    fallbackAssetName:htmlAsset.name
  };
}
export function githubUpdateHeaders(accept){
  return {Accept:accept||'application/vnd.github+json','X-GitHub-Api-Version':UPDATE_API_VERSION};
}
export function clearLegacyUpdateCredential(){
  try{localStorage.removeItem(LEGACY_UPDATE_CREDENTIAL_KEY);}catch(_){}
}
export function updateRequestError(status){
  const error=new Error('GitHub update check failed: HTTP '+status);
  error.status=status;return error;
}
export async function fetchLatestUpdateRelease(){
  let timer=0;
  try{
    const controller=new AbortController();
    timer=setTimeout(()=>controller.abort(),UPDATE_TIMEOUT_MS);
    const res=await fetch(UPDATE_RELEASE_API,{signal:controller.signal,headers:githubUpdateHeaders('application/vnd.github+json')});
    if(!res.ok)throw updateRequestError(res.status);
    return res.json();
  }finally{if(timer)clearTimeout(timer);}
}
export function updateInfoFromRelease(release){
  const tagName=String(release&&release.tag_name||''),remoteVersion=tagName.replace(/^v/i,'');
  if(!isNewerVersion(remoteVersion,APP_VERSION))return null;
  const selected=selectUpdateAsset(release.assets);
  if(!selected)return null;
  return {version:remoteVersion,tagName,releaseNotes:release.body||'',...selected};
}
export async function checkForAppUpdate(){
  try{return updateInfoFromRelease(await fetchLatestUpdateRelease());}
  catch(_){return null;}
}
export function isPwaHostedApp(){
  return !!document.querySelector('meta[name="ssmanagement-pwa"][content="true"]');
}
export function versionedUpdateFilename(version){
  const cleanVersion=String(version||APP_VERSION).replace(/^v/i,'').replace(/[^0-9A-Za-z._-]/g,'').trim()||APP_VERSION;
  return 'SSMCompiler-v'+cleanVersion+'.html';
}
export function getDecompressionStream(){
  return typeof DecompressionStream==='function'?DecompressionStream:null;
}
export function canDecompressGzipInBrowser(){
  return !!getDecompressionStream();
}
export async function decompressGzipHtml(blob){
  const Stream=getDecompressionStream();
  if(!Stream)throw new Error('This browser cannot decompress gzip updates.');
  const decompressed=blob.stream().pipeThrough(new Stream('gzip'));
  const htmlBlob=await new Response(decompressed).blob();
  return new Blob([htmlBlob],{type:'text/html'});
}
export function trustedUpdateAssetApiUrl(value){
  const url=String(value||'').trim();
  return /^https:\/\/api\.github\.com\/repos\/noahfgarrett\/SSMCompiler-Releases\/releases\/assets\/\d+$/i.test(url)?url:'';
}
export async function fetchGitHubAssetBlob(assetApiUrl){
  const trustedUrl=trustedUpdateAssetApiUrl(assetApiUrl);
  if(!trustedUrl)throw new Error('The update asset URL was not trusted.');
  const res=await fetch(trustedUrl,{headers:githubUpdateHeaders('application/octet-stream')});
  if(!res.ok)throw updateRequestError(res.status);
  return res.blob();
}
export async function validateUpdateHtmlBlob(blob,version){
  const html=await blob.text();
  if(!/<html[\s>]/i.test(html)||!html.includes("const APP_VERSION = '"+version+"'")){
    throw new Error('Downloaded update did not match the expected app version.');
  }
  return new Blob([html],{type:'text/html'});
}
export async function embedProfileTransferInHtml(blob,encoded){
  const transfer=encoded===undefined?portableProfileTransferBase64():String(encoded||'');
  if(!transfer)return blob;
  const html=await blob.text(),block='<script type="application/json" id="ssmanagement-profile-transfer">'+transfer+'</scr'+'ipt>';
  const withoutPrevious=html.replace(/<script\s+type=["']application\/json["']\s+id=["']ssmanagement-profile-transfer["']>[\s\S]*?<\/script>/i,'');
  if(!/<\/body>/i.test(withoutPrevious))throw new Error('Downloaded update was missing its document body.');
  return new Blob([withoutPrevious.replace(/<\/body>/i,block+'</body>')],{type:'text/html'});
}
export async function savePreparedUpdateHtml(blob,filename){
  return saveUpdateHtml(await embedProfileTransferInHtml(blob),filename);
}
export function saveUpdateFromUrl(url,filename){
  if(!url)throw new Error('No direct update URL is available.');
  const a=document.createElement('a');
  a.href=url;a.download=filename||'SSMCompiler.html';a.rel='noopener';
  document.body.appendChild(a);a.click();a.remove();
}
export async function downloadUpdateFile(info){
  const filename=versionedUpdateFilename(info.version);
  if(info.downloadKind==='gzip-html'&&canDecompressGzipInBrowser()){
    try{
      const compressedBlob=await fetchGitHubAssetBlob(info.assetApiUrl);
      const htmlBlob=await validateUpdateHtmlBlob(await decompressGzipHtml(compressedBlob),info.version);
      await savePreparedUpdateHtml(htmlBlob,filename);
      return {downloadedAssetName:info.assetName,savedFilename:filename,usedCompressedAsset:true};
    }catch(e){}
  }
  const assetApiUrl=info.downloadKind==='gzip-html'?info.fallbackAssetApiUrl:info.assetApiUrl;
  const assetName=info.downloadKind==='gzip-html'?info.fallbackAssetName:info.assetName;
  if(!assetApiUrl||!assetName)throw new Error('No compatible update asset is available.');
  try{
    const htmlBlob=await validateUpdateHtmlBlob(await fetchGitHubAssetBlob(assetApiUrl),info.version);
    await savePreparedUpdateHtml(htmlBlob,filename);
    return {downloadedAssetName:assetName,savedFilename:filename,usedCompressedAsset:false,source:'asset-api'};
  }catch(e){
    const directUrl=info.downloadKind==='gzip-html'?info.fallbackDownloadUrl:info.downloadUrl;
    saveUpdateFromUrl(directUrl,filename);
    return {downloadedAssetName:assetName,savedFilename:filename,usedCompressedAsset:false,source:'direct-url'};
  }
}
export function notesHtml(md){
  const lines=String(md||'').split(/\r?\n/).map(l=>l.trim()).filter(Boolean);
  if(!lines.length)return '';
  let html='',open=false;
  const close=()=>{if(open){html+='</ul>';open=false;}};
  for(const line of lines){
    const h=line.match(/^###\s+(.+)/);
    const bullet=line.match(/^[-*]\s+(.+)/);
    if(h){close();html+='<h3>'+esc(h[1])+'</h3>';continue;}
    if(bullet){if(!open){html+='<ul>';open=true;}html+='<li>'+esc(bullet[1])+'</li>';continue;}
    close();html+='<p>'+esc(line)+'</p>';
  }
  close();
  return html;
}
export function releaseTypeForVersion(version){
  const p=String(version||'').split('.').map(Number);
  if((p[0]||0)>1&&!(p[1]||0)&&!(p[2]||0))return 'major';
  if((p[1]||0)>0&&!(p[2]||0))return 'feature';
  return 'fix';
}
export function typeLabel(type){return type==='major'?'Major':type==='feature'?'Feature':'Fix';}
export function formatChangeDate(iso){
  const d=new Date(iso);if(Number.isNaN(d.getTime()))return '';
  return d.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
}
export function changelogEntries(info){
  if(!info||!info.version||!info.releaseNotes)return CHANGELOG;
  if(CHANGELOG.some(e=>e.version===info.version))return CHANGELOG;
  return [{version:info.version,date:new Date().toISOString(),type:releaseTypeForVersion(info.version),notes:info.releaseNotes},...CHANGELOG];
}
export function renderChangelog(info){
  const entries=changelogEntries(info);
  const body=entries.map((entry,i)=>{
    const closed=i>0?' closed':'';
    const latest=i===0?'<span class="change-latest">latest</span>':'';
    const stats=entry.stats?Object.entries(entry.stats).filter(([,v])=>v).map(([k,v])=>v+' '+(k==='fixes'?'fix'+(v>1?'es':''):k.slice(0,-1)+(v>1?'s':''))).join(' · '):'';
    return `<div class="change-entry ${esc(entry.type)}${closed}" data-version="${esc(entry.version)}">
      <button class="change-head" type="button" data-change="${esc(entry.version)}">
        <span class="change-chev">${ic('chevron-down')}</span>
        <span class="change-ver">v${esc(entry.version)}</span>
        <span class="change-type">${esc(typeLabel(entry.type))}</span>
        ${latest}
        ${stats?`<span class="change-stats">${esc(stats)}</span>`:''}
        <span class="change-date">${esc(formatChangeDate(entry.date))}</span>
      </button>
      <div class="change-body">${notesHtml(entry.notes)}</div>
    </div>`;
  }).join('');
  return `<p class="changelog-intro">Recent SSM Compiler changes, newest first.</p><div class="changelog-list">${body}</div>`;
}
export function setUpdateTab(tab){
  activeUpdateTab=tab;
  const hasInfo=!!pendingUpdateInfo;
  $('#updateTab').hidden=!hasInfo;
  $('#updatePanel').hidden=tab!=='update'||!hasInfo;
  $('#changelogPanel').hidden=tab!=='changelog';
  $('#updateTab').classList.toggle('on',tab==='update');
  $('#changelogTab').classList.toggle('on',tab==='changelog');
  $('#updateTitle').textContent=tab==='update'&&hasInfo?'Update Available':'Changelog';
}
export function closeUpdateModal(){
  const m=$('#updateModal');if(!m)return;
  updateModalDismissed=true;m.classList.remove('show');m.setAttribute('aria-hidden','true');m.hidden=true;
}
export function openUpdateModal(tab){
  $('#changelogPanel').innerHTML=renderChangelog(pendingUpdateInfo);
  $$('#changelogPanel [data-change]').forEach(btn=>btn.onclick=()=>{
    const entry=btn.closest('.change-entry');if(entry)entry.classList.toggle('closed');
  });
  setUpdateTab(tab);
  const m=$('#updateModal');m.hidden=false;m.classList.add('show');m.setAttribute('aria-hidden','false');
}
export function showUpdateModal(info){
  pendingUpdateInfo=info;
  $('#updateLocal').textContent='v'+APP_VERSION;
  $('#updateRemote').textContent='v'+info.version;
  $('#updateMsg').textContent='A newer single-file HTML version is ready. The download carries your current site profiles into the replacement file.';
  const notes=$('#updateNotes'),html=notesHtml(info.releaseNotes);
  notes.innerHTML=html;notes.hidden=!html;
  $('#updateStatus').innerHTML='';
  const btn=$('#updateDownload');
  btn.disabled=false;btn.innerHTML=ic('download')+'Download v'+esc(info.version);
  openUpdateModal('update');
}
export function showAppChangelog(){
  updateModalDismissed=false;
  $('#updateStatus').innerHTML='';
  openUpdateModal('changelog');
}
export async function handleUpdateDownload(){
  if(!pendingUpdateInfo)return;
  const btn=$('#updateDownload'),status=$('#updateStatus');
  btn.disabled=true;btn.textContent='Preparing...';status.innerHTML='';
  try{
    const result=await downloadUpdateFile(pendingUpdateInfo);
    status.innerHTML='<div class="update-status">Download ready: '+esc(result.savedFilename)+'</div>';
    btn.innerHTML=ic('check')+'Downloaded';
  }catch(_){
    status.innerHTML='<div class="update-error">Download failed. Check the connection and try again.</div>';
    btn.disabled=false;btn.innerHTML=ic('download')+'Download v'+esc(pendingUpdateInfo.version);
  }
}
export function initUpdateCheck(){
  clearLegacyUpdateCredential();
  $('#updateCloseX').innerHTML=ic('x');
  $('#updateSkip').onclick=closeUpdateModal;
  $('#updateDownload').onclick=handleUpdateDownload;
  $('#updateTab').onclick=()=>setUpdateTab('update');
  $('#changelogTab').onclick=()=>setUpdateTab('changelog');
  $('#versionLink').textContent='v'+APP_VERSION;
  $('#versionLink').onclick=showAppChangelog;
  const m=$('#updateModal');
  m.addEventListener('click',e=>{
    if(e.target.closest&&e.target.closest('#updateCloseX')){e.preventDefault();closeUpdateModal();return;}
    if(e.target===m)closeUpdateModal();
  });
  if(isPwaHostedApp())return;
  checkForAppUpdate().then(info=>{if(info&&!updateModalDismissed)showUpdateModal(info);});
}
