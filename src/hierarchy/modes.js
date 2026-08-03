import { clean } from '../core/text.js'
import { makeExampleModes } from '../rules/defaults.js'

/* A mode is an ordered list of levels plus a root policy. `raw` preserves
   source occurrences such as one PMD instrument shown beneath both matched
   power variants; `projected` uses the canonical one-parent register model. */
export const MODE_EXECUTORS=['raw','projected'];
export const LEVEL_KINDS=['grouping','flow'];

export function groupingLevels(mode){return ((mode&&mode.levels)||[]).filter(level=>level&&level.kind==='grouping');}
export function hasFlowLevel(mode){return ((mode&&mode.levels)||[]).some(level=>level&&level.kind==='flow');}

/** Every problem with one mode, as readable strings. Empty means valid. */
export function validateMode(mode){
  if(!mode||typeof mode!=='object')return ['a mode must be an object'];
  const id=clean(mode.id)||'(unnamed)',errors=[];
  if(!clean(mode.id))errors.push('a mode needs an id');
  if(!MODE_EXECUTORS.includes(mode.executor))errors.push(`mode "${id}" has an unknown executor "${mode.executor}"`);
  const levels=Array.isArray(mode.levels)?mode.levels:[];
  if(!levels.length)errors.push(`mode "${id}" has no levels`);
  levels.forEach((level,index)=>{
    if(!level||typeof level!=='object'){errors.push(`mode "${id}" level ${index+1} is not an object`);return;}
    if(!LEVEL_KINDS.includes(level.kind)){errors.push(`mode "${id}" level ${index+1} has an unknown kind "${level.kind}"`);return;}
    if(level.kind==='grouping'&&!clean(level.attribute))errors.push(`mode "${id}" level ${index+1} is a grouping level with no attribute`);
  });
  /* At most one flow level and always last: a flow level expands to whatever
     depth the data has, so anything after it could never be reached. */
  const flowCount=levels.filter(level=>level&&level.kind==='flow').length;
  if(flowCount>1)errors.push(`mode "${id}" has ${flowCount} flow levels; at most one is allowed`);
  const flowAt=levels.findIndex(level=>level&&level.kind==='flow');
  if(flowAt>=0&&flowAt!==levels.length-1)errors.push(`mode "${id}" has a flow level that is not last`);
  return errors;
}

/** Valid modes in order, plus why anything was dropped. */
export function validateModes(list){
  const modes=[],errors=[];let rawSeen=false;
  for(const mode of Array.isArray(list)?list:[]){
    const problems=validateMode(mode);
    if(problems.length){errors.push(...problems);continue;}
    /* Root policy is applied once, to the one build-time tree both modes read,
       so a second raw mode's policy could never take effect. */
    if(mode.executor==='raw'){
      if(rawSeen){errors.push(`mode "${clean(mode.id)}" is a second raw mode; only one is supported`);continue;}
      rawSeen=true;
    }
    if(modes.some(kept=>clean(kept.id)===clean(mode.id))){errors.push(`mode "${clean(mode.id)}" is declared twice`);continue;}
    modes.push(mode);
  }
  return {modes,errors};
}

export function exampleModes(){return makeExampleModes();}

/* Fall back only when the profile declares no USABLE mode -- key absent, empty
   list, or every mode invalid. Unlike the rules fallback, an empty list is not
   honoured as a deliberate statement: zero modes would leave no way to view the
   hierarchy at all, and there is no useful reading of that. Nothing here infers
   intent from migration origin; that inference is what silently discarded
   authored rules before it was fixed. */
export function activeModes(profile){
  const declared=profile&&Array.isArray(profile.modes)?profile.modes:[];
  const {modes}=validateModes(declared);
  return modes.length?modes:exampleModes();
}

/** The named mode, or the first available one. Never returns undefined. */
export function modeById(profile,id){
  const modes=activeModes(profile),wanted=clean(id);
  return modes.find(mode=>clean(mode.id)===wanted)||modes[0];
}
