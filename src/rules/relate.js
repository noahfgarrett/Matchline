import { clean } from '../core/text.js'
import { cleanTag } from '../core/tags.js'
import { isRuleEnabled } from './schema.js'

const NONE = Object.freeze({ status: 'none', parent: '', dependencies: [], candidates: [], reason: '', ruleId: '' })

function decision(status, fields) {
  return { status, parent: '', dependencies: [], candidates: [], reason: '', ruleId: '', ...fields }
}

/** Every entry in `expected` must equal the corresponding value in `actual`, case-insensitively. */
function guardPasses(expected, actual) {
  const entries = Object.entries(expected || {})
  if (!entries.length) return true
  const own = actual || {}
  return entries.every(([key, value]) => clean(own[key]).toLowerCase() === clean(value).toLowerCase())
}

/** Resolve `@name` references in a match spec against the record's own attributes. */
function resolveMatchSpec(spec, attributes) {
  const out = {}
  for (const [key, value] of Object.entries(spec || {})) {
    const text = clean(value)
    out[key] = text.startsWith('@') ? clean((attributes || {})[text.slice(1)]) : text
  }
  return out
}

/**
 * True when a match spec references an own-attribute (`@name`) that is
 * empty or absent. A LookupSource treats a missing criterion as "don't
 * care" (see createMemoryLookup.findAll), which is wrong here: an
 * attributeMatch rule keyed on, say, `@matchKey` must not fire at all when
 * this record has no matchKey, or it would match every record regardless
 * of the attribute it was supposed to filter on.
 */
function referencesUnresolved(spec, attributes) {
  return Object.values(spec || {}).some(value => {
    const text = clean(value)
    return text.startsWith('@') && !clean((attributes || {})[text.slice(1)])
  })
}

/**
 * Tags this rule must never claim, named on the rule itself. The Visual
 * Trainer writes these when an engineer deselects a tag from a proposed
 * rule's affected list: keeping the opt-out on the rule that would otherwise
 * take the tag (rather than as a per-tag override) means it stays readable
 * next to the rule it qualifies and survives a profile rebuild.
 *
 * Compared through the engine-bound identity normalizer, so an entry that
 * differs only in case or separator spelling still excludes.
 */
function ruleExcludesTag(rule, tag, normalize) {
  const list = rule.exclusions
  if (!Array.isArray(list) || !list.length) return false
  const key = normalize(tag)
  return list.some(entry => normalize(entry) === key)
}

function composeParent(parts, parts_context) {
  if (!Array.isArray(parts) || !parts.length) return ''
  let out = ''
  for (const part of parts) {
    if (!part) return ''
    if (part.kind === 'literal') { out += String(part.text == null ? '' : part.text); continue }
    const value = part.kind === 'column' ? (parts_context.columns || {})[part.name]
      : part.kind === 'part' ? (parts_context.parts || {})[part.name]
      : undefined
    const resolved = clean(value)
    if (!resolved) return ''
    out += resolved
  }
  return out
}

function fragmentLookupDecision(rule, tag, context) {
  const source = (context.sources || {})[rule.source]
  if (!source) return null
  const upper = tag.toUpperCase()
  for (const marker of rule.markers || []) {
    const at = upper.indexOf(String(marker).toUpperCase())
    if (at < 0) continue
    const fragment = rule.fragmentFrom === 'wholeTag' ? tag : tag.slice(at)
    const matches=typeof source.findMatches==='function'?source.findMatches(fragment,rule.mode||'containing'):[source.find(fragment,rule.mode||'containing')].filter(Boolean)
    // Matches melScrSccParent: a marker hit with no record ends the search entirely
    // rather than falling through to the next marker.
    if (!matches.length) return decision('none', { ruleId: rule.id })
    const resolved=matches.map(record=>{
      const parts = {}
      if (rule.buildingFrom === 'tagBeforeFirst') {
        const delimiter = rule.buildingDelimiter || '-'
        const index = String(record.tag || '').indexOf(delimiter)
        parts.building = index > 0 ? clean(String(record.tag).slice(0, index)) : ''
      }
      if (rule.unitFrom === 'fragmentBeforeFirst') parts.unit = clean(fragment.split(rule.unitDelimiter || '_')[0])
      return {record,parent:composeParent(rule.parent,{columns:record.columns||{},parts})}
    }).filter(item=>item.parent)
    if(rule.onMultiple==='first'&&resolved.length)return decision('resolved',{parent:resolved[0].parent,ruleId:rule.id})
    const parents=[...new Set(resolved.map(item=>item.parent))]
    if(parents.length===1)return decision('resolved',{parent:parents[0],ruleId:rule.id})
    if(parents.length>1)return decision('ambiguous',{ruleId:rule.id,candidates:resolved.map(item=>clean(item.record.tag)),
      reason:clean(rule.ambiguousReason)||'Multiple lookup rows match the same tag fragment'})
    return decision('none',{ruleId:rule.id})
  }
  return null
}

