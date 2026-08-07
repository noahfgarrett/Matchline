import assert from 'node:assert/strict'
import { test } from 'node:test'
import { legendClusterLines, legendDetectColumnBands, legendNormalizeRotation, legendReconstructPage } from '../src/legend/layout.js'
import { legendPageFromRows, legendPageFromText, legendPageFromTokens, legendPageRows, legendScorePage } from '../src/legend/extract.js'
import {
  oneColumnList, page, rotatedTable, threeColumnTable, token, tableBlock,
  twoColumnTable, twoIndependentBands, wrappedDescriptions,
} from './support/legend-fixtures.mjs'

const rowsOf = source => legendPageRows(legendPageFromTokens(source))

test('tokens on the same baseline cluster into one line, in reading order', () => {
  const lines = legendClusterLines(twoColumnTable().tokens)
  assert.equal(lines.length, 4, 'one heading plus three table rows')
  assert.equal(lines[1].text, 'AAA Air Handling Assembly')
  assert.equal(lines[3].text, 'CCC Cooling Circuit')
})

test('a one-column list yields one row per line', () => {
  const rows = rowsOf(oneColumnList())
  const texts = rows.map(row => row.text)
  assert.ok(texts.includes('AAA - Air Handling Assembly'))
  assert.ok(texts.includes('CCC - Cooling Circuit'))
})

test('an aligned two-column table splits code from description', () => {
  const rows = rowsOf(twoColumnTable()).filter(row => row.code && row.description)
  assert.deepEqual(rows.map(row => [row.code, row.description]), [
    ['AAA', 'Air Handling Assembly'],
    ['BBB', 'Bus Bar Bank'],
    ['CCC', 'Cooling Circuit'],
  ])
})

test('a three-column table keeps the category with the description, not the code', () => {
  // The code column is the one that matters; everything to its right is meaning.
  // Splitting on every gap would make "Mechanical" a second code.
  const rows = rowsOf(threeColumnTable()).filter(row => row.code && row.description)
  assert.deepEqual(rows.map(row => row.code), ['AAA', 'BBB', 'CCC'])
  assert.ok(rows[0].description.startsWith('Mechanical'))
  assert.ok(rows[0].description.includes('Air Handling Assembly'))
})

test('two side-by-side blocks are parsed as independent bands', () => {
  // The regression that motivates column-band detection at all. Read by
  // y-position alone, the first row of this page is
  // "AAA Air Handling Assembly QQQ Quench Panel" -- the right block's code
  // glued onto the left block's meaning.
  const reconstructed = legendPageFromTokens(twoIndependentBands())
  assert.equal(reconstructed.bands.length, 2, 'the page has two independent column bands')

  const pairs = legendPageRows(reconstructed).filter(row => row.code && row.description).map(row => [row.code, row.description])
  assert.deepEqual(pairs, [
    ['AAA', 'Air Handling Assembly'],
    ['BBB', 'Bus Bar Bank'],
    ['QQQ', 'Quench Panel'],
    ['RRR', 'Return Riser'],
  ])
  for (const [, description] of pairs) {
    assert.equal(/QQQ|RRR|AAA|BBB/.test(description), false, 'a meaning absorbed a code from the other band')
  }
})

test('a wrapped description is joined back onto its own row', () => {
  const rows = rowsOf(wrappedDescriptions()).filter(row => row.code && row.description)
  assert.deepEqual(rows.map(row => row.code), ['AAA', 'BBB', 'CCC'],
    'the continuation line must not become a codeless row of its own')
  assert.equal(rows[1].description, 'Bus Bar Bank serving the lower distribution level')
})

test('a rotated sheet is normalised before clustering', () => {
  const rotated = rotatedTable()
  const upright = legendNormalizeRotation(rotated)
  assert.equal(upright.rotation, 0)
  assert.equal(upright.width, 612, 'page dimensions swap back on a 90-degree page')

  const rows = rowsOf(rotated).filter(row => row.code && row.description)
  assert.deepEqual(rows.map(row => [row.code, row.description]), [
    ['AAA', 'Air Handling Assembly'],
    ['BBB', 'Bus Bar Bank'],
    ['CCC', 'Cooling Circuit'],
  ])
})

