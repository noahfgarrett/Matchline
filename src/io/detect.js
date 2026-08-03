import { clean, KEYSEP } from '../core/text.js'
import { cleanTag, cleanRegisterTag, normSep } from '../core/tags.js'
import { S, fileById } from '../state.js'
import { profileMapping, profileManualFields, profileMappedHeaderRow } from '../profile/schema.js'
import { ruleEngine } from '../rules/provider.js'
import { getAoa, sheetRowCount } from './workbook.js'

/* ---- column detection ---- */
export function findHeaderRow(aoa){
  for(let i=0;i<Math.min(aoa.length,15);i++){
    const j=(aoa[i]||[]).map(c=>clean(c).toLowerCase()).join('|');
    if(/id\s*name/.test(j)||/down\s*stream/.test(j)||/start(ing)?\s*source/.test(j))return i;
  }
  return 0;
}
export function autoDetect(headers){
  const H=headers.map(x=>clean(x)),low=H.map(h=>h.toLowerCase());
  let source=low.findIndex(h=>/^start(ing)?\s*source$/.test(h));
  if(source<0)source=low.findIndex(h=>/start.*source/.test(h));
  if(source<0)source=low.findIndex(h=>/^source$/.test(h));
  let idName=low.findIndex(h=>/^id[\s_]*name$/.test(h));
  if(idName<0)idName=low.findIndex(h=>/id[\s_]*name/.test(h));
  if(idName<0)idName=low.findIndex(h=>/(final\s*load|^id$)/.test(h));
  const ds=[];low.forEach((h,i)=>{const m=h.match(/down\s*stream\s*0*(\d+)/)||h.match(/^ds\s*0*(\d+)$/);if(m)ds.push({i,n:+m[1]});});
  ds.sort((a,b)=>a.n-b.n);
  const loadDesc=low.findIndex(h=>/load\s*desc/.test(h));
  const finalSource=low.findIndex(h=>/^final[\s_]*source$/.test(h)||/final.*source/.test(h));
  let circuit=low.findIndex(h=>/^circuit\s*#$/.test(h)||/circuit\s*#/.test(h));
  if(circuit<0)circuit=low.findIndex(h=>normH(h)==='circuit');
  return {sourceAuto:source,idAuto:idName,dsPattern:ds.map(d=>d.i),loadDescAuto:loadDesc,finalSourceAuto:finalSource,circuitAuto:circuit,headers:H};
}
export function resolveCols(key){
  const {headers}=getAoa(key);
  const a=autoDetect(headers),stored=S.override[key]||{},mapping=profileMapping('easyPower'),mapped=profileManualFields(mapping);
  /* An override is a column INDEX, so it stops meaning anything if the sheet's
     header row moves under it -- a profile mapping can change which row counts
     as the header, and overrides now outlive profile saves. An index the
     current headers cannot satisfy falls through to the mapping and then to
     auto-detection, rather than resolving to a column that is not there. */
  const inRange=i=>i!=null&&i>=0&&i<headers.length;
  const ov={source:inRange(stored.source)?stored.source:null,idName:inRange(stored.idName)?stored.idName:null};
  let source=ov.source!=null?ov.source:(mapped.startingSource!=null?+mapped.startingSource:(a.sourceAuto<0?0:a.sourceAuto));
  let idName=ov.idName!=null?ov.idName:(mapped.idName!=null?+mapped.idName:(a.idAuto<0?headers.length-1:a.idAuto));
  let downstream;
  const mappedDownstream=Object.keys(mapped).filter(id=>/^downstream\d+$/.test(id)).sort((x,y)=>+x.replace(/\D/g,'')-+y.replace(/\D/g,'')).map(id=>+mapped[id]).filter(i=>i>=0);
  if(mappedDownstream.length){
    downstream=mappedDownstream.filter(i=>i!==source&&i!==idName);
  }else if(a.dsPattern.length){
    downstream=a.dsPattern.filter(i=>i!==source&&i!==idName);
  }else{
    const lo=Math.min(source,idName),hi=Math.max(source,idName);downstream=[];
    for(let i=lo+1;i<hi;i++)downstream.push(i);
  }
  const loadDesc=mapped.loadDescription!=null?+mapped.loadDescription:a.loadDescAuto;
  const finalSource=mapped.finalSource!=null?+mapped.finalSource:a.finalSourceAuto;
  const circuit=mapped.circuit!=null?+mapped.circuit:a.circuitAuto;
  return {source,idName,downstream,loadDesc,finalSource,circuit,headers,ok:(source>=0&&idName>=0&&(mapped.startingSource!=null||a.sourceAuto>=0)&&(mapped.idName!=null||a.idAuto>=0))};
}
/* ---- cable schedule detection (Load Name (To) -> Panel (From)) + detail columns ---- */
export const normH=s=>clean(s).toLowerCase().replace(/[^a-z0-9]/g,'');
export const CABLE_FIELDS=[ // label, test(normalizedHeader) — order matters (first match wins, headers used once)
  ['Load Name (To)',     h=>h==='loadnameto'||(h.includes('loadname')&&h.includes('to'))],
  ['Panel (From)',       h=>h==='panelfrom'||(h.includes('panel')&&h.includes('from'))],
  ['Circuits_Id',        h=>h==='circuitsid'],
  ['Cable Tag',          h=>h.includes('cabletag')],
  ['Circuit_Number',     h=>h.includes('circuitnumber')||(h.includes('circuit')&&h.includes('number'))],
  ['Circuit ID',         h=>h==='circuitid'],
  ['Load kVA/HP/Amps',   h=>h.includes('kva')||h.includes('hpamps')||(h.includes('load')&&(h.includes('kva')||h.includes('hp')||h.includes('amps')))],
  ['Cable (ref table)',  h=>h.includes('reference')||(h==='cable')],
  ['Package/Revision',   h=>h.includes('package')||h.includes('revision')],
  ['RFI Number',         h=>h.includes('rfi')],
  ['Cable Length [ft]',  h=>h.includes('cablelength')||(h.includes('cable')&&h.includes('length'))],
  ['Raceway',            h=>h.includes('raceway')]
];
export function detectCable(headers){
  const norm=headers.map(normH);
  const used=new Set(),map={};
  for(const [label,test] of CABLE_FIELDS){
    for(let i=0;i<norm.length;i++){ if(used.has(i))continue; if(test(norm[i])){map[label]=i;used.add(i);break;} }
  }
  if(map['Load Name (To)']==null||map['Panel (From)']==null)return null;
  return map; // {label: colIndex}
}
export const isCableName=name=>/cable\s*schedule/i.test(clean(name));
/* Cable Schedule lives in its own file/tab and can have title rows above the header,
   so scan the first rows for the row that yields Load Name (To) + Panel (From). */
export const _cableCache=new Map();
export function scanMappedHeader(aoa,detector,limit){
  for(let row=0;row<Math.min(aoa.length,limit);row++){
    const map=detector((aoa[row]||[]).map(clean));
    if(map)return {map,headerRow:row};
  }
  return null;
}
export function cableInfo(key){
  if(_cableCache.has(key))return _cableCache.get(key);
  const {aoa}=getAoa(key);
  const detected=scanMappedHeader(aoa,detectCable,30);
  let res=detected;
  const mapping=profileMapping('cable'),fields=profileManualFields(mapping);
  if(fields.loadName!=null&&fields.panel!=null){
    const ids={loadName:'Load Name (To)',panel:'Panel (From)',circuitsId:'Circuits_Id',cableTag:'Cable Tag',circuitNumber:'Circuit_Number',
      circuitId:'Circuit ID',loadRating:'Load kVA/HP/Amps',cableReference:'Cable (ref table)',packageRevision:'Package/Revision',
      rfiNumber:'RFI Number',cableLength:'Cable Length [ft]',raceway:'Raceway'},map={};
    for(const [id,label] of Object.entries(ids))if(fields[id]!=null)map[label]=+fields[id];
    res={map,headerRow:profileMappedHeaderRow('cable',detected?detected.headerRow:findHeaderRow(aoa))};
  }
  _cableCache.set(key,res);return res; // {map,headerRow} | null
}
export function isCableSheet(key){return isCableName(key.split(KEYSEP)[1])||!!cableInfo(key);}
export function cableRowCount(key){const ci=cableInfo(key);if(!ci)return sheetRowCount(key);const {aoa}=getAoa(key);return Math.max(0,aoa.length-ci.headerRow-1);}
/* ---- Point Master Database (PANEL -> INSTRUMENT TAG) ---- */
export const PMD_SHEET_NAME='installpmd';
export const PMD_FIELDS=[
  ['CARD','card'],
  ['POINT POSITION','pointposition'],
  ['POINT TYPE','pointtype'],
  ['P&ID','pid'],
  ['Location','location'],
  ['RELEASE','release'],
  ['DESCRIPTION','description']
];
export const _pmdCache=new Map();
export function isPmdFile(file){return !!(file&&file.sheets.some(s=>normH(s)===PMD_SHEET_NAME));}
export function detectPmd(headers){
  const norm=headers.map(normH),panel=norm.indexOf('panel'),tag=norm.indexOf('instrumenttag');
  if(panel<0||tag<0)return null;
  const map={PANEL:panel,'INSTRUMENT TAG':tag};
  for(const [label,key] of PMD_FIELDS){const i=norm.indexOf(key);if(i>=0)map[label]=i;}
  return map;
}
export function pmdInfo(key){
  if(_pmdCache.has(key))return _pmdCache.get(key);
  const {aoa}=getAoa(key),detected=scanMappedHeader(aoa,detectPmd,60);let res=detected;
  const mapping=profileMapping('pmd'),fields=profileManualFields(mapping);
  if(fields.panel!=null&&fields.instrumentTag!=null){
    const ids={panel:'PANEL',instrumentTag:'INSTRUMENT TAG',card:'CARD',pointPosition:'POINT POSITION',pointType:'POINT TYPE',
      pid:'P&ID',location:'Location',release:'RELEASE',description:'DESCRIPTION'},map={};
    for(const [id,label] of Object.entries(ids))if(fields[id]!=null)map[label]=+fields[id];
    res={map,headerRow:profileMappedHeaderRow('pmd',detected?detected.headerRow:findHeaderRow(aoa))};
  }
  _pmdCache.set(key,res);return res;
}
export function isPmdSheet(key){const [fid]=key.split(KEYSEP);return isPmdFile(fileById(fid));}
export function pmdRowCount(key){const pi=pmdInfo(key);if(!pi)return sheetRowCount(key);const {aoa}=getAoa(key);return Math.max(0,aoa.length-pi.headerRow-1);}
export function pmdPanelMatchParts(value){
  const panel=ruleEngine().normalizeOnly(cleanTag(value),'matching'),key=normSep(panel),split=panel.indexOf('-');
  const building=split>0?clean(panel.slice(0,split)):'',matchKey=building?normSep(panel.slice(split+1)):'';
  return {key,matchKey,building};
}
export function pmdPanelKey(value){return pmdPanelMatchParts(value).key;}
/* ---- Master Equipment List (Equipment Tag -> UPN) ---- */
export const MEL_SHEET_NAME='equipmentlist';
export const _melCache=new Map();
export function isMelSheet(key){const [fid,sheet]=key.split(KEYSEP);return normH(sheet)===MEL_SHEET_NAME||!!(fileById(fid)&&melInfo(key));}
export function detectMel(headers){
  const norm=headers.map(normH),tag=norm.findIndex(h=>h==='equipmenttag'||(h.endsWith('equipmenttag')&&!h.startsWith('systemparent')));
  const upn=norm.findIndex(h=>h==='upn'||h.startsWith('upn'));
  const building=norm.findIndex(h=>h==='bldg'||h==='building'||h.startsWith('building'));
  const systemParent=norm.findIndex(h=>h.startsWith('systemparent')&&h.includes('equipmenttag'));
  const discipline=norm.findIndex(h=>h==='discipline'||h.startsWith('discipline'));
  const systemDescription=norm.findIndex(h=>h==='systemdescription'||(h.startsWith('system')&&h.includes('description')));
  return tag>=0?{tag,upn,building,systemParent,discipline,systemDescription}:null;
}
export function melInfo(key){
  if(_melCache.has(key))return _melCache.get(key);
  const {aoa}=getAoa(key),detected=scanMappedHeader(aoa,detectMel,200);let res=detected;
  const mapping=profileMapping('mel'),fields=profileManualFields(mapping);
  if(fields.equipmentTag!=null){
    res={map:{tag:+fields.equipmentTag,upn:fields.upn!=null?+fields.upn:-1,building:fields.building!=null?+fields.building:-1,
      systemParent:fields.systemParent!=null?+fields.systemParent:-1,discipline:fields.discipline!=null?+fields.discipline:-1,
      systemDescription:fields.systemDescription!=null?+fields.systemDescription:-1},headerRow:profileMappedHeaderRow('mel',detected?detected.headerRow:findHeaderRow(aoa))};
  }
  _melCache.set(key,res);return res;
}
export function profileFieldsFromHeaders(kind,headers){
  const fields={};
  if(kind==='easyPower'){
    const detected=autoDetect(headers);
    if(detected.sourceAuto>=0)fields.startingSource=detected.sourceAuto;
    headers.forEach((header,col)=>{
      const value=clean(header).toLowerCase(),match=value.match(/down\s*stream\s*0*(\d+)/)||value.match(/^ds\s*0*(\d+)$/);
      const level=match?+match[1]:0;if(level>=1&&level<=12)fields['downstream'+level]=col;
    });
    if(detected.finalSourceAuto>=0)fields.finalSource=detected.finalSourceAuto;
    if(detected.idAuto>=0)fields.idName=detected.idAuto;
    if(detected.loadDescAuto>=0)fields.loadDescription=detected.loadDescAuto;
    if(detected.circuitAuto>=0)fields.circuit=detected.circuitAuto;
    return fields.startingSource!=null&&fields.idName!=null?fields:null;
  }
  if(kind==='cable'){
    const detected=detectCable(headers);if(!detected)return null;
    const labels={loadName:'Load Name (To)',panel:'Panel (From)',circuitsId:'Circuits_Id',cableTag:'Cable Tag',circuitNumber:'Circuit_Number',
      circuitId:'Circuit ID',loadRating:'Load kVA/HP/Amps',cableReference:'Cable (ref table)',packageRevision:'Package/Revision',
      rfiNumber:'RFI Number',cableLength:'Cable Length [ft]',raceway:'Raceway'};
    for(const [id,label] of Object.entries(labels))if(detected[label]!=null)fields[id]=detected[label];
    return fields;
  }
  if(kind==='pmd'){
    const detected=detectPmd(headers);if(!detected)return null;
    const labels={panel:'PANEL',instrumentTag:'INSTRUMENT TAG',card:'CARD',pointPosition:'POINT POSITION',pointType:'POINT TYPE',
      pid:'P&ID',location:'Location',release:'RELEASE',description:'DESCRIPTION'};
    for(const [id,label] of Object.entries(labels))if(detected[label]!=null)fields[id]=detected[label];
    return fields;
  }
  if(kind==='mel'){
    const detected=detectMel(headers);if(!detected)return null;
    /* Every key detectMel returns must appear here, or a site that saves a MEL
       mapping silently loses the columns this map omits: melInfo switches to its
       manual-mapping branch as soon as fields.equipmentTag is set, and anything
       unmapped resolves to -1 even when the sheet plainly has the column. */
    const labels={equipmentTag:'tag',upn:'upn',building:'building',systemParent:'systemParent',discipline:'discipline',systemDescription:'systemDescription'};
    for(const [id,key] of Object.entries(labels))if(detected[key]!=null&&detected[key]>=0)fields[id]=detected[key];
    return fields;
  }
  return null;
}
export function detectProfileColumns(key,kind){
  if(!key)return null;
  const {aoa}=getAoa(key),limit={easyPower:30,cable:30,pmd:60,mel:200}[kind]||30;
  let best=null;
  for(let row=0;row<Math.min(aoa.length,limit);row++){
    const fields=profileFieldsFromHeaders(kind,(aoa[row]||[]).map(clean));if(!fields)continue;
    const count=Object.keys(fields).length;
    const core=kind==='easyPower'
      ?Number(fields.startingSource!=null&&fields.idName!=null)
      :kind==='cable'?Number(fields.loadName!=null&&fields.panel!=null)
      :kind==='pmd'?Number(fields.panel!=null&&fields.instrumentTag!=null)
      :Number(fields.equipmentTag!=null);
    const score=count+core*100;
    if(!best||score>best.score)best={headerRow:row,fields,score};
  }
  return best;
}
export function mergeDetectedProfileMapping(draft,kind,detection,reset){
  if(!draft||!kind||!detection)return {changed:false,count:0};
  const before=JSON.stringify(draft.mappings&&draft.mappings[kind]||null);
  draft.mappings=draft.mappings||{};
  const mapping=draft.mappings[kind]||(draft.mappings[kind]={fields:{}});
  if(reset){mapping.fields={};mapping.autoFields=[];mapping.ignoredFields=[];}
  mapping.fields=mapping.fields||{};
  const ignored=new Set(mapping.ignoredFields||[]),previousAuto=new Set(mapping.autoFields||[]),nextAuto=new Set();
  const occupiedManual=new Set(Object.entries(mapping.fields).filter(([id])=>!previousAuto.has(id)).map(([,col])=>Number(col)));
  if(mapping.headerRow==null||mapping.autoHeaderRow===true||reset){mapping.headerRow=detection.headerRow;mapping.autoHeaderRow=true;}
  for(const [id,col] of Object.entries(detection.fields||{})){
    if(ignored.has(id))continue;
    if(mapping.fields[id]!=null&&!previousAuto.has(id))continue;
    if(occupiedManual.has(Number(col)))continue;
    mapping.fields[id]=col;nextAuto.add(id);
  }
  for(const id of previousAuto)if(!nextAuto.has(id))delete mapping.fields[id];
  mapping.autoFields=[...nextAuto];
  mapping.ignoredFields=[...ignored];
  return {changed:before!==JSON.stringify(mapping),count:Object.keys(detection.fields||{}).length,mapping};
}
export function ensureProfileAutoMapping(draft,key,kind,reset){
  const before=JSON.stringify(draft&&draft.mappings&&draft.mappings[kind]||null);
  const detection=detectProfileColumns(key,kind);
  if(!detection){
    const mapping=draft&&draft.mappings&&draft.mappings[kind];
    if(!mapping)return {changed:false,count:0};
    mapping.fields=mapping.fields||{};
    for(const id of mapping.autoFields||[])delete mapping.fields[id];
    mapping.autoFields=[];
    if(mapping.autoHeaderRow===true){delete mapping.headerRow;delete mapping.autoHeaderRow;}
    delete mapping.sampleSheet;
    return {changed:before!==JSON.stringify(mapping),count:0,mapping};
  }
  const result=mergeDetectedProfileMapping(draft,kind,detection,!!reset);
  if(result.mapping)result.mapping.sampleSheet=String(key||'').split(KEYSEP)[1]||'';
  result.changed=before!==JSON.stringify(result.mapping||null);
  return result;
}
export function melRowCount(key){const mi=melInfo(key);if(!mi)return sheetRowCount(key);const {aoa}=getAoa(key);return Math.max(0,aoa.length-mi.headerRow-1);}
/* ---- Current Working Copy (an SSM-like sheet: Equipment ID / Closest Parent / Dependencies) ---- */
export function detectWC(headers){
  const norm=headers.map(normH);
  const find=t=>{for(let i=0;i<norm.length;i++)if(t(norm[i]))return i;return -1;};
  const equip=find(h=>h==='equipmentid'||(h.includes('equipment')&&h.includes('id'))||h==='equipment');
  if(equip<0)return null;
  return {equip,parent:find(h=>h.includes('closestparent')||h.includes('parent')),dep:find(h=>h.includes('dependenc'))};
}
export function parseWorkCopy(){
  S.wcRows=null;if(!S.workCopy||!S.workCopy.wb)return;
  const wb=S.workCopy.wb;
  for(const sn of wb.SheetNames){
    const aoa=XLSX.utils.sheet_to_json(wb.Sheets[sn],{header:1,raw:false,defval:'',blankrows:false});
    for(let r=0;r<Math.min(aoa.length,30);r++){
      const cols=detectWC((aoa[r]||[]).map(clean));
      if(!cols)continue;
      const rows=[];
      for(let i=r+1;i<aoa.length;i++){
        const equip=cleanTag(aoa[i][cols.equip]);if(!equip)continue;
        rows.push({equip:cleanRegisterTag(aoa[i][cols.equip]),parent:cols.parent>=0?cleanRegisterTag(aoa[i][cols.parent]):'',dep:cols.dep>=0?cleanRegisterTag(aoa[i][cols.dep]):''});
      }
      if(rows.length){S.wcRows=rows;return;}
    }
  }
}
