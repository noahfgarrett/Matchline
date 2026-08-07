import { $, clean, esc, sleep, raf } from '../core/text.js'

/* ---- loading / toast ---- */
export const RING_C=238.76; // 2·π·38
export let _pCur=0,_pTarget=0,_pRAF=0;
export function _pTick(){
  const d=_pTarget-_pCur;
  if(Math.abs(d)<0.4)_pCur=_pTarget;else _pCur+=d*0.2;
  const r=$('#lring'),n=$('#lpct');
  if(n)n.textContent=Math.round(_pCur);
  if(r)r.style.strokeDashoffset=RING_C*(1-_pCur/100);
  _pRAF=_pCur!==_pTarget?requestAnimationFrame(_pTick):0;
}
/* frac: 0..1 for a real %, or null for an indeterminate sweep. label: the step counter. */
export function setProgress(frac,label){
  const ov=$('#overlay');if(!ov)return;
  if(label!=null)$('#lcount').textContent=label;
  if(frac==null){ov.classList.add('indet');return;}
  ov.classList.remove('indet');
  _pTarget=Math.max(0,Math.min(100,frac*100));
  if(!_pRAF)_pRAF=requestAnimationFrame(_pTick);
}
export function showOverlay(msg,sub){
  $('#lmsg').textContent=msg;$('#lsub').textContent=sub||'';$('#lcount').textContent='';
  _pCur=0;_pTarget=0;if(_pRAF){cancelAnimationFrame(_pRAF);_pRAF=0;}
  $('#lpct').textContent='0';$('#lring').style.strokeDashoffset=RING_C;
  $('#overlay').classList.add('indet');$('#overlay').classList.add('show');
}
export function hideOverlay(){$('#overlay').classList.remove('show');}
export async function withLoading(msg,sub,fn){
  showOverlay(msg,sub);
  const t0=performance.now();
  try{return await fn(setProgress);}
  finally{
    setProgress(1);
    const el=performance.now()-t0,minT=560;
    await sleep(el<minT?minT-el:240);
    hideOverlay();
  }
}
/* Runs chunked work and only reveals the loader if the work is still going after
   `delay` ms. `work` receives (checkpoint, report); fast work finishes first -> no flash. */
export async function deferredRun(msg,sub,work,delay){
  let shown=false,shownAt=0;
  const timer=setTimeout(()=>{shown=true;shownAt=performance.now();showOverlay(msg,sub);},delay==null?500:delay);
  const checkpoint=()=>raf();
  const report=(f,l)=>{if(shown)setProgress(f,l);};
  try{return await work(checkpoint,report);}
  finally{
    clearTimeout(timer);
    if(shown){setProgress(1);const el=performance.now()-shownAt;if(el<360)await sleep(360-el);else await sleep(160);hideOverlay();}
  }
}
export let toastT;
export function toast(m){const el=$('#toast');el.textContent=m;el.classList.add('show');clearTimeout(toastT);toastT=setTimeout(()=>el.classList.remove('show'),1700);}
export function markCopiedTag(source){
  if(!source)return;
  source.classList.add('copied');clearTimeout(source._copyTimer);
  source._copyTimer=setTimeout(()=>source.classList.remove('copied'),900);
}
export function legacyCopyText(t){
  const area=document.createElement('textarea');area.value=t;area.readOnly=true;
  area.style.cssText='position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none';
  document.body.appendChild(area);area.focus({preventScroll:true});area.select();area.setSelectionRange(0,area.value.length);
  let copied=false;try{copied=document.execCommand('copy');}catch(_){}
  area.remove();return copied;
}
export function copyText(t,source){
  t=clean(t);if(!t)return;
  const done=()=>{markCopiedTag(source);toast('Copied  '+t);};
  const fallback=()=>{if(legacyCopyText(t))done();else toast(t);};
  if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(t).then(done).catch(fallback);
  else fallback();
}
export function copyableTag(value){const tag=clean(value);return tag&&!/^(?:N\/A|—|-)$/i.test(tag);}
export function copyTagHtml(value,displayValue,cls){
  const tag=clean(value),display=displayValue==null?tag:clean(displayValue);
  if(!copyableTag(tag))return esc(display||'—');
  return `<span class="copy-tag${cls?' '+cls:''}" data-copy-tag="${esc(tag)}" title="Copy ${esc(tag)}">${esc(display)}</span>`;
}
export function copyTagListHtml(value){
  const display=registerDisplayValue(value);
  if(!copyableTag(display))return esc(display);
  return display.split(/\s*;\s*/).map(tag=>copyTagHtml(tag)).join('<span class="tag-sep">; </span>');
}
export function wireCopyTags(root){
  if(!root||root._copyTagsWired)return;
  root.addEventListener('click',e=>{
    const target=e.target.closest&&e.target.closest('[data-copy-tag]');
    if(!target||!root.contains(target))return;
    e.preventDefault();e.stopPropagation();copyText(target.dataset.copyTag,target);
  },true);
  root._copyTagsWired=true;
}
