import { clean } from '../core/text.js'
import { S, tagKey } from '../state.js'
import { activeProfile } from '../profile/schema.js'
import { p6SheetTasks } from '../io/p6.js'
import { melUpnKey } from '../hierarchy/build.js'

/* ---- Milestone fallback ladder (spec §6a) ----
   Every record gets a milestone at every input maturity level:
     rung 1 — a P6 activity carries this equipment ID explicitly
     rung 2 — a P6 milestone carries this record's UPN in an explicit column
     rung 3 — the UPN is extracted from a milestone name by pattern
     rung 4 — no L2 found: the building-ready bucket (the SOP's own default)
   An immature or absent P6 just lands more records on lower rungs; the next
   recompile with a fuller schedule promotes them. */

export function collectP6(){
  const tasks=[];
  for(const file of S.files||[])if(file.p6)tasks.push(...file.p6.tasks);
  for(const key of S.p6Sel||[])tasks.push(...p6SheetTasks(key));
  return {tasks};
}

export function assignMilestones(records){
  const hierarchy=activeProfile().hierarchy||{},cfg=hierarchy.milestones||{};
  const buildingReady=clean(cfg.buildingReadyLabel)||'OP / Building Ready';
  const upnPattern=new RegExp(cfg.upnPattern||'\\bUPN\\s*[-#]?\\s*([A-Za-z0-9.-]+)','i');
  const {tasks}=collectP6();
  /* Milestone-flagged tasks claim a UPN first; unflagged activities only fill
     gaps, so a task row never shadows a real L2 milestone. */
  const byTag=new Map(),byUpn=new Map();
  const claimUpn=(upnValue,task,rung)=>{
    const key=melUpnKey(upnValue);if(!key||byUpn.has(key))return;
    byUpn.set(key,{task,rung});
  };
  const ordered=[...tasks].sort((a,b)=>(b.milestone?1:0)-(a.milestone?1:0));
  for(const task of ordered){
    if(task.equipmentId){const key=tagKey(task.equipmentId);if(key&&!byTag.has(key))byTag.set(key,task);}
    if(task.upn)claimUpn(task.upn,task,2);
    const match=(task.name||'').match(upnPattern);
    if(match)claimUpn(match[1],task,3);
  }
  for(const record of records.values()){
    const direct=byTag.get(record.key);
    if(direct){record.milestone={label:direct.name||direct.code,rung:1};continue;}
    const upnKey=record.mel?melUpnKey(record.mel.upn||''):'';
    const viaUpn=upnKey&&byUpn.get(upnKey);
    if(viaUpn){record.milestone={label:viaUpn.task.name||viaUpn.task.code,rung:viaUpn.rung};continue;}
    record.milestone={label:buildingReady,rung:4};
  }
}
