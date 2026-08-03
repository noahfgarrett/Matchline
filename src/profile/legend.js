import { clean } from '../core/text.js'
import { emptyLegendTraining } from '../rules/schema.js'

/* ---- legend training metadata ----
   Compact, reviewed knowledge extracted from a design legend, plus the
   provenance linking a generated rule back to the page it came from.

   What this file exists to guarantee: a profile can be saved, exported,
   snapshotted into revision history, and carried through an update handoff
   without ever containing a byte of the original document. Raw pages, images,
   canvases, OCR output, and worker objects live in the module-owned legend
   session (src/ui/legend-trainer.js) and never reach a profile at all. */

export const LEGEND_TRAINING_VERSION = 1
/* Caps are deliberately conservative. This payload rides along in localStorage
   next to every other profile, in eight revision-history snapshots, and inside
   the base64 handoff embedded in a downloaded replacement HTML. An uncapped
   pending list would eventually push the whole store past the localStorage
   quota, which is how a profile gets silently downgraded to session storage
   and lost on close. */
export const LEGEND_MAX_SOURCES = 24
export const LEGEND_MAX_PENDING_ENTRIES = 500
export const LEGEND_MAX_DISMISSED_HASHES = 2000
export const LEGEND_EVIDENCE_MAX = 160
export const LEGEND_TEXT_MAX = 200
export const LEGEND_MAX_SERIALIZED_BYTES = 131072

export const LEGEND_ENTRY_KINDS = Object.freeze([
  'abbreviation', 'code-list', 'tag-anatomy', 'classification',
  'normalization', 'relationship', 'hierarchy-root', 'reference-only',
])

/** Stable across key order, so a re-serialized record hashes identically. */
function legendStableValue(value) {
  if (Array.isArray(value)) return value.map(legendStableValue)
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const key of Object.keys(value).sort()) out[key] = legendStableValue(value[key])
  return out
}

export function legendStableStringify(value) {
  return JSON.stringify(legendStableValue(value))
}

/** FNV-style double hash, matching the profile compiler's approach. */
export function legendStableHash(value) {
  const text = legendStableStringify(value)
  let first = 0x811c9dc5
  let second = 0x9e3779b9
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index)
    first = Math.imul(first ^ code, 0x01000193)
    second = Math.imul(second ^ code, 0x85ebca6b)
    second ^= second >>> 13
  }
  const left = (first >>> 0).toString(16).padStart(8, '0')
  const right = (second >>> 0).toString(16).padStart(8, '0')
  return `lgd${LEGEND_TRAINING_VERSION}-${left}${right}`
}

function legendText(value, limit) {
  const text = clean(value)
  const max = limit || LEGEND_TEXT_MAX
  return text.length > max ? text.slice(0, max) : text
}

function legendCount(value) {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0
}

function legendConfidenceValue(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.min(1, Math.max(0, number))
}

/**
 * Fields that do not change what a rule DOES. A generated rule whose name or
 * note was edited is still the rule the legend produced; one whose pattern,
 * target, or value changed is not. Provenance itself is deliberately absent
 * from rule objects (it lives in ruleOrigins) precisely so that recording it
 * cannot alter this hash.
 */
const LEGEND_RULE_PRESENTATION_KEYS = Object.freeze(['name', 'note', 'ui', 'example'])

/** Hash of a rule's execution semantics only. */
export function legendRuleExecutionHash(rule) {
  if (!rule || typeof rule !== 'object') return ''
  const semantic = {}
  for (const key of Object.keys(rule)) {
    if (LEGEND_RULE_PRESENTATION_KEYS.includes(key)) continue
    semantic[key] = rule[key]
  }
  return legendStableHash(semantic)
}