function prefixSplitDecision(rule, tag, ctx) {
  const index = tag.indexOf(rule.delimiter || '_')
  if (index < 1) return null
  /* `cleanPrefix` re-runs the identity-stage normalize on the extracted prefix,
     which is what the original mahClosestParent did and the rule kind did not.
     Without it the prefix keeps a panel side that every other path strips, so
     the resolved parent names a tag no canonical node carries:
     'B14-MAH-01-A_CPS' resolves to 'B14-MAH-01-A' while the node is
     'B14-MAH-01'. Normalizing the WHOLE tag up front is not an option -- that
     is precisely what tagSource:'raw' exists to avoid, because the
     power-variant strip consumes the delimiter this rule splits on. */
  const head = tag.slice(0, index)
  const normalizeIdentity = (ctx && ctx.normalizeIdentity) || cleanTag
  const prefix = rule.cleanPrefix ? normalizeIdentity(head) : clean(head)
  let re = null
  try { re = new RegExp(rule.pattern, 'i') } catch (_) { return null }
  return re.test(prefix) ? decision('resolved', { parent: prefix, ruleId: rule.id }) : null
}

/**
 * The exact-tag heuristic, generalised from the MEL transformer convention:
 * before falling back to "how many candidates share the matched attribute",
 * it tries a tag built from the CURRENT PARENT's own prefix with the record's
 * own matched attribute swapped in for the trailing characters that attribute
 * came from. If that composed tag exists in the lookup source and itself
 * satisfies the match spec, it wins outright — even over several ordinary
 * candidates. Optional and general: any attributeMatch rule can opt in via
 * `preferExactTag`, not just the transformer convention.
 */
function preferredExactMatch(rule, context, currentParent) {
  const spec = rule.preferExactTag
  if (!spec) return null
  const source = (context.sources || {})[spec.source || rule.source]
  if (!source) return null
  const suffix = clean((context.attributes || {})[spec.attribute])
  const parent = clean(currentParent)
  if (!suffix || parent.length < suffix.length) return null
  const expected = parent.slice(0, -suffix.length) + suffix
  const record = source.find(expected, 'exact')
  if (!record) return null
  const criteria = resolveMatchSpec(rule.match, context.attributes)
  return guardPasses(criteria, record.attributes) ? record : null
}

function attributeMatchDecision(rule, context, currentParent) {
  if (!guardPasses(rule.when, context.attributes)) return null
  if (rule.whenParent && !guardPasses(rule.whenParent, context.parentAttributes)) return null
  if (referencesUnresolved(rule.match, context.attributes)) return null
  // whenDiffers: skip the rule when the named attribute is already the
  // same on the equipment and its current parent — or missing on either
  // side. Mirrors melTransformerDecision's two early-outs in one guard:
  // "current.length<4" (parentAttributes[attr] absent, so there is nothing
  // to compare) and "suffix===equipmentSuffix(current)" (they agree
  // already). Both cases mean "leave the parent alone" — a `none` decision
  // that keeps the current parent, not a `resolved` decision naming it.
  if (rule.whenDiffers) {
    const own = clean((context.attributes || {})[rule.whenDiffers])
    const theirs = clean((context.parentAttributes || {})[rule.whenDiffers])
    if (!own || !theirs || own.toLowerCase() === theirs.toLowerCase()) return null
  }
  const source = (context.sources || {})[rule.source]
  if (!source) return null
  const preferred = preferredExactMatch(rule, context, currentParent)
  if (preferred) return decision('resolved', { parent: clean(preferred.tag), ruleId: rule.id })
  let hits = source.findAll(resolveMatchSpec(rule.match, context.attributes))
  if (rule.excludeSelf) {
    const own = clean(context.currentTag).toLowerCase()
    hits = hits.filter(record => clean(record && record.tag).toLowerCase() !== own)
  }
  if (hits.length === 1) return decision('resolved', { parent: clean(hits[0].tag), ruleId: rule.id })
  return decision('ambiguous', {
    ruleId: rule.id,
    candidates: hits.map(r => clean(r.tag)),
    reason: hits.length ? clean(rule.ambiguousReason) : clean(rule.emptyReason),
  })
}

