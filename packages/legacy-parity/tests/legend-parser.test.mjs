import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { legendPageFromRows, legendPageFromText, legendPageFromTokens } from '../src/legend/extract.js'
import { legendParsePages, legendParseStatement, legendSplitInline, legendParseAnatomyExample } from '../src/legend/parser.js'
import { legendHeadingFor, legendLooksLikeHeading, legendMakeEntry, legendNormalizeCode } from '../src/legend/model.js'
import {
  conflictingAbbreviations, generalNotesPage, oneColumnList, scannedTable,
  tagAnatomyPage, threeColumnTable, twoColumnTable, twoIndependentBands,
} from './support/legend-fixtures.mjs'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const parse = (source, meta) => legendParsePages([legendPageFromTokens(source)], { sourceId: 'source-1', ...meta })
const abbreviations = entries => entries.filter(entry => entry.kind === 'abbreviation' || entry.kind === 'code-list')

/* ---------------------------------------------------------------------------
 * Inline forms
 * ------------------------------------------------------------------------- */

test('every supported inline form splits code from meaning', () => {
  for (const [text, code, meaning] of [
    ['AAA = Air Handling Assembly', 'AAA', 'Air Handling Assembly'],
    ['BBB — Bus Bar Bank', 'BBB', 'Bus Bar Bank'],
    ['CCC – Cooling Circuit', 'CCC', 'Cooling Circuit'],
    ['DDD: Discharge Damper', 'DDD', 'Discharge Damper'],
    ['EEE - Exhaust Element', 'EEE', 'Exhaust Element'],
  ]) {
    const split = legendSplitInline(text)
    assert.ok(split, `no inline form matched ${text}`)
    assert.equal(split.code, code)
    assert.equal(split.meaning, meaning)
  }
})

test('a bare tag is never read as a definition', () => {
  // The trap the hyphen form exists to avoid. A sample tag printed on a legend
  // page would otherwise define "ZZ9" as meaning "QQQ-4321" for the whole site.
  assert.equal(legendSplitInline('ZZ9-QQQ-4321'), null)
  assert.equal(legendSplitInline('ZZ9-QQQ-4321-A'), null)
  // Spaces around the hyphen are what make it a definition rather than a tag.
  assert.equal(legendSplitInline('ZZ9 - Building Nine')?.code, 'ZZ9')
})

test('a sentence is not mistaken for a definition', () => {
  assert.equal(legendSplitInline('Contractor to verify all dimensions in the field.'), null)
})

/* ---------------------------------------------------------------------------
 * Tables
 * ------------------------------------------------------------------------- */

test('a two-column abbreviation table yields one entry per code', () => {
  const entries = abbreviations(parse(twoColumnTable()))
  assert.deepEqual(entries.map(entry => [entry.code, entry.meaning]), [
    ['AAA', 'Air Handling Assembly'],
    ['BBB', 'Bus Bar Bank'],
    ['CCC', 'Cooling Circuit'],
  ])
})

test('a one-column inline list yields the same entries as the table form', () => {
  const entries = abbreviations(parse(oneColumnList()))
  assert.deepEqual(entries.map(entry => entry.code), ['AAA', 'BBB', 'CCC'])
})

test('side-by-side blocks contribute their own entries, uncrossed', () => {
  const entries = abbreviations(parse(twoIndependentBands()))
  assert.deepEqual(entries.map(entry => [entry.code, entry.meaning]), [
    ['AAA', 'Air Handling Assembly'],
    ['BBB', 'Bus Bar Bank'],
    ['QQQ', 'Quench Panel'],
    ['RRR', 'Return Riser'],
  ])
})

test('a heading sets the target for the codes beneath it', () => {
  const entries = abbreviations(parse(threeColumnTable()))
  assert.ok(entries.length >= 3)
  for (const entry of entries) {
    assert.equal(entry.targetHint, 'equipmentType', 'a "DEVICE CODES" heading names the target')
  }
})

test('an unheaded block carries no target and is left for the user to choose', () => {
  const entries = abbreviations(legendParsePages([legendPageFromRows([
    ['AAA', 'Air Handling Assembly'],
    ['BBB', 'Bus Bar Bank'],
  ], {})], { sourceId: 'source-1' }))
  assert.equal(entries.length, 2)
  for (const entry of entries) assert.equal(entry.targetHint, '', 'a guessed target must not be presented as known')
})

