import { clean } from '../core/text.js'
import { getAoa } from './workbook.js'
import { scanMappedHeader } from './detect.js'

/* ---- Optional EXTO-layer inputs ----
   Both are strictly optional: sites on other Cx software never provide them
   and the plain SSM outputs are unaffected (spec §8.1).

   1. A prior EXTO registry export / upload sheet (Standardized Upload File
      Template Rev21 shape) — the item-master learning source and audit target.
   2. The Standardized Item Master Template — the legal VF item-master
      vocabulary used to validate assignments and normalize legacy CA_* names. */

function extoNormHeader(value){return clean(value).toLowerCase().replace(/[^a-z0-9&]+/g,'');}

export function detectExtoRegistry(headers){
  const norm=headers.map(extoNormHeader);
  const find=want=>norm.findIndex(h=>h===want);
  const equipmentId=find('equipmentid'),discipline=find('discipline'),upn=find('upn');
  const itemMaster=norm.findIndex(h=>h.startsWith('itemmaster'));
  if(equipmentId<0||discipline<0||upn<0||itemMaster<0)return null;
  return {equipmentId,discipline,upn,itemMaster,
    classification:norm.findIndex(h=>h.startsWith('equipmentclassification')),
    description:find('equipmentdescription'),
    closestParent:find('closestparent'),systemName:find('systemname')};
}
export const _extoRegCache=new Map();
export function extoRegistryInfo(key){
  if(_extoRegCache.has(key))return _extoRegCache.get(key);
  const {aoa}=getAoa(key),res=scanMappedHeader(aoa,detectExtoRegistry,10);
  _extoRegCache.set(key,res);return res;
}
export function isExtoRegistrySheet(key){return !!extoRegistryInfo(key);}
export function extoRegistryRows(key){
  const info=extoRegistryInfo(key);if(!info)return [];
  const {map,headerRow}=info,{aoa}=getAoa(key),rows=[];
  for(let i=headerRow+1;i<aoa.length;i++){
    const row=aoa[i]||[],equipmentId=clean(row[map.equipmentId]);
    if(!equipmentId)continue;
    rows.push({equipmentId,discipline:clean(row[map.discipline]),upn:clean(row[map.upn]),
      itemMaster:clean(row[map.itemMaster]),
      classification:map.classification>=0?clean(row[map.classification]):'',
      description:map.description>=0?clean(row[map.description]):'',
      closestParent:map.closestParent>=0?clean(row[map.closestParent]):'',
      systemName:map.systemName>=0?clean(row[map.systemName]):''});
  }
  return rows;
}

export function detectItemMasterTemplate(headers){
  const norm=headers.map(extoNormHeader);
  const site=norm.findIndex(h=>h==='site'),discipline=norm.findIndex(h=>h==='discipline');
  const imName=norm.findIndex(h=>h==='imname'||h.startsWith('imname'));
  if(site<0||discipline<0||imName<0)return null;
  return {site,discipline,imName};
}
export const _imTemplateCache=new Map();
export function itemMasterTemplateInfo(key){
  if(_imTemplateCache.has(key))return _imTemplateCache.get(key);
  const {aoa}=getAoa(key),res=scanMappedHeader(aoa,detectItemMasterTemplate,10);
  _imTemplateCache.set(key,res);return res;
}
export function isItemMasterTemplateSheet(key){return !!itemMasterTemplateInfo(key);}
export function itemMasterNames(key){
  const info=itemMasterTemplateInfo(key);if(!info)return [];
  const {map,headerRow}=info,{aoa}=getAoa(key),names=[];
  for(let i=headerRow+1;i<aoa.length;i++){
    const name=clean((aoa[i]||[])[map.imName]);
    if(name)names.push({name,discipline:clean((aoa[i]||[])[map.discipline]),site:clean((aoa[i]||[])[map.site])});
  }
  return names;
}
