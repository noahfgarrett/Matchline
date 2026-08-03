import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  makeDefaultProfile,
  normalizeProfile,
  ruleSelection,
  profileAssignments,
  profileTrimmedTag,
  profileMappedColumn,
  profileMappedHeaderRow,
  profileCore,
  persistProfiles,
  installCurrentEagle,
  mergeProfileStores,
  PROFILE_STORE,
} from '../src/profile/schema.js'
import { RULES_SCHEMA_VERSION } from '../src/rules/schema.js'
import {
  isGisTag,
  isBusTag,
  isSpareName,
  isSpaceName,
  isNote,
  validLoad,
  bestFuzzy,
  topFuzzy,
  gisBusCut,
  nodeDep,
} from '../src/profile/classify.js'
import {
  profileFieldsFromHeaders,
  mergeDetectedProfileMapping,
  ensureProfileAutoMapping,
  detectMel,
  cableInfo,
  pmdInfo,
  melInfo,
  pmdPanelMatchParts,
  pmdPanelKey,
} from '../src/io/detect.js'
import { S } from '../src/state.js'
import { KEYSEP } from '../src/core/text.js'

/* Direct-import behavioral replacement for tests/profile-studio.test.mjs and the
   Profile-Studio-adjacent portions of tests/update-source.test.mjs (Task 9). These modules
   import cleanly under plain Node with no DOM: neither src/profile/schema.js,
   src/profile/classify.js, nor src/io/detect.js touches `document` at module scope. */

const ruleBase = { id: 'x', name: 'x', target: 'equipmentType', value: '', sourceKind: 'easyPower', enabled: true, strict: true, exclusions: [] }

test('ruleSelection evaluates every rule mode and honors exclusions', () => {
  const tag = 'F15-GIS-101'
  assert.equal(ruleSelection({ ...ruleBase, mode: 'contains', needle: 'GIS' }, tag), 'GIS')
  assert.equal(ruleSelection({ ...ruleBase, mode: 'prefix', needle: 'F15' }, tag), 'F15')
  assert.equal(ruleSelection({ ...ruleBase, mode: 'suffix', needle: '101' }, tag), '101')
  assert.equal(ruleSelection({ ...ruleBase, mode: 'slice', needle: 'GIS', start: 4, end: 7 }, tag), 'GIS')
  assert.equal(ruleSelection({ ...ruleBase, mode: 'segment', needle: 'GIS', segmentIndex: 1 }, tag), 'GIS')
  assert.equal(ruleSelection({ ...ruleBase, mode: 'contains', needle: 'GIS', exclusions: ['F15-GIS-101'] }, tag), null)
  assert.equal(ruleSelection({ ...ruleBase, mode: 'contains', needle: 'XYZ' }, tag), null, 'a non-matching needle selects nothing')
  assert.equal(ruleSelection({ ...ruleBase, mode: 'contains', needle: 'GIS', enabled: false }, tag), null, 'a disabled rule selects nothing')
})

test('profileAssignments scopes rules by target and source kind, and profileTrimmedTag strips configured suffixes', () => {
  const profile = makeDefaultProfile('Rule Test')
  profile.tagRules = [
    { ...ruleBase, id: 'first', name: 'GIS first', mode: 'contains', needle: 'GIS', value: 'TRAINED' },
    { ...ruleBase, id: 'second', name: 'Prefix second', mode: 'prefix', needle: 'F15', value: 'PANEL' },
    { ...ruleBase, id: 'building', name: 'Building all sources', target: 'building', mode: 'prefix', needle: 'F15', value: 'Building 15', sourceKind: '' },
    { ...ruleBase, id: 'suffix', name: 'Ignore DEV', target: 'ignoreSuffix', mode: 'suffix', needle: '_DEV', sourceKind: '', exclusions: ['KEEP_DEV'] },
  ]
  const easy = profileAssignments('F15-GIS-101', profile, 'easyPower').values
  const pmd = profileAssignments('F15-GIS-101', profile, 'pmd').values
  assert.deepEqual(easy, { equipmentType: 'TRAINED', building: 'Building 15', gisMarker: 'yes', matchKey: '-101' }, 'the first matching rule per target wins, scoped to easyPower')
  assert.deepEqual(pmd, { equipmentType: 'GIS', building: 'Building 15', gisMarker: 'yes', matchKey: '-101' }, 'sourceKind-scoped rules do not apply to a different source')
  assert.equal(profileTrimmedTag('TAG_DEV', profile, 'easyPower'), 'TAG')
  assert.equal(profileTrimmedTag('KEEP_DEV', profile, 'easyPower'), 'KEEP_DEV', 'an excluded value keeps its suffix')
})

