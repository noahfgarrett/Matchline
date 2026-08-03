import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RULES_SCHEMA_VERSION, emptyLegendTraining, migrateProfile } from '../src/rules/schema.js'
import {
  LEGEND_EVIDENCE_MAX, LEGEND_MAX_PENDING_ENTRIES, LEGEND_MAX_SERIALIZED_BYTES, LEGEND_MAX_SOURCES,
  clearLegendProvenance, legendRuleExecutionHash, legendRuleState, legendStableStringify,
  legendStripForHistory, normalizeLegendTraining, pruneLegendRuleOrigins,
} from '../src/profile/legend.js'
import { makeDefaultProfile, normalizeProfile, profileExecutionSignature, profileHistorySnapshot } from '../src/profile/schema.js'

/* ---------------------------------------------------------------------------
 * Migration
 * ------------------------------------------------------------------------- */

test('a v1 profile migrates to v3 and gains an empty legend container', () => {
  const v1 = { id: 'p1', name: 'Site A', tagRules: [{ id: 'r1', target: 'equipmentType' }] }
  const migrated = migrateProfile(v1)
  assert.equal(migrated.schemaVersion, RULES_SCHEMA_VERSION)
  assert.deepEqual(migrated.legendTraining, emptyLegendTraining())
  assert.deepEqual(migrated.tagRules, v1.tagRules, 'v1 data must survive')
})

test('a stored v2 profile migrates to v3 without a second copy of itself', () => {
  // migratedFrom exists so a pre-rules-engine profile can be rolled back. v2->v3
  // is purely additive, so capturing it here would hand every existing user a
  // complete duplicate of their own profile in localStorage the moment v3 shipped
  // -- to preserve a snapshot differing only by an empty container.
  const v2 = {
    id: 'p1', name: 'Site A', schemaVersion: 2,
    anatomies: [{ id: 'a1', pattern: '^B', delimiter: '-', segments: [] }],
    rules: { normalize: [], classify: [{ id: 'c1', target: 'building', kind: 'segment', segmentIndex: 0 }], relate: [] },
  }
  const migrated = migrateProfile(v2)
  assert.equal(migrated.schemaVersion, RULES_SCHEMA_VERSION)
  assert.equal(migrated.migratedFrom, undefined, 'an additive migration has no pre-rules payload to retain')
  assert.deepEqual(migrated.rules.classify, v2.rules.classify, 'authored rules must survive untouched')
  assert.deepEqual(migrated.legendTraining, emptyLegendTraining())
})

test('the pre-v2 payload is still captured once and never nests', () => {
  const v1 = { id: 'p1', name: 'Site A', tagRules: [] }
  let profile = migrateProfile(v1)
  for (let i = 0; i < 25; i++) profile = migrateProfile(profile)
  let depth = 0
  for (let cursor = profile; cursor && cursor.migratedFrom; cursor = cursor.migratedFrom) depth++
  assert.equal(depth, 1, 'migratedFrom nested instead of being captured once')
  assert.deepEqual(profile.migratedFrom, v1)
})

test('legend migration is idempotent and preserves existing knowledge', () => {
  const seeded = migrateProfile({
    id: 'p1', name: 'Site A',
    legendTraining: {
      version: 1,
      sources: [{ id: 'source-1', name: 'legend.pdf' }],
      pendingEntries: [{ id: 'entry-1', kind: 'abbreviation', code: 'XFM', meaning: 'Transformer' }],
      ruleOrigins: { 'legend-classify-equipmentType-abc': { sourceId: 'source-1', page: 3 } },
      dismissedEntryHashes: ['lgd1-deadbeef'],
    },
  })
  assert.deepEqual(migrateProfile(seeded), seeded, 'a second migration must change nothing')
  assert.equal(seeded.legendTraining.sources.length, 1)
  assert.equal(seeded.legendTraining.pendingEntries.length, 1)
})

test('a profile carrying a corrupt legend container is repaired, not rejected', () => {
  const damaged = migrateProfile({ id: 'p1', name: 'A', legendTraining: 'not an object' })
  assert.deepEqual(damaged.legendTraining, emptyLegendTraining())
  const arrayOrigins = migrateProfile({ id: 'p1', name: 'A', legendTraining: { ruleOrigins: ['wrong'] } })
  assert.deepEqual(arrayOrigins.legendTraining.ruleOrigins, {}, 'an array is not a rule-origin map')
})

/* ---------------------------------------------------------------------------
 * Rebuild isolation -- the property that keeps reviewing a document cheap
 * ------------------------------------------------------------------------- */