function legendNormalizeSource(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = legendText(raw.id)
  if (!id) return null
  const selected = Array.isArray(raw.selectedPages)
    ? raw.selectedPages.map(legendCount).filter(page => page > 0).slice(0, 200)
    : []
  return {
    id,
    name: legendText(raw.name),
    fingerprint: legendText(raw.fingerprint),
    kind: legendText(raw.kind),
    pageCount: legendCount(raw.pageCount),
    selectedPages: selected,
    analyzedAt: legendText(raw.analyzedAt),
    extractorVersion: legendText(raw.extractorVersion),
    ocrUsed: raw.ocrUsed === true,
  }
}

function legendNormalizeEntry(raw) {
  if (!raw || typeof raw !== 'object') return null
  const id = legendText(raw.id)
  const kind = legendText(raw.kind)
  if (!id || !LEGEND_ENTRY_KINDS.includes(kind)) return null
  return {
    id,
    sourceId: legendText(raw.sourceId),
    page: legendCount(raw.page),
    kind,
    code: legendText(raw.code),
    meaning: legendText(raw.meaning),
    targetHint: legendText(raw.targetHint),
    confidence: legendConfidenceValue(raw.confidence),
    evidenceSummary: legendText(raw.evidenceSummary, LEGEND_EVIDENCE_MAX),
    semanticHash: legendText(raw.semanticHash),
  }
}

function legendNormalizeOrigin(raw) {
  if (!raw || typeof raw !== 'object') return null
  const entryIds = Array.isArray(raw.entryIds)
    ? raw.entryIds.map(value => legendText(value)).filter(Boolean).slice(0, 50)
    : []
  return {
    sourceId: legendText(raw.sourceId),
    page: legendCount(raw.page),
    entryIds,
    generatedExecutionHash: legendText(raw.generatedExecutionHash),
    acceptedAt: legendText(raw.acceptedAt),
  }
}

/**
 * Validate and cap a stored legendTraining container. Invalid records are
 * dropped rather than repaired -- a half-understood entry that still shows up
 * in the review list is worse than one that never appears, because the user
 * would be approving something nobody can explain.
 */
export function normalizeLegendTraining(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const container = {
    version: LEGEND_TRAINING_VERSION,
    sources: (Array.isArray(source.sources) ? source.sources : [])
      .map(legendNormalizeSource).filter(Boolean).slice(0, LEGEND_MAX_SOURCES),
    pendingEntries: (Array.isArray(source.pendingEntries) ? source.pendingEntries : [])
      .map(legendNormalizeEntry).filter(Boolean).slice(0, LEGEND_MAX_PENDING_ENTRIES),
    ruleOrigins: {},
    dismissedEntryHashes: [...new Set((Array.isArray(source.dismissedEntryHashes) ? source.dismissedEntryHashes : [])
      .map(value => legendText(value)).filter(Boolean))].slice(0, LEGEND_MAX_DISMISSED_HASHES),
  }
  const origins = source.ruleOrigins && typeof source.ruleOrigins === 'object' && !Array.isArray(source.ruleOrigins)
    ? source.ruleOrigins : {}
  for (const [ruleId, value] of Object.entries(origins)) {
    const id = legendText(ruleId)
    const origin = legendNormalizeOrigin(value)
    if (id && origin) container.ruleOrigins[id] = origin
  }
  /* Last line of defence. Even with per-array caps, a pathological import can
     carry 500 entries that are each at their length limit. Shed the least
     useful data first -- lowest-confidence pending entries -- and only then
     start dropping sources, so what survives is the knowledge most likely to
     be right. */
  if (legendStableStringify(container).length > LEGEND_MAX_SERIALIZED_BYTES) {
    container.pendingEntries.sort((left, right) => right.confidence - left.confidence)
    while (container.pendingEntries.length && legendStableStringify(container).length > LEGEND_MAX_SERIALIZED_BYTES) {
      container.pendingEntries.pop()
    }
    while (container.sources.length && legendStableStringify(container).length > LEGEND_MAX_SERIALIZED_BYTES) {
      container.sources.pop()
    }
    if (legendStableStringify(container).length > LEGEND_MAX_SERIALIZED_BYTES) container.dismissedEntryHashes = []
  }
  return container
}