test('makeDefaultProfile produces a complete schema with sensible defaults', () => {
  const profile = makeDefaultProfile('My Site')
  assert.equal(profile.name, 'My Site')
  assert.equal(profile.schemaVersion, RULES_SCHEMA_VERSION)
  assert.deepEqual(profile.tagRules, [])
  assert.deepEqual(profile.hierarchy.parentSourcePriority, ['cable', 'mel', 'easyPower', 'pmd'])
  assert.deepEqual(profile.details.layout, makeDefaultProfile().details.layout)
  assert.equal(profile.details.layout.length > 0, true)
})

test('the current Eagle preset is always installed without replacing project profiles', () => {
  const project=makeDefaultProfile('Project Copy')
  const installed=installCurrentEagle({activeId:project.id,profiles:[project]})
  assert.equal(installed.activeId,project.id)
  assert.equal(installed.profiles.filter(profile=>profile.builtIn).length,1)
  assert.equal(installed.profiles.find(profile=>profile.builtIn).id,'builtin-eagle')
  assert.ok(installed.profiles.some(profile=>profile.id===project.id))
})

test('an embedded update handoff merges only newer editable profile revisions', () => {
  const local={activeId:'project',profiles:[{id:'project',name:'Local',revision:4,updatedAt:'2026-01-02'}]}
  const incoming={activeId:'project',profiles:[
    {id:'project',name:'Transferred',revision:5,updatedAt:'2026-01-03'},
    {id:'builtin-eagle',name:'Untrusted built-in copy',revision:99,builtIn:true}
  ]}
  const merged=mergeProfileStores(local,incoming)
  assert.equal(merged.profiles.length,1)
  assert.equal(merged.profiles[0].name,'Transferred')
})

test('a freshly created profile reports the same schema version as a migrated one', () => {
  // makeDefaultProfile is the one construction path that does not run through
  // migrateProfile -- initProfiles seeds an empty store with it directly, and
  // activeProfile falls back to it. It used to stamp 1 while every stored
  // profile reported 2, and the export envelope declared 1 around a profile
  // declaring 2.
  const fresh = makeDefaultProfile('Fresh')
  assert.equal(fresh.schemaVersion, RULES_SCHEMA_VERSION)
  assert.equal(normalizeProfile(fresh).schemaVersion, fresh.schemaVersion,
    'normalising a fresh profile must not change the schema version it reports')
  assert.equal(normalizeProfile({ name: 'Imported' }).schemaVersion, RULES_SCHEMA_VERSION)

  assert.deepEqual(Object.keys(fresh.rules).sort(), ['classify', 'normalize', 'relate'],
    'a saved profile is a complete executable document, never a request for hidden fallback rules')
  assert.equal(fresh.presetId, 'eagle')
})

test('normalizeProfile fills in missing hierarchy sources, defaults invalid rules, and caps history', () => {
  const raw = {
    name: 'Imported',
    hierarchy: { parentSourcePriority: ['pmd'] },
    tagRules: [{ mode: 'contains' }],
    details: { layout: ['not-a-real-field'] },
    history: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  }
  const normalized = normalizeProfile(raw)
  assert.deepEqual(normalized.hierarchy.parentSourcePriority, ['pmd', 'cable', 'mel', 'easyPower'],
    'unlisted sources are appended after the configured priority, none are dropped')
  assert.equal(normalized.tagRules[0].target, 'equipmentType', 'a rule missing a target defaults to equipmentType')
  assert.equal(normalized.tagRules[0].enabled, true, 'a rule missing enabled defaults to true')
  assert.deepEqual(normalized.details.layout, makeDefaultProfile().details.layout,
    'a layout with no recognised field ids falls back to the default layout')
  assert.equal(normalized.history.length, 8, 'history is capped at 8 entries')
  assert.equal(normalizeProfile(null).name, 'Imported Site Profile', 'a missing name falls back to a default name')
})

