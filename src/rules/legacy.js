import { clean } from '../core/text.js'

const escapeLegacyPattern=value=>String(value||'').replace(/[.*+?^${}()|[\]\\]/g,'\\$&')

function compiledId(rule){return 'trained-'+clean(rule&&rule.id)}

function legacyClassifyRule(rule){
  const needle=clean(rule.needle),value=clean(rule.value)||needle;
  const base={id:compiledId(rule),name:clean(rule.name)||'Trained rule',target:clean(rule.target)||'equipmentType',
    value,sourceKind:clean(rule.sourceKind),enabled:rule.enabled!==false,legacyTagRuleId:clean(rule.id),
    excludeTags:Array.isArray(rule.exclusions)?rule.exclusions.map(clean).filter(Boolean):[]};
  if(rule.mode==='prefix')return {...base,kind:'pattern',pattern:'^'+escapeLegacyPattern(needle)};
  if(rule.mode==='suffix')return {...base,kind:'pattern',pattern:escapeLegacyPattern(needle)+'$'};
  if(rule.mode==='slice')return {...base,kind:'slice',start:Number(rule.start)||0,end:Number(rule.end)||undefined,
    expected:rule.strict===false?'':needle};
  if(rule.mode==='segment')return {...base,kind:'segment',segmentIndex:Math.max(0,Number(rule.segmentIndex)||0),
    expected:rule.strict===false?'':needle};
  return {...base,kind:'pattern',pattern:escapeLegacyPattern(needle)};
}

function legacyNormalizeRule(rule){
  const needle=clean(rule.needle),separator=/^[^A-Za-z0-9]/.test(needle)?needle[0]:'-',suffix=separator===needle[0]?needle.slice(1):needle;
  return {id:compiledId(rule),name:clean(rule.name)||'Trained suffix rule',kind:'stripSuffix',stage:'identity',
    separators:[separator],suffixes:[suffix],repeat:true,enabled:rule.enabled!==false,legacyTagRuleId:clean(rule.id),
    excludeTags:Array.isArray(rule.exclusions)?rule.exclusions.map(clean).filter(Boolean):[],
    sourceKind:clean(rule.sourceKind)};
}

/**
 * Tag Trainer remains a friendly authoring surface, but it is no longer a
 * second runtime. Its compact UI records are compiled into the same ordered
 * Normalize/Classify arrays that the production engine executes.
 */
export function materializeTrainedRules(profile){
  if(!profile||typeof profile!=='object')return profile;
  const existing=profile.rules&&typeof profile.rules==='object'?profile.rules:{};
  const normalize=(Array.isArray(existing.normalize)?existing.normalize:[]).filter(rule=>!rule.legacyTagRuleId);
  const classify=(Array.isArray(existing.classify)?existing.classify:[]).filter(rule=>!rule.legacyTagRuleId);
  const relate=Array.isArray(existing.relate)?existing.relate:[];
  const trainedNormalize=[],trainedClassify=[];
  for(const rule of Array.isArray(profile.tagRules)?profile.tagRules:[]){
    if(!rule||!clean(rule.id)||!clean(rule.needle))continue;
    if(rule.target==='ignoreSuffix')trainedNormalize.push(legacyNormalizeRule(rule));
    else trainedClassify.push(legacyClassifyRule(rule));
  }
  profile.rules={normalize:[...trainedNormalize,...normalize],classify:[...trainedClassify,...classify],relate};
  return profile;
}