test('editing legend metadata does not change the execution signature', () => {
  // profileExecutionSignature decides whether a save forces a full hierarchy
  // rebuild. Analyzing a page, renaming a source, or adjusting an entry's
  // confidence changes nothing the engine executes, so none of it may register
  // here -- otherwise reviewing a legend costs a rebuild of the whole tree.
  const profile = normalizeProfile(makeDefaultProfile('Site'))
  const before = profileExecutionSignature(profile)
  profile.legendTraining.sources.push({ id: 'source-1', name: 'legend.pdf', pageCount: 12 })
  profile.legendTraining.pendingEntries.push({ id: 'entry-1', kind: 'abbreviation', code: 'XFM', meaning: 'Transformer' })
  profile.legendTraining.ruleOrigins['rule-9'] = { sourceId: 'source-1', page: 2 }
  assert.equal(profileExecutionSignature(profile), before, 'legend metadata leaked into the rebuild signal')
})

test('a real rule change still moves the execution signature', () => {
  // Control for the test above: proves the signature is not simply inert.
  const profile = normalizeProfile(makeDefaultProfile('Site'))
  const before = profileExecutionSignature(profile)
  profile.rules.classify.push({ id: 'c-new', target: 'building', kind: 'segment', segmentIndex: 0 })
  assert.notEqual(profileExecutionSignature(profile), before)
})

/* ---------------------------------------------------------------------------
 * Caps
 * ------------------------------------------------------------------------- */

test('pending entries, sources, and evidence excerpts are capped', () => {
  const container = normalizeLegendTraining({
    sources: Array.from({ length: LEGEND_MAX_SOURCES + 40 }, (_, i) => ({ id: 'source-' + i, name: 'f' + i })),
    pendingEntries: Array.from({ length: LEGEND_MAX_PENDING_ENTRIES + 200 }, (_, i) => ({
      id: 'entry-' + i, kind: 'abbreviation', code: 'C' + i, meaning: 'M',
      evidenceSummary: 'x'.repeat(LEGEND_EVIDENCE_MAX + 500),
    })),
  })
  assert.equal(container.sources.length, LEGEND_MAX_SOURCES)
  assert.ok(container.pendingEntries.length <= LEGEND_MAX_PENDING_ENTRIES)
  for (const entry of container.pendingEntries) {
    assert.ok(entry.evidenceSummary.length <= LEGEND_EVIDENCE_MAX, 'evidence excerpt exceeded its cap')
  }
})

test('an oversized container is trimmed to the serialized byte cap', () => {
  const container = normalizeLegendTraining({
    pendingEntries: Array.from({ length: LEGEND_MAX_PENDING_ENTRIES }, (_, i) => ({
      id: 'entry-' + i, kind: 'abbreviation', code: 'CODE' + i,
      meaning: 'A description long enough to matter '.repeat(4),
      evidenceSummary: 'y'.repeat(LEGEND_EVIDENCE_MAX),
      confidence: i / LEGEND_MAX_PENDING_ENTRIES,
    })),
  })
  assert.ok(legendStableStringify(container).length <= LEGEND_MAX_SERIALIZED_BYTES,
    'container exceeded the serialized cap after normalization')
  assert.ok(container.pendingEntries.length > 0, 'trimming must not empty the container outright')
  // Highest-confidence entries are the ones worth keeping.
  const confidences = container.pendingEntries.map(entry => entry.confidence)
  assert.deepEqual(confidences, [...confidences].sort((a, b) => b - a),
    'trimming should shed the least-confident knowledge first')
})

test('records that cannot be understood are dropped rather than half-repaired', () => {
  const container = normalizeLegendTraining({
    sources: [{ name: 'no id' }, { id: 'source-ok', name: 'fine' }, null, 'string'],
    pendingEntries: [
      { id: 'entry-1', kind: 'not-a-real-kind', code: 'X' },
      { kind: 'abbreviation', code: 'no id' },
      { id: 'entry-2', kind: 'abbreviation', code: 'XFM', meaning: 'Transformer' },
    ],
  })
  assert.deepEqual(container.sources.map(s => s.id), ['source-ok'])
  assert.deepEqual(container.pendingEntries.map(e => e.id), ['entry-2'])
})

/* ---------------------------------------------------------------------------
 * History
 * ------------------------------------------------------------------------- */

test('a history snapshot drops pending knowledge but keeps rule origins', () => {
  // Eight snapshots are retained. Without this, each one carries a full copy of
  // the pending-entry list and source metadata that describes the live profile,
  // not the snapshot -- nine copies of the same non-executable data.
  const profile = normalizeProfile(makeDefaultProfile('Site'))
  profile.legendTraining.sources.push({ id: 'source-1', name: 'legend.pdf', pageCount: 40 })
  profile.legendTraining.pendingEntries.push({ id: 'entry-1', kind: 'abbreviation', code: 'XFM', meaning: 'Transformer' })
  profile.legendTraining.ruleOrigins['rule-1'] = { sourceId: 'source-1', page: 3, entryIds: ['entry-1'] }

  const snapshot = profileHistorySnapshot(profile)
  assert.deepEqual(snapshot.legendTraining.sources, [])
  assert.deepEqual(snapshot.legendTraining.pendingEntries, [])
  assert.deepEqual(snapshot.legendTraining.ruleOrigins, profile.legendTraining.ruleOrigins,
    'origins are keyed to the snapshot rule ids and must survive')
  assert.equal(profile.legendTraining.sources.length, 1, 'the live profile must not be mutated')
})