test('semantic mappings override detected columns without exposing workbook data', () => {
  const profile = makeDefaultProfile('Mapping Test')
  profile.mappings.easyPower = { headerRow: 1, fields: { source: 4, idName: 9 } }
  PROFILE_STORE.activeId = profile.id
  PROFILE_STORE.profiles = [profile]
  assert.equal(profileMappedColumn('easyPower', 'source', 0), 4)
  assert.equal(profileMappedColumn('easyPower', 'idName', 0), 9)
  assert.equal(profileMappedColumn('easyPower', 'loadDesc', 12), 12, 'an unmapped field falls back to the caller-supplied column')
  assert.equal(profileMappedHeaderRow('easyPower', 0), 1)
  const coreKeys = Object.keys(profileCore(profile)).join(',')
  assert.doesNotMatch(coreKeys, /workbook|rows|files|viewCache|canonicalModel/,
    'profileCore (used for export/persistence) never carries loaded workbook data')
})

test('profileFieldsFromHeaders auto-detects columns for every supported source kind', () => {
  const detected = {
    easyPower: profileFieldsFromHeaders('easyPower', ['Starting Source', 'Downstream1', 'Downstream2', 'Final Source', 'ID Name', 'Load Description', 'Circuit #']),
    cable: profileFieldsFromHeaders('cable', ['Load Name (To)', 'Panel (From)', 'Cable Tag', 'Circuit_Number', 'Raceway']),
    pmd: profileFieldsFromHeaders('pmd', ['PANEL', 'INSTRUMENT TAG', 'CARD', 'POINT POSITION', 'DESCRIPTION']),
    mel: profileFieldsFromHeaders('mel', ['Equipment Tag', 'UPN', 'Bldg', 'System Parent Equipment Tag(s)']),
  }
  assert.deepEqual(detected, {
    easyPower: { startingSource: 0, downstream1: 1, downstream2: 2, finalSource: 3, idName: 4, loadDescription: 5, circuit: 6 },
    cable: { loadName: 0, panel: 1, cableTag: 2, circuitNumber: 3, raceway: 4 },
    pmd: { panel: 0, instrumentTag: 1, card: 2, pointPosition: 3, description: 4 },
    mel: { equipmentTag: 0, upn: 1, building: 2, systemParent: 3 },
  })
  assert.equal(profileFieldsFromHeaders('easyPower', ['Project title', 'Load Description', 'Circuit #']), null,
    'a header row missing the two required easyPower columns detects nothing')
})

test('mergeDetectedProfileMapping preserves manual edits across sheets and a reset restores full automatic mapping', () => {
  const profile = makeDefaultProfile('Auto Map Test')
  profile.mappings.easyPower = { fields: { startingSource: 8 }, ignoredFields: ['idName'] }
  const first = mergeDetectedProfileMapping(profile, 'easyPower', { headerRow: 1, fields: { startingSource: 0, idName: 4, loadDescription: 5 } }, false)
  assert.deepEqual({ changed: first.changed, count: first.count }, { changed: true, count: 3 })
  assert.deepEqual(profile.mappings.easyPower, {
    fields: { startingSource: 8, loadDescription: 5 }, ignoredFields: ['idName'], headerRow: 1, autoHeaderRow: true, autoFields: ['loadDescription'],
  }, 'the manually-set startingSource=8 survives; the ignored idName never gets auto-filled')

  mergeDetectedProfileMapping(profile, 'easyPower', { headerRow: 2, fields: { startingSource: 2, idName: 4, loadDescription: 6 } }, false)
  assert.deepEqual(profile.mappings.easyPower.fields, { startingSource: 8, loadDescription: 6 },
    'switching sample sheets updates the auto-detected column but keeps the manual one')

  const reset = mergeDetectedProfileMapping(profile, 'easyPower', { headerRow: 1, fields: { startingSource: 0, idName: 4, loadDescription: 5 } }, true)
  assert.deepEqual(reset.mapping, {
    fields: { startingSource: 0, idName: 4, loadDescription: 5 }, ignoredFields: [], headerRow: 1, autoHeaderRow: true,
    autoFields: ['startingSource', 'idName', 'loadDescription'],
  }, 'reset clears manual overrides and re-detects every field as automatic')

  const conflict = makeDefaultProfile('Conflict Test')
  conflict.mappings.easyPower = { fields: { loadDescription: 0 } }
  mergeDetectedProfileMapping(conflict, 'easyPower', { headerRow: 0, fields: { startingSource: 0, idName: 4 } }, false)
  assert.deepEqual(conflict.mappings.easyPower.fields, { loadDescription: 0, idName: 4 },
    'a detected column already occupied by a manual field (startingSource=0 collides with loadDescription=0) is skipped')
})

