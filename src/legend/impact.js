import { clean } from '../core/text.js'
import { createEngine } from '../rules/engine.js'
import { compileRuleProfile } from '../rules/profile-compiler.js'
import { profileClone } from '../profile/schema.js'
import { legendPreselect } from './proposals.js'

/* ---- impact simulation ----
   What a proposal would actually DO to this project's tags, measured at the
   position it would actually occupy.

   The baseline is computed once per session and threaded through every call.
   The Visual Trainer learned this the expensive way: re-deriving it per
   proposal was measured at roughly three seconds on a real profile, and
   passing it in cut that by 46% (visualTrainerRelationshipImpact,
   src/profile/visual-trainer.js). A legend can produce dozens of proposals at
   once, so the same mistake here would be dozens of times worse.

   Nothing in this file mutates the profile it is given. Preview must be free. */

const LEGEND_FAMILY_KEY = Object.freeze({ anatomy: 'anatomies', normalize: 'normalize', classify: 'classify', relate: 'relate' })

/** Distinct raw tags in the corpus, each with a source kind for rule scoping. */
function legendCorpusTags(corpus) {
  const tags = new Map()
  for (const record of (corpus && corpus.records) || []) {
    const key = record.raw.toLowerCase()
    if (!tags.has(key)) tags.set(key, { raw: record.raw, sourceKind: record.sourceKind })
  }
  return [...tags.values()]
}

/**
 * Evaluate every corpus tag under one profile.
 *
 * Computed ONCE and passed to every impact call. Callers that skip it get a
 * correct answer and pay for it per proposal.
 */
export function legendEvaluate(profile, corpus) {
  const engine = createEngine(profile || {})
  const tags = legendCorpusTags(corpus)
  const resolved = new Map()
  for (const { raw, sourceKind } of tags) {
    const result = engine.resolve(raw, { sourceKind })
    resolved.set(raw.toLowerCase(), {
      raw,
      sourceKind,
      canonical: result.canonical,
      identity: result.identity,
      attributes: result.attributes,
      anatomyId: result.anatomyId,
      ruleIds: (result.classificationRules || []).map(match => match.id),
      ruleByTarget: Object.fromEntries((result.classificationRules || []).map(match => [match.target, match])),
    })
  }
  return { profile, tags, resolved }
}

/** Insert proposed rules into a cloned profile at their proposed positions. */
export function legendApplyProposals(profile, proposals) {
  const candidate = profileClone(profile || {})
  candidate.anatomies = Array.isArray(candidate.anatomies) ? candidate.anatomies : []
  candidate.rules = candidate.rules && typeof candidate.rules === 'object' ? candidate.rules : {}
  for (const family of ['normalize', 'classify', 'relate']) {
    candidate.rules[family] = Array.isArray(candidate.rules[family]) ? candidate.rules[family] : []
  }

  const grouped = new Map()
  for (const proposal of proposals || []) {
    const key = LEGEND_FAMILY_KEY[proposal.family]
    if (!key) continue
    if (!grouped.has(key)) grouped.set(key, [])
    grouped.get(key).push(proposal)
  }

  for (const [key, group] of grouped) {
    const target = key === 'anatomies' ? candidate.anatomies : candidate.rules[key]
    /* Ascending with a running offset, so a second insertion into the same
       family lands where it was simulated rather than being pushed around by
       the first. Order between proposals at the same index follows the order
       they were generated. */
    group.sort((left, right) => left.insertIndex - right.insertIndex)
    let offset = 0
    for (const proposal of group) {
      const at = Math.max(0, Math.min(target.length, proposal.insertIndex + offset))
      target.splice(at, 0, profileClone(proposal.rule))
      offset++
    }
  }
  return candidate
}

/**
 * Proposals this one cannot be simulated without, resolved transitively.
 *
 * Applying a Classify segment rule without the anatomy that defines its segment
 * produces a profile the compiler rejects, so the proposal reports itself as
 * invalid when it is only incomplete.
 */
