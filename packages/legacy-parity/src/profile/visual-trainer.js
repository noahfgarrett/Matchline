import { clean } from '../core/text.js'
import { S, tagKey } from '../state.js'
import { profileClone, profileExecutionSignature } from './schema.js'
import { createEngine } from '../rules/engine.js'
import { createMemoryLookup } from '../rules/lookup.js'
import { resolveRecordContext } from '../hierarchy/projection.js'
import { melSources } from '../hierarchy/build.js'

export const VISUAL_TRAINER_SOURCE = 'canonical'
export const VISUAL_TRAINER_GROUP_ATTRIBUTES = Object.freeze(['building', 'discipline', 'system'])

function visualTrainerId(prefix) {
  return prefix + '-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7)
}

export function visualTrainerData(profile, sourceRecords) {
  const records = [...(sourceRecords || S.canonicalModel).values()]
  const byKey = new Map(records.map(record => [record.key || tagKey(record.tag), record]))
  const contexts = new Map()
  const rows = records.map(record => {
    const context = resolveRecordContext(record, profile)
    const key = record.key || tagKey(record.tag)
    contexts.set(key, context)
    return { tag: record.tag, columns: {}, attributes: { ...context.attributes }, record, key }
  })
  return { records, byKey, contexts, lookup: createMemoryLookup(rows) }
}

/* Evaluating parents walks every canonical record through the profile's
   engine — seconds at real scale — and three separate consumers need it (the
   Visual Trainer canvas, the Test & Publish impact diff, the post-build
   prewarm). Memoized on execution content + build identity, but only for the
   live canonical model; explicit record sets (tests, tools) always compute. */
const EVALUATE_MEMO = new Map()
const EVALUATE_MEMO_CAP = 4
/* Everything the evaluation actually reads — profileExecutionSignature minus
   `mappings`, deliberately: opening the studio auto-maps detected columns into
   the draft, which must not invalidate an evaluation that never reads them. */
export function visualEvaluationSignature(profile) {
  const value = profile || {}
  return JSON.stringify({ anatomies: value.anatomies || [], rules: value.rules || {}, tagRules: value.tagRules || [],
    hierarchy: value.hierarchy || {}, overrides: value.overrides || {} })
}
export function visualTrainerEvaluateParents(profile, sourceRecords) {
  const live = !sourceRecords || sourceRecords === S.canonicalModel
  const memoKey = live
    ? visualEvaluationSignature(profile) + '|' + S.profileBuildRevision + '|' + S.canonicalModel.size
    : null
  if (memoKey !== null && EVALUATE_MEMO.has(memoKey)) return EVALUATE_MEMO.get(memoKey)
  const result = evaluateParentsUncached(profile, sourceRecords)
  if (memoKey !== null) {
    if (EVALUATE_MEMO.size >= EVALUATE_MEMO_CAP) EVALUATE_MEMO.delete(EVALUATE_MEMO.keys().next().value)
    EVALUATE_MEMO.set(memoKey, result)
  }
  return result
}
function evaluateParentsUncached(profile, sourceRecords) {
  const data = visualTrainerData(profile, sourceRecords)
  const engine = createEngine(profile)
  const sources = { ...melSources(), [VISUAL_TRAINER_SOURCE]: data.lookup }
  const overrides = new Map(((profile.overrides && profile.overrides.relationships) || []).map(override => [tagKey(override.equipment), override]))
  const parents = new Map()
  const decisions = new Map()
  for (const record of data.records) {
    const key = record.key || tagKey(record.tag)
    const current = clean(record.ssmParentTag)
    const currentRecord = data.byKey.get(tagKey(current))
    const decision = engine.relate(record.tag, current, {
      sources,
      sourceKind: record.sourceKind,
      attributes: data.contexts.get(key).attributes,
      parentAttributes: currentRecord ? data.contexts.get(currentRecord.key || tagKey(currentRecord.tag)).attributes : {},
    })
    const override = overrides.get(key)
    const parent = override ? clean(override.parent) : decision.status === 'resolved' ? clean(decision.parent) : current
    parents.set(key, parent)
    decisions.set(key, { ...decision, overridden: !!override, override })
  }
  return { ...data, parents, decisions }
}

