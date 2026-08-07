import { clean } from '../core/text.js'
import { LEGEND_EVIDENCE_MAX, legendStableHash } from '../profile/legend.js'

/* ---- legend knowledge model ----
   The intermediate representation between "what the document says" and "what
   the profile executes". The parser produces these; it never touches profile
   rules. Everything here is pure and deterministic -- no Date.now(), no
   Math.random() -- so the same document always yields the same ids, which is
   what makes reanalysis able to recognise an entry it has already seen. */

export const LEGEND_EXTRACTOR_VERSION = 1

/** Where a piece of knowledge is trying to end up in the profile. */
export const LEGEND_TARGET_HINTS = Object.freeze([
  'building', 'discipline', 'system', 'equipmentType', 'matchKey',
  'placeholder', 'gisMarker', 'busMarker',
])

/**
 * Headings that tell us what a block of codes is FOR. Deliberately generic:
 * these are drafting conventions, not site vocabulary. No site's own
 * abbreviations appear anywhere in this file -- the whole point is that the
 * document teaches them to us.
 */
export const LEGEND_HEADINGS = Object.freeze([
  { match: /\bequipment\s+abbreviat/i, targetHint: 'equipmentType', kind: 'abbreviation' },
  { match: /\bequipment\s+(identification|type|codes?)\b/i, targetHint: 'equipmentType', kind: 'abbreviation' },
  { match: /\bdevice\s+codes?\b/i, targetHint: 'equipmentType', kind: 'abbreviation' },
  { match: /\bbuilding\s+codes?\b/i, targetHint: 'building', kind: 'code-list' },
  { match: /\bdiscipline\s+codes?\b/i, targetHint: 'discipline', kind: 'code-list' },
  { match: /\bsystem\s+codes?\b/i, targetHint: 'system', kind: 'code-list' },
  { match: /\btag\s+(identification|format|structure|breakdown)\b/i, targetHint: '', kind: 'tag-anatomy' },
  { match: /\bnomenclature\b/i, targetHint: '', kind: 'tag-anatomy' },
  { match: /\bgeneral\s+notes?\b/i, targetHint: '', kind: 'reference-only' },
  { match: /\babbreviat/i, targetHint: '', kind: 'abbreviation' },
  { match: /\blegend\b/i, targetHint: '', kind: 'abbreviation' },
])

/**
 * A line that defines something is not a heading, however heading-like its
 * words are.
 *
 * Without this, `ZZ9-QQQ-4321 = Building-Equipment Type-Unit` -- a worked
 * tag-format example -- is swallowed by the "Equipment Type" heading pattern
 * and never interpreted at all. The anatomy it describes silently vanishes,
 * and every abbreviation on the page falls back to a rule per code.
 */
const LEGEND_DEFINITION_SEPARATOR = /\S\s*=\s*\S|\S\s+[-–—]\s+\S|\S\s*:\s+\S/

/** The heading that governs a line, or null. */
export function legendHeadingFor(text) {
  const value = clean(text)
  if (!value || value.length > 80) return null
  if (LEGEND_DEFINITION_SEPARATOR.test(value)) return null
  for (const heading of LEGEND_HEADINGS) {
    if (heading.match.test(value)) return heading
  }
  return null
}