test('cableInfo, pmdInfo, and melInfo detect row-2 headers, and stale automatic fields clear when detection fails', () => {
  const profile = makeDefaultProfile('Header Mapping Test')
  profile.mappings.easyPower = {
    headerRow: 3, autoHeaderRow: true, fields: { startingSource: 0, idName: 1, loadDescription: 2 },
    autoFields: ['startingSource', 'idName'], sampleSheet: 'Old',
  }
  PROFILE_STORE.activeId = profile.id
  PROFILE_STORE.profiles = [profile]

  const put = (key, aoa) => S.aoaCache.set(key, { aoa, rowNums: aoa.map((_, i) => i), headerRow: 0, headers: aoa[0] || [], ws: {}, strikes: new Set() })
  const cableKey = 'profile-test-cable' + KEYSEP + 'Cable', pmdKey = 'profile-test-pmd' + KEYSEP + 'PMD'
  const melKey = 'profile-test-mel' + KEYSEP + 'MEL', unknownKey = 'profile-test-unknown' + KEYSEP + 'Unknown'
  put(cableKey, [['Cable Schedule'], ['Load Name (To)', 'Panel (From)'], ['LOAD-1', 'PANEL-1']])
  put(pmdKey, [['Point Master Database'], ['PANEL', 'INSTRUMENT TAG'], ['PANEL-1', 'INST-1']])
  put(melKey, [['Master Equipment List'], ['Equipment Tag', 'UPN'], ['EQUIP-1', '133']])
  put(unknownKey, [['Notes'], ['Nothing', 'Recognized']])

  assert.equal(cableInfo(cableKey).headerRow, 1)
  assert.equal(pmdInfo(pmdKey).headerRow, 1)
  assert.equal(melInfo(melKey).headerRow, 1)

  const stale = ensureProfileAutoMapping(profile, unknownKey, 'easyPower', false)
  assert.equal(stale.changed, true)
  assert.equal(stale.count, 0)
  assert.deepEqual(profile.mappings.easyPower.fields, { loadDescription: 2 },
    'when the sample sheet no longer detects easyPower columns, the previously automatic startingSource/idName are cleared, and the manual loadDescription survives')
  assert.deepEqual(profile.mappings.easyPower.autoFields, [])
})

test('detectMel finds Equipment Tag, UPN, building, system parent, discipline, and system description columns across header variants', () => {
  assert.deepEqual(detectMel(['Description', 'Equipment Tag', 'UPN', 'Bldg', 'System Parent Equipment Tag(s)']), { tag: 1, upn: 2, building: 3, systemParent: 4, discipline: -1, systemDescription: -1 })
  assert.deepEqual(detectMel(['Equipment Tag', 'UPN (Code)']), { tag: 0, upn: 1, building: -1, systemParent: -1, discipline: -1, systemDescription: -1 })
  assert.deepEqual(detectMel(['Equipment Tag', 'UPN', 'System Parent Equipment Tag(s)']), { tag: 0, upn: 1, building: -1, systemParent: 2, discipline: -1, systemDescription: -1 })
  assert.deepEqual(detectMel(['Equipment Tag', 'System Parent Equipment Tag(s)', 'Discipline', 'System Description']),
    { tag: 0, upn: -1, building: -1, systemParent: 1, discipline: 2, systemDescription: 3 },
    'the system-parent header must not be claimed as the system description')
  assert.equal(detectMel(['Equipment Tag', 'Description']).upn, -1, 'a missing UPN column is reported as -1, not absent')
  assert.equal(detectMel(['Equipment Tag', 'Description']).systemDescription, -1, 'a bare Description column is not a System Description column')
  assert.equal(detectMel(['Equipment', 'Unit Number']), null, 'no Equipment Tag column means no detection')
})

test('pmdPanelMatchParts strips CPS/NPS suffixes and separates a building prefix for cross-sheet matching', () => {
  assert.deepEqual(pmdPanelMatchParts('OO44-RIO650-02-1'), { key: 'oo44rio650021', matchKey: 'rio650021', building: 'OO44' })
  assert.equal(pmdPanelKey('RIO-1-09'), pmdPanelKey('RIO-1-09_CPS'), 'a CPS suffix does not change the panel identity')
  assert.equal(pmdPanelKey('RIO-1-09'), pmdPanelKey('RIO-1-09-NPS'), 'an NPS suffix does not change the panel identity')
})

