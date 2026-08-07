import { clean } from '../core/text.js'
import { legendPageFromTokens, legendScorePage, legendToken } from './extract.js'
import { legendNormalizeRotation } from './layout.js'

/* ---- searchable-PDF adapter ----
   PDF.js is vendored as SOURCE TEXT (see build/build.mjs) rather than as
   executed code, for two reasons: the library is an ES module, which a classic
   script cannot host, and its worker has to be constructed from a URL. Both are
   handed to URL.createObjectURL on demand.

   Verified under file:// during the compatibility spike: a blob-URL module
   loads, a REAL Worker is constructed rather than PDF.js's main-thread
   fallback, a local File's bytes parse, and destroy/revoke cleans up. Nothing
   is decoded at boot -- the 1.8 MB of source sits as two untouched strings
   until someone actually uploads a PDF.

   No OCR in this build. A page with no text layer is reported as exactly that
   rather than being silently skipped, so a scanned package says why it produced
   nothing instead of looking empty. */

/** Longest edge of a rendered page, in pixels. See legendPdfRenderPage. */
export const LEGEND_PDF_MAX_CANVAS = 2400
/** Pages scanned for text before the user is asked to narrow the selection. */
export const LEGEND_PDF_MAX_PAGES = 400

let legendPdfModule = null
let legendPdfLibUrl = ''
let legendPdfWorkerUrl = ''

export function legendPdfAvailable() {
  return typeof LEGEND_PDFJS_LIB === 'string' && LEGEND_PDFJS_LIB.length > 0
    && typeof LEGEND_PDFJS_WORKER === 'string' && LEGEND_PDFJS_WORKER.length > 0
}

/**
 * Load PDF.js once, lazily.
 *
 * The blob URLs are retained for the life of the page deliberately: the module
 * and its worker script are re-fetched by the browser whenever a new document
 * is opened, so revoking them after the first parse breaks every later one.
 * They are two URL handles, not two copies of the payload.
 */
export async function legendPdfLoad() {
  if (legendPdfModule) return legendPdfModule
  if (!legendPdfAvailable()) throw new Error('The PDF extractor is not included in this build.')
  legendPdfLibUrl = URL.createObjectURL(new Blob([LEGEND_PDFJS_LIB], { type: 'text/javascript' }))
  legendPdfWorkerUrl = URL.createObjectURL(new Blob([LEGEND_PDFJS_WORKER], { type: 'text/javascript' }))
  const loaded = await import(legendPdfLibUrl)
  loaded.GlobalWorkerOptions.workerSrc = legendPdfWorkerUrl
  legendPdfModule = loaded
  return legendPdfModule
}

/** Release the module and its blob URLs. Safe to call when nothing is loaded. */
export function legendPdfRelease() {
  for (const url of [legendPdfLibUrl, legendPdfWorkerUrl]) {
    if (url) { try { URL.revokeObjectURL(url) } catch (_) { /* already revoked */ } }
  }
  legendPdfLibUrl = ''
  legendPdfWorkerUrl = ''
  legendPdfModule = null
}

/**
 * One PDF.js text item to a canonical token.
 *
 * PDF user space puts the origin bottom-left with y increasing upward; the
 * layout stack works top-down. `transform[5]` is the BASELINE, so the glyph box
 * runs from the baseline up by `height` -- which inverts to
 * `[pageHeight - baseline - height, pageHeight - baseline]` top-down. Getting
 * this wrong flips the page and every line clusters in the wrong order.
 */
export function legendPdfToken(item, pageNumber, pageHeight) {
  const transform = item.transform || [0, 0, 0, 0, 0, 0]
  const x0 = Number(transform[4]) || 0
  const baseline = Number(transform[5]) || 0
  const width = Number(item.width) || 0
  const height = Number(item.height) || Math.abs(Number(transform[3])) || 0
  return legendToken({
    text: item.str,
    rawText: item.str,
    page: pageNumber,
    x0,
    x1: x0 + width,
    y0: pageHeight - baseline - height,
    y1: pageHeight - baseline,
    fontSize: height,
    confidence: 1,
    extractionMethod: 'pdf-text',
  })
}

/**
 * Extract every page's text layer.
 *
 * Text-only: no page is rendered. Rendering forty sheets to find the one legend
 * costs seconds and hundreds of megabytes of bitmap, and the text layer already
 * answers both "what does this page say" and "is there anything here to read".
 */
