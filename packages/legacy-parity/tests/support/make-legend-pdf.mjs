/**
 * Generate the deterministic legend PDFs used for browser verification.
 *
 * Written by hand rather than with a library: these need to be reproducible
 * byte-for-byte, tiny, and free of any build-time dependency. Uncompressed
 * content streams and Helvetica keep them readable in a text editor, which
 * matters when a text-extraction bug needs diagnosing.
 *
 *   node tests/support/make-legend-pdf.mjs
 *
 * The Node VM harness has no PDF runtime, so these are exercised in a real
 * browser; everything downstream of the adapter boundary is covered by the
 * fixtures in legend-fixtures.mjs.
 */
import { writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const fixturesDir = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures')

/** Escape a string for a PDF literal. */
const pdfText = value => String(value).replace(/[\\()]/g, char => '\\' + char)

/** One `Td`-positioned text run. PDF origin is bottom-left. */
function textRun(x, y, size, value) {
  return `BT /F1 ${size} Tf 1 0 0 1 ${x} ${y} Tm (${pdfText(value)}) Tj ET`
}

/**
 * Assemble a single-page PDF from content-stream operators.
 * Offsets are computed after the fact so the xref table is always correct.
 */
function buildPdf(pages, { width = 612, height = 792 } = {}) {
  const objects = []
  const pageIds = pages.map((_, index) => 4 + index * 2)

  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'

  pages.forEach((content, index) => {
    const pageId = pageIds[index]
    const streamId = pageId + 1
    const rotate = content.rotate ? ` /Rotate ${content.rotate}` : ''
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}]${rotate} `
      + `/Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`
    const stream = content.operators.join('\n')
    objects[streamId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  })

  let out = '%PDF-1.4\n'
  const offsets = []
  for (let id = 1; id < objects.length; id++) {
    if (!objects[id]) continue
    offsets[id] = out.length
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`
  }
  const xrefAt = out.length
  const count = objects.length
  out += `xref\n0 ${count}\n0000000000 65535 f \n`
  for (let id = 1; id < count; id++) {
    out += offsets[id] == null
      ? '0000000000 65535 f \n'
      : `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  }
  out += `trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

/** A two-column abbreviation table plus a tag-format example and a note. */
function legendPage() {
  const operators = [textRun(40, 740, 14, 'EQUIPMENT ABBREVIATIONS')]
  const rows = [
    ['AAA', 'Air Handling Assembly'],
    ['BBB', 'Bus Bar Bank'],
    ['CCC', 'Cooling Circuit'],
    ['DDD', 'Discharge Damper'],
  ]
  rows.forEach(([code, meaning], index) => {
    const y = 705 - index * 18
    operators.push(textRun(40, y, 10, code), textRun(120, y, 10, meaning))
  })

  // A second, independent block on the right half of the same sheet. This is
  // the case that fails without column-band detection.
  operators.push(textRun(340, 740, 14, 'DEVICE CODES'))
  const right = [['QQQ', 'Quench Panel'], ['RRR', 'Return Riser']]
  right.forEach(([code, meaning], index) => {
    const y = 705 - index * 18
    operators.push(textRun(340, y, 10, code), textRun(420, y, 10, meaning))
  })

  operators.push(
    textRun(40, 600, 14, 'TAG IDENTIFICATION'),
    textRun(40, 575, 10, 'ZZ9-QQQ-4321 = Building-Equipment Type-Unit'),
    textRun(40, 557, 10, 'Characters 1 through 3 indicate Building'),
    textRun(40, 500, 14, 'GENERAL NOTES'),
    textRun(40, 475, 10, 'All work shall conform to the project specification.'),
    textRun(40, 457, 10, 'Suffix A and B are panel sides and are not part of equipment identity.'),
  )
  return { operators }
}

/** A page carrying no text at all, to exercise the no-searchable-text path. */
function imageOnlyPage() {
  return { operators: ['0.9 0.9 0.9 rg 60 500 480 200 re f'] }
}

writeFileSync(resolve(fixturesDir, 'legend.pdf'), buildPdf([legendPage()]))
writeFileSync(resolve(fixturesDir, 'legend-multipage.pdf'), buildPdf([
  { operators: [textRun(40, 740, 12, 'COVER SHEET'), textRun(40, 700, 10, 'Issued for construction.')] },
  imageOnlyPage(),
  legendPage(),
]))
console.log('wrote tests/fixtures/legend.pdf and legend-multipage.pdf')
