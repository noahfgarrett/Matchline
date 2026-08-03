import { clean } from '../core/text.js'
import { getAoa } from './workbook.js'
import { scanMappedHeader } from './detect.js'

/* ---- P&ID line list (spec §3 input 6, optional) ----
   Feeds the piping/duct roll-up rows: each UPN's line segments collapse to one
   "UPN {upn} Distribution Piping" register row, per the SOP's roll-up rule. */
function lineNormHeader(value){return clean(value).toLowerCase().replace(/[^a-z0-9]+/g,'');}
export function detectLineList(headers){
  const norm=headers.map(lineNormHeader);
  if(norm.some(h=>h==='equipmenttag'||h.endsWith('equipmenttag')))return null; // that's a MEL
  const lineId=norm.findIndex(h=>h==='lineid'||h==='linenumber'||h==='lineno');
  const upn=norm.findIndex(h=>h==='upn'||h.startsWith('upn'));
  if(lineId<0||upn<0)return null;
  return {lineId,upn};
}
export const _lineListCache=new Map();
export function lineListInfo(key){
  if(_lineListCache.has(key))return _lineListCache.get(key);
  const {aoa}=getAoa(key),res=scanMappedHeader(aoa,detectLineList,30);
  _lineListCache.set(key,res);return res;
}
export function isLineListSheet(key){return !!lineListInfo(key);}
export function lineListRows(key){
  const info=lineListInfo(key);if(!info)return [];
  const {map,headerRow}=info,{aoa}=getAoa(key),rows=[];
  for(let i=headerRow+1;i<aoa.length;i++){
    const row=aoa[i]||[],lineId=clean(row[map.lineId]),upn=clean(row[map.upn]);
    if(lineId&&upn)rows.push({lineId,upn});
  }
  return rows;
}
