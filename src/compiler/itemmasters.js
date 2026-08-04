import { clean } from '../core/text.js'
import { S } from '../state.js'
import { extoRegistryRows, itemMasterNames } from '../io/exto.js'

/* ---- Item-master auto-assignment (optional EXTO layer) ----
   Learned from a prior registry export as a majority-vote table with two key
   rungs, confidence-gated: validated on a real 18k-row registry this
   auto-assigns ~81% of rows at ~99% accuracy and sends the rest to review.

     rung A — (discipline, equipment classification, UPN)
     rung B — (discipline, UPN, first word of the equipment description)

   Legacy site-specific names normalize to the universal VF vocabulary when a
   suffix match exists (CA_NB_EL_MV_GEAR → VF_EL_MV_GEAR). Suspect registry
   rows (placeholders; electrical-gear masters on non-electrical equipment)
   are excluded from learning and reported as an audit list. */

export function normalizeItemMasterName(name,vfVocabulary){
  const value=clean(name);
  if(!value||/^VF_/i.test(value))return value;
  const match=value.match(/^CA_[A-Z0-9]+_(.+)$/i);
  if(!match)return value;
  const candidate='VF_'+match[1];
  if(!vfVocabulary||!vfVocabulary.size)return value;
  for(const known of vfVocabulary)if(known.toLowerCase()===candidate.toLowerCase())return known;
  return value;
}

export function suspectRegistryRow(row){
  const im=clean(row.itemMaster),discipline=clean(row.discipline).toUpperCase();
  if(!im)return 'blank item master';
  if(/blank/i.test(im))return 'placeholder item master';
  if(/GEAR|XFMR|SWGR/i.test(im)&&!discipline.includes('ELECTRICAL'))return 'electrical-gear item master on non-electrical equipment';
  return '';
}

const IM_KEYSEP='';
function firstWord(value){return clean(value).split(/\s+/)[0]||'';}
function normPart(value){return clean(value).toLowerCase();}

export function learnItemMasterTable(){
  const vocabulary=new Set();
  for(const key of S.imSel||[])for(const entry of itemMasterNames(key))vocabulary.add(entry.name);
  const byClass=new Map(),byDesc=new Map(),audit=[];
  const tally=(map,key,name)=>{
    if(!map.has(key))map.set(key,new Map());
    const counts=map.get(key);counts.set(name,(counts.get(name)||0)+1);
  };
  for(const key of S.extoSel||[])for(const row of extoRegistryRows(key)){
    const reason=suspectRegistryRow(row);
    if(reason){audit.push({equipmentId:row.equipmentId,itemMaster:row.itemMaster,discipline:row.discipline,reason});continue;}
    const name=normalizeItemMasterName(row.itemMaster,vocabulary);
    if(row.classification)tally(byClass,[normPart(row.discipline),normPart(row.classification),normPart(row.upn)].join(IM_KEYSEP),name);
    if(row.description)tally(byDesc,[normPart(row.discipline),normPart(row.upn),normPart(firstWord(row.description))].join(IM_KEYSEP),name);
  }
  return {byClass,byDesc,vocabulary,audit,learned:byClass.size+byDesc.size>0};
}

function lookup(map,key,minConfidence){
  const counts=map.get(key);if(!counts)return null;
  let total=0,top='',topCount=0;
  for(const [name,count] of counts){total+=count;if(count>topCount){top=name;topCount=count;}}
  const confidence=total?topCount/total:0;
  if(confidence<minConfidence)return {review:[...counts.keys()].slice(0,3)};
  return {name:top,confidence};
}

export function assignItemMasters(records,table,minConfidence=0.9){
  if(!table||!table.learned)return;
  for(const record of records.values()){
    if(!record.includeInRegister||record.isSyntheticRollup)continue;
    const upn=record.mel?normPart(record.mel.upn):'';
    const discipline=normPart(record.discipline);
    const classification=normPart(record.attributes&&record.attributes.equipmentClassification||'');
    const candidates=[];
    if(classification&&upn)candidates.push(lookup(table.byClass,[discipline,classification,upn].join(IM_KEYSEP),minConfidence));
    if(record.description&&upn)candidates.push(lookup(table.byDesc,[discipline,upn,normPart(firstWord(record.description))].join(IM_KEYSEP),minConfidence));
    const hit=candidates.find(candidate=>candidate&&candidate.name);
    if(hit){record.itemMaster={name:hit.name,confidence:hit.confidence};continue;}
    const review=candidates.find(candidate=>candidate&&candidate.review);
    if(review)record.itemMasterReview=review.review;
  }
}
