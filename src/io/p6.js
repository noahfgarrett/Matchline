import { clean } from '../core/text.js'
import { getAoa } from './workbook.js'
import { scanMappedHeader } from './detect.js'

/* ---- P6 schedule ingestion (spec §3 input 5) ----
   Strictly optional: nothing downstream may require P6 data. XER is P6's
   native plain-text export — %T names a table, %F lists its fields, %R is a
   row. Only TASK and TASKPRED matter here. */
export function parseXer(text){
  const tasks=[],links=[];
  let table='',fields=[];
  for(const line of String(text||'').split(/\r?\n/)){
    const cells=line.split('\t'),marker=cells[0];
    if(marker==='%T'){table=clean(cells[1]).toUpperCase();fields=[];continue;}
    if(marker==='%F'){fields=cells.slice(1).map(f=>clean(f).toLowerCase());continue;}
    if(marker!=='%R')continue;
    const row={};fields.forEach((field,i)=>{row[field]=clean(cells[i+1]);});
    if(table==='TASK'){
      tasks.push({id:row.task_id||'',code:row.task_code||'',name:row.task_name||'',
        milestone:/^TT_(Mile|FinMile)$/i.test(row.task_type||'')});
    }else if(table==='TASKPRED'){
      links.push({taskId:row.task_id||'',predTaskId:row.pred_task_id||''});
    }
  }
  return {tasks,links};
}
function p6NormHeader(value){return clean(value).toLowerCase().replace(/[^a-z0-9]+/g,'');}
export function detectP6(headers){
  const norm=headers.map(p6NormHeader);
  const activityId=norm.findIndex(h=>h==='activityid');
  const activityName=norm.findIndex(h=>h==='activityname');
  if(activityId<0||activityName<0)return null;
  const equipmentId=norm.findIndex(h=>h==='equipmentid'||h==='equipmenttag');
  const upn=norm.findIndex(h=>h==='upn'||h.startsWith('upn'));
  return {activityId,activityName,equipmentId,upn};
}
export const _p6Cache=new Map();
export function p6Info(key){
  if(_p6Cache.has(key))return _p6Cache.get(key);
  const {aoa}=getAoa(key),res=scanMappedHeader(aoa,detectP6,30);
  _p6Cache.set(key,res);return res;
}
export function isP6Sheet(key){return !!p6Info(key);}
/* Rows from one selected P6 XLSX sheet, in parseXer's task shape. An activity
   sheet has no task_type column, so milestone detection falls to the name
   pattern in the ladder; an explicit equipment/UPN column rides along. */
export function p6SheetTasks(key){
  const info=p6Info(key);if(!info)return [];
  const {map,headerRow}=info,{aoa}=getAoa(key),tasks=[];
  for(let i=headerRow+1;i<aoa.length;i++){
    const row=aoa[i]||[],code=clean(row[map.activityId]),name=clean(row[map.activityName]);
    if(!code&&!name)continue;
    tasks.push({id:code,code,name,milestone:false,
      equipmentId:map.equipmentId>=0?clean(row[map.equipmentId]):'',
      upn:map.upn>=0?clean(row[map.upn]):''});
  }
  return tasks;
}