export function legendPrerequisites(proposal, all) {
  const list = all || []
  const found = []
  const seen = new Set([proposal.id])
  const walk = ids => {
    for (const id of ids || []) {
      if (seen.has(id)) continue
      seen.add(id)
      const dependency = list.find(item => item.id === id)
      if (!dependency) continue
      walk(dependency.dependsOn)
      found.push(dependency)
    }
  }
  walk(proposal.dependsOn)
  return found
}

/** A profile carrying only this proposal's rule and its prerequisites. */
function legendIsolatedProfile(profile, proposal, prerequisites) {
  const isolated = {
    schemaVersion: (profile && profile.schemaVersion) || 3,
    anatomies: profileClone((profile && profile.anatomies) || []),
    rules: { normalize: [], classify: [], relate: [] },
  }
  for (const dependency of prerequisites || []) {
    if (dependency.family === 'anatomy') isolated.anatomies = [...isolated.anatomies, profileClone(dependency.rule)]
  }
  if (proposal.family === 'anatomy') isolated.anatomies = [profileClone(proposal.rule)]
  else if (proposal.family === 'normalize') isolated.rules.normalize = [profileClone(proposal.rule)]
  else if (proposal.family === 'classify') isolated.rules.classify = [profileClone(proposal.rule)]
  else isolated.rules.relate = [profileClone(proposal.rule)]
  return isolated
}

function legendTagsWhoseIdentityMerges(baseline, candidate) {
  const byCanonical = new Map()
  const merged = []
  for (const [key, after] of candidate.resolved) {
    const canonical = after.canonical.toLowerCase()
    if (!byCanonical.has(canonical)) byCanonical.set(canonical, [])
    byCanonical.get(canonical).push(key)
  }
  for (const [canonical, keys] of byCanonical) {
    if (keys.length < 2) continue
    const before = new Set(keys.map(key => clean(baseline.resolved.get(key) && baseline.resolved.get(key).canonical).toLowerCase()))
    /* Tags that already shared a canonical identity are not a new merge. Only
       a set that was distinct before and is single now has actually collapsed
       two equipment records into one. */
    if (before.size > 1) merged.push({ canonical, tags: keys.map(key => candidate.resolved.get(key).raw) })
  }
  return merged
}

/**
 * Impact of one proposal, measured at its proposed insertion index.
 *
 * The distinction that matters is structural vs effective. A Classify rule is
 * first-match-wins per target, so a rule that would match a hundred tags in
 * isolation may change nothing at all where it actually sits. Reporting the
 * hundred alone would be a lie of omission.
 */