test('rotation normalisation is a no-op on an upright page', () => {
  const upright = twoColumnTable()
  const normalised = legendNormalizeRotation(upright)
  assert.deepEqual(
    normalised.tokens.map(item => [item.x0, item.y0]),
    upright.tokens.map(item => [item.x0, item.y0]),
  )
})

test('a full-width heading does not bridge two column bands', () => {
  // A spanning title covers both columns horizontally. Counted as ordinary
  // text it would close the gap between the bands and merge them.
  const source = page([
    token('SITE EQUIPMENT ABBREVIATIONS AND DEVICE CODE IDENTIFICATION SCHEDULE', 40, 40, { fontSize: 14 }),
    ...tableBlock([['AAA', 'Air Handling Assembly']], { x: 40, y: 80 }),
    ...tableBlock([['QQQ', 'Quench Panel']], { x: 360, y: 80 }),
  ])
  const { bands, spanning } = legendDetectColumnBands(source.tokens, source.width)
  assert.equal(spanning.length, 1, 'the title is reported as spanning, not as column content')
  assert.equal(bands.length, 2, 'the two blocks stay independent')
})

test('a single-column page produces exactly one band', () => {
  const { bands } = legendDetectColumnBands(twoColumnTable().tokens, 612)
  assert.equal(bands.length, 1)
})

test('band detection reads tokens, not clustered lines', () => {
  // On a two-column sheet every visual line spans both columns, so a
  // line-extent measurement finds one page-wide "line" and reports nothing to
  // split. This is the exact failure that made side-by-side blocks merge.
  const source = twoIndependentBands()
  const lineExtents = legendClusterLines(source.tokens).map(line => line.x1 - line.x0)
  assert.ok(Math.max(...lineExtents) > source.width * 0.6,
    'fixture precondition: a clustered line really does span most of the page')
  assert.equal(legendDetectColumnBands(source.tokens, source.width).bands.length, 2)
})

/* ---------------------------------------------------------------------------
 * Structured adapters
 * ------------------------------------------------------------------------- */

test('spreadsheet rows pair the first cell as code and the rest as meaning', () => {
  const built = legendPageFromRows([
    ['AAA', 'Air Handling Assembly'],
    ['BBB', 'Bus Bar Bank', 'Electrical'],
    [],
    ['CCC = Cooling Circuit'],
  ], { page: 1 })
  const rows = legendPageRows(built)
  assert.equal(built.layout, 'structured')
  assert.deepEqual(rows.map(row => row.code), ['AAA', 'BBB', ''])
  assert.ok(rows[1].description.includes('Bus Bar Bank'))
  assert.ok(rows[1].description.includes('Electrical'))
  assert.equal(rows[2].text, 'CCC = Cooling Circuit', 'a single cell is handed on whole for inline parsing')
})

test('pasted text becomes one row per non-empty line', () => {
  const built = legendPageFromText('AAA = Air Handling Assembly\n\n  \nBBB = Bus Bar Bank\n', {})
  assert.deepEqual(legendPageRows(built).map(row => row.text), ['AAA = Air Handling Assembly', 'BBB = Bus Bar Bank'])
})

test('page scoring ranks a legend above prose but never returns zero for a real table', () => {
  // Scoring only ORDERS pages for review. A page that scores low is still
  // selectable, so the cost of a bad guess is a scroll, not a missed legend.
  const legendScore = legendScorePage(legendPageFromTokens(twoColumnTable()))
  const proseScore = legendScorePage(legendPageFromText(
    'All work shall conform to the project specification.\nContractor to verify dimensions in the field.', {}))
  assert.ok(legendScore > proseScore, `legend ${legendScore} should outrank prose ${proseScore}`)
  assert.ok(legendScore > 0.3, `a plain two-column legend scored only ${legendScore}`)
})

test('reconstructing an empty page is safe', () => {
  const empty = legendReconstructPage(page([]))
  assert.deepEqual(empty.bands, [])
  assert.equal(legendScorePage(legendPageFromTokens(page([]))), 0)
})
