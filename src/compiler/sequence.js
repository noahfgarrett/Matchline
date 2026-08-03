import { clean, natCmp } from '../core/text.js'
import { activeProfile } from '../profile/schema.js'
import { tagKey } from '../state.js'
import { melUpnKey } from '../hierarchy/build.js'

/* ---- Sequencing (spec §5 "Sequencing") ----
   Within a system block: topological order of the structural tree, direction
   set by discipline polarity — Electrical/LSS/Security commission top-down
   (parents before children: LVSS → transformer → panelboard), Mechanical/I&C
   bottom-up (children before parents: TETs before the MAH). Across systems:
   cross-partition dependencies collapse to UPN precedence edges and a Kahn
   topological sort gives the startup order; cycles are review items. */

export function disciplinePolarity(discipline,profile){
  const hierarchy=(profile||activeProfile()).hierarchy||{},map=hierarchy.polarity||{};
  const configured=map[discipline]||map[clean(discipline)];
  if(configured==='top-down'||configured==='bottom-up')return configured;
  return /elec|lss|security|fire/i.test(discipline||'')?'top-down':'bottom-up';
}

function groupKeyOf(record){return [record.building||'',record.discipline||'',record.system||''].join('');}

export function computeSequence(records,profile){
  const groups=new Map();
  for(const record of records.values()){
    if(!record.includeInRegister)continue;
    const key=groupKeyOf(record);
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push(record);
  }
  for(const members of groups.values()){
    const byKey=new Map(members.map(record=>[record.key,record]));
    const children=new Map(members.map(record=>[record.key,[]]));
    const roots=[];
    for(const record of members){
      const parent=byKey.get(tagKey(record.ssmParentTag));
      if(parent)children.get(parent.key).push(record);
      else roots.push(record);
    }
    const sortRecords=list=>list.sort((a,b)=>natCmp(a.tag,b.tag));
    sortRecords(roots);for(const list of children.values())sortRecords(list);
    const polarity=disciplinePolarity(members[0].discipline,profile);
    let index=0;
    const walk=record=>{
      if(polarity==='top-down')record.sequence=++index;
      for(const child of children.get(record.key))walk(child);
      if(polarity!=='top-down')record.sequence=++index;
    };
    roots.forEach(walk);
  }
}

export function upnPrecedence(records){
  const edges=new Map(),nodes=new Set();
  for(const record of records.values()){
    const upn=record.mel?melUpnKey(record.mel.upn||''):'';
    if(!upn)continue;
    nodes.add(upn);
    for(const dependency of record.dependencies){
      const target=records.get(tagKey(dependency));
      const depUpn=target&&target.mel?melUpnKey(target.mel.upn||''):'';
      if(!depUpn||depUpn===upn)continue;
      nodes.add(depUpn);
      const edgeKey=depUpn+''+upn;
      if(!edges.has(edgeKey))edges.set(edgeKey,{from:depUpn,to:upn,via:[]});
      edges.get(edgeKey).via.push(`${clean(dependency)} → ${record.tag}`);
    }
  }
  /* Kahn's algorithm; whatever cannot be scheduled is cyclic and goes to review. */
  const inDegree=new Map([...nodes].map(node=>[node,0])),outbound=new Map([...nodes].map(node=>[node,[]]));
  for(const {from,to} of edges.values()){inDegree.set(to,inDegree.get(to)+1);outbound.get(from).push(to);}
  const queue=[...nodes].filter(node=>!inDegree.get(node)).sort(natCmp),order=[];
  while(queue.length){
    const node=queue.shift();order.push(node);
    for(const next of outbound.get(node)){
      inDegree.set(next,inDegree.get(next)-1);
      if(!inDegree.get(next)){queue.push(next);queue.sort(natCmp);}
    }
  }
  const cycles=[...nodes].filter(node=>!order.includes(node)).sort(natCmp);
  return {edges:[...edges.values()],order,cycles};
}
