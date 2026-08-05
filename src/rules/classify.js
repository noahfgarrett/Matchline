import { clean } from '../core/text.js'
import { isRuleEnabled } from './schema.js'

// Named distinctly from anatomy.js's patternCache/compile: the build
// concatenates every module into one shared top-level scope (see
// build/build.mjs), so identical top-level const/function names across
// modules collide.
const classifyPatternCache = new Map()
function compileClassifyPattern(pattern) {
  /* Keyed by the pattern as given: cleaning before the cache lookup put a
     String()+trim on every single rule evaluation. Distinct patterns are
     bounded by the profile's rule set, so raw keys cost nothing. */
  if (classifyPatternCache.has(pattern)) return classifyPatternCache.get(pattern)
  const source = clean(pattern)
  let re = null
  if (source) { try { re = new RegExp(source, 'i') } catch (_) { re = null } }
  classifyPatternCache.set(pattern, re)
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
/* Per-rules-array compilation of the excludeTags lists: applyClassifyDetailed
   runs once per resolve() miss, and lowercasing every exclude entry (and the
   tag itself, once per entry) on every call dominated the rule checks at
   scale. `enabled`, `target`, and `sourceKind` stay per-call, as before. */
const classifyMetaCache = new WeakMap()
function classifyMeta(rules) {
  let meta = classifyMetaCache.get(rules)
  if (meta) return meta
  meta = rules.map(rule => ({ rule, exclude: new Set((rule.excludeTags || []).map(value => clean(value).toLowerCase())) }))
  classifyMetaCache.set(rules, meta)
  return meta
}

export function applyClassifyDetailed(rawTag, canonicalTag, rules, segments, context) {
  const raw = clean(rawTag)
  const canonical = clean(canonicalTag)
  const out = {}
  const matches=[]
  if (!raw && !canonical) return {attributes:out,matches}
  const seg = segments || {}
  let rawLower = null, canonicalLower = null, contextKind = null
  for (const entry of classifyMeta(rules || [])) {
    const rule = entry.rule
    if (!isRuleEnabled(rule) || !rule.target || out[rule.target] !== undefined) continue
    if (rule.sourceKind) {
      if (contextKind === null) contextKind = clean(context && context.sourceKind)
      if (rule.sourceKind !== contextKind) continue
    }
    const useRaw = rule.source === 'raw'
    const tag = useRaw ? raw : canonical
    if (entry.exclude.size) {
      const lower = useRaw
        ? (rawLower === null ? (rawLower = raw.toLowerCase()) : rawLower)
        : (canonicalLower === null ? (canonicalLower = canonical.toLowerCase()) : canonicalLower)
      if (entry.exclude.has(lower)) continue
    }
    const resolved = ruleValue(rule, tag, seg)
    if (resolved){out[rule.target] = resolved;matches.push({id:rule.id,name:rule.name,target:rule.target,value:resolved})}
  }
  return {attributes:out,matches}
}

export function applyClassify(rawTag, canonicalTag, rules, segments, context) {
  return applyClassifyDetailed(rawTag,canonicalTag,rules,segments,context).attributes
}
