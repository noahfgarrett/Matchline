import assert from 'node:assert/strict'
import { test } from 'node:test'
import { legendLassoLines, legendLassoRect, legendLassoRegion, legendTokenOverlap, legendTokensInRect } from '../src/legend/lasso.js'
import { legendSampleTags, legendSections } from '../src/legend/parser.js'

/**
 * Lasso region selection.
 *
 * The user drags a box over a rendered sheet and the tokens inside it are
 * reconstructed on their own. These tests pin the geometry and the fact that a
 * selection reconstructs as its OWN page -- the part that makes a small
 * selection behave like a small document rather than a sliver of a big one.
 */

/* A token laid out like PDF.js emits them: upright, top-down, in points. */
function tok(text, x0, y0, width = text.length * 6, height = 10) {
  return { text, rawText: text, page: 1, x0, y0, x1: x0 + width, y1: y0 + height, fontSize: height, confidence: 1, extractionMethod: 'pdf-text' }
}

/* ---------------------------------------------------------------------------
 * Geometry
 * ------------------------------------------------------------------------- */

test('a drag is normalised low to high whichever way it was made', () => {
  const forward = legendLassoRect({ x: 10, y: 20 }, { x: 110, y: 220 })
  const backward = legendLassoRect({ x: 110, y: 220 }, { x: 10, y: 20 })
  assert.deepEqual(forward, { x0: 10, y0: 20, x1: 110, y1: 220 })
  assert.deepEqual(backward, forward)
})

test('a token fully inside overlaps completely and one fully outside not at all', () => {
  const rect = { x0: 0, y0: 0, x1: 100, y1: 100 }
  assert.equal(legendTokenOverlap(tok('IN', 10, 10, 20, 10), rect), 1)
  assert.equal(legendTokenOverlap(tok('OUT', 200, 200, 20, 10), rect), 0)
})

test('a token clipped by the edge is judged by how much of it is inside', () => {
  const rect = { x0: 0, y0: 0, x1: 100, y1: 100 }
  // 20pt wide, sitting at x 90..110 -- half in.
  assert.equal(legendTokenOverlap(tok('EDGE', 90, 10, 20, 10), rect), 0.5)
})

test('a clipped token still counts, because nobody drags a box that precisely', () => {
  const rect = { x0: 0, y0: 0, x1: 100, y1: 100 }
  const tokens = [tok('HALF', 90, 10, 20, 10), tok('SLIVER', 98, 30, 20, 10)]
  const picked = legendTokensInRect(tokens, rect).map(token => token.text)
  assert.deepEqual(picked, ['HALF'], 'half-in counts, a 10% sliver does not')
})

test('a degenerate zero-area token is judged by its centre, not by a fraction of zero', () => {
  const rect = { x0: 0, y0: 0, x1: 100, y1: 100 }
  const inside = { text: 'DOT', x0: 50, y0: 50, x1: 50, y1: 50 }
  const outside = { text: 'DOT', x0: 500, y0: 50, x1: 500, y1: 50 }
  assert.equal(legendTokenOverlap(inside, rect), 1)
  assert.equal(legendTokenOverlap(outside, rect), 0)
})

test('an empty drag selects nothing rather than everything', () => {
  const rect = legendLassoRect({ x: 40, y: 40 }, { x: 40, y: 40 })
  assert.deepEqual(legendTokensInRect([tok('AAA', 0, 0)], rect), [])
})

/* ---------------------------------------------------------------------------
 * Region reconstruction
 * ------------------------------------------------------------------------- */

/* Two abbreviation tables side by side, exactly the layout that defeats
   page-wide reconstruction. The user lassos only the right-hand one. */
const LEFT_COLUMN = [
  tok('TRAIN:', 40, 100), tok('A', 40, 120), tok('=', 60, 120), tok('TRAIN A', 80, 120),
  tok('B', 40, 140), tok('=', 60, 140), tok('TRAIN B', 80, 140),
]
const RIGHT_COLUMN = [
  tok('LEVEL:', 900, 100), tok('0', 900, 120), tok('=', 920, 120), tok('BASEMENT LEVEL', 940, 120),
  tok('1', 900, 140), tok('=', 920, 140), tok('GROUND LEVEL', 940, 140),
]
const SHEET_TOKENS = [...LEFT_COLUMN, ...RIGHT_COLUMN]

test('a lasso takes only the block it was drawn around', () => {
  const rect = legendLassoRect({ x: 880, y: 90 }, { x: 1200, y: 160 })
  const region = legendLassoRegion(SHEET_TOKENS, rect, { page: 3 })
  const lines = legendLassoLines(region)
  assert.ok(lines.some(line => line.includes('BASEMENT LEVEL')), JSON.stringify(lines))
  assert.ok(!lines.some(line => line.includes('TRAIN')), 'the other column leaked in: ' + JSON.stringify(lines))
})

test('a selection reconstructs in its own space, not the sheet\'s', () => {
  const rect = legendLassoRect({ x: 880, y: 90 }, { x: 1200, y: 160 })
  const region = legendLassoRegion(SHEET_TOKENS, rect, { page: 3 })
  assert.equal(region.width, 320, 'the page must report the rect size')
  assert.equal(region.height, 70)
  const xs = region.bands.flatMap(band => band.rows.map(row => row.x0))
  assert.ok(Math.min(...xs) >= 0, 'tokens must be translated into the rect: ' + JSON.stringify(xs))
})