export async function legendPdfExtract(bytes, deps) {
  const cancellation = deps && deps.cancellation
  const pdfjs = await legendPdfLoad()
  const task = pdfjs.getDocument({
    data: bytes,
    // No scripting, no remote resources, no system font probing: this parses
    // untrusted engineering documents and needs no part of that surface.
    isEvalSupported: false,
    useSystemFonts: false,
    disableAutoFetch: true,
    disableStream: true,
  })
  const pages = []
  let document = null
  try {
    document = await task.promise
    const count = Math.min(document.numPages, LEGEND_PDF_MAX_PAGES)
    for (let number = 1; number <= count; number++) {
      if (cancellation) cancellation.throwIfCancelled()
      const page = await document.getPage(number)
      try {
        const upright = page.getViewport({ scale: 1, rotation: 0 })
        const content = await page.getTextContent()
        const tokens = (content.items || [])
          .filter(item => clean(item && item.str))
          .map(item => legendPdfToken(item, number, upright.height))
        const built = legendPageFromTokens({
          page: number,
          width: upright.width,
          height: upright.height,
          rotation: Number(page.rotate) || 0,
          tokens,
          extractionMethod: 'pdf-text',
          /* No OCR in this build, so this is advisory only: it tells the user
             why an image-only sheet produced nothing. */
          ocrRecommended: tokens.length === 0,
          warnings: tokens.length ? [] : ['This page has no searchable text. Scanned pages need OCR, which is not included in this build.'],
        })
        built.score = legendScorePage(built)
        pages.push(built)
      } finally {
        /* Released per page rather than at the end -- holding forty pages'
           operator lists is how a large package stays resident. */
        page.cleanup()
      }
    }
    if (document.numPages > count) {
      pages.push({
        page: 0, width: 0, height: 0, rotation: 0, layout: 'structured',
        extractionMethod: 'pdf-text', spanning: [], bands: [{ x0: 0, x1: 0, columnX: 0, lines: [], rows: [] }],
        warnings: [`Only the first ${count} pages were scanned.`], ocrRecommended: false, score: 0,
      })
    }
    return pages
  } finally {
    /* destroy() tears down the worker's document; the worker itself is pooled
       by PDF.js and released by legendPdfRelease(). */
    try { await task.destroy() } catch (_) { /* already torn down */ }
  }
}

/**
 * Render one page, and hand back its tokens in the SAME space as the image.
 *
 * This is the only place a page is rasterised, and it happens on demand for the
 * single page the user opened -- never during extraction, where forty sheets of
 * bitmap would cost hundreds of megabytes to answer a question the text layer
 * already answers.
 *
 * The coordinate agreement is the whole point of this function. `getViewport`
 * defaults to the page's own rotation, so the image comes out upright; the raw
 * tokens are in unrotated space, so `legendNormalizeRotation` puts them in that
 * same upright space with the dimensions swapped to match. The returned
 * `width`/`height` are that upright space in POINTS, which is what lets a
 * caller map a pointer position to a token box as a plain fraction of the
 * element -- no dependence on canvas scale or device pixel ratio.
 *
 * Browser-only: there is no canvas in the Node harness, so the geometry this
 * feeds is tested through src/legend/lasso.js instead.
 */
export async function legendPdfRenderPage(bytes, pageNumber, options) {
  const maxSize = Number(options && options.maxSize) || LEGEND_PDF_MAX_CANVAS
  const pdfjs = await legendPdfLoad()
  const task = pdfjs.getDocument({
    data: bytes, isEvalSupported: false, useSystemFonts: false,
    disableAutoFetch: true, disableStream: true,
  })
  let document = null
  let page = null
  try {
    document = await task.promise
    const number = Math.min(Math.max(1, Number(pageNumber) || 1), document.numPages)
    page = await document.getPage(number)

    const natural = page.getViewport({ scale: 1 })
    /* Scaled DOWN only. Enlarging a small page wastes memory to add no detail,
       and the cap is what keeps a large-format sheet from allocating a bitmap
       measured in hundreds of megabytes. */
    const scale = Math.min(1, maxSize / Math.max(natural.width, natural.height))
    const viewport = page.getViewport({ scale })
    const canvas = window.document.createElement('canvas')
    canvas.width = Math.max(1, Math.floor(viewport.width))
    canvas.height = Math.max(1, Math.floor(viewport.height))
    const context = canvas.getContext('2d')
    if (!context) throw new Error('This browser could not provide a canvas to render the page.')
    await page.render({ canvasContext: context, viewport }).promise

    const upright = page.getViewport({ scale: 1, rotation: 0 })
    const content = await page.getTextContent()
    const raw = (content.items || [])
      .filter(item => clean(item && item.str))
      .map(item => legendPdfToken(item, number, upright.height))
    const rotated = legendNormalizeRotation({
      page: number, width: upright.width, height: upright.height,
      rotation: Number(page.rotate) || 0, tokens: raw,
    })

    return {
      canvas,
      page: number,
      pageCount: document.numPages,
      width: rotated.width,
      height: rotated.height,
      tokens: rotated.tokens,
    }
  } finally {
    if (page) { try { page.cleanup() } catch (_) { /* already released */ } }
    try { await task.destroy() } catch (_) { /* already torn down */ }
  }
}

/** The adapter registered for `kind: 'pdf'`. */
export async function legendPdfAdapter(source, deps) {
  if (!legendPdfAvailable()) {
    throw new Error('The PDF extractor is not included in this build. Paste the legend text, or upload it as a spreadsheet or CSV.')
  }
  if (!source || !source.file) throw new Error('That PDF could not be read.')
  const buffer = await source.file.arrayBuffer()
  return legendPdfExtract(new Uint8Array(buffer), deps)
}
