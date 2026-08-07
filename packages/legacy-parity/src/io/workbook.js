import { clean, KEYSEP } from '../core/text.js'
import { cleanTag } from '../core/tags.js'
import { S, fileById, tagKey } from '../state.js'
import { profileMappedHeaderRow, profileKindForKey } from '../profile/schema.js'
import { isNote } from '../profile/classify.js'
import { findHeaderRow, resolveCols } from './detect.js'

/* ---- parsing ---- */
export function readArrayBuffer(file){return new Promise((res,rej)=>{const fr=new FileReader();fr.onload=()=>res(fr.result);fr.onerror=()=>rej(fr.error||new Error('read error'));fr.readAsArrayBuffer(file);});}
/* xlsx-js-style writes cell styles but does not expose imported font details.
   Read the XLSX archive metadata directly so strike formatting stays offline. */
export function extractStrikeCells(bytes){
  const out=new Map();
  if(typeof fflate==='undefined'||bytes[0]!==0x50||bytes[1]!==0x4b)return out;
  try{
    const dec=new TextDecoder(),parser=new DOMParser();
    const parse=entry=>entry?parser.parseFromString(dec.decode(entry),'application/xml'):null;
    /* Styles first, and on their own. The whole pass exists to find struck
       cells, so a workbook whose style table defines no strike-through font
       cannot contain any -- and most do not. Decompressing just xl/styles.xml
       lets that case return before the rest of the archive is inflated: on the
       6.7MB fixture the filtered read is 0.17ms against 0.8ms to inflate all
       6.6MB, and it never materialises the sheet XML at all. Only a workbook
       that really does carry struck styles pays for the full unzip and the
       per-sheet DOM parse below. */
    const stylesOnly=fflate.unzipSync(bytes,{filter:entry=>entry.name==='xl/styles.xml'});
    const styles=parse(stylesOnly['xl/styles.xml']);if(!styles)return out;
    const strikeFonts=new Set();
    [...styles.querySelectorAll('fonts > font')].forEach((font,i)=>{
      const strike=[...font.children].find(el=>el.localName==='strike');
      const val=strike?clean(strike.getAttribute('val')).toLowerCase():'';
      if(strike&&val!=='0'&&val!=='false')strikeFonts.add(i);
    });
    const strikeStyles=new Set();
    [...styles.querySelectorAll('cellXfs > xf')].forEach((xf,i)=>{if(strikeFonts.has(Number(xf.getAttribute('fontId')||0)))strikeStyles.add(i);});
    if(!strikeStyles.size)return out;
    const files=fflate.unzipSync(bytes),doc=path=>parse(files[path]);
    const relDoc=doc('xl/_rels/workbook.xml.rels'),wbDoc=doc('xl/workbook.xml');if(!relDoc||!wbDoc)return out;
    const rels=new Map([...relDoc.querySelectorAll('Relationship')].map(rel=>[rel.getAttribute('Id'),rel.getAttribute('Target')]));
    const localAttr=(el,name)=>[...el.attributes].find(a=>a.localName===name)?.value||'';
    const pathFor=target=>{
      let path=clean(target).replace(/\\/g,'/').replace(/^\//,'');if(!path.startsWith('xl/'))path='xl/'+path;
      const parts=[];for(const part of path.split('/')){if(part==='..')parts.pop();else if(part&&part!=='.')parts.push(part);}return parts.join('/');
    };
    for(const sheet of wbDoc.querySelectorAll('sheets > sheet')){
      const name=sheet.getAttribute('name'),rid=sheet.getAttribute('r:id')||localAttr(sheet,'id'),sheetDoc=doc(pathFor(rels.get(rid)));
      if(!name||!sheetDoc)continue;
      const cells=new Set();
      for(const cell of sheetDoc.querySelectorAll('c')){
        const own=cell.hasAttribute('s'),style=Number(own?cell.getAttribute('s'):cell.parentElement?.getAttribute('s')||0);
        if(strikeStyles.has(style))cells.add(cell.getAttribute('r'));
      }
      if(cells.size)out.set(name,cells);
    }
  }catch(e){console.warn('Could not read imported strike formatting',e);}
  return out;
}
/* One tab can hold hundreds of thousands of cells, and the scan below is the
   longest uninterrupted stretch of work in an import. Splitting it into chunks
   lets an async caller hand control back between them so the progress ring
   keeps painting -- prewarmSheets used to yield between SHEETS only, so a
   single large tab blocked straight through it, which is the most likely
   source of a "page unresponsive" report. The synchronous entry point runs
   every chunk back to back and produces byte-identical output. */
const AOA_CHUNK=20000;
const AOA_DENSE_ROW_CHUNK=2000;
function scanCells(ws,addresses,from,to,state){
  for(let i=from;i<to;i++){
    const address=addresses[i];
    if(address[0]==='!'||!/^[A-Z]{1,3}\d+$/.test(address))continue;
    const cell=ws[address];if(!cell||(cell.v==null&&cell.f==null&&cell.w==null))continue;
    const pos=XLSX.utils.decode_cell(address),value=cell.w!=null?cell.w:XLSX.utils.format_cell(cell);
    let row=state.rows.get(pos.r);if(!row){row=new Map();state.rows.set(pos.r,row);}
    row.set(pos.c,value);if(pos.c>state.maxCol)state.maxCol=pos.c;
  }
}
/* Dense worksheets (XLSX.read {dense:true}) are arrays of row arrays, so the
   per-cell address regex, decode_cell, and the giant Object.keys walk all
   disappear. Feeds the same state shape as scanCells, so assembleAoa keeps
   producing byte-identical output either way. */
function scanDenseRows(data,from,to,state){
  for(let r=from;r<to;r++){
    const cells=data[r];if(!cells)continue;
    let row=null;
    for(let c=0;c<cells.length;c++){
      const cell=cells[c];if(!cell||(cell.v==null&&cell.f==null&&cell.w==null))continue;
      if(row===null){row=state.rows.get(r);if(!row){row=new Map();state.rows.set(r,row);}}
      row.set(c,cell.w!=null?cell.w:XLSX.utils.format_cell(cell));if(c>state.maxCol)state.maxCol=c;
    }
  }
}
function assembleAoa(state){
  const rowNums=[...state.rows.keys()].sort((a,b)=>a-b);
  const width=state.maxCol+1,aoa=new Array(rowNums.length);
  for(let i=0;i<rowNums.length;i++){
    const cells=state.rows.get(rowNums[i]),row=new Array(width);
    for(let c=0;c<width;c++){const value=cells.get(c);row[c]=value===undefined?'':value;}
    aoa[i]=row;
  }
  return {aoa,rowNums};
}
export function sheetAoa(ws){
  if(!ws||!ws['!ref'])return {aoa:[],rowNums:[]};
  const state={rows:new Map(),maxCol:0};
  if(Array.isArray(ws)){scanDenseRows(ws,0,ws.length,state);return assembleAoa(state);}
  const addresses=Object.keys(ws);
  scanCells(ws,addresses,0,addresses.length,state);
  return assembleAoa(state);
}
export async function sheetAoaAsync(ws,onChunk){
  if(!ws||!ws['!ref'])return {aoa:[],rowNums:[]};
  const state={rows:new Map(),maxCol:0};
  if(Array.isArray(ws)){
    for(let i=0;i<ws.length;i+=AOA_DENSE_ROW_CHUNK){
      const end=Math.min(i+AOA_DENSE_ROW_CHUNK,ws.length);
      scanDenseRows(ws,i,end,state);
      if(onChunk&&end<ws.length)await onChunk(end,ws.length);
    }
    return assembleAoa(state);
  }
  const addresses=Object.keys(ws);
  for(let i=0;i<addresses.length;i+=AOA_CHUNK){
    const end=Math.min(i+AOA_CHUNK,addresses.length);
    scanCells(ws,addresses,i,end,state);
    if(onChunk&&end<addresses.length)await onChunk(end,addresses.length);
  }
  return assembleAoa(state);
}
function aoaRecord(key,parsed){
  const [fid,sheet]=key.split(KEYSEP),f=fileById(fid);
  const {aoa,rowNums}=parsed,headerRow=profileMappedHeaderRow(profileKindForKey(key,aoa),findHeaderRow(aoa));
  const rec={aoa,rowNums,headerRow,headers:aoa[headerRow]||[],ws:f.wb.Sheets[sheet],strikes:(f.strikes&&f.strikes.get(sheet))||new Set()};
  S.aoaCache.set(key,rec);return rec;
}
export function getAoa(key){
  if(S.aoaCache.has(key))return S.aoaCache.get(key);
  const [fid,sheet]=key.split(KEYSEP);
  return aoaRecord(key,sheetAoa(fileById(fid).wb.Sheets[sheet]));
}
/* Same result as getAoa, but yields mid-sheet. Used by prewarmSheets so every
   later getAoa call is a cache hit and can stay synchronous -- the alternative,
   making getAoa itself async, would ripple through every caller in the app. */
export async function getAoaAsync(key,onChunk){
  if(S.aoaCache.has(key))return S.aoaCache.get(key);
  const [fid,sheet]=key.split(KEYSEP);
  return aoaRecord(key,await sheetAoaAsync(fileById(fid).wb.Sheets[sheet],onChunk));
}
export function sheetRowCount(key){const {aoa,headerRow}=getAoa(key);return Math.max(0,aoa.length-headerRow-1);}
export function cellIsStruck(rec,row,col){const sourceRow=rec&&rec.rowNums?rec.rowNums[row]:row;return !!(rec&&sourceRow!=null&&col>=0&&rec.strikes&&rec.strikes.has(XLSX.utils.encode_cell({r:sourceRow,c:col})));}
export function rowTag(row,col,rec,rowIndex){
  return col>=0?cleanTag(row[col]):'';
}
export async function collectLoadDescriptionTags(keys,tick){
  const tags=new Set();
  for(const key of keys){
    const rec=getAoa(key),cols=resolveCols(key);
    for(let i=rec.headerRow+1;i<rec.aoa.length;i++){
      if(tick){const pending=tick('Indexing Load Descriptions');if(pending)await pending;}
      if(cols.loadDesc<0)continue;
      const load=rowTag(rec.aoa[i],cols.loadDesc,rec,i);if(load&&!isNote(load))tags.add(tagKey(load));
    }
  }
  return tags;
}