/** Every rule id across the three families plus anatomies. */
function legendProfileRuleIds(profile) {
  const ids = new Set()
  for (const anatomy of (profile && profile.anatomies) || []) if (anatomy && anatomy.id) ids.add(anatomy.id)
  const rules = (profile && profile.rules) || {}
  for (const family of ['normalize', 'classify', 'relate']) {
    for (const rule of rules[family] || []) if (rule && rule.id) ids.add(rule.id)
  }
  return ids
}

/** Find a rule or anatomy by id across every family. */
export function legendFindRule(profile, ruleId) {
  const id = clean(ruleId)
  if (!id) return null
  for (const anatomy of (profile && profile.anatomies) || []) if (anatomy && anatomy.id === id) return anatomy
  const rules = (profile && profile.rules) || {}
  for (const family of ['normalize', 'classify', 'relate']) {
    for (const rule of rules[family] || []) if (rule && rule.id === id) return rule
  }
  return null
}

/**
 * Drop provenance for rules that no longer exist. Restoring an older revision
 * is the case that matters: the executable arrays go back, but the legend
 * knowledge stays, so origins can outlive the rules they describe.
 */
export function pruneLegendRuleOrigins(profile) {
  const legend = profile && profile.legendTraining
  if (!legend || !legend.ruleOrigins) return profile
  const live = legendProfileRuleIds(profile)
  for (const ruleId of Object.keys(legend.ruleOrigins)) {
    if (!live.has(ruleId)) delete legend.ruleOrigins[ruleId]
  }
  return profile
}

/**
 * '' when the rule did not come from a legend, 'current' when it still matches
 * what the legend generated, 'edited' when someone has since changed what it
 * does. An edited rule is never overwritten by reanalysis.
 */
export function legendRuleState(profile, ruleId) {
  const legend = profile && profile.legendTraining
  const origin = legend && legend.ruleOrigins && legend.ruleOrigins[clean(ruleId)]
  if (!origin) return ''
  const rule = legendFindRule(profile, ruleId)
  if (!rule) return ''
  if (!origin.generatedExecutionHash) return 'current'
  return legendRuleExecutionHash(rule) === origin.generatedExecutionHash ? 'current' : 'edited'
}

export function legendRuleOrigin(profile, ruleId) {
  const legend = profile && profile.legendTraining
  return (legend && legend.ruleOrigins && legend.ruleOrigins[clean(ruleId)]) || null
}

export function legendSourceById(profile, sourceId) {
  const legend = profile && profile.legendTraining
  const id = clean(sourceId)
  return ((legend && legend.sources) || []).find(source => source.id === id) || null
}

/**
 * Strip the bulky, re-derivable half of the legend container from a profile
 * copy destined for revision history.
 *
 * Eight snapshots are kept, and every one of them would otherwise carry a full
 * copy of the pending-entry list and the source metadata -- knowledge that is
 * not executable, does not describe the snapshot's rules, and is already held
 * once on the live profile. Rule origins DO stay: they are small, they are
 * keyed to the rule ids in that snapshot, and without them a restored revision
 * could not say where its own rules came from.
 */
export function legendStripForHistory(profile) {
  if (!profile || typeof profile !== 'object') return profile
  const legend = profile.legendTraining
  if (!legend || typeof legend !== 'object') return profile
  profile.legendTraining = {
    version: LEGEND_TRAINING_VERSION,
    sources: [],
    pendingEntries: [],
    ruleOrigins: legend.ruleOrigins || {},
    dismissedEntryHashes: [],
  }
  return profile
}

/**
 * A profile created from another starts with no legend history of its own.
 * Copying it forward would claim the new profile's inherited rules came from
 * documents that were never uploaded to it.
 */
export function clearLegendProvenance(profile) {
  if (!profile || typeof profile !== 'object') return profile
  profile.legendTraining = emptyLegendTraining()
  return profile
}
