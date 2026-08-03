/**
 * Deterministic legend documents for the parser and layout tests.
 *
 * These build canonical PAGES with positioned tokens -- the shape a real PDF
 * text layer or an OCR pass produces -- so the layout and parser stack is
 * exercised exactly as it would be in a browser, without needing one. The Node
 * VM harness has no Worker and no canvas, so real PDF/OCR integration is
 * verified separately; everything downstream of the adapter boundary is
 * verified here.
 *
 * Coordinates are top-down (y grows downward), matching what the adapters emit.
 */

const CHAR_WIDTH = 5.4
const LINE_HEIGHT = 12
const FONT_SIZE = 10

/** One positioned token. Width is derived from the text so gaps are realistic. */
export function token(text, x, y, opts = {}) {
  const size = opts.fontSize || FONT_SIZE
  const width = opts.width != null ? opts.width : String(text).length * (size * CHAR_WIDTH / FONT_SIZE)
  return {
    text: String(text),
    rawText: String(text),
    page: opts.page || 1,
    x0: x, y0: y, x1: x + width, y1: y + size,
    fontSize: size,
    confidence: opts.confidence != null ? opts.confidence : 1,
    extractionMethod: opts.extractionMethod || 'pdf-text',
  }
}

/**
 * Lay out a block of `[code, description]` pairs as an aligned two-column
 * table starting at (x, y). `codeWidth` is the distance to the description
 * column, which is what makes the columns detectably aligned.
 */
export function tableBlock(pairs, { x = 40, y = 60, codeWidth = 70, lineHeight = LINE_HEIGHT, opts = {} } = {}) {
  const tokens = []
  pairs.forEach(([code, description], row) => {
    const top = y + row * lineHeight
    if (code) tokens.push(token(code, x, top, opts))
    if (description) tokens.push(token(description, x + codeWidth, top, opts))
  })
  return tokens
}

/** A run of single-token lines, e.g. a heading or a block of prose. */
export function textBlock(lines, { x = 40, y = 60, lineHeight = LINE_HEIGHT, opts = {} } = {}) {
  return lines.map((line, row) => token(line, x, y + row * lineHeight, opts))
}

export function page(tokens, { number = 1, width = 612, height = 792, rotation = 0, extractionMethod = 'pdf-text', warnings = [] } = {}) {
  return { page: number, width, height, rotation, tokens, warnings, extractionMethod, ocrRecommended: false }
}

/* ---- named fixtures ---- */

/** A plain one-column list using inline `CODE - Meaning` pairs. */
export function oneColumnList() {
  return page([
    ...textBlock(['EQUIPMENT ABBREVIATIONS'], { x: 40, y: 40, opts: { fontSize: 13 } }),
    ...textBlock([
      'AAA - Air Handling Assembly',
      'BBB - Bus Bar Bank',
      'CCC - Cooling Circuit',
    ], { x: 40, y: 70 }),
  ])
}

/** Two aligned columns: code, description. */
export function twoColumnTable() {
  return page([
    ...textBlock(['EQUIPMENT ABBREVIATIONS'], { x: 40, y: 40, opts: { fontSize: 13 } }),
    ...tableBlock([
      ['AAA', 'Air Handling Assembly'],
      ['BBB', 'Bus Bar Bank'],
      ['CCC', 'Cooling Circuit'],
    ], { x: 40, y: 70 }),
  ])
}

/** Three columns: code, category, description. */
export function threeColumnTable() {
  const tokens = [...textBlock(['DEVICE CODES'], { x: 40, y: 40, opts: { fontSize: 13 } })]
  const rows = [
    ['AAA', 'Mechanical', 'Air Handling Assembly'],
    ['BBB', 'Electrical', 'Bus Bar Bank'],
    ['CCC', 'Mechanical', 'Cooling Circuit'],
  ]
  rows.forEach(([code, category, description], row) => {
    const y = 70 + row * LINE_HEIGHT
    tokens.push(token(code, 40, y), token(category, 110, y), token(description, 220, y))
  })
  return page(tokens)
}

/**
 * Two independent abbreviation blocks side by side.
 *
 * This is the fixture that catches naive reading-order extraction: read by
 * y-position alone, row one yields "AAA Air Handling Assembly QQQ Quench Panel".
 */
export function twoIndependentBands() {
  return page([
    ...tableBlock([
      ['AAA', 'Air Handling Assembly'],
      ['BBB', 'Bus Bar Bank'],
    ], { x: 40, y: 70 }),
    ...tableBlock([
      ['QQQ', 'Quench Panel'],
      ['RRR', 'Return Riser'],
    ], { x: 360, y: 70 }),
  ])
}

/** A table whose second description wraps onto a continuation line. */
export function wrappedDescriptions() {
  return page([
    ...tableBlock([
      ['AAA', 'Air Handling Assembly'],
      ['BBB', 'Bus Bar Bank serving the'],
    ], { x: 40, y: 70 }),
    // continuation: description column only, no code
    token('lower distribution level', 110, 70 + 2 * LINE_HEIGHT),
    ...tableBlock([['CCC', 'Cooling Circuit']], { x: 40, y: 70 + 3 * LINE_HEIGHT }),
  ])
}

/** The two-column table, drawn on a sheet rotated 90 degrees. */
export function rotatedTable() {
  const upright = twoColumnTable()
  // Invert the display rotation so normalising by 90 restores the original.
  const rotated = upright.tokens.map(item => ({
    ...item,
    x0: item.y0, y0: upright.width - item.x1,
    x1: item.y1, y1: upright.width - item.x0,
  }))
  return page(rotated, { width: upright.height, height: upright.width, rotation: 90 })
}

/** A worked tag-format example plus supported statements. */
export function tagAnatomyPage() {
  return page([
    ...textBlock(['TAG IDENTIFICATION'], { x: 40, y: 40, opts: { fontSize: 13 } }),
    ...textBlock([
      'ZZ9-QQQ-4321 = Building-Equipment Type-Unit',
      'Characters 1 through 3 indicate Building',
      'The second hyphen-delimited segment is Equipment Type',
    ], { x: 40, y: 70 }),
  ])
}

/** One page defining the same code two different ways. */
export function conflictingAbbreviations() {
  return page([
    ...textBlock(['ABBREVIATIONS'], { x: 40, y: 40, opts: { fontSize: 13 } }),
    ...tableBlock([
      ['AAA', 'Air Handling Assembly'],
      ['BBB', 'Bus Bar Bank'],
      ['AAA', 'Auxiliary Air Accumulator'],
    ], { x: 40, y: 70 }),
  ])
}

/**
 * A general-notes page carrying exactly one deterministic rule among prose
 * that must stay reference-only.
 */
export function generalNotesPage() {
  return page([
    ...textBlock(['GENERAL NOTES'], { x: 40, y: 40, opts: { fontSize: 13 } }),
    ...textBlock([
      'All work shall conform to the project specification and applicable codes.',
      'Contractor to verify all dimensions in the field prior to fabrication.',
      'Suffix A and B are panel sides and are not part of equipment identity.',
      'Refer to the electrical single line diagram for coordination requirements.',
    ], { x: 40, y: 70 }),
  ])
}

/** A scanned page: OCR-derived tokens carrying per-token confidence. */
export function scannedTable({ confidence = 0.62 } = {}) {
  return page(
    tableBlock([
      ['AAA', 'Air Handling Assembly'],
      ['B88', 'Bus Bar Bank'],
    ], { x: 40, y: 70, opts: { confidence, extractionMethod: 'pdf-ocr' } }),
    { extractionMethod: 'pdf-ocr' },
  )
}