export function visualTrainerCycleKeys(parents, records) {
  const known = new Set(records.map(record => record.key || tagKey(record.tag)))
  const cycles = new Set()
  const settled = new Set()
  for (const start of known) {
    if (settled.has(start)) continue
    const path = []
    const at = new Map()
    let current = start
    while (current && known.has(current) && !settled.has(current)) {
      if (at.has(current)) {
        for (let index = at.get(current); index < path.length; index++) cycles.add(path[index])
        break
      }
      at.set(current, path.length)
      path.push(current)
      current = tagKey(parents.get(current))
    }
    path.forEach(key => settled.add(key))
  }
  return cycles
}

export function visualTrainerIsDescendant(sourceKey, targetKey, parents) {
  const source = tagKey(sourceKey)
  let current = tagKey(targetKey)
  const seen = new Set()
  while (current && !seen.has(current)) {
    if (current === source) return true
    seen.add(current)
    current = tagKey(parents.get(current))
  }
  return false
}

export function visualTrainerRelationshipRule(sourceRecord, targetRecord, profile, sourceRecords) {
  if (!sourceRecord || !targetRecord || tagKey(sourceRecord.tag) === tagKey(targetRecord.tag)) return null
  const data = visualTrainerData(profile, sourceRecords)
  const source = data.contexts.get(sourceRecord.key || tagKey(sourceRecord.tag))
  const target = data.contexts.get(targetRecord.key || tagKey(targetRecord.tag))
  const childType = clean(source && source.equipmentType)
  const parentType = clean(target && target.equipmentType)
  const childMatch = clean(source && source.matchKey)
  const parentMatch = clean(target && target.matchKey)
  if (!childType || !parentType || !childMatch || childMatch.toLowerCase() !== parentMatch.toLowerCase()) return null
  const match = { equipmentType: parentType, matchKey: '@matchKey' }
  const childBuilding = clean(source.building)
  const parentBuilding = clean(target.building)
  if (childBuilding && !/^unassigned/i.test(childBuilding) && childBuilding.toLowerCase() === parentBuilding.toLowerCase()) {
    match.building = '@building'
  }
  return {
    id: visualTrainerId('visual-rel'),
    name: `${childType} to matching ${parentType}`,
    kind: 'attributeMatch',
    source: VISUAL_TRAINER_SOURCE,
    when: { equipmentType: childType },
    match,
    excludeSelf: true,
    ambiguousReason: `Multiple ${parentType} tags share this equipment's matching attributes`,
    emptyReason: `No ${parentType} tag shares this equipment's matching attributes`,
    enabled: true,
    note: `Trained visually by moving ${sourceRecord.tag} beneath ${targetRecord.tag}.`,
    ui: { generatedBy: 'visual-trainer' },
  }
}

export function visualTrainerRelationshipCandidate(profile, sourceRecord, targetRecord, scope, sourceRecords, suppliedRule) {
  const candidate = profileClone(profile)
  candidate.overrides = candidate.overrides || { relationships: [], attributes: [] }
  candidate.overrides.relationships = candidate.overrides.relationships || []
  candidate.overrides.attributes = candidate.overrides.attributes || []
  let rule = suppliedRule || null
  let override = null
  if (scope === 'similar') {
    rule = rule || visualTrainerRelationshipRule(sourceRecord, targetRecord, profile, sourceRecords)
    if (!rule) return null
    candidate.rules.relate = [profileClone(rule), ...(candidate.rules.relate || [])]
  } else {
    override = {
      id: visualTrainerId('visual-placement'),
      equipment: sourceRecord.tag,
      parent: targetRecord.tag,
      savedAt: new Date().toISOString(),
    }
    candidate.overrides.relationships = candidate.overrides.relationships.filter(item => tagKey(item.equipment) !== tagKey(sourceRecord.tag))
    candidate.overrides.relationships.push(override)
  }
  return { candidate, rule, override }
}

