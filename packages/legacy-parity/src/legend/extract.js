import { clean } from '../core/text.js'
import { legendReconstructPage } from './layout.js'
import { LEGEND_EXTRACTOR_VERSION, legendHeadingFor } from './model.js'

/* ---- extraction adapter boundary ----
   Everything upstream of this file knows about PDFs, canvases, workers, and
   spreadsheets. Everything downstream knows only about rows of text with a
   page number and a confidence. That separation is what lets the entire
   parser/proposal/impact stack be tested in the Node VM harness, which has no
   Worker, no canvas, and a stubbed DOMParser.

   Two adapter shapes converge on one canonical page:

   - VISUAL sources (PDF text layer, OCR) emit positioned tokens, and layout
     reconstruction recovers lines, column bands, and code/description rows.
   - STRUCTURED sources (spreadsheet, CSV, pasted text) already carry the
     structure that reconstruction exists to recover. Round-tripping them
     through synthetic coordinates would be pure loss: it can only discard
     information we already had, and mis-split a two-column sheet whose cells
     happen to be far apart. */

export const LEGEND_SOURCE_KINDS = Object.freeze(['pdf', 'image', 'spreadsheet', 'text'])
export const LEGEND_EXTRACTION_METHODS = Object.freeze(['pdf-text', 'pdf-ocr', 'image-ocr', 'spreadsheet', 'text'])

/** Cancellation for scan and OCR. Cooperative -- adapters poll it. */
export function legendCancellation() {
  let cancelled = false
  return {
    cancel() { cancelled = true },
    get cancelled() { return cancelled },
    throwIfCancelled() { if (cancelled) throw new Error('Legend analysis cancelled') },
  }
}

export function legendToken(input) {
  const text = clean(input && input.text)
  return {
    text,
    rawText: input && input.rawText != null ? String(input.rawText) : text,
    page: Math.max(0, Number(input && input.page) || 0),
    x0: Number(input && input.x0) || 0,
    y0: Number(input && input.y0) || 0,
    x1: Number(input && input.x1) || 0,
    y1: Number(input && input.y1) || 0,
    fontSize: Number(input && input.fontSize) || 0,
    confidence: Math.min(1, Math.max(0, input && input.confidence != null ? Number(input.confidence) : 1)),
    extractionMethod: clean(input && input.extractionMethod) || 'text',
  }
}

function legendRow(code, description, text, confidence) {
  const joined = clean(text) || clean([code, description].filter(Boolean).join(' '))
  return { code: clean(code), description: clean(description), text: joined, confidence, tokens: [], wrapped: false }
}

/**
 * A structured page: one band, rows already paired. `columnX` is 0 because
 * there is no geometry to report -- the pairing came from the source's own
 * structure, not from measuring gaps.
 */
export function legendStructuredPage(rows, meta) {
  return {
    /* Pages are 1-based everywhere they are shown. Defaulting to 0 put "p. 0"
       in front of the user for any caller that did not pass one. */
    page: Math.max(1, Number(meta && meta.page) || 1),
    width: 0, height: 0, rotation: 0,
    layout: 'structured',
    extractionMethod: clean(meta && meta.extractionMethod) || 'text',
    spanning: [],
    bands: [{ x0: 0, x1: 0, columnX: 0, lines: [], rows }],
    warnings: (meta && meta.warnings) || [],
    ocrRecommended: false,
  }
}

/**
 * Spreadsheet or CSV rows (an array of arrays) to a canonical page.
 *
 * The first non-empty cell is the code and the rest of the row is the meaning.
 * A row with a single cell carries no pairing of its own and is handed on whole
 * for inline parsing, so `AAA = Air Handler` typed into one cell still works.
 */
export function legendPageFromRows(aoa, meta) {
  const rows = []
  for (const raw of aoa || []) {
    const cells = (raw || []).map(clean)
    const filled = cells.filter(Boolean)
    if (!filled.length) continue
    if (filled.length === 1) { rows.push(legendRow('', '', filled[0], 1)); continue }
    rows.push(legendRow(filled[0], filled.slice(1).join(' — '), filled.join(' '), 1))
  }
  return legendStructuredPage(rows, { ...meta, extractionMethod: 'spreadsheet' })
}

/**
 * Pasted or uploaded plain text to a canonical page. Each line is handed on
 * whole; splitting code from meaning is the parser's job, because only it
 * knows which inline forms are supported.
 */