test('a heading in one band does not govern the other band', () => {
  // Headings are tracked per band. A "Building Codes" heading over the left
  // column must not silently retarget an unrelated block on the right.
  const entries = abbreviations(parse({
    ...twoIndependentBands(),
    tokens: [
      { text: 'BUILDING CODES', page: 1, x0: 40, y0: 40, x1: 150, y1: 53, fontSize: 13, confidence: 1, extractionMethod: 'pdf-text' },
      ...twoIndependentBands().tokens,
    ],
  }))
  const left = entries.filter(entry => ['AAA', 'BBB'].includes(entry.code))
  const right = entries.filter(entry => ['QQQ', 'RRR'].includes(entry.code))
  assert.ok(left.length && right.length, 'both bands must still produce entries')
  assert.ok(left.every(entry => entry.targetHint === 'building'))
  assert.ok(right.every(entry => entry.targetHint === ''), 'the heading leaked across a column boundary')
})

/* ---------------------------------------------------------------------------
 * Anatomy and statements
 * ------------------------------------------------------------------------- */

test('a worked tag-format example becomes a tag-anatomy entry', () => {
  const parsed = legendParseAnatomyExample('ZZ9-QQQ-4321', 'Building-Equipment Type-Unit')
  assert.equal(parsed.kind, 'tag-anatomy')
  assert.equal(parsed.detail.delimiter, '-')
  assert.deepEqual(parsed.detail.segments.map(segment => segment.attribute), ['building', 'equipmentType', 'matchKey'])
})

test('a tag-format example is refused when the parts do not line up', () => {
  // A partly understood anatomy silently drops segments from every canonical
  // tag on the site, so a near miss must produce nothing at all.
  assert.equal(legendParseAnatomyExample('ZZ9-QQQ-4321', 'Building-Equipment Type'), null)
  assert.equal(legendParseAnatomyExample('ZZ9-QQQ-4321', 'Building-Widget-Unit'), null,
    'an unrecognised label must not be silently skipped')
})

test('the supported statement forms are recognised', () => {
  const cases = [
    ['Characters 1 through 3 indicate Building', 'slice', { start: 0, end: 3, attribute: 'building' }],
    ['The second hyphen-delimited segment is Equipment Type', 'segment', { index: 1, delimiter: '-', attribute: 'equipmentType' }],
    ['Everything before the first underscore is the parent tag', 'prefixSplit', { delimiter: '_' }],
  ]
  for (const [text, form, expected] of cases) {
    const parsed = legendParseStatement(text)
    assert.ok(parsed, `statement not recognised: ${text}`)
    assert.equal(parsed.detail.form, form)
    for (const [key, value] of Object.entries(expected)) assert.equal(parsed.detail[key], value, `${text} -> ${key}`)
  }
})

test('a suffix statement becomes a normalization entry', () => {
  const parsed = legendParseStatement('Suffix A and B are panel sides and are not part of equipment identity.')
  assert.equal(parsed.kind, 'normalization')
  assert.deepEqual(parsed.detail.suffixes, ['A', 'B'])
})

test('parent-language statements become relationship and root entries', () => {
  const matched = legendParseStatement('QQQ equipment is parented to the ZZZ with the same unit code')
  assert.equal(matched.kind, 'relationship')
  assert.equal(matched.detail.form, 'attributeMatch')
  assert.equal(matched.detail.childType, 'QQQ')
  assert.equal(matched.detail.parentType, 'ZZZ')

  const root = legendParseStatement('Unparented QQQ equipment belongs below 602 Medium Voltage')
  assert.equal(root.kind, 'hierarchy-root')
  assert.equal(root.detail.equipmentType, 'QQQ')
  assert.equal(root.detail.parent, '602 Medium Voltage')
})