function constantDecision(rule, tag, currentParent) {
  if (rule.requiresNoParent && clean(currentParent)) return null
  let re = null
  try { re = new RegExp(rule.pattern, 'i') } catch (_) { return null }
  if (!re.test(tag)) return null
  const parent = clean(rule.parent)
  return parent ? decision('resolved', { parent, ruleId: rule.id }) : null
}

/**
 * Try each rule in order. The first `resolved` wins. An `ambiguous` result also
 * stops the search — otherwise a later rule would silently paper over the
 * ambiguity an engineer needs to see in Placement Review.
 */
export function applyRelate(tag, currentParent, rules, context) {
  const canonicalTag = clean(tag)
  if (!canonicalTag) return NONE
  const ctx = context || {}
  /* Exclusions are compared through THIS engine's identity normalizer, not the
     globally active profile's, so a draft whose Normalize rules differ from the
     live profile still keys an opt-out against the tag it was written from.
     Same idiom prefixSplit uses for cleanPrefix. Kept local rather than
     importing tagKey from src/state.js, which would make the otherwise
     state-free rules layer depend on app state. */
  const excludeKey = value => ((ctx.normalizeIdentity || cleanTag)(value) || '').toLowerCase()
  for (const rule of rules || []) {
    if (!isRuleEnabled(rule)) continue
    // Alongside `enabled` because it is the same shape of guard: a rule-level
    // opt-out that decides whether this rule is considered at all, before any
    // kind dispatch. Sitting here it holds for every kind, and an excluded tag
    // falls through to the next rule rather than ending the search — an
    // exclusion says "not this rule", not "no parent".
    if (ruleExcludesTag(rule, canonicalTag, excludeKey)) continue
    // Most conventions run against the fully-normalized (canonical) tag —
    // the same value Classify rules call 'canonical'. A rule can opt into
    // the less-processed 'raw' tier instead: cleanTag applied to the tag as
    // originally given to the engine, WITHOUT the power-variant strip.
    // mahClosestParent needs this (src/hierarchy/build.js) — it splits on
    // the tag's own '_', which the power-variant strip can consume before
    // this rule ever sees it (e.g. 'B14-MAH-01_CPS' canonicalizes to
    // 'B14-MAH-01', erasing the very underscore mahClosestParent looks for).
    const identity = ctx.normalizeIdentity || cleanTag
    const value = rule.tagSource === 'raw' ? identity(ctx.rawTag || '') : canonicalTag
    if (!value) continue
    let result = null
    if (rule.kind === 'fragmentLookup') result = fragmentLookupDecision(rule, value, ctx)
    else if (rule.kind === 'prefixSplit') {
      result = prefixSplitDecision(rule, value, ctx)
      if(!result&&rule.alsoCurrentParent){
        const parentValue=identity(ctx.rawParentTag||currentParent);
        result=parentValue?prefixSplitDecision(rule,parentValue,ctx):null;
        if(result&&result.status==='resolved')result={...result,dependencies:[parentValue]};
      }
    }
    else if (rule.kind === 'attributeMatch') result = attributeMatchDecision(rule, ctx, currentParent)
    else if (rule.kind === 'constant') result = constantDecision(rule, value, currentParent)
    if (!result) continue
    if (result.status === 'resolved' || result.status === 'ambiguous') return result
  }
  return NONE
}