test('legendStripForHistory tolerates a profile with no legend container', () => {
  assert.doesNotThrow(() => legendStripForHistory({ id: 'p1' }))
  assert.doesNotThrow(() => legendStripForHistory(null))
})

/* ---------------------------------------------------------------------------
 * Provenance lifecycle
 * ------------------------------------------------------------------------- */

test('origins for rules that no longer exist are pruned', () => {
  const profile = {
    anatomies: [{ id: 'anatomy-live' }],
    rules: { normalize: [], classify: [{ id: 'rule-live' }], relate: [] },
    legendTraining: {
      version: 1, sources: [], pendingEntries: [], dismissedEntryHashes: [],
      ruleOrigins: { 'rule-live': { page: 1 }, 'rule-gone': { page: 2 }, 'anatomy-live': { page: 3 } },
    },
  }
  pruneLegendRuleOrigins(profile)
  assert.deepEqual(Object.keys(profile.legendTraining.ruleOrigins).sort(), ['anatomy-live', 'rule-live'])
})

test('a generated rule reads as current until its execution semantics change', () => {
  const rule = { id: 'legend-classify-building-abc', target: 'building', kind: 'segment', segmentIndex: 0, value: 'B14' }
  const profile = {
    anatomies: [],
    rules: { normalize: [], classify: [rule], relate: [] },
    legendTraining: {
      version: 1, sources: [], pendingEntries: [], dismissedEntryHashes: [],
      ruleOrigins: { [rule.id]: { generatedExecutionHash: legendRuleExecutionHash(rule) } },
    },
  }
  assert.equal(legendRuleState(profile, rule.id), 'current')

  rule.name = 'Renamed by hand'
  rule.note = 'why I renamed it'
  assert.equal(legendRuleState(profile, rule.id), 'current',
    'renaming a rule does not change what it does')

  rule.segmentIndex = 2
  assert.equal(legendRuleState(profile, rule.id), 'edited',
    'changing which segment is read is an execution change')
})

test('a rule with no legend origin reports no state at all', () => {
  const profile = { anatomies: [], rules: { normalize: [], classify: [{ id: 'hand-authored' }], relate: [] }, legendTraining: emptyLegendTraining() }
  assert.equal(legendRuleState(profile, 'hand-authored'), '')
  assert.equal(legendRuleState(profile, 'nonexistent'), '')
})

test('a new profile created from another inherits no legend history', () => {
  const source = normalizeProfile(makeDefaultProfile('Site'))
  source.legendTraining.sources.push({ id: 'source-1', name: 'legend.pdf' })
  source.legendTraining.pendingEntries.push({ id: 'entry-1', kind: 'abbreviation', code: 'XFM', meaning: 'Transformer' })
  source.legendTraining.dismissedEntryHashes.push('lgd1-abc')
  source.legendTraining.ruleOrigins['rule-1'] = { sourceId: 'source-1' }

  const copy = clearLegendProvenance(JSON.parse(JSON.stringify(source)))
  assert.deepEqual(copy.legendTraining, emptyLegendTraining(),
    'a copy must not claim its inherited rules came from the original documents')
  assert.equal(source.legendTraining.sources.length, 1, 'the original must be untouched')
})

/* ---------------------------------------------------------------------------
 * Serialization boundary -- nothing raw may ever reach a stored profile
 * ------------------------------------------------------------------------- */

test('raw document state cannot survive normalization into a profile', () => {
  // The guarantee the whole feature rests on: whatever a caller attaches, only
  // the compact reviewed fields are kept. Anything resembling document bytes,
  // page text, or a worker handle is gone by the time the profile is stored.
  const profile = normalizeProfile({
    name: 'Site',
    legendTraining: {
      sources: [{
        id: 'source-1', name: 'legend.pdf', kind: 'pdf',
        bytes: new Array(64).fill(7), pdfDocument: { destroy() {} }, pageText: 'x'.repeat(5000),
        canvas: { width: 2000, height: 2000 }, blobUrl: 'blob:null/abc',
      }],
      pendingEntries: [{
        id: 'entry-1', kind: 'abbreviation', code: 'XFM', meaning: 'Transformer',
        ocrOutput: 'y'.repeat(9000), imageData: [1, 2, 3], worker: {},
      }],
    },
  })
  const serialized = JSON.stringify(profile.legendTraining)
  for (const banned of ['bytes', 'pdfDocument', 'pageText', 'canvas', 'blobUrl', 'ocrOutput', 'imageData', 'worker']) {
    assert.equal(serialized.includes(banned), false, `${banned} reached the persisted profile`)
  }
  assert.equal(profile.legendTraining.sources[0].name, 'legend.pdf', 'the reviewed metadata must survive')
  assert.equal(profile.legendTraining.pendingEntries[0].code, 'XFM')
})
