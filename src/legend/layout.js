import { clean } from '../core/text.js'

/* ---- coordinate-aware layout reconstruction ----
   Legend pages are not tables. They are one-column lists, two- and three-column
   tables, several independent abbreviation blocks sharing a sheet, rotated
   drawings, wrapped descriptions, and free-form notes -- often several of those
   at once.

   Reading tokens in raw order is what makes naive extraction useless here: on a
   two-column abbreviations sheet it produces "AAA Air Handler QQQ" by gluing the
   right column's code onto the left column's meaning. Detecting independent
   column bands FIRST, and parsing each one separately, is what this file is for. */

/** A single token this wide, relative to the page, is a spanning title. */
const LEGEND_SPAN_FRACTION = 0.6
/** A gap this wide relative to the page always separates bands. */
const LEGEND_BAND_GAP_FRACTION = 0.15
/** A gap this many times the typical gap also separates bands. */
const LEGEND_BAND_GAP_RATIO = 2
/** Below this, a gap is never a band boundary however the page is scaled. */
const LEGEND_MIN_BAND_GAP = 12
/** Line clustering tolerance as a fraction of token height. */
const LEGEND_LINE_TOLERANCE = 0.6

function legendMedian(values) {
  if (!values.length) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

/**
 * Rotate tokens into display space so reading order is always left-to-right,
 * top-to-bottom. A rotated legend sheet is otherwise parsed sideways, and every
 * line clusters into a single unreadable column.
 */
export function legendNormalizeRotation(page) {
  const rotation = ((Number(page && page.rotation) || 0) % 360 + 360) % 360
  const width = Number(page && page.width) || 0
  const height = Number(page && page.height) || 0
  const tokens = (page && page.tokens) || []
  if (rotation === 0) return { ...page, rotation: 0, width, height, tokens: tokens.map(token => ({ ...token })) }

  const mapped = tokens.map(token => {
    const { x0, y0, x1, y1 } = token
    if (rotation === 90) return { ...token, x0: height - y1, y0: x0, x1: height - y0, y1: x1 }
    if (rotation === 180) return { ...token, x0: width - x1, y0: height - y1, x1: width - x0, y1: height - y0 }
    return { ...token, x0: y0, y0: width - x1, x1: y1, y1: width - x0 }
  })
  const swapped = rotation === 90 || rotation === 270
  return { ...page, rotation: 0, width: swapped ? height : width, height: swapped ? width : height, tokens: mapped }
}

/**
 * Group tokens into visual lines by vertical centre, then order each line
 * left-to-right. Tolerance scales with token height so a page mixing a large
 * title with small body text does not merge two body lines into one.
 */
export function legendClusterLines(tokens) {
  const items = (tokens || []).filter(token => clean(token && token.text))
  if (!items.length) return []
  const heights = items.map(token => Math.abs(token.y1 - token.y0)).filter(value => value > 0)
  const tolerance = Math.max(1, legendMedian(heights) * LEGEND_LINE_TOLERANCE)
  const sorted = [...items].sort((left, right) => ((left.y0 + left.y1) / 2) - ((right.y0 + right.y1) / 2))

  const lines = []
  let current = null
  let currentCentre = 0
  for (const token of sorted) {
    const centre = (token.y0 + token.y1) / 2
    if (!current || Math.abs(centre - currentCentre) > tolerance) {
      current = { tokens: [token], y0: token.y0, y1: token.y1 }
      currentCentre = centre
      lines.push(current)
      continue
    }
    current.tokens.push(token)
    current.y0 = Math.min(current.y0, token.y0)
    current.y1 = Math.max(current.y1, token.y1)
    /* Track the running centre so a line that drifts (superscripts, mixed
       sizes) does not pull later tokens out of it. */
    currentCentre = (currentCentre * (current.tokens.length - 1) + centre) / current.tokens.length
  }
  for (const line of lines) {
    line.tokens.sort((left, right) => left.x0 - right.x0)
    line.x0 = Math.min(...line.tokens.map(token => token.x0))
    line.x1 = Math.max(...line.tokens.map(token => token.x1))
    line.text = legendLineText(line.tokens)
  }
  return lines
}

/** Join a line's tokens, inserting a space only where the gap warrants one. */
export function legendLineText(tokens) {
  let text = ''
  let previous = null
  for (const token of tokens) {
    const value = clean(token.text)
    if (!value) continue
    if (previous) {
      const gap = token.x0 - previous.x1
      const size = Math.abs(previous.y1 - previous.y0) || Number(previous.fontSize) || 8
      text += gap > size * 0.25 ? ' ' : ''
    }
    text += value
    previous = token
  }
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Split a page into independent vertical bands by finding horizontal gaps that
 * no text crosses.
 *
 * Operates on TOKENS, never on clustered lines. On a two-column sheet a single
 * visual line legitimately spans both columns -- that is what a multi-column
 * page means -- so measuring line extents finds one page-wide "line" and
 * concludes there is nothing to split. Bands must be found before lines exist.
 *
 * A single token wide enough to be a title is set aside: counted as ordinary
 * content, one full-width heading closes the gap between two columns and merges
 * them.
 */
export function legendDetectColumnBands(tokens, pageWidth) {
  const width = Number(pageWidth) || 0
  const spanning = []
  const columnar = []
  for (const item of tokens || []) {
    if (!clean(item && item.text)) continue
    if (width > 0 && (item.x1 - item.x0) >= width * LEGEND_SPAN_FRACTION) spanning.push(item)
    else columnar.push(item)
  }
  if (!columnar.length) return { bands: [], spanning }

  const merged = []
  for (const [start, end] of columnar.map(item => [item.x0, item.x1]).sort((left, right) => left[0] - right[0])) {
    const last = merged[merged.length - 1]
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }

  const gaps = []
  for (let index = 1; index < merged.length; index++) gaps.push(merged[index][0] - merged[index - 1][1])
  /* A fixed threshold cannot tell "the gap between a code and its description"
     from "the gap between two independent blocks" -- both are large in absolute
     terms and their ratio is what distinguishes them. So a gap separates bands
     when it dwarfs the typical gap on the page, OR when it is simply enormous
     relative to the page (which catches a page whose only gap is a real
     boundary, where there is no typical gap to compare against). */
  const typical = legendMedian(gaps.filter(value => value > 0))
  const threshold = Math.max(
    LEGEND_MIN_BAND_GAP,
    Math.min(typical > 0 ? typical * LEGEND_BAND_GAP_RATIO : Infinity, (width || merged[merged.length - 1][1]) * LEGEND_BAND_GAP_FRACTION),
  )

  const groups = [[merged[0]]]
  for (let index = 1; index < merged.length; index++) {
    if (merged[index][0] - merged[index - 1][1] > threshold) groups.push([merged[index]])
    else groups[groups.length - 1].push(merged[index])
  }

  const bands = groups.map(group => ({ x0: group[0][0], x1: group[group.length - 1][1], tokens: [], lines: [] }))
  for (const item of columnar) {
    const centre = (item.x0 + item.x1) / 2
    let band = bands.find(candidate => centre >= candidate.x0 && centre <= candidate.x1)
    if (!band) {
      band = bands.reduce((best, candidate) => {
        const distance = Math.min(Math.abs(centre - candidate.x0), Math.abs(centre - candidate.x1))
        return !best || distance < best.distance ? { candidate, distance } : best
      }, null).candidate
    }
    band.tokens.push(item)
  }
  /* Lines are clustered per band, so a row in the left column never absorbs a
     token sitting at the same height in the right column. */
  for (const band of bands) band.lines = legendClusterLines(band.tokens)
  return { bands, spanning: spanning.sort((left, right) => left.y0 - right.y0) }
}

/**
 * Find the x position where descriptions start, when a band is laid out as
 * aligned code/description columns.
 *
 * Returns 0 when no consistent boundary exists, which is the signal to fall
 * back to inline parsing (`CODE = Meaning`) rather than inventing a split.
 */
export function legendDetectCodeColumns(band) {
  const candidates = []
  let gapLines = 0
  for (const line of band.lines || []) {
    const tokens = line.tokens || []
    if (tokens.length < 2) continue
    const size = legendMedian(tokens.map(token => Math.abs(token.y1 - token.y0))) || 8
    let found = false
    for (let index = 1; index < tokens.length; index++) {
      const gap = tokens[index].x0 - tokens[index - 1].x1
      if (gap > size * 0.9) { candidates.push(tokens[index].x0); found = true }
    }
    if (found) gapLines++
  }
  if (candidates.length < 2 || gapLines < 2) return 0

  /* Cluster the candidate boundaries, then take the LEFTMOST well-supported
     one. On a three-column code/category/description table the widest gap sits
     before the description, and choosing it would make "AAA Mechanical" the
     code. The code is whatever occupies the first column; everything right of
     the first boundary is meaning. */
  const sorted = [...candidates].sort((left, right) => left - right)
  const tolerance = Math.max(6, (band.x1 - band.x0) * 0.04)
  const clusters = []
  let start = 0
  for (let index = 1; index <= sorted.length; index++) {
    if (index < sorted.length && sorted[index] - sorted[start] <= tolerance) continue
    clusters.push({ count: index - start, value: legendMedian(sorted.slice(start, index)) })
    start = index
  }
  const support = Math.max(2, Math.ceil(gapLines * 0.5))
  const chosen = clusters.find(cluster => cluster.count >= support)
  return chosen ? chosen.value : 0
}

/**
 * Turn a band into code/description rows.
 *
 * When an aligned description column exists, a line whose text begins at or
 * after that column with nothing to its left is a wrapped continuation of the
 * row above, not a row of its own -- joining it back is what keeps a
 * two-line description from becoming a codeless orphan.
 */
export function legendBandRows(band) {
  const columnX = legendDetectCodeColumns(band)
  const rows = []
  for (const line of band.lines || []) {
    const tokens = line.tokens || []
    if (!tokens.length) continue
    if (!columnX) {
      rows.push({ code: '', description: line.text, text: line.text, y0: line.y0, y1: line.y1, x0: line.x0, x1: line.x1, tokens, wrapped: false })
      continue
    }
    const left = tokens.filter(token => token.x0 < columnX - 1)
    const right = tokens.filter(token => token.x0 >= columnX - 1)
    const leftText = legendLineText(left)
    const rightText = legendLineText(right)
    if (!leftText && rightText && rows.length) {
      const previous = rows[rows.length - 1]
      previous.description = clean(previous.description + ' ' + rightText)
      previous.text = clean(previous.text + ' ' + rightText)
      previous.y1 = line.y1
      previous.tokens = previous.tokens.concat(tokens)
      continue
    }
    rows.push({
      code: leftText, description: rightText, text: line.text,
      y0: line.y0, y1: line.y1, x0: line.x0, x1: line.x1, tokens, wrapped: false,
    })
  }
  return { columnX, rows }
}

/**
 * Full reconstruction for one page: upright coordinates, visual lines,
 * independent bands, and code/description rows per band.
 */
/**
 * Group lines into vertical blocks separated by whitespace.
 *
 * Columns are a property of a REGION, not of a whole page. A legend sheet
 * commonly puts two abbreviation tables side by side near the top and
 * full-width prose underneath -- and one long prose line spans the gutter, so a
 * page-wide projection sees no gap at all and merges the two tables. Reading
 * order then yields "Air Handling Assembly QQQ Quench Panel", the exact failure
 * column detection exists to prevent.
 */
export function legendGroupBlocks(lines) {
  const sorted = [...(lines || [])].sort((left, right) => left.y0 - right.y0)
  if (!sorted.length) return []
  const heights = sorted.map(line => line.y1 - line.y0).filter(value => value > 0)
  const gapLimit = Math.max(4, legendMedian(heights) * 1.5)
  const blocks = [[sorted[0]]]
  for (let index = 1; index < sorted.length; index++) {
    const gap = sorted[index].y0 - sorted[index - 1].y1
    if (gap > gapLimit) blocks.push([sorted[index]])
    else blocks[blocks.length - 1].push(sorted[index])
  }
  return blocks
}

export function legendReconstructPage(page) {
  const upright = legendNormalizeRotation(page)
  const lines = legendClusterLines(upright.tokens)
  const built = []
  const spanningAll = []

  for (const block of legendGroupBlocks(lines)) {
    const tokens = block.flatMap(line => line.tokens)
    const { bands, spanning } = legendDetectColumnBands(tokens, upright.width)
    spanningAll.push(...spanning)
    const blockBands = bands.map(band => ({ ...band, ...legendBandRows(band) }))
    /* A title spanning this block belongs to the block, not to any one of its
       columns, so it leads the first band -- which is how "Building Codes"
       reaches the rows beneath it as heading context. */
    const spanningLines = legendClusterLines(spanning)
    if (spanningLines.length && blockBands.length) {
      blockBands[0].rows = spanningLines
        .map(line => ({ code: '', description: '', text: line.text, y0: line.y0, y1: line.y1, x0: line.x0, x1: line.x1, tokens: line.tokens, wrapped: false }))
        .concat(blockBands[0].rows)
    } else if (spanningLines.length) {
      blockBands.push({
        x0: 0, x1: upright.width, tokens: spanning, lines: spanningLines, columnX: 0,
        rows: spanningLines.map(line => ({ code: '', description: '', text: line.text, y0: line.y0, y1: line.y1, x0: line.x0, x1: line.x1, tokens: line.tokens, wrapped: false })),
      })
    }
    built.push(...blockBands)
  }

  return {
    page: Number(upright.page) || 0,
    width: upright.width,
    height: upright.height,
    spanning: legendClusterLines(spanningAll),
    bands: built,
    warnings: (page && page.warnings) || [],
  }
}
