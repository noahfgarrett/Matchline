import { clean } from '../core/text.js'
import { selectAnatomy, segmentTag, canonicalFromAnatomy } from './anatomy.js'
import { applyNormalize } from './normalize.js'
import { applyClassifyDetailed } from './classify.js'
import { applyRelate } from './relate.js'
import { isRuleEnabled } from './schema.js'

/**
 * A profile-bound evaluator. Results are memoized per raw tag because the
 * hot paths (tree rendering, placement candidate search) resolve the same
 * tags repeatedly.
 */
export function createEngine(profile) {
  const anatomies = (profile && profile.anatomies) || []
  const rules = (profile && profile.rules) || { normalize: [], classify: [], relate: [] }
  const cache = new Map()
  let hits = 0, misses = 0

  function resolve(tag, context) {
    const raw = clean(tag)
    const sourceKind = clean(context && context.sourceKind)
    const cacheKey = raw + '\u001f' + sourceKind
    if (cache.has(cacheKey)) { hits++; return cache.get(cacheKey) }
    misses++
    const anatomy = selectAnatomy(raw, anatomies)
    const segments = anatomy ? segmentTag(raw, anatomy) : {}
    const trimmed = anatomy ? canonicalFromAnatomy(raw, anatomy) : raw
    const identity = applyNormalize(trimmed, rules.normalize, 'identity', {sourceKind})
    const canonical = applyNormalize(identity, rules.normalize, 'matching', {sourceKind})
    const classified = applyClassifyDetailed(raw, canonical, rules.classify, segments, { sourceKind })
    const attributes = classified.attributes
    const result = Object.freeze({
      raw, identity, canonical, segments, attributes, classificationRules:classified.matches,
      anatomyId: anatomy ? anatomy.id : '',
      unmatched: !anatomy,
    })
    cache.set(cacheKey, result)
    return result
  }

  /**
   * Apply only the Normalize rules belonging to `stage`, bypassing the
   * `resolve()` memo entirely — no caching here, by design. `resolve()`'s
   * cache is keyed on the raw tag alone; reusing it for a stage-scoped
   * call would either return another stage's answer for the same tag
   * (wrong) or require a second, stage-aware key space (cleanTag and
   * stripPowerVariant are simple, cheap regex passes over a handful of
   * rules — not the anatomy/classify work resolve() does — so paying for
   * a cache here buys nothing and adds a place for the two stages to get
   * crossed).
   */
  function normalizeOnly(tag, stage) {
    return applyNormalize(tag, rules.normalize, stage)
  }

  function relate(tag, currentParent, context) {
    const self = resolve(tag, context)
    const parent = resolve(currentParent, context)
    const suppliedAttributes = context && context.attributes || {}
    const suppliedParentAttributes = context && context.parentAttributes || {}
    return applyRelate(self.canonical, parent.canonical, rules.relate, {
      ...(context || {}),
      attributes: { ...self.attributes, ...suppliedAttributes },
      parentAttributes: { ...parent.attributes, ...suppliedParentAttributes },
      segments: self.segments,
      rawTag: self.raw,
      rawParentTag: clean(currentParent),
      currentTag: self.canonical,
      // This engine's own identity-stage normalizer. Rules that need to
      // re-normalise a fragment must use it rather than the global cleanTag,
      // or an engine built for a draft profile silently answers using whatever
      // profile happens to be active in the app.
      normalizeIdentity: value => resolve(clean(value), context).identity,
    })
  }

  /* Literal text a Relate rule appends to a composed parent, e.g. the ' - CIM'
     in "<Building> - CIM". Tag normalization collapses ' - ' to '-', which would
     rewrite a parent the profile deliberately spelled with spaces, so
     cleanRegisterTag (src/core/tags.js) preserves these verbatim. Derived from
     the profile rather than hardcoded, so a site whose rule composes
     "<Building> - RACK" is protected without touching any code. Only a TRAILING
     literal counts -- it is the suffix -- and only one containing whitespace,
     since that is the only kind normalization would alter. */
  const registerLiteralSuffixes = () => {
    const found = []
    for (const rule of rules.relate || []) {
      // A disabled rule composes nothing, so its literal must not shape how
      // tags are cleaned either -- otherwise turning the rule off still
      // changes register output.
      if (!isRuleEnabled(rule)) continue
      if (!Array.isArray(rule.parent) || !rule.parent.length) continue
      const last = rule.parent[rule.parent.length - 1]
      if (!last || last.kind !== 'literal') continue
      const text = String(last.text || '')
      if (!/\s/.test(text) || found.includes(text)) continue
      found.push(text)
    }
    return found
  }

  return {
    resolve,
    relate,
    normalizeOnly,
    registerLiteralSuffixes,
    stats: () => ({ hits, misses, size: cache.size }),
    clear: () => { cache.clear(); hits = 0; misses = 0 },
  }
}
