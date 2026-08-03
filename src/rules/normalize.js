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
  const inputKey=value.toLowerCase(),sourceKind=clean(context&&context.sourceKind)
  for (const rule of rules || []) {
    if (!isRuleEnabled(rule) || rule.kind !== 'stripSuffix') continue
    if (stage && rule.stage && rule.stage !== stage) continue
    if ((rule.excludeTags || []).some(excluded => clean(excluded).toLowerCase() === inputKey)) continue
    if (rule.sourceKind && rule.sourceKind !== sourceKind) continue
    const separators = Array.isArray(rule.separators) && rule.separators.length ? rule.separators : ['-']
    const suffixes = Array.isArray(rule.suffixes) ? rule.suffixes : []
    if (!suffixes.length) continue
    let stripped = stripOnce(value, separators, suffixes)
    if (stripped === null) continue
    value = stripped
    if (rule.repeat) {
      while ((stripped = stripOnce(value, separators, suffixes)) !== null) value = stripped
    }
  }
  return value
}
