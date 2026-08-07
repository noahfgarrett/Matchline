import { clean } from '../core/text.js'
import { isRuleEnabled } from './schema.js'

function stripOnce(tag, separators, suffixes) {
  const upper = tag.toUpperCase()
  for (const separator of separators) {
    for (const suffix of suffixes) {
      const ending = (separator + suffix).toUpperCase()
      if (upper.length > ending.length && upper.endsWith(ending)) {
        return tag.slice(0, tag.length - ending.length)
      }
    }
  }
  return null
}

/* Per-rules-array compilation of the stripSuffix structure. applyNormalize
   runs twice per resolve() miss and the separator×suffix endings never change
   for a given rules array, so building the uppercase ending list (in the same
   separator-major order stripOnce scans) once beats re-concatenating and
   re-uppercasing every combination on every call. `enabled`, `stage`, and
   `sourceKind` stay per-call checks — toggling a rule keeps taking effect
   immediately, exactly as before. */
const compiledStripCache = new WeakMap()
function compiledStripRules(rules) {
  let compiled = compiledStripCache.get(rules)
  if (compiled) return compiled
  compiled = []
  for (const rule of rules) {
    if (rule.kind !== 'stripSuffix') continue
    const separators = Array.isArray(rule.separators) && rule.separators.length ? rule.separators : ['-']
    const suffixes = Array.isArray(rule.suffixes) ? rule.suffixes : []
    const endings = []
    for (const separator of separators) for (const suffix of suffixes) endings.push((separator + suffix).toUpperCase())
    compiled.push({ rule, endings, exclude: new Set((rule.excludeTags || []).map(excluded => clean(excluded).toLowerCase())) })
  }
  compiledStripCache.set(rules, compiled)
  return compiled
}
function stripOnceCompiled(tag, endings) {
  const upper = tag.toUpperCase()
  for (const ending of endings) {
    if (upper.length > ending.length && upper.endsWith(ending)) {
      return tag.slice(0, tag.length - ending.length)
    }
  }
  return null
}

/**
 * Apply every matching Normalize rule, in profile order.
 * Never reduces a tag to the empty string — an empty canonical tag
 * would silently merge unrelated equipment.
 *
 * `stage`, when given, restricts application to rules whose own `stage`
 * matches. A rule with no `stage` belongs to every stage, so existing
 * profiles (authored before staging existed) keep working unchanged.
 * Omitting `stage` entirely (the falsy default) applies every rule
 * regardless of its stage — this is `resolve()`'s behavior, proven by
 * the equivalence harness to equal `stripPowerVariant`.
 */
export function applyNormalize(tag, rules, stage, context) {
  let value = clean(tag)
  if (!value) return ''
  const compiled = compiledStripRules(rules || [])
  if (!compiled.length) return value
  const original = value // excludeTags always compare against the input as given, not a part-stripped value
  let inputKey = null
  let sourceKind = null
  for (const entry of compiled) {
    const rule = entry.rule
    if (!isRuleEnabled(rule)) continue
    if (stage && rule.stage && rule.stage !== stage) continue
    if (entry.exclude.size) {
      if (inputKey === null) inputKey = original.toLowerCase()
      if (entry.exclude.has(inputKey)) continue
    }
    if (rule.sourceKind) {
      if (sourceKind === null) sourceKind = clean(context && context.sourceKind)
      if (rule.sourceKind !== sourceKind) continue
    }
    if (!entry.endings.length) continue
    let stripped = stripOnceCompiled(value, entry.endings)
    if (stripped === null) continue
    value = stripped
    if (rule.repeat) {
      while ((stripped = stripOnceCompiled(value, entry.endings)) !== null) value = stripped
    }
  }
  return value
}
