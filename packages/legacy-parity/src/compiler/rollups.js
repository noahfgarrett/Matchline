import { clean } from '../core/text.js'
import { S } from '../state.js'
import { melUpnKey } from '../hierarchy/build.js'
import { lineListRows } from '../io/linelist.js'

/* ---- Piping roll-ups (spec §5.9) ----
   Line-list segments collapse to one synthetic register row per UPN. Partition
   attributes come from the majority of that UPN's MEL members, so the roll-up
   lands inside the system block it serves. Synthetic rows are excluded from
   tag-vs-MEL validation. */

function majority(values){
  const counts=new Map();
  for(const value of values){const v=clean(value);if(!v)continue;counts.set(v,(counts.get(v)||0)+1);}
  let best='';for(const [value,count] of counts)if(!best||count>counts.get(best))best=value;
  return best;
}

export function synthesizeLineRollups(records,ensure){
  const byUpn=new Map();
  for(const key of S.lineSel||[])for(const row of lineListRows(key)){
    const upnKey=melUpnKey(row.upn);if(!upnKey)continue;
    if(!byUpn.has(upnKey))byUpn.set(upnKey,{upn:clean(row.upn),lines:[]});
    byUpn.get(upnKey).lines.push(row.lineId);
  }
  for(const {upn,lines} of byUpn.values()){
    const record=ensure(`UPN ${upn} Distribution Piping`,{observed:true});
    if(!record)continue;
    record.isSyntheticRollup=true;record.includeInRegister=true;record.includeInHierarchy=true;
    record.description=`${lines.length} line segment${lines.length===1?'':'s'}: ${lines.join(', ')}`;
    const members=(S.melRows||[]).filter(row=>melUpnKey(row.upn)===melUpnKey(upn));
    record._rollupAttrs={
      building:majority(members.map(row=>row.building)),
      discipline:majority(members.map(row=>row.discipline)),
      systemDescription:majority(members.map(row=>row.systemDescription)),
      upn,
    };
  }
}

/* Applied after resolveRecordContext, which only knows MEL/rule sources —
   roll-ups override the fallback attributes with the UPN-majority partition
   and mark them explicit so grouping and the fold treat them as proven. */
export function finalizeLineRollups(records){
  for(const record of records.values()){
    if(!record.isSyntheticRollup||!record._rollupAttrs||!record.context)continue;
    const attrs=record._rollupAttrs;
    const system=attrs.upn&&attrs.systemDescription?`${attrs.upn} ${attrs.systemDescription}`:(attrs.systemDescription||record.system);
    if(attrs.building){record.building=attrs.building;record.attributes.building=attrs.building;record.context.explicit.building=true;}
    if(attrs.discipline){record.discipline=attrs.discipline;record.attributes.discipline=attrs.discipline;record.context.explicit.discipline=true;}
    if(system){record.system=system;record.attributes.system=system;record.context.explicit.system=true;}
  }
}
