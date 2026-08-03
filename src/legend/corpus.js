import { clean } from '../core/text.js'
/* cleanTagRaw, deliberately NOT cleanTag. cleanTag is
   `ruleEngine().resolve(...).identity` -- it runs the GLOBALLY ACTIVE profile's
   Normalize rules, which is the exact leak this module exists to prevent. Worse,
   it makes identity-change impact unmeasurable: a suffix-stripping proposal
   cannot be seen to merge two tags if the active profile already stripped the
   suffix before the corpus recorded it. cleanTagRaw is unicode and separator
   cleanup only, with no site convention in it. */
import { cleanTagRaw } from '../core/tags.js'
import { profileManualFields, profileMappedHeaderRow, profileMapping } from '../profile/schema.js'
import { autoDetect, detectCable, detectMel, detectPmd, findHeaderRow, scanMappedHeader } from '../io/detect.js'
import { createEngine } from '../rules/engine.js'

/* ---- project tag corpus ----
   Every real tag the project actually contains, with where it came from.
   Proposals are checked against this before anything is preselected: a rule
   the document justifies but the corpus never matches is a rule about a site
   this is not.

   THE CANDIDATE-PROFILE RULE. Column resolution here takes an explicit profile
   and never falls back to activeProfile(). During profile creation the profile
   being validated is not the active one, and reading its tags through a
   different profile's column mappings yields a corpus of the wrong values --
   which then "confirms" proposals that are wrong. Every helper below is pure:
   raw rows in, records out, no ambient state. */

export const LEGEND_CORPUS_FIELDS = Object.freeze({
  easyPower: ['startingSource', 'downstream', 'finalSource', 'idName'],
  cable: ['loadName', 'panel', 'cableTag'],
  mel: ['equipmentTag', 'systemParent'],
  pmd: ['panel', 'instrumentTag'],
})

function legendMappedFields(kind, profile) {
  return profileManualFields(profileMapping(kind, profile))
}

function legendColumn(fields, id) {
  const value = fields[id]
  return value != null && Number.isInteger(Number(value)) ? Number(value) : -1
}

/**
 * Resolve the columns that carry tags, for one sheet, under one profile.
 *
 * The candidate profile's mapping wins; auto-detection fills the gaps. `overrides`
 * is a caller-supplied per-sheet column choice -- passed explicitly rather than
 * read from session state, so this stays a pure function of its arguments.
 */
export function legendResolveColumns(aoa, sourceKind, profile, overrides) {
  const rows = aoa || []
  const kind = clean(sourceKind) || 'easyPower'
  const fields = legendMappedFields(kind, profile)
  const stored = overrides || {}

  if (kind === 'cable') {
    const detected = scanMappedHeader(rows, detectCable, 30)
    const headerRow = profileMappedHeaderRow('cable', detected ? detected.headerRow : findHeaderRow(rows), profile)
    const map = detected ? detected.map : {}
    return {
      headerRow,
      columns: {
        loadName: legendColumn(fields, 'loadName') >= 0 ? legendColumn(fields, 'loadName') : (map['Load Name (To)'] ?? -1),
        panel: legendColumn(fields, 'panel') >= 0 ? legendColumn(fields, 'panel') : (map['Panel (From)'] ?? -1),
        cableTag: legendColumn(fields, 'cableTag') >= 0 ? legendColumn(fields, 'cableTag') : (map['Cable Tag'] ?? -1),
      },
    }
  }

  if (kind === 'pmd') {
    const detected = scanMappedHeader(rows, detectPmd, 60)
    const headerRow = profileMappedHeaderRow('pmd', detected ? detected.headerRow : findHeaderRow(rows), profile)
    const map = detected ? detected.map : {}
    return {
      headerRow,
      columns: {
        panel: legendColumn(fields, 'panel') >= 0 ? legendColumn(fields, 'panel') : (map.PANEL ?? -1),
        instrumentTag: legendColumn(fields, 'instrumentTag') >= 0 ? legendColumn(fields, 'instrumentTag') : (map['INSTRUMENT TAG'] ?? -1),
      },
    }
  }

  if (kind === 'mel') {
    const detected = scanMappedHeader(rows, detectMel, 200)
    const headerRow = profileMappedHeaderRow('mel', detected ? detected.headerRow : findHeaderRow(rows), profile)
    const map = detected ? detected.map : {}
    return {
      headerRow,
      columns: {
        equipmentTag: legendColumn(fields, 'equipmentTag') >= 0 ? legendColumn(fields, 'equipmentTag') : (map.tag ?? -1),
        systemParent: legendColumn(fields, 'systemParent') >= 0 ? legendColumn(fields, 'systemParent') : (map.systemParent ?? -1),
      },
    }
  }

  const headerRow = profileMappedHeaderRow('easyPower', findHeaderRow(rows), profile)
  const detected = autoDetect((rows[headerRow] || []).map(clean))
  const inRange = index => index != null && index >= 0 && index < (rows[headerRow] || []).length
  const startingSource = inRange(stored.source) ? stored.source
    : legendColumn(fields, 'startingSource') >= 0 ? legendColumn(fields, 'startingSource')
      : detected.sourceAuto
  const idName = inRange(stored.idName) ? stored.idName
    : legendColumn(fields, 'idName') >= 0 ? legendColumn(fields, 'idName')
      : detected.idAuto
  const mappedDownstream = Object.keys(fields)
    .filter(id => /^downstream\d+$/.test(id))
    .sort((left, right) => Number(left.replace(/\D/g, '')) - Number(right.replace(/\D/g, '')))
    .map(id => Number(fields[id]))
    .filter(index => index >= 0)
  return {
    headerRow,
    columns: {
      startingSource,
      idName,
      finalSource: legendColumn(fields, 'finalSource') >= 0 ? legendColumn(fields, 'finalSource') : detected.finalSourceAuto,
      downstream: mappedDownstream.length ? mappedDownstream : detected.dsPattern,
    },
  }
}

