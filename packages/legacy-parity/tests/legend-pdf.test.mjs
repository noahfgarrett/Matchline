import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { LEGEND_PDF_MAX_PAGES, legendPdfAvailable, legendPdfRelease, legendPdfToken } from '../src/legend/pdf.js'
import { legendClusterLines } from '../src/legend/layout.js'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The PDF adapter's browser half -- module loading, workers, document parsing --
 * cannot run here: the Node VM harness has no Worker and no dynamic import of a
 * Blob URL. It is verified in a real browser instead (see the evidence report).
 *
 * What IS covered here is the part that gets silently wrong without a test:
 * the coordinate conversion out of PDF user space, and the guarantees about
 * what the vendored payload may and may not contain.
 */

/* ---------------------------------------------------------------------------
 * Coordinate conversion
 * ------------------------------------------------------------------------- */

test('a PDF text item converts from bottom-left baseline space to top-down boxes', () => {
  // PDF puts the origin bottom-left with y increasing upward, and transform[5]
  // is the BASELINE, not the top of the glyph box. The layout stack is top-down.
  // Getting this wrong flips the page and every line clusters in reverse.
  const token = legendPdfToken(
    { str: 'AAA', width: 24, height: 10, transform: [10, 0, 0, 10, 40, 700] },
    3, 792,
  )
  assert.equal(token.text, 'AAA')
  assert.equal(token.page, 3)
  assert.equal(token.x0, 40)
  assert.equal(token.x1, 64, 'width extends rightward from x')
  assert.equal(token.y1, 92, 'the baseline sits 792 - 700 from the top')
  assert.equal(token.y0, 82, 'and the box rises from the baseline by its height')
  assert.equal(token.fontSize, 10)
  assert.equal(token.extractionMethod, 'pdf-text')
})

test('a token near the top of the page converts to a small y, not a large one', () => {
  // The direct statement of the inversion: higher on the page means smaller y
  // once converted. Without the flip, reading order is bottom-to-top.
  const top = legendPdfToken({ str: 'TITLE', width: 60, height: 14, transform: [14, 0, 0, 14, 40, 740] }, 1, 792)
  const bottom = legendPdfToken({ str: 'note', width: 40, height: 10, transform: [10, 0, 0, 10, 40, 100] }, 1, 792)
  assert.ok(top.y0 < bottom.y0, 'text higher on the page must convert to a smaller y')
})

test('converted tokens cluster into lines in reading order', () => {
  // The property that matters downstream: a title above two table rows must
  // come out first, and each row's cells must group together.
  const items = [
    { str: 'EQUIPMENT ABBREVIATIONS', width: 200, height: 14, transform: [14, 0, 0, 14, 40, 740] },
    { str: 'AAA', width: 24, height: 10, transform: [10, 0, 0, 10, 40, 705] },
    { str: 'Air Handling Assembly', width: 110, height: 10, transform: [10, 0, 0, 10, 120, 705] },
    { str: 'BBB', width: 24, height: 10, transform: [10, 0, 0, 10, 40, 687] },
    { str: 'Bus Bar Bank', width: 70, height: 10, transform: [10, 0, 0, 10, 120, 687] },
  ]
  const lines = legendClusterLines(items.map(item => legendPdfToken(item, 1, 792)))
  assert.deepEqual(lines.map(line => line.text), [
    'EQUIPMENT ABBREVIATIONS',
    'AAA Air Handling Assembly',
    'BBB Bus Bar Bank',
  ])
})

test('a malformed text item degrades to zeros rather than NaN', () => {
  // A NaN coordinate poisons every median, gap, and comparison downstream, and
  // does it silently -- one bad item would take out the whole page.
  const token = legendPdfToken({ str: 'X' }, 1, 792)
  for (const key of ['x0', 'x1', 'y0', 'y1', 'fontSize']) {
    assert.equal(Number.isFinite(token[key]), true, `${key} must stay finite, got ${token[key]}`)
  }
})