export function legendProposalImpact(profile, proposal, corpus, baseline, options) {
  const base = baseline || legendEvaluate(profile, corpus)
  const prerequisites = legendPrerequisites(proposal, options && options.proposals)
  const candidateProfile = legendApplyProposals(profile, [...prerequisites, proposal])
  const candidate = legendEvaluate(candidateProfile, corpus)
  const isolated = legendEvaluate(legendIsolatedProfile(profile, proposal, prerequisites), corpus)

  const structural = []
  const effective = []
  const conflicts = []
  const shadowedBy = new Map()
  const sampleLimit = (options && options.sampleLimit) || 8

  for (const [key, after] of candidate.resolved) {
    const before = base.resolved.get(key)
    const alone = isolated.resolved.get(key)
    if (!before || !alone) continue

    if (proposal.family === 'classify') {
      const target = proposal.target
      const matchesAlone = alone.attributes[target] !== undefined
      if (matchesAlone) structural.push(after.raw)
      const fired = after.ruleIds.includes(proposal.rule.id)
      if (fired) {
        effective.push(after.raw)
        const previous = before.attributes[target]
        if (previous !== undefined && clean(previous).toLowerCase() !== clean(after.attributes[target]).toLowerCase()) {
          conflicts.push({ tag: after.raw, before: previous, after: after.attributes[target] })
        }
      } else if (matchesAlone) {
        const owner = before.ruleByTarget[target]
        if (owner) shadowedBy.set(owner.id, { id: owner.id, name: owner.name || owner.id, count: (shadowedBy.get(owner.id) || { count: 0 }).count + 1 })
      }
      continue
    }

    /* An anatomy is measured by how many tags it SELECTS, not by how many
       identities it changes. An anatomy whose segments all carry identity
       rewrites nothing, so an identity-delta measure reports zero for the
       common case -- and then blocks it with "matches no project tag", which
       is both wrong and baffling. What it does is name the segments other
       rules read. */
    if (proposal.family === 'anatomy') {
      if (alone.anatomyId === proposal.rule.id) structural.push(after.raw)
      if (after.anatomyId === proposal.rule.id) effective.push(after.raw)
      continue
    }
    /* Normalize genuinely is an identity change, so the canonical delta is the
       right measure. Relate does not act on tags in isolation and is measured
       through the parent simulation instead. */
    if (proposal.family === 'normalize') {
      if (clean(alone.canonical) !== clean(alone.raw)) structural.push(after.raw)
      if (clean(after.canonical) !== clean(before.canonical)) effective.push(after.raw)
    }
  }

  const merges = legendTagsWhoseIdentityMerges(base, candidate)
  const validation = compileRuleProfile(candidateProfile, { allowUnmapped: true })
  const shadow = [...shadowedBy.values()]
  const fullyShadowed = structural.length > 0 && effective.length === 0

  const impact = {
    proposalId: proposal.id,
    structuralMatches: structural.length,
    effectiveMatches: effective.length,
    conflicts,
    identityCollisions: merges.length,
    canonicalMerges: merges.slice(0, sampleLimit),
    shadowedBy: shadow,
    fullyShadowed,
    sampleTags: effective.slice(0, sampleLimit),
    shadowedTags: structural.filter(tag => !effective.includes(tag)).slice(0, sampleLimit),
    sourceDistribution: legendSourceDistribution(effective, corpus),
    compiles: validation.ok,
    validationErrors: validation.ok ? [] : validation.errors.slice(0, 4),
    /* With no hierarchy built there is nothing to re-parent against, so
       relationship and cycle effects are reported as unverified rather than as
       safe. Absence of evidence is not evidence of safety. */
    parentImpact: legendParentImpact(proposal, options),
    candidateProfile,
  }
  return { ...impact, ...legendPreselect(proposal, {
    corpusLoaded: !!(corpus && corpus.size),
    compiles: validation.ok,
    effectiveMatches: effective.length,
    conflicts: conflicts.length,
    collisions: merges.length,
    fullyShadowed,
  }) }
}

function legendSourceDistribution(tags, corpus) {
  const counts = {}
  for (const tag of tags) {
    for (const kind of (corpus && corpus.sourcesFor ? corpus.sourcesFor(tag) : [])) {
      counts[kind] = (counts[kind] || 0) + 1
    }
  }
  return counts
}

function legendParentImpact(proposal, options) {
  const hasHierarchy = !!(options && options.hasHierarchy)
  if (proposal.family !== 'relate') return { applicable: false, verified: true, reason: '' }
  if (!hasHierarchy) {
    return {
      applicable: true, verified: false,
      reason: 'Not yet verified — no hierarchy has been built, so parent changes, ambiguities, and cycles cannot be simulated.',
    }
  }
  return { applicable: true, verified: true, reason: '' }
}

/**
 * Combined impact of a selected batch.
 *
 * Evaluated as one candidate rather than as a sum of individual impacts,
 * because rules interact: two proposals can each look harmless alone and
 * shadow one another, or together collapse two identities into one.
 */
/**
 * A selection plus everything it depends on, in dependency order.
 *
 * Selecting "classify from the equipmentType segment" without the anatomy that
 * defines that segment cannot be applied at all, so the dependency comes along
 * rather than the apply failing validation and blaming the user's choice.
 */