function legendPushRecord(records, seen, input) {
  const raw = cleanTagRaw(input.raw)
  if (!raw) return
  const key = input.normalized.toLowerCase() + '' + input.sourceKind + '' + input.semanticField
  const existing = seen.get(key)
  if (existing) { existing.occurrenceCount++; return }
  const record = {
    raw,
    normalized: input.normalized,
    sourceKind: input.sourceKind,
    fileId: input.fileId,
    sheet: input.sheet,
    row: input.row,
    semanticField: input.semanticField,
    occurrenceCount: 1,
  }
  seen.set(key, record)
  records.push(record)
}

function legendIndexAdd(index, key, value) {
  if (!key) return
  if (!index.has(key)) index.set(key, new Set())
  index.get(key).add(value)
}

/**
 * Build the corpus from loaded sheets under one candidate profile.
 *
 * `sheets` are `{fileId, sheet, sourceKind, aoa, overrides}`. Normalization uses
 * an engine bound to the CANDIDATE profile, so the canonical values a proposal
 * is measured against are the ones that profile would actually produce.
 */
export function legendBuildCorpus(sheets, profile) {
  const engine = createEngine(profile || {})
  const records = []
  const seen = new Map()

  for (const sheet of sheets || []) {
    const aoa = sheet && sheet.aoa
    if (!Array.isArray(aoa) || !aoa.length) continue
    const sourceKind = clean(sheet.sourceKind) || 'easyPower'
    const { headerRow, columns } = legendResolveColumns(aoa, sourceKind, profile, sheet.overrides)
    const fileId = clean(sheet.fileId)
    const sheetName = clean(sheet.sheet)

    const emit = (value, row, semanticField) => {
      const raw = cleanTagRaw(value)
      if (!raw) return
      legendPushRecord(records, seen, {
        raw, normalized: engine.resolve(raw, { sourceKind }).canonical,
        sourceKind, fileId, sheet: sheetName, row, semanticField,
      })
    }

    for (let row = headerRow + 1; row < aoa.length; row++) {
      const cells = aoa[row] || []
      if (sourceKind === 'easyPower') {
        if (columns.startingSource >= 0) emit(cells[columns.startingSource], row, 'startingSource')
        if (columns.idName >= 0) emit(cells[columns.idName], row, 'idName')
        if (columns.finalSource >= 0) emit(cells[columns.finalSource], row, 'finalSource')
        for (const index of columns.downstream || []) if (index >= 0) emit(cells[index], row, 'downstream')
        continue
      }
      for (const [field, index] of Object.entries(columns)) {
        if (Number.isInteger(index) && index >= 0) emit(cells[index], row, field)
      }
    }
  }

  return legendIndexCorpus(records)
}

