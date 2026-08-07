import { clean } from '../core/text.js'
import { legendPageFromTokens } from './extract.js'

/* ---- lasso region selection ----
   The block picker offers whatever the parser managed to find. This file
   answers the other half: when the parser found the wrong thing, or nothing,
   the user drags a box around the region they mean and the tokens inside it are
   reconstructed on their own.

   The important idea is that a selection is reconstructed AS ITS OWN PAGE, in
   rect-local coordinates. Band detection scales its thresholds to the page
   width -- a spanning title is 60% of the width, a band gap is 15% of it -- so
   reconstructing a 200pt selection against a 1700pt sheet would find no title
   and no column gap ever. Translating to the rect and reporting the rect's own
   size is what makes a selection behave like the small document it is. */

/** A token must be at least this much inside the rect to count as selected. */
export const LEGEND_LASSO_MIN_OVERLAP = 0.4

/** Two drag points to a rect, normalised low-to-high. */
export function legendLassoRect(from, to) {
  const ax = Number(from && from.x) || 0
  const ay = Number(from && from.y) || 0
  const bx = Number(to && to.x) || 0
  const by = Number(to && to.y) || 0
  return {
    x0: Math.min(ax, bx), y0: Math.min(ay, by),
    x1: Math.max(ax, bx), y1: Math.max(ay, by),
  }
}

export function legendRectWidth(rect) { return Math.max(0, (rect && rect.x1) - (rect && rect.x0)) }
export function legendRectHeight(rect) { return Math.max(0, (rect && rect.y1) - (rect && rect.y0)) }

/**
 * How much of a token lies inside the rect, 0..1.
 *
 * Area overlap rather than containment: a person dragging a box across a dense
 * sheet inevitably clips the glyphs at the edges, and demanding full
 * containment drops the first and last character of every line they meant to
 * take. A token with no area -- which a degenerate text item can have -- is
 * judged by its centre instead, since every fraction of zero is zero.
 */
export function legendTokenOverlap(token, rect) {
  if (!token || !rect) return 0
  const width = Math.max(0, Math.min(token.x1, rect.x1) - Math.max(token.x0, rect.x0))
  const height = Math.max(0, Math.min(token.y1, rect.y1) - Math.max(token.y0, rect.y0))
  const area = Math.max(0, token.x1 - token.x0) * Math.max(0, token.y1 - token.y0)
  if (area <= 0) {
    const cx = (token.x0 + token.x1) / 2
    const cy = (token.y0 + token.y1) / 2
    return cx >= rect.x0 && cx <= rect.x1 && cy >= rect.y0 && cy <= rect.y1 ? 1 : 0
  }
  return (width * height) / area
}

/** Tokens far enough inside the rect to be part of the selection. */
export function legendTokensInRect(tokens, rect, minOverlap) {
  const floor = Number.isFinite(minOverlap) ? minOverlap : LEGEND_LASSO_MIN_OVERLAP
  return (tokens || []).filter(token => clean(token && token.text) && legendTokenOverlap(token, rect) >= floor)
}

/**
 * A selected region as a canonical page.
 *
 * Tokens are translated into the rect's own space so the reconstruction sees a
 * self-contained little document. What it is NOT given is the rect's width.
 *
 * Column-gap and spanning-title thresholds are fractions of the page width, and
 * they have to stay fractions of the SOURCE page, because what they measure --
 * "is this gap a gutter between two tables, or the indent between a code and
 * its description?" -- is a property of how the sheet was drawn, not of how the
 * user cropped it. Measured against the crop, an ordinary 62pt indent is 23% of
 * a 270pt selection, sails past the 15% band threshold, and splits one table
 * into two bands: every code lands in one band, every description in another,
 * and the pairing is lost. Lassoing a single table -- the whole point of the
 * tool -- would be the case that broke.
 *
 * `rotation: 0` because the tokens handed in are already upright; the caller
 * normalises once, when it renders.
 */
export function legendLassoRegion(tokens, rect, meta) {
  const selected = legendTokensInRect(tokens, rect, meta && meta.minOverlap)
  const local = selected.map(token => ({
    ...token,
    x0: token.x0 - rect.x0, x1: token.x1 - rect.x0,
    y0: token.y0 - rect.y0, y1: token.y1 - rect.y0,
  }))
  const pageWidth = Number(meta && meta.pageWidth)
  const page = legendPageFromTokens({
    page: Math.max(1, Number(meta && meta.page) || 1),
    width: pageWidth > 0 ? pageWidth : legendRectWidth(rect),
    height: legendRectHeight(rect),
    rotation: 0,
    tokens: local,
    extractionMethod: clean(meta && meta.extractionMethod) || 'pdf-text',
  })
  return { ...page, rect, tokenCount: local.length }
}

/** Every line of a selection, in reading order -- what the user sees echoed back. */
export function legendLassoLines(page) {
  const lines = []
  for (const band of (page && page.bands) || []) {
    for (const row of band.rows || []) {
      const text = clean(row.text)
      if (text) lines.push(text)
    }
  }
  return lines
}