/* `precomputedBaseline` is the caller's already-evaluated view of the UNCHANGED
   profile. The Studio holds exactly that in its visual cache, and a single drop
   asks for two impacts (single and similar) -- so without this the same baseline
   is evaluated twice per drop on top of the cached copy, three identical O(n)
   passes where one would do. Omit it and the baseline is evaluated here. */
export function visualTrainerRelationshipImpact(profile, sourceRecord, targetRecord, scope, sourceRecords, suppliedRule, precomputedBaseline) {
  const built = visualTrainerRelationshipCandidate(profile, sourceRecord, targetRecord, scope, sourceRecords, suppliedRule)
  if (!built) return { valid: false, reason: 'These tags do not share enough trained attributes for a reusable rule.' }
  const baseline = precomputedBaseline || visualTrainerEvaluateParents(profile, sourceRecords)
  const candidate = visualTrainerEvaluateParents(built.candidate, sourceRecords)
  const sourceKey = sourceRecord.key || tagKey(sourceRecord.tag)
  const targetKey = targetRecord.key || tagKey(targetRecord.tag)
  const baselineCycles = visualTrainerCycleKeys(baseline.parents, baseline.records)
  const cycles = visualTrainerCycleKeys(candidate.parents, candidate.records)
  const introducedCycles = new Set([...cycles].filter(key => !baselineCycles.has(key)))
  /* `examples` stays capped at 8 for the callers that only ever wanted a
     sample. `affected` is the complete list the proposal panel needs so every
     tag the rule claims can be deselected individually. */
  const examples = []
  const affected = []
  const excludedKeys = new Set((built.rule && Array.isArray(built.rule.exclusions) ? built.rule.exclusions : []).map(tagKey))
  let applicable = 0
  let moved = 0
  let alreadyCorrect = 0
  let ambiguous = 0
  let pinned = 0
  for (const record of candidate.records) {
    const key = record.key || tagKey(record.tag)
    const decision = candidate.decisions.get(key)
    const applies = scope === 'single' ? key === sourceKey : decision && decision.ruleId === built.rule.id
    if (!applies) {
      /* An excluded tag is never applicable -- the rule now skips it outright
         -- but it still belongs on the affected list. Drop it and deselecting
         a tag would erase its own row, leaving no way to select it back. It
         keeps its baseline parent on both sides because it does not move. */
      if (scope !== 'single' && excludedKeys.has(key)) {
        const parent = clean(baseline.parents.get(key))
        affected.push({ tag: record.tag, before: parent, after: parent, excluded: true })
      }
      continue
    }
    applicable++
    const before = clean(baseline.parents.get(key))
    const after = clean(candidate.parents.get(key))
    affected.push({ tag: record.tag, before, after, excluded: false })
    if (decision.status === 'ambiguous') {
      ambiguous++
      continue
    }
    if (decision.overridden && scope === 'similar') pinned++
    if (tagKey(before) === tagKey(after)) alreadyCorrect++
    else {
      moved++
      if (examples.length < 8) examples.push({ tag: record.tag, before, after })
    }
  }
  const sourceParent = clean(candidate.parents.get(sourceKey))
  const sourceDecision = candidate.decisions.get(sourceKey)
  const sourceResolved = tagKey(sourceParent) === targetKey
  const sourceAmbiguous = !!(sourceDecision && sourceDecision.status === 'ambiguous' && (!built.rule || sourceDecision.ruleId === built.rule.id))
  const sourceCycle = introducedCycles.has(sourceKey)
  const descendant = visualTrainerIsDescendant(sourceKey, targetKey, baseline.parents)
  const valid = sourceResolved && !sourceAmbiguous && !sourceCycle && !descendant
  return {
    valid,
    reason: descendant ? 'A branch cannot move beneath one of its own descendants.'
      : sourceCycle ? 'This proposal creates a parent cycle.'
        : sourceAmbiguous ? 'The example tag matches more than one possible parent.'
          : !sourceResolved ? 'The inferred rule does not reproduce the example move.'
            : '',
    applicable,
    moved,
    alreadyCorrect,
    ambiguous,
    pinned,
    invalid: introducedCycles.size,
    unaffected: Math.max(0, candidate.records.length - applicable),
    dependenciesChanged: 0,
    examples,
    affected,
    rule: built.rule,
    override: built.override,
    candidate: built.candidate,
  }
}