test('tag classification predicates recognise GIS/BUS roles, spares, spaces, and notes', () => {
  assert.equal(isGisTag('F15-GIS-101'), true)
  assert.equal(isGisTag('F15-XFM-101'), false)
  assert.equal(isBusTag('BUS-A'), true)
  assert.equal(isBusTag('PANEL-A'), false)
  assert.equal(isSpareName('SP-100'), true)
  assert.equal(isSpareName('SPARE-1'), true)
  assert.equal(isSpareName('SPARENOTREAL'), false, 'a tag that merely starts with the word must not match')
  assert.equal(isSpaceName('SPACE-1'), true)
  assert.equal(isSpaceName('SPACENOTREAL'), false)
  assert.equal(isNote('NOTE 1'), true)
  assert.equal(isNote('NOT-A-NOTE'), false)
})

test('validLoad rejects blanks, NOTE placeholders, and a load description identical to its own parent', () => {
  assert.equal(validLoad('LOAD-1', 'PARENT-1'), true)
  assert.equal(validLoad('NOTE 1', 'PARENT-1'), false)
  assert.equal(validLoad('', 'PARENT-1'), false)
  assert.equal(validLoad('PARENT-1', 'PARENT-1'), false)
})

test('bestFuzzy and topFuzzy rank separator-insensitive matches by similarity', () => {
  const pool = ['TAG_100', 'TAG-101', 'TAG-200', 'OTHER']
  assert.deepEqual(bestFuzzy('TAG-100', pool), { match: 'TAG_100', pct: 100 })
  assert.equal(bestFuzzy('ZZZ-999', ['TAG-100']), null, 'nothing within the similarity floor returns null')
  assert.deepEqual(topFuzzy('TAG-100', pool, 2), [{ match: 'TAG_100', pct: 100 }, { match: 'TAG-101', pct: 83 }])
})

test('gisBusCut drops a BUS hop sandwiched between two GIS segments, repeating for nested occurrences', () => {
  assert.deepEqual(gisBusCut(['ROOT', 'GIS-1', 'BUS-A', 'GIS-2', 'LOAD']), ['GIS-2', 'LOAD'])
  assert.deepEqual(gisBusCut(['ROOT', 'PANEL', 'LOAD']), ['ROOT', 'PANEL', 'LOAD'], 'a path with no GIS-BUS-GIS pattern is unchanged')
})

test('nodeDep prefers an explicit override, then a load dependency, then the cable schedule map', () => {
  S.deps = new Map([['panel-1', 'DEP-A']])
  assert.equal(nodeDep({ name: 'X', dependencyOverride: 'OVERRIDE' }), 'OVERRIDE')
  assert.equal(nodeDep({ name: 'PANEL-1', isLoad: true, loadDependency: 'LOAD-DEP' }), 'LOAD-DEP')
  assert.equal(nodeDep({ name: 'PANEL-1' }), 'DEP-A', 'a non-load node falls back to the cable schedule dependency map')
})

test('persistProfiles writes only profile data to localStorage, never the session-only view caches', () => {
  const profile = makeDefaultProfile('Persist Test')
  PROFILE_STORE.activeId = profile.id
  PROFILE_STORE.profiles = [profile]
  const stored = new Map()
  const previousLocalStorage = globalThis.localStorage
  globalThis.localStorage = {
    getItem: key => stored.has(key)?stored.get(key):null,
    setItem: (key, value) => stored.set(key,String(value)),
    removeItem: key => stored.delete(key)
  }
  try {
    const ok = persistProfiles()
    assert.equal(ok, true)
    const generation=[...stored.entries()].find(([key])=>key.includes('.generation.'))
    assert.ok(generation,'a checksummed generation was written')
    const parsed = JSON.parse(generation[1]).payload
    assert.deepEqual(Object.keys(parsed).sort(), ['activeId', 'profiles', 'schemaVersion'])
    assert.doesNotMatch(JSON.stringify(parsed), /viewCache|canonicalModel|compareRows|reviewRows|workbook/)
  } finally {
    globalThis.localStorage = previousLocalStorage
  }
})