export function legendPageFromText(text, meta) {
  const rows = []
  for (const line of String(text == null ? '' : text).split(/\r?\n/)) {
    const value = clean(line)
    if (value) rows.push(legendRow('', '', value, 1))
  }
  return legendStructuredPage(rows, { ...meta, extractionMethod: 'text' })
}

/** Positioned tokens to a canonical page, via layout reconstruction. */
export function legendPageFromTokens(page) {
  const reconstructed = legendReconstructPage(page)
  const confidences = ((page && page.tokens) || []).map(token => Number(token.confidence)).filter(Number.isFinite)
  const confidence = confidences.length ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length : 1
  for (const band of reconstructed.bands) {
    for (const row of band.rows) if (row.confidence == null) row.confidence = confidence
  }
  return {
    ...reconstructed,
    layout: 'visual',
    extractionMethod: clean(page && page.extractionMethod) || 'pdf-text',
    ocrRecommended: !!(page && page.ocrRecommended),
  }
}

/** Every row on a page, in reading order, band by band. */
export function legendPageRows(page) {
  const rows = []
  for (const band of (page && page.bands) || []) {
    for (const row of band.rows || []) rows.push({ ...row, page: page.page, bandX0: band.x0 })
  }
  return rows
}

/**
 * How much a page looks like a legend, 0..1.
 *
 * Used only to ORDER pages for review, never to exclude one. A user can always
 * select any page: a scoring heuristic that hid the real legend because it was
 * laid out unusually would be worse than no scoring at all.
 */
export function legendScorePage(page) {
  const rows = legendPageRows(page)
  if (!rows.length) return 0
  let headings = 0
  let pairs = 0
  let coded = 0
  for (const row of rows) {
    if (legendHeadingFor(row.text)) headings++
    if (row.code && row.description) { pairs++; continue }
    if (/^[A-Z0-9][A-Z0-9\-/_]{0,11}\s*(?:[=:]|[-–—])\s+\S/.test(row.text)) pairs++
    if (/^[A-Z0-9][A-Z0-9\-/_]{1,11}$/.test(clean(row.code) || clean(row.text))) coded++
  }
  const density = pairs / rows.length
  const codeDensity = Math.min(1, coded / Math.max(1, rows.length))
  const headingBoost = Math.min(0.35, headings * 0.18)
  return Math.min(1, density * 0.6 + codeDensity * 0.25 + headingBoost)
}

/**
 * Run the adapter registered for a source kind.
 *
 * Adapters are injected rather than imported so the harness can supply a
 * deterministic fake token source, and so the PDF and OCR adapters -- the only
 * ones needing a browser -- stay optional. A source whose adapter is absent
 * reports that plainly instead of failing deep inside the parser.
 */
export async function legendExtractPages(source, deps) {
  const adapters = (deps && deps.adapters) || {}
  const cancellation = (deps && deps.cancellation) || legendCancellation()
  const kind = clean(source && source.kind)
  const adapter = adapters[kind]
  if (typeof adapter !== 'function') {
    return { ok: false, code: 'no_adapter', message: `No extractor is available for ${kind || 'this file'}.`, pages: [] }
  }
  try {
    cancellation.throwIfCancelled()
    const produced = await adapter(source, { ...deps, cancellation })
    cancellation.throwIfCancelled()
    /* Reconstruct only what still needs it. An adapter may hand back raw
       positioned tokens OR pages it has already reconstructed (the PDF adapter
       does the latter, so it can score pages as it goes). Reconstructing a
       second time finds no `tokens` on the already-built page and silently
       produces nothing at all -- every band, row, and entry vanishes with no
       error anywhere. */
    const pages = (Array.isArray(produced) ? produced : (produced && produced.pages) || [])
      .filter(Boolean)
      .map(page => (Array.isArray(page.bands) ? page : legendPageFromTokens(page)))
    return {
      ok: true,
      pages,
      extractorVersion: LEGEND_EXTRACTOR_VERSION,
      ocrUsed: pages.some(page => String(page.extractionMethod).includes('ocr')),
    }
  } catch (error) {
    const message = clean(error && error.message) || 'Could not read that document.'
    return { ok: false, code: cancellation.cancelled ? 'cancelled' : 'extract_failed', message, pages: [] }
  }
}