function visualTrainerSafeClassifier(sourceRecord, profile, sourceRecords) {
  const data = visualTrainerData(profile, sourceRecords)
  const context = data.contexts.get(sourceRecord.key || tagKey(sourceRecord.tag))
  const match = (context && context.rules || []).find(item => item.target === 'equipmentType')
  const rule = match && (profile.rules.classify || []).find(item => item.id === match.id)
  if (!rule || !['pattern', 'segment', 'slice'].includes(rule.kind)) return null
  if (rule.kind !== 'pattern' && !clean(rule.expected)) return null
  return rule
}

export function visualTrainerGroupingRules(sourceRecord, groupValues, profile, sourceRecords) {
  const classifier = visualTrainerSafeClassifier(sourceRecord, profile, sourceRecords)
  if (!classifier) return []
  return Object.entries(groupValues || {}).filter(([attribute, value]) => VISUAL_TRAINER_GROUP_ATTRIBUTES.includes(attribute) && clean(value)).map(([attribute, value]) => {
    const generated={
      ...profileClone(classifier),
      id: visualTrainerId('visual-classify'),
      name: `${clean(classifier.value) || 'Matching tags'} to ${value}`,
      target: attribute,
      value: clean(value),
      enabled: true,
      note: `Trained visually by moving ${sourceRecord.tag} into ${attribute} "${value}".`,
      ui: { ...(classifier.ui || {}), generatedBy: 'visual-trainer', basedOn: classifier.id },
    }
    delete generated.legacyTagRuleId
    return generated
  })
}

export function visualTrainerGroupingCandidate(profile, sourceRecord, groupValues, scope, sourceRecords, suppliedRules) {
  const candidate = profileClone(profile)
  candidate.overrides = candidate.overrides || { relationships: [], attributes: [] }
  candidate.overrides.relationships = candidate.overrides.relationships || []
  candidate.overrides.attributes = candidate.overrides.attributes || []
  let rules = suppliedRules || []
  let override = null
  if (scope === 'similar') {
    rules = rules.length ? rules : visualTrainerGroupingRules(sourceRecord, groupValues, profile, sourceRecords)
    if (!rules.length) return null
    candidate.rules.classify = [...profileClone(rules), ...(candidate.rules.classify || [])]
  } else {
    override = {
      id: visualTrainerId('visual-grouping'),
      equipment: sourceRecord.tag,
      values: Object.fromEntries(Object.entries(groupValues || {}).filter(([key, value]) => VISUAL_TRAINER_GROUP_ATTRIBUTES.includes(key) && clean(value))),
      savedAt: new Date().toISOString(),
    }
    if (!Object.keys(override.values).length) return null
    candidate.overrides.attributes = candidate.overrides.attributes.filter(item => tagKey(item.equipment) !== tagKey(sourceRecord.tag))
    candidate.overrides.attributes.push(override)
  }
  return { candidate, rules, override }
}

/* `precomputedBaseline` mirrors visualTrainerRelationshipImpact: the caller's
   evaluated view of the unchanged profile. Grouping only needs the `data` half
   (contexts and records), which an evaluation already carries. */