/**
 * Index a record list for the lookups proposal scoring needs.
 *
 * Segments, prefixes, and suffixes are indexed from the CANONICAL value,
 * because that is the string Classify rules are evaluated against. Indexing the
 * raw value would report matches the engine never actually makes.
 */
export function legendIndexCorpus(records) {
  const byNormalized = new Map()
  const bySegment = new Map()
  const byPrefix = new Map()
  const bySuffix = new Map()
  const byPosition = new Map()
  const bySourceKind = new Map()
  const byField = new Map()

  for (const record of records || []) {
    const canonical = record.normalized
    const key = canonical.toLowerCase()
    if (!byNormalized.has(key)) byNormalized.set(key, [])
    byNormalized.get(key).push(record)
    legendIndexAdd(bySourceKind, record.sourceKind, key)
    legendIndexAdd(byField, record.semanticField, key)

    for (const delimiter of ['-', '_', '.', '/']) {
      const parts = canonical.split(delimiter)
      if (parts.length < 2) continue
      parts.forEach((part, index) => legendIndexAdd(bySegment, `${delimiter}${index}${part.toUpperCase()}`, key))
    }
    for (let length = 1; length <= Math.min(6, canonical.length); length++) {
      legendIndexAdd(byPrefix, canonical.slice(0, length).toUpperCase(), key)
      legendIndexAdd(bySuffix, canonical.slice(-length).toUpperCase(), key)
      legendIndexAdd(byPosition, `0${length}${canonical.slice(0, length).toUpperCase()}`, key)
    }
  }

  return {
    records,
    size: records.length,
    distinct: byNormalized.size,
    byNormalized, bySegment, byPrefix, bySuffix, byPosition, bySourceKind, byField,
    /** Distinct canonical tags whose segment `index` on `delimiter` equals `value`. */
    segmentMatches(delimiter, index, value) {
      return bySegment.get(`${delimiter}${index}${clean(value).toUpperCase()}`) || new Set()
    },
    prefixMatches(value) { return byPrefix.get(clean(value).toUpperCase()) || new Set() },
    suffixMatches(value) { return bySuffix.get(clean(value).toUpperCase()) || new Set() },
    exactMatches(value) { return byNormalized.get(clean(value).toLowerCase()) || [] },
    sourcesFor(key) {
      const found = byNormalized.get(clean(key).toLowerCase()) || []
      return [...new Set(found.map(record => record.sourceKind))]
    },
  }
}

/** An empty corpus, so callers never branch on null. */
export function legendEmptyCorpus() {
  return legendIndexCorpus([])
}

/**
 * What a character range actually holds across the project's real tags.
 *
 * This is the point of binding a range to a value list. The legend says
 * positions 2-4 mean "GIS numbering, 30/31/32"; only the corpus can say whether
 * the site agrees. Three answers matter and they are different problems:
 *
 * - documented: values in the tags that the legend explains
 * - undocumented: values in the tags the legend never mentions -- a gap in the
 *   drawing, or a sign the range is bound to the wrong position
 * - unused: codes the legend defines that no tag carries -- harmless, but a
 *   whole section of unused codes usually means the binding is wrong
 */
export function legendSliceCoverage(corpus, start, end, values) {
  const found = new Map()
  let tooShort = 0
  for (const records of ((corpus && corpus.byNormalized) || new Map()).values()) {
    const tag = records[0] && records[0].normalized
    if (!tag) continue
    if (tag.length < end) { tooShort++; continue }
    const value = tag.slice(start, end).toUpperCase()
    if (!value) continue
    found.set(value, (found.get(value) || 0) + 1)
  }
  const listed = new Set((values || []).map(entry => clean(entry && entry.code).toUpperCase()).filter(Boolean))
  const documented = []
  const undocumented = []
  for (const [value, count] of [...found.entries()].sort((left, right) => right[1] - left[1] || (left[0] < right[0] ? -1 : 1))) {
    (listed.has(value) ? documented : undocumented).push({ value, count })
  }
  return {
    tagsMatched: [...found.values()].reduce((sum, count) => sum + count, 0),
    tooShort,
    distinct: found.size,
    documented,
    undocumented,
    unused: [...listed].filter(code => !found.has(code)).sort(),
  }
}
