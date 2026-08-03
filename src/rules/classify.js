import { clean } from '../core/text.js'
import { isRuleEnabled } from './schema.js'

// Named distinctly from anatomy.js's patternCache/compile: the build
// concatenates every module into one shared top-level scope (see
// build/build.mjs), so identical top-level const/function names across
// modules collide.
const classifyPatternCache = new Map()
function compileClassifyPattern(pattern) {
  const source = clean(pattern)
  if (!source) return null
  if (classifyPatternCache.has(source)) return classifyPatternCache.get(source)
  let re = null
  try { re = new RegExp(source, 'i') } catch (_) { re = null }
  classifyPatternCache.set(source, re)
  return re
}

function ruleValue(rule, tag, segments) {
  if (rule.kind === 'pattern') {
    const re = compileClassifyPattern(rule.pattern)
    return re && re.test(tag) ? clean(rule.value) : ''
  }
  if (rule.kind === 'segment') {
    const sample=rule.segment?clean(segments[rule.segment]):clean(String(tag).split('-')[Math.max(0,Number(rule.segmentIndex)||0)])
    if(rule.expected&&sample.toLowerCase()!==clean(rule.expected).toLowerCase())return ''
    return clean(rule.value)||sample
  }
  if (rule.kind === 'slice') {
    if (Number.isInteger(rule.minLength) && tag.length < rule.minLength) return ''
    const start = Number.isInteger(rule.start) ? rule.start : 0
    const end = Number.isInteger(rule.end) ? rule.end : undefined
    // Not run through clean(): clean() trims, and trimming a sliced
    // substring can silently drop a leading/trailing space that was part
    // of the original text (e.g. the last four characters of a tag
    // containing an internal space). The hardcoded functions this rule
    // family reproduces (e.g. equipmentSuffix) never trim after slicing.
    const sliced = tag.slice(start, end)
    if(rule.expected&&sliced.toLowerCase()!==clean(rule.expected).toLowerCase())return ''
    const resolved=clean(rule.value)||sliced
    return rule.lowercase ? resolved.toLowerCase() : resolved
  }
  return ''
}

/**
 * Produce attributes from a tag. First match wins per target; a later rule
 * cannot override an earlier one. Unmatched targets are absent, not empty.
 *
 * Most rules read the canonical (post-Normalize) tag, but a rule can set
 * `source: 'raw'` to read the tag as originally passed to the engine,
 * before anatomy segment-dropping or Normalize stripping. This matters for
 * conventions like isSpareName/isSpaceName/isNote that the hardcoded code
 * runs on the untouched value — normalizing first can change the verdict
 * (e.g. 'NOTE-A' is not a note, but stripping '-A' first would make it
 * look like one).
 */
export function applyClassifyDetailed(rawTag, canonicalTag, rules, segments, context) {
  const raw = clean(rawTag)
  const canonical = clean(canonicalTag)
  const out = {}
  const matches=[]
  if (!raw && !canonical) return {attributes:out,matches}
  const seg = segments || {}
  for (const rule of rules || []) {
    if (!isRuleEnabled(rule) || !rule.target || out[rule.target] !== undefined) continue
    if (rule.sourceKind && rule.sourceKind !== clean(context && context.sourceKind)) continue
    const tag = rule.source === 'raw' ? raw : canonical
    if((rule.excludeTags||[]).some(value=>clean(value).toLowerCase()===tag.toLowerCase()))continue
    const resolved = ruleValue(rule, tag, seg)
    if (resolved){out[rule.target] = resolved;matches.push({id:rule.id,name:rule.name,target:rule.target,value:resolved})}
  }
  return {attributes:out,matches}
}

export function applyClassify(rawTag, canonicalTag, rules, segments, context) {
  return applyClassifyDetailed(rawTag,canonicalTag,rules,segments,context).attributes
}