/** Shape of an all-caps section label: no sentence punctuation, no commas. */
const LEGEND_HEADING_SHAPE = /^[A-Z0-9][A-Z0-9 &/()\-.'#]*$/

/**
 * A line that reads as a section heading, whether or not we know what it means.
 *
 * This exists so an UNRECOGNISED heading still ends the previous section. On a
 * real equipment-numbering sheet, "LEVEL:" and "POWER SUPPLY:" are not in the
 * vocabulary, so the preceding "EQUIPMENT TYPE:" carried straight through them
 * and every level, voltage, and power-supply code came out labelled an
 * equipment type. Wrong with confidence is worse than unlabelled.
 *
 * Deliberately narrow. A bare code sitting alone in a column ("AAA") and a
 * sample tag ("ZZ9-QQQ-0001") are both short and upper-case, so a label must
 * either end in a colon or contain a space -- neither of those does.
 */
export function legendLooksLikeHeading(text) {
  const value = clean(text)
  if (!value || value.length > 48) return false
  if (LEGEND_DEFINITION_SEPARATOR.test(value)) return false
  if (!/[A-Za-z]/.test(value)) return false
  const label = value.replace(/:+$/, '').trim()
  if (!label) return false
  if (value.endsWith(':')) return !/[.!?]$/.test(label) && label.split(/\s+/).length <= 8
  return label.includes(' ') && LEGEND_HEADING_SHAPE.test(label)
}

/**
 * Codes are compared case- and separator-insensitively, so a legend spelling a
 * code `ZZ9 - QQQ` and a corpus spelling it `ZZ9-QQQ` are recognised as the
 * same thing. Without this, whitespace a draftsman added for legibility would
 * read as a different code and every match would silently miss.
 */
export function legendNormalizeCode(value) {
  return clean(value).toUpperCase().replace(/[\s_]*([-–—/])[\s_]*/g, '$1').replace(/\s+/g, ' ')
}

export function legendNormalizeMeaning(value) {
  return clean(value).replace(/\s+/g, ' ')
}

/** Stable comparison key -- what "the same entry" means across reanalysis. */
export function legendEntrySemanticHash(entry) {
  return legendStableHash({
    kind: clean(entry && entry.kind),
    code: legendNormalizeCode(entry && entry.code),
    meaning: legendNormalizeMeaning(entry && entry.meaning).toLowerCase(),
    targetHint: clean(entry && entry.targetHint),
    statement: clean(entry && entry.statement),
  })
}

export function legendEvidence(value) {
  const text = legendNormalizeMeaning(value)
  return text.length > LEGEND_EVIDENCE_MAX ? text.slice(0, LEGEND_EVIDENCE_MAX - 1) + '…' : text
}

/**
 * Build a knowledge entry. The id is derived from the semantic hash, never
 * from a counter or a clock, so re-analyzing the same page produces the same
 * id and reanalysis can tell "already seen" from "new".
 */
export function legendMakeEntry(input) {
  const entry = {
    kind: clean(input && input.kind) || 'reference-only',
    code: clean(input && input.code),
    meaning: legendNormalizeMeaning(input && input.meaning),
    targetHint: clean(input && input.targetHint),
    statement: clean(input && input.statement),
    sourceId: clean(input && input.sourceId),
    page: Math.max(0, Number(input && input.page) || 0),
    parserConfidence: Math.min(1, Math.max(0, Number(input && input.parserConfidence) || 0)),
    extractionMethod: clean(input && input.extractionMethod),
    evidenceSummary: legendEvidence(input && input.evidenceSummary),
  }
  if (input && input.detail && typeof input.detail === 'object') entry.detail = input.detail
  if (input && Array.isArray(input.conflicts) && input.conflicts.length) entry.conflicts = input.conflicts
  entry.semanticHash = legendEntrySemanticHash(entry)
  entry.id = 'entry-' + entry.semanticHash
  return entry
}

/**
 * Deterministic rule id from execution semantics.
 *
 * Provenance is deliberately NOT part of it -- and deliberately not stored in
 * the rule at all. profileExecutionSignature and the compiler fingerprint hash
 * the complete rule arrays, so a filename or a page number inside a rule would
 * make every reanalysis look like an executable change and force a needless
 * full hierarchy rebuild.
 */
export function legendRuleId(family, target, semantics) {
  const suffix = legendStableHash(semantics)
  const scope = clean(target) || 'any'
  return `legend-${clean(family) || 'rule'}-${scope}-${suffix}`
}

/** Group entries by the code they define, so conflicts are visible. */
export function legendGroupByCode(entries) {
  const groups = new Map()
  for (const entry of entries || []) {
    const key = legendNormalizeCode(entry && entry.code)
    if (!key) continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(entry)
  }
  return groups
}

/**
 * A code the document defines two different ways is genuinely unresolved. It
 * is reported rather than decided: picking the first occurrence would bury a
 * real drafting inconsistency behind a confident-looking rule.
 */
export function legendMarkConflicts(entries) {
  const groups = legendGroupByCode(entries)
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const meanings = new Set(group.map(entry => legendNormalizeMeaning(entry.meaning).toLowerCase()).filter(Boolean))
    if (meanings.size < 2) continue
    for (const entry of group) {
      entry.conflicts = [...meanings]
      entry.unresolved = true
    }
  }
  return entries
}