test('a lassoed block parses into a bindable section', () => {
  const rect = legendLassoRect({ x: 880, y: 90 }, { x: 1200, y: 160 })
  const region = legendLassoRegion(SHEET_TOKENS, rect, { page: 3 })
  const sections = legendSections([region])
  assert.equal(sections.length, 1, JSON.stringify(sections))
  assert.equal(sections[0].title, 'LEVEL:')
  assert.deepEqual(sections[0].values.map(value => value.code), ['0', '1'])
  assert.deepEqual(sections[0].values.map(value => value.meaning), ['BASEMENT LEVEL', 'GROUND LEVEL'])
})

test('the page number a selection reports is the page it was drawn on', () => {
  const rect = legendLassoRect({ x: 880, y: 90 }, { x: 1200, y: 160 })
  assert.equal(legendSections([legendLassoRegion(SHEET_TOKENS, rect, { page: 7 })])[0].page, 7)
})

test('a lasso around a sample tag yields that tag', () => {
  const tokens = [tok('3AAAB-QQQ-00-A', 400, 300, 120, 12)]
  const rect = legendLassoRect({ x: 380, y: 290 }, { x: 540, y: 320 })
  const region = legendLassoRegion(tokens, rect, { page: 1 })
  assert.deepEqual(legendSampleTags([region]).map(tag => tag.text), ['3AAAB-QQQ-00-A'])
})

test('a lasso over blank paper produces an empty selection, not a crash', () => {
  const rect = legendLassoRect({ x: 5000, y: 5000 }, { x: 5200, y: 5200 })
  const region = legendLassoRegion(SHEET_TOKENS, rect, { page: 1 })
  assert.equal(region.tokenCount, 0)
  assert.deepEqual(legendLassoLines(region), [])
  assert.deepEqual(legendSections([region]), [])
})

test('a selection spanning both tables keeps them as separate blocks', () => {
  const rect = legendLassoRect({ x: 0, y: 90 }, { x: 1400, y: 160 })
  const region = legendLassoRegion(SHEET_TOKENS, rect, { page: 1 })
  const sections = legendSections([region])
  assert.deepEqual(sections.map(section => section.title).sort(), ['LEVEL:', 'TRAIN:'])
  const level = sections.find(section => section.title === 'LEVEL:')
  assert.deepEqual(level.values.map(value => value.meaning), ['BASEMENT LEVEL', 'GROUND LEVEL'],
    'the columns were merged, which is the failure band detection exists to prevent')
})

/* ---------------------------------------------------------------------------
 * Regressions found by lassoing a real rendered sheet
 * ------------------------------------------------------------------------- */

/* A table drawn the way real sheets draw them: a 14pt heading, a blank band of
   whitespace beneath it, then codes at x=40 with descriptions indented to
   x=120. The 80pt indent is the detail that matters. */
const REAL_TABLE = [
  tok('EQUIPMENT ABBREVIATIONS', 40, 38, 180, 14),
  tok('AAA', 40, 77, 18), tok('Air Handling Assembly', 120, 77, 110),
  tok('BBB', 40, 95, 18), tok('Bus Bar Bank', 120, 95, 70),
  tok('CCC', 40, 113, 18), tok('Cooling Circuit', 120, 113, 80),
]

test('lassoing one narrow table still pairs each code with its description', () => {
  // 270pt wide: the 80pt code-to-description indent is 30% of the SELECTION but
  // only 13% of the 612pt page. Judged against the selection it reads as a
  // column gutter, every code lands in one band and every description in
  // another, and the pairing is lost.
  const rect = legendLassoRect({ x: 20, y: 30 }, { x: 290, y: 130 })
  const sections = legendLassoRegion(REAL_TABLE, rect, { page: 1, pageWidth: 612 })
  const parsed = legendSections([sections])
  assert.equal(parsed.length, 1, JSON.stringify(parsed))
  assert.deepEqual(parsed[0].values.map(value => value.code + '=' + value.meaning), [
    'AAA=Air Handling Assembly', 'BBB=Bus Bar Bank', 'CCC=Cooling Circuit',
  ])
})

test('a heading in its own band still titles the list beneath it', () => {
  // A heading has whitespace under it, so block grouping puts it in a band of
  // its own. Tracked band-locally it never reaches the values it labels.
  const rect = legendLassoRect({ x: 20, y: 30 }, { x: 290, y: 130 })
  const region = legendLassoRegion(REAL_TABLE, rect, { page: 1, pageWidth: 612 })
  assert.equal(legendSections([region])[0].title, 'EQUIPMENT ABBREVIATIONS')
})

test('an inherited heading does not leak into an unrelated block beside it', () => {
  /* Two rows, not one: legendDetectCodeColumns refuses to infer a code column
     from a single line, so a one-row block genuinely cannot be split into
     code and meaning. Real tables have more than one row. */
  const withNeighbour = [
    ...REAL_TABLE,
    tok('DEVICE CODES', 340, 38, 90, 14),
    tok('QQQ', 340, 77, 18), tok('Quench Panel', 420, 77, 70),
    tok('RRR', 340, 95, 18), tok('Return Riser', 420, 95, 66),
  ]
  const rect = legendLassoRect({ x: 0, y: 30 }, { x: 600, y: 130 })
  const parsed = legendSections([legendLassoRegion(withNeighbour, rect, { page: 1, pageWidth: 612 })])
  assert.deepEqual(parsed.map(section => section.title), ['EQUIPMENT ABBREVIATIONS', 'DEVICE CODES'])
  assert.deepEqual(parsed[1].values.map(value => value.code), ['QQQ', 'RRR'])
  assert.deepEqual(parsed[0].values.map(value => value.code), ['AAA', 'BBB', 'CCC'])
})