export function legendExpandSelection(selected, all) {
  const out = []
  const seen = new Set()
  for (const proposal of selected || []) {
    for (const dependency of legendPrerequisites(proposal, all)) {
      if (seen.has(dependency.id)) continue
      seen.add(dependency.id)
      out.push(dependency)
    }
    if (seen.has(proposal.id)) continue
    seen.add(proposal.id)
    out.push(proposal)
  }
  return out
}

export function legendBatchImpact(profile, proposals, corpus, baseline, options) {
  const selected = legendExpandSelection((proposals || []).filter(Boolean), (options && options.proposals) || proposals)
  const base = baseline || legendEvaluate(profile, corpus)
  if (!selected.length) {
    return {
      selected: 0, identityChanges: [], canonicalMerges: [], classificationsAdded: 0, classificationsChanged: 0,
      unreachableRules: [], compiles: true, validationErrors: [], candidateProfile: profileClone(profile || {}),
      parentImpact: { applicable: false, verified: true, reason: '' },
    }
  }
  const candidateProfile = legendApplyProposals(profile, selected)
  const candidate = legendEvaluate(candidateProfile, corpus)

  const identityChanges = []
  let classificationsAdded = 0
  let classificationsChanged = 0
  for (const [key, after] of candidate.resolved) {
    const before = base.resolved.get(key)
    if (!before) continue
    if (clean(before.canonical) !== clean(after.canonical)) {
      identityChanges.push({ tag: after.raw, before: before.canonical, after: after.canonical })
    }
    for (const [target, value] of Object.entries(after.attributes)) {
      const previous = before.attributes[target]
      if (previous === undefined) classificationsAdded++
      else if (clean(previous).toLowerCase() !== clean(value).toLowerCase()) classificationsChanged++
    }
  }

  /* A rule that fires for nothing once the batch is in place is unreachable at
     its position -- worth naming, because the user selected it expecting an
     effect. */
  const fired = new Set()
  for (const after of candidate.resolved.values()) for (const id of after.ruleIds) fired.add(id)
  const unreachableRules = selected
    .filter(proposal => proposal.family === 'classify' && !fired.has(proposal.rule.id))
    .map(proposal => ({ id: proposal.rule.id, title: proposal.title }))

  const validation = compileRuleProfile(candidateProfile, { allowUnmapped: true })
  const sampleLimit = (options && options.sampleLimit) || 8
  return {
    selected: selected.length,
    identityChanges: identityChanges.slice(0, sampleLimit),
    identityChangeCount: identityChanges.length,
    canonicalMerges: legendTagsWhoseIdentityMerges(base, candidate),
    classificationsAdded,
    classificationsChanged,
    unreachableRules,
    compiles: validation.ok,
    validationErrors: validation.ok ? [] : validation.errors.slice(0, 4),
    parentImpact: legendParentImpact(
      selected.find(proposal => proposal.family === 'relate') || { family: 'none' }, options),
    candidateProfile,
  }
}

/**
 * Apply a batch to the draft.
 *
 * Compiles the WHOLE candidate before replacing anything, so a batch that
 * validates only in pieces never reaches the draft. Returns the new draft
 * rather than assigning it, leaving the caller to mark the draft dirty --
 * publication stays where it has always been, behind Save & apply.
 */
export function legendApplyToDraft(draft, proposals, all) {
  const picked = (proposals || []).filter(Boolean)
  if (!picked.length) return { ok: false, code: 'nothing_selected', message: 'Select at least one proposal first.' }
  const selected = legendExpandSelection(picked, all || proposals)
  const candidate = legendApplyProposals(draft, selected)
  const validation = compileRuleProfile(candidate, { allowUnmapped: true })
  if (!validation.ok) {
    return {
      ok: false, code: 'validation_failed',
      message: (validation.errors[0] && validation.errors[0].message) || 'The resulting profile does not validate.',
      errors: validation.errors.slice(0, 4),
    }
  }
  return { ok: true, draft: candidate, applied: selected.length }
}