/* ---------------------------------------------------------------------------
 * Availability
 * ------------------------------------------------------------------------- */

test('the extractor reports itself unavailable when the payload is absent', () => {
  // LEGEND_PDFJS_LIB is a global supplied by its own script block, which this
  // module context does not have. `typeof` on an undeclared identifier is the
  // only safe check, and getting it wrong throws a ReferenceError at import.
  assert.equal(legendPdfAvailable(), false)
  assert.doesNotThrow(() => legendPdfRelease(), 'releasing when nothing loaded must be safe')
})

/* ---------------------------------------------------------------------------
 * What the vendored payload may contain
 * ------------------------------------------------------------------------- */

test('the vendored PDF.js is the pinned Mozilla build, with its licence', () => {
  const licence = readFileSync(resolve(rootDir, 'src/vendor/legend/LICENSE-pdfjs.txt'), 'utf8')
  assert.match(licence, /Apache License/i)
  const lib = readFileSync(resolve(rootDir, 'src/vendor/legend/pdf.min.mjs'), 'utf8')
  const worker = readFileSync(resolve(rootDir, 'src/vendor/legend/pdf.worker.min.mjs'), 'utf8')
  assert.ok(lib.length > 100000, 'the library should be the real minified build')
  assert.ok(worker.length > 500000, 'the worker should be the real minified build')
})

test('the vendored payload can be embedded in a script block without escaping hazards', () => {
  // Two ways a source string breaks the page it is embedded in: `</script`
  // closes the block early, and `<!--` can start a comment. JSON.stringify
  // handles every JS-level escape but neither of these.
  for (const name of ['pdf.min.mjs', 'pdf.worker.min.mjs']) {
    const source = readFileSync(resolve(rootDir, 'src/vendor/legend', name), 'utf8')
    assert.equal(/<\/script/i.test(source), false, `${name} contains a script-closing sequence`)
    assert.equal(source.includes('<!--'), false, `${name} contains a comment opener`)
    assert.equal(JSON.parse(JSON.stringify(source)), source, `${name} does not survive JSON round-tripping`)
  }
})

test('the built artifact embeds PDF.js escaped, in its own block, with no external fetch target', () => {
  const html = readFileSync(resolve(rootDir, 'SSManagement.html'), 'utf8')
  assert.match(html, /const LEGEND_PDFJS_LIB="/)
  assert.match(html, /const LEGEND_PDFJS_WORKER="/)
  assert.equal((html.match(/<script>/g) || []).length, 4)
  // The only endpoint the app may reach remains the anonymous update check.
  const hosts = [...new Set((html.match(/https?:\/\/[a-zA-Z0-9.-]+/g) || []))]
    .filter(host => !/^https?:\/\/(www\.)?(w3\.org|purl\.org|purl\.oclc\.org|schemas\.|docs\.oasis|openoffice\.org|apache\.org|github\.com|a$|x$)/.test(host))
  assert.deepEqual(hosts.filter(host => host.includes('api.')), ['https://api.github.com'],
    `unexpected network host embedded: ${JSON.stringify(hosts)}`)
})

test('the page cap is a real bound, not an accident', () => {
  assert.ok(Number.isInteger(LEGEND_PDF_MAX_PAGES) && LEGEND_PDF_MAX_PAGES > 0)
  assert.ok(LEGEND_PDF_MAX_PAGES <= 1000, 'an unbounded scan would hang on a huge package')
})

/* ---------------------------------------------------------------------------
 * Fixtures
 * ------------------------------------------------------------------------- */

test('the browser-verification PDFs exist and are real PDFs', () => {
  for (const name of ['legend.pdf', 'legend-multipage.pdf']) {
    const bytes = readFileSync(resolve(rootDir, 'tests/fixtures', name))
    assert.equal(bytes.subarray(0, 5).toString('latin1'), '%PDF-', `${name} is not a PDF`)
    assert.ok(bytes.includes(Buffer.from('%%EOF')), `${name} is truncated`)
  }
})
