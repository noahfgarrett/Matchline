import { clean, natCmp } from '../core/text.js'
import { cleanTag, normSep, simPct } from '../core/tags.js'
import { S, tagKey } from '../state.js'
import { profileAssignment, profileEquipmentRole } from './schema.js'
import { ruleEngine } from '../rules/provider.js'

/* ---- tag classifiers ---- */
export const tagTokens=n=>String(n).toUpperCase().split(/[^A-Z]+/).filter(Boolean);
export const isGisTag=n=>profileEquipmentRole(n)==='GIS'||profileAssignment(n,'gisMarker',null,'easyPower')==='yes';
export const isBusTag=n=>profileAssignment(n,'busMarker',null,'easyPower')==='yes';
export const isSpareName=n=>ruleEngine().resolve(clean(n)).attributes.placeholder==='spare';
export const isSpaceName=n=>ruleEngine().resolve(clean(n)).attributes.placeholder==='space';
export const isNote=v=>ruleEngine().resolve(clean(v)).attributes.placeholder==='note';
/* Load Description becomes the lowest leaf; disregard blanks, NOTEs, and values
   identical to the node it would nest under (its ID Name / Final Source). */
export function validLoad(loadDesc,deepest){const ld=cleanTag(loadDesc);return !!ld&&!isNote(ld)&&tagKey(ld)!==tagKey(deepest);}
export function bestFuzzy(name,pool,min){const t=min==null?85:min;let best=null,bp=-1;const ns=normSep(name);for(const c of pool){if(Math.abs(normSep(c).length-ns.length)>4)continue;const p=simPct(name,c);if(p>=t&&p>bp){bp=p;best=c;}}return best?{match:best,pct:bp}:null;}
/* top-N closest names (deduped, ranked best-first) for the Review possible-match column */
export function topFuzzy(name,pool,n,min){
  const t=min==null?70:min,ns=normSep(name),seen=new Set(),out=[];
  for(const c of pool){
    if(Math.abs(normSep(c).length-ns.length)>4)continue;
    const k=c.toLowerCase();if(seen.has(k))continue;
    const p=simPct(name,c);if(p>=t){seen.add(k);out.push({match:c,pct:p});}
  }
  out.sort((a,b)=>b.pct-a.pct||natCmp(a.match,b.match));
  return out.slice(0,n||3);
}
/* Drop "…GIS → BUS → GIS…": disregard the BUS and everything above it, re-rooting
   at the GIS that follows the BUS (repeated for nested occurrences). */
export function gisBusCut(segs){
  let s=segs,changed=true;
  while(changed){changed=false;
    for(let i=1;i<s.length-1;i++){
      if(isBusTag(s[i])&&isGisTag(s[i-1])&&isGisTag(s[i+1])){s=s.slice(i+1);changed=true;break;}
    }
  }
  return s;
}
export function treeSig(n){return n.name+'\u0002'+n.children.map(treeSig).join('\u0003')+'\u0004';}
export function dedupRoots(roots){const seen=new Set(),out=[];for(const r of roots){const s=treeSig(r);if(!seen.has(s)){seen.add(s);out.push(r);}}return out;}
export function nodeHidden(n){return (n.isSpare&&!S.showSpares)||(n.isSpace&&!S.showSpaces);}
export function kidsOf(n){return n.children.filter(c=>!nodeHidden(c));}
export function depOf(name){return S.deps.get(cleanTag(name).toLowerCase())||'';}
/* Load descriptions keep their source-row ID Name/Final Source relationship;
   everything else uses the cable schedule. */
export function nodeDep(n){return n.dependencyOverride||(n.isLoad?n.loadDependency:depOf(n.name));}