test('an unrecognised section label ends the previous section', () => {
  // Regression from a real equipment-numbering sheet. Its sections run
  // "EQUIPMENT TYPE:", then "LEVEL:", then "EQUIPMENT VOLTAGE:", then
  // "POWER SUPPLY:" -- only the first is in the vocabulary, so the rest
  // inherited it and every level, voltage, and power-supply code came out
  // labelled an equipmentType. Wrong with confidence is worse than unlabelled.
  const entries = legendParsePages([legendPageFromText([
    'EQUIPMENT TYPE:',
    'QQQ = Quench Panel',
    'LEVEL:',
    '0 = Basement Level / Below Grade',
    '1 = Ground Level / First Level',
    'POWER SUPPLY:',
    'N = Normal',
    'E = Emergency',
  ].join('\n'), {})], { sourceId: 'source-1' })
    .filter(entry => entry.kind !== 'reference-only')

  const target = code => entries.find(entry => entry.code === code).targetHint
  assert.equal(target('QQQ'), 'equipmentType', 'a code genuinely under the heading keeps it')
  for (const code of ['0', '1', 'N', 'E']) {
    assert.equal(target(code), '', `${code} sits under a different section and must not inherit equipmentType`)
  }
})

test('a section label is recognised by shape, and a bare code or sample tag is not', () => {
  // Narrow on purpose. Clearing the heading on every short upper-case line
  // would wipe the context off a table whose rows have no description.
  for (const label of ['LEVEL:', 'POWER SUPPLY:', 'SEQUENTIAL NUMBER', 'COLUMN LINE NUMERIC (TWO DIGITS)', 'Panel Voltages:']) {
    assert.equal(legendLooksLikeHeading(label), true, `${label} should read as a section label`)
  }
  for (const notLabel of ['AAA', 'ZZ9-QQQ-0001', '001, 002, 003, (ETC)', 'AAA = Air Handling Assembly', '']) {
    assert.equal(legendLooksLikeHeading(notLabel), false, `${notLabel} must not read as a section label`)
  }
})

test('a line that defines something is never swallowed as a heading', () => {
  // Regression, found in the browser. `ZZ9-QQQ-4321 = Building-Equipment Type-Unit`
  // contains the words "Equipment Type", so the equipment-heading pattern
  // claimed the whole line and the worked tag-format example vanished --
  // taking the anatomy with it, and leaving every abbreviation on the page to
  // fall back to a rule per code.
  assert.equal(legendHeadingFor('ZZ9-QQQ-4321 = Building-Equipment Type-Unit'), null)
  assert.equal(legendHeadingFor('AAA - Equipment Codes for the north yard'), null)
  // A real heading still reads as one, with or without a trailing colon.
  assert.ok(legendHeadingFor('EQUIPMENT ABBREVIATIONS'))
  assert.ok(legendHeadingFor('Tag Identification'))
  assert.ok(legendHeadingFor('Equipment Abbreviations:'))

  const entries = legendParsePages([legendPageFromText([
    'TAG IDENTIFICATION',
    'ZZ9-QQQ-4321 = Building-Equipment Type-Unit',
  ].join('\n'), {})], { sourceId: 'source-1' })
  const anatomy = entries.find(entry => entry.kind === 'tag-anatomy' && entry.detail.form === 'anatomy')
  assert.ok(anatomy, `the worked example was lost: ${JSON.stringify(entries.map(e => [e.kind, e.meaning]))}`)
  assert.deepEqual(anatomy.detail.segments.map(segment => segment.attribute), ['building', 'equipmentType', 'matchKey'])
})

test('a tag-identification page produces an anatomy and its statements', () => {
  const entries = parse(tagAnatomyPage())
  const kinds = entries.filter(entry => entry.kind === 'tag-anatomy')
  assert.ok(kinds.some(entry => entry.detail.form === 'anatomy'), 'the worked example was not interpreted')
  assert.ok(kinds.some(entry => entry.detail.form === 'slice'), 'the character-range statement was not interpreted')
  assert.ok(kinds.some(entry => entry.detail.form === 'segment'), 'the ordinal-segment statement was not interpreted')
})

/* ---------------------------------------------------------------------------
 * Prose restraint
 * ------------------------------------------------------------------------- */

