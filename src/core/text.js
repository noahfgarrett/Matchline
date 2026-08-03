export const $=(s,r=document)=>r.querySelector(s);
export const $$=(s,r=document)=>[...r.querySelectorAll(s)];
export const esc=s=>String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export const sleep=ms=>new Promise(r=>setTimeout(r,ms));
export const raf=()=>new Promise(r=>requestAnimationFrame(()=>r()));
export const clean=v=>String(v==null?'':v).trim();
export const NAT_COLLATOR=new Intl.Collator(undefined,{numeric:true,sensitivity:'base'});
export const natCmp=(a,b)=>NAT_COLLATOR.compare(String(a),String(b));
export const KEYSEP='\u0001';