export function visualTrainerGroupingImpact(profile, sourceRecord, groupValues, scope, sourceRecords, suppliedRules, precomputedBaseline) {
  const built = visualTrainerGroupingCandidate(profile, sourceRecord, groupValues, scope, sourceRecords, suppliedRules)
  if (!built) return { valid: false, reason: 'No safe reusable tag classifier could be inferred from this equipment.' }
  const baseline = precomputedBaseline || visualTrainerData(profile, sourceRecords)
  const candidate = visualTrainerData(built.candidate, sourceRecords)
  const sourceKey = sourceRecord.key || tagKey(sourceRecord.tag)
  const generatedIds = new Set((built.rules || []).map(rule => rule.id))
  const examples = []
  let applicable = 0
  let moved = 0
  let alreadyCorrect = 0
  let boundaryWarnings = 0
  for (const record of candidate.records) {
    const key = record.key || tagKey(record.tag)
    const before = baseline.contexts.get(key)
    const after = candidate.contexts.get(key)
    const applies = scope === 'single' ? key === sourceKey : (after.rules || []).some(rule => generatedIds.has(rule.id))
    if (!applies) continue
    applicable++
    const changed = Object.keys(groupValues).some(attribute => clean(before[attribute]).toLowerCase() !== clean(after[attribute]).toLowerCase())
    if (changed) {
      moved++
      if (examples.length < 8) examples.push({
        tag: record.tag,
        before: VISUAL_TRAINER_GROUP_ATTRIBUTES.map(attribute => before[attribute]).join(' / '),
        after: VISUAL_TRAINER_GROUP_ATTRIBUTES.map(attribute => after[attribute]).join(' / '),
      })
      const parent = candidate.byKey.get(tagKey(record.ssmParentTag))
      const parentContext = parent && candidate.contexts.get(parent.key || tagKey(parent.tag))
      if (parentContext && VISUAL_TRAINER_GROUP_ATTRIBUTES.some(attribute => clean(after[attribute]).toLowerCase() !== clean(parentContext[attribute]).toLowerCase())) boundaryWarnings++
    } else alreadyCorrect++
  }
  const sourceAfter = candidate.contexts.get(sourceKey)
  const sourceResolved = Object.entries(groupValues).every(([attribute, value]) => clean(sourceAfter && sourceAfter[attribute]).toLowerCase() === clean(value).toLowerCase())
  return {
    valid: sourceResolved,
    reason: sourceResolved ? '' : 'The inferred classifier does not reproduce the example move.',
    applicable,
    moved,
    alreadyCorrect,
    ambiguous: 0,
    pinned: 0,
    invalid: 0,
    unaffected: Math.max(0, candidate.records.length - applicable),
    dependenciesChanged: 0,
    boundaryWarnings,
    examples,
    rules: built.rules,
    override: built.override,
    candidate: built.candidate,
  }
}

export function visualTrainerDraftSlice(profile) {
  return profileClone({ rules: profile.rules, overrides: profile.overrides, modes: profile.modes, hierarchy: profile.hierarchy })
}

export function visualTrainerRestoreDraftSlice(profile, slice) {
  const restored = profileClone(profile)
  restored.rules = profileClone(slice.rules)
  restored.overrides = profileClone(slice.overrides)
  restored.modes = profileClone(slice.modes)
  restored.hierarchy = profileClone(slice.hierarchy)
  return restored
}

export function visualTrainerEnableResolvedFlow(profile) {
  profile.hierarchy = profile.hierarchy || {}
  profile.hierarchy.resolutionStrategy = 'source-priority'
  for (const mode of profile.modes || []) {
    const levels = mode && mode.levels || []
    if (mode.executor === 'raw' && levels.some(level => level.kind === 'flow')) mode.executor = 'projected'
  }
  return profile
}