test('a general-notes page yields exactly one rule and keeps the rest as reference', () => {
  const entries = parse(generalNotesPage())
  const actionable = entries.filter(entry => entry.kind !== 'reference-only')
  assert.equal(actionable.length, 1, `expected one actionable note, got ${JSON.stringify(actionable.map(e => e.meaning))}`)
  assert.equal(actionable[0].kind, 'normalization')
  assert.deepEqual(actionable[0].detail.suffixes, ['A', 'B'])

  const reference = entries.filter(entry => entry.kind === 'reference-only')
  assert.ok(reference.length >= 3, 'the surrounding construction notes must be retained, not discarded')
  assert.ok(reference.every(entry => entry.parserConfidence < 0.5),
    'unparsed prose must not present itself as confident knowledge')
})

test('unrelated construction prose never becomes an actionable entry', () => {
  const entries = legendParsePages([legendPageFromText([
    'All penetrations shall be fire-stopped per the project specification.',
    'Coordinate final routing with the mechanical contractor before rough-in.',
    'See sheet E-101 for the complete single line diagram.',
    'Revision 3 issued for construction on 14 March.',
  ].join('\n'), {})], { sourceId: 'source-1' })
  assert.ok(entries.every(entry => entry.kind === 'reference-only'),
    `prose produced an actionable entry: ${JSON.stringify(entries.filter(e => e.kind !== 'reference-only'))}`)
})

/* ---------------------------------------------------------------------------
 * Conflicts and confidence
 * ------------------------------------------------------------------------- */

test('a code defined two ways stays unresolved rather than first-wins', () => {
  const entries = abbreviations(parse(conflictingAbbreviations()))
  const clashing = entries.filter(entry => entry.code === 'AAA')
  assert.equal(clashing.length, 2, 'both readings must be retained')
  for (const entry of clashing) {
    assert.equal(entry.unresolved, true)
    assert.equal(entry.conflicts.length, 2, 'the competing meanings must both be reported')
  }
  assert.equal(entries.find(entry => entry.code === 'BBB').unresolved, undefined,
    'an unambiguous code must not be dragged into the conflict')
})

test('OCR confidence flows through to entry confidence', () => {
  const clean = abbreviations(parse(twoColumnTable()))
  const scanned = abbreviations(parse(scannedTable({ confidence: 0.62 })))
  assert.ok(scanned.length > 0)
  assert.ok(scanned[0].parserConfidence < clean[0].parserConfidence,
    'a low-confidence scan must not read as confidently as clean text')
})

/* ---------------------------------------------------------------------------
 * Determinism and site-neutrality
 * ------------------------------------------------------------------------- */

test('the same document always produces the same entry ids', () => {
  const first = parse(twoColumnTable())
  const second = parse(twoColumnTable())
  assert.deepEqual(first.map(entry => entry.id), second.map(entry => entry.id))
  assert.ok(first.every(entry => entry.id.startsWith('entry-')))
})

test('codes compare without regard to separator spacing', () => {
  // A draftsman spacing a code for legibility must not create a second code.
  assert.equal(legendNormalizeCode('ZZ9 - QQQ'), legendNormalizeCode('ZZ9-QQQ'))
  assert.equal(legendNormalizeCode('zz9-qqq'), 'ZZ9-QQQ')
  assert.equal(
    legendMakeEntry({ kind: 'abbreviation', code: 'ZZ9 - QQQ', meaning: 'X' }).semanticHash,
    legendMakeEntry({ kind: 'abbreviation', code: 'ZZ9-QQQ', meaning: 'X' }).semanticHash,
  )
})

test('the extractor hardcodes no site vocabulary', () => {
  // The legend teaches the app a site's abbreviations. Baking any real site's
  // codes into the parser would make it right for one project and quietly wrong
  // for every other one.
  const sources = ['model.js', 'layout.js', 'extract.js', 'parser.js']
    .map(name => readFileSync(resolve(rootDir, 'src/legend', name), 'utf8')).join('\n')
  for (const term of ['XFM', 'GIS', 'LVS', 'SCR', 'SCC', 'CIM', 'MAH', 'Eagle']) {
    assert.equal(new RegExp(`\\b${term}\\b`).test(sources), false,
      `${term} is hardcoded in the legend extractor`)
  }
})
