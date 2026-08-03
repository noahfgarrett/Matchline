import { clean } from '../core/text.js'
import { legendPageRows } from './extract.js'
import { legendHeadingFor, legendLooksLikeHeading, legendMakeEntry, legendMarkConflicts, legendNormalizeCode } from './model.js'

/* ---- interpretation ----
   Rows of text become structured knowledge here. Nothing in this file writes a
   profile rule; that is proposals.js, and keeping the boundary means an
   interpretation can be shown to the user, corrected, or ignored before
   anything executable exists.

   The governing bias: prose that is not clearly understood becomes
   reference-only. A legend page is full of sentences that read like rules and
   are not -- notes about installation, coordination, revision history. Guessing
   at those produces confident nonsense, so only explicitly supported statement
   shapes ever become a proposal. */

/** A code looks like a code: short, upper-case-ish, no sentence punctuation. */
const LEGEND_CODE_PATTERN = /^[A-Z0-9][A-Z0-9\-/_.]{0,15}$/

/**
 * Inline definition forms, most trustworthy first.
 *
 * The bare-hyphen form REQUIRES whitespace on both sides. Without that guard
 * `ZZ9-QQQ-1234` -- an ordinary tag -- parses as the code `ZZ9` meaning
 * `QQQ-1234`, and a single sample tag printed on a legend page would generate a
 * confident, wrong abbreviation for every site.
 */
const LEGEND_INLINE_FORMS = Object.freeze([
  { pattern: /^(.{1,16}?)\s*=\s*(.+)$/, confidence: 0.9 },
  { pattern: /^(.{1,16}?)\s*[–—]\s*(.+)$/, confidence: 0.88 },
  { pattern: /^(.{1,16}?)\s*:\s+(.+)$/, confidence: 0.86 },
  { pattern: /^(.{1,16}?)\s+-\s+(.+)$/, confidence: 0.74 },
])

const LEGEND_ATTRIBUTE_PHRASES = Object.freeze([
  { match: /^(the\s+)?building(\s+code)?$/i, attribute: 'building' },
  { match: /^(the\s+)?discipline(\s+code)?$/i, attribute: 'discipline' },
  { match: /^(the\s+)?system(\s+code)?$/i, attribute: 'system' },
  { match: /^(the\s+)?equipment\s*(type|code)$/i, attribute: 'equipmentType' },
  { match: /^(the\s+)?(unit|sequence|number|serial)(\s+(code|number))?$/i, attribute: 'matchKey' },
])

const LEGEND_ORDINALS = Object.freeze({
  first: 0, '1st': 0, second: 1, '2nd': 1, third: 2, '3rd': 2,
  fourth: 3, '4th': 3, fifth: 4, '5th': 4,
})

const LEGEND_DELIMITER_WORDS = Object.freeze({
  hyphen: '-', dash: '-', underscore: '_', period: '.', dot: '.', slash: '/', space: ' ', colon: ':',
})

/** Map a phrase from the document onto a profile attribute, or ''. */
export function legendAttributeFromPhrase(phrase) {
  const value = clean(phrase).replace(/[.;,]+$/, '')
  for (const entry of LEGEND_ATTRIBUTE_PHRASES) if (entry.match.test(value)) return entry.attribute
  return ''
}

function legendDelimiterFrom(word) {
  const value = clean(word).toLowerCase().replace(/[^a-z]/g, '')
  return LEGEND_DELIMITER_WORDS[value] || (clean(word).length === 1 ? clean(word) : '')
}

/**
 * Free-form statements that are supported EXACTLY. Anything else is
 * reference-only.
 *
 * Every capture is taken from the document -- no site vocabulary is baked in
 * here, so a legend using entirely different abbreviations parses identically.
 */
const LEGEND_STATEMENTS = Object.freeze([
  {
    id: 'character-range',
    pattern: /\bcharacters?\s+(\d+)\s*(?:through|thru|to|[-–—])\s*(\d+)\s+(?:indicate|indicates|is|are|denote|denotes|represent|represents)\s+(.+)$/i,
    build(match) {
      const start = Number(match[1])
      const end = Number(match[2])
      const attribute = legendAttributeFromPhrase(match[3])
      if (!attribute || !(start >= 1) || !(end >= start)) return null
      return { kind: 'tag-anatomy', targetHint: attribute, detail: { form: 'slice', start: start - 1, end, attribute } }
    },
  },
  {
    id: 'ordinal-segment',
    pattern: /\bthe\s+(first|second|third|fourth|fifth|1st|2nd|3rd|4th|5th)\s+([a-z]+|.)[-\s]delimited\s+segment\s+(?:is|indicates|denotes|represents)\s+(.+)$/i,
    build(match) {
      const index = LEGEND_ORDINALS[clean(match[1]).toLowerCase()]
      const delimiter = legendDelimiterFrom(match[2])
      const attribute = legendAttributeFromPhrase(match[3])
      if (index == null || !delimiter || !attribute) return null
      return { kind: 'tag-anatomy', targetHint: attribute, detail: { form: 'segment', index, delimiter, attribute } }
    },
  },
  {
    id: 'suffix-not-identity',
    pattern: /\bsuffix(?:es)?\s+(.+?)\s+(?:are|is)\b.*?\bnot\s+part\s+of\s+(?:the\s+)?\S*\s*identity/i,
    build(match) {
      const suffixes = clean(match[1]).split(/\s*(?:,|and|&|or)\s*/i)
        .map(value => clean(value).replace(/^["']|["']$/g, ''))
        .filter(value => value && value.length <= 6)
      if (!suffixes.length) return null
      return { kind: 'normalization', targetHint: '', detail: { form: 'stripSuffix', suffixes } }
    },
  },
  {
    id: 'prefix-parent',
    pattern: /\beverything\s+before\s+the\s+first\s+(\S+?)\s+is\s+the\s+parent(?:\s+tag)?\b/i,
    build(match) {
      const delimiter = legendDelimiterFrom(match[1])
      if (!delimiter) return null
      return { kind: 'relationship', targetHint: '', detail: { form: 'prefixSplit', delimiter } }
    },
  },
  {
    id: 'parented-to-matching',
    pattern: /\b([A-Z0-9][A-Z0-9\-/]{0,11})\s+equipment\s+is\s+parented\s+to\s+(?:the\s+)?([A-Z0-9][A-Z0-9\-/]{0,11})\s+with\s+the\s+same\s+(.+)$/i,
    build(match) {
      const childType = legendNormalizeCode(match[1])
      const parentType = legendNormalizeCode(match[2])
      const matchOn = legendAttributeFromPhrase(match[3]) || 'matchKey'
      if (!childType || !parentType || childType === parentType) return null
      return { kind: 'relationship', targetHint: '', detail: { form: 'attributeMatch', childType, parentType, matchOn } }
    },
  },
  {
    id: 'unparented-root',
    pattern: /\bunparented\s+([A-Z0-9][A-Z0-9\-/]{0,11})\s+equipment\s+belongs\s+(?:below|under|beneath)\s+(.+)$/i,
    build(match) {
      const equipmentType = legendNormalizeCode(match[1])
      const parent = clean(match[2]).replace(/[.;,]+$/, '')
      if (!equipmentType || !parent) return null
      return { kind: 'hierarchy-root', targetHint: '', detail: { form: 'constant', equipmentType, parent } }
    },
  },
])

/** Match a supported statement, or null. */
export function legendParseStatement(text) {
  const value = clean(text)
  if (!value) return null
  for (const statement of LEGEND_STATEMENTS) {
    const match = value.match(statement.pattern)
    if (!match) continue
    const built = statement.build(match)
    if (built) return { ...built, statementId: statement.id }
  }
  return null
}

/**
 * A tag-anatomy diagram written as a worked example, e.g.
 * `ZZ9-QQQ-1234 = Building-Equipment Type-Unit`.
 *
 * Both sides must split into the same number of parts on the same delimiter,
 * and every label must name a known attribute. A near-miss is left alone rather
 * than half-interpreted -- a partly understood anatomy silently drops segments
 * from every canonical tag on the site.
 */
export function legendParseAnatomyExample(code, description) {
  const sample = clean(code)
  const labels = clean(description)
  if (!sample || !labels) return null
  for (const delimiter of ['-', '_', '.', '/']) {
    const sampleParts = sample.split(delimiter)
    if (sampleParts.length < 2) continue
    const labelParts = labels.split(delimiter).map(clean)
    if (labelParts.length !== sampleParts.length) continue
    const segments = labelParts.map((label, index) => ({ index, attribute: legendAttributeFromPhrase(label), label }))
    if (segments.some(segment => !segment.attribute)) continue
    return { kind: 'tag-anatomy', targetHint: '', detail: { form: 'anatomy', delimiter, sample, segments } }
  }
  return null
}

/** Split a row into code and meaning using the supported inline forms. */
/**
 * Drop a separator left stranded at the front of a meaning.
 *
 * Column detection splits a row wherever the aligned description column
 * starts, and on a sheet that sets `0  =  BASEMENT LEVEL` in three pieces that
 * boundary lands BEFORE the `=`, not after it -- so the code comes out right
 * and the meaning comes out as "= BASEMENT LEVEL". No real meaning begins with
 * a bare separator, so removing one leading separator is always the right
 * reading.
 */
export function legendStripSeparator(text) {
  return clean(String(text == null ? '' : text).replace(/^\s*[=:]\s*|^\s*[-–—]\s+/, ''))
}

export function legendSplitInline(text) {
  const value = clean(text)
  if (!value) return null
  for (const form of LEGEND_INLINE_FORMS) {
    const match = value.match(form.pattern)
    if (!match) continue
    const code = clean(match[1])
    const meaning = clean(match[2])
    if (!code || !meaning) continue
    if (!LEGEND_CODE_PATTERN.test(code.toUpperCase())) continue
    return { code, meaning, confidence: form.confidence }
  }
  return null
}

function legendRowConfidence(row, base) {
  const source = Number(row && row.confidence)
  return Math.min(1, Math.max(0, base * (Number.isFinite(source) && source > 0 ? source : 1)))
}

/**
 * Interpret every row of every page into knowledge entries.
 *
 * Headings are tracked per band: a "Building Codes" heading governs the rows
 * beneath it in that band, and does not leak across a column boundary into an
 * unrelated block on the other half of the sheet.
 */
export function legendParsePages(pages, meta) {
  const sourceId = clean(meta && meta.sourceId)
  const entries = []
  const seen = new Set()

  const push = input => {
    const entry = legendMakeEntry({ ...input, sourceId })
    if (seen.has(entry.semanticHash)) return null
    seen.add(entry.semanticHash)
    entries.push(entry)
    return entry
  }

  for (const page of pages || []) {
    const extractionMethod = clean(page && page.extractionMethod) || 'text'
    /* Headings carry across bands, but only over the columns they physically
       sit above. A heading almost always has whitespace beneath it, which puts
       it in its own vertical block and therefore its own band -- so band-local
       tracking alone loses it. Matching on horizontal overlap is what keeps
       "Building Codes" governing the column under it without leaking into an
       unrelated block on the other half of the sheet. */
    const seen = []
    const overlapping = band => {
      for (let index = seen.length - 1; index >= 0; index--) {
        const item = seen[index]
        if (item.x1 >= band.x0 && item.x0 <= band.x1) return item.heading
      }
      return null
    }
    for (const band of (page && page.bands) || []) {
      let heading = overlapping(band)
      for (const row of band.rows || []) {
        const text = clean(row.text)
        if (!text) continue

        /* Statements are tested BEFORE headings. "The second hyphen-delimited
           segment is Equipment Type" contains the words "Equipment Type" and so
           matches a heading pattern; read as a heading it is swallowed whole and
           the rule it describes is lost. A real heading matches no statement
           form, so nothing is given up by this order. */
        const statement = legendParseStatement(text)
        if (statement) {
          push({
            ...statement, page: page.page, extractionMethod, statement: text,
            meaning: text, parserConfidence: legendRowConfidence(row, 0.8), evidenceSummary: text,
          })
          continue
        }

        /* A heading line lands in `code` or in `description` depending on
           whether its band happened to have a detectable code column, so
           neither field alone identifies one. What disqualifies a heading is
           carrying BOTH -- that is a definition, e.g. "LEGEND | see sheet 3". */
        const labelled = !(clean(row.code) && clean(row.description))
        const found = legendHeadingFor(text)
        if (found && labelled) {
          heading = found
          seen.push({
            heading: found,
            x0: row.x0 != null ? row.x0 : band.x0,
            x1: row.x1 != null ? row.x1 : band.x1,
          })
          continue
        }
        /* An unrecognised section label still ENDS the previous section. Without
           this, a sheet whose sections are "EQUIPMENT TYPE:", then "LEVEL:",
           then "POWER SUPPLY:" tags every level and every voltage as an
           equipment type, because only the first label is in the vocabulary.
           Falls through rather than consuming the line, so the text is still
           kept as reference. */
        if (!found && labelled && legendLooksLikeHeading(text)) {
          heading = null
          seen.push({
            heading: null,
            x0: row.x0 != null ? row.x0 : band.x0,
            x1: row.x1 != null ? row.x1 : band.x1,
          })
        }

        let code = clean(row.code)
        let meaning = legendStripSeparator(row.description)
        let confidence = 0.9
        if (!code || !meaning) {
          const inline = legendSplitInline(text)
          if (!inline) {
            push({
              kind: 'reference-only', page: page.page, extractionMethod,
              meaning: text, parserConfidence: legendRowConfidence(row, 0.3), evidenceSummary: text,
            })
            continue
          }
          code = inline.code
          meaning = inline.meaning
          confidence = inline.confidence
        }

        const anatomy = legendParseAnatomyExample(code, meaning)
        if (anatomy) {
          push({
            ...anatomy, page: page.page, extractionMethod, statement: text,
            meaning, code, parserConfidence: legendRowConfidence(row, 0.82), evidenceSummary: text,
          })
          continue
        }

        if (!LEGEND_CODE_PATTERN.test(code.toUpperCase())) {
          push({
            kind: 'reference-only', page: page.page, extractionMethod,
            meaning: text, parserConfidence: legendRowConfidence(row, 0.3), evidenceSummary: text,
          })
          continue
        }

        push({
          kind: heading && heading.kind === 'code-list' ? 'code-list' : 'abbreviation',
          code, meaning,
          targetHint: (heading && heading.targetHint) || '',
          page: page.page, extractionMethod,
          /* A heading is real evidence about what a block of codes means, so it
             lifts confidence; without one the target is a guess the user has to
             confirm. */
          parserConfidence: legendRowConfidence(row, heading && heading.targetHint ? Math.min(1, confidence + 0.05) : confidence * 0.88),
          evidenceSummary: text,
        })
      }
    }
  }
  return legendMarkConflicts(entries)
}

/** Convenience: rows for one page, already flattened. */
export function legendPageEntries(page, meta) {
  return legendParsePages([page], meta)
}

/* ---- manual binding support ----
   Leader lines are what bind a character position to its value list on a real
   numbering sheet, and they are drawn geometry -- no text-layer heuristic
   recovers them, and every package draws them differently. So the machine does
   what it demonstrably does well (find the sections, parse the value pairs,
   spot the sample tags) and a person does the binding, which they can see at a
   glance. These two functions produce the things a person picks between. */

/** A tag-shaped line: upper-case, delimited, carrying at least one digit. */
const LEGEND_SAMPLE_TAG = /^[A-Z0-9]+(?:[-_.][A-Z0-9]+)*$/

/**
 * A section is a heading plus the value pairs beneath it -- "TRAIN:" with its
 * A/B/C, "LEVEL:" with its 0/1/2. This is the unit the binding UI offers,
 * because it is the unit a legend is actually drawn in.
 *
 * Sections are cut on ANY heading-shaped line, recognised or not. A sheet's
 * sections are mostly labels nobody has taught us ("FED FROM:", "POWER
 * SUPPLY:"), and they still divide the page.
 */
export function legendSections(pages) {
  const sections = []
  let counter = 0
  for (const page of pages || []) {
    /* Headings carry across bands, over the columns they physically sit above
       -- the same rule legendParsePages uses, and for the same reason. A
       heading has whitespace beneath it, which puts it in its own vertical
       block and so its own band; tracked band-locally it never reaches the
       values it labels, and every list in the picker comes out "Untitled
       block". Horizontal overlap is what stops it leaking into an unrelated
       block on the other half of the sheet. */
    const seen = []
    const inherited = band => {
      for (let index = seen.length - 1; index >= 0; index--) {
        const item = seen[index]
        if (item.x1 >= band.x0 && item.x0 <= band.x1) return item.title
      }
      return ''
    }
    for (const band of (page && page.bands) || []) {
      let current = null
      const carried = inherited(band)
      const open = title => {
        current = {
          id: 'section-' + (++counter), title: clean(title),
          page: Number(page.page) || 0, values: [], lines: [],
        }
        sections.push(current)
      }
      for (const row of band.rows || []) {
        const text = clean(row.text)
        if (!text) continue
        const labelled = !(clean(row.code) && clean(row.description))
        if (labelled && (legendHeadingFor(text) || legendLooksLikeHeading(text))) {
          seen.push({
            title: text,
            x0: row.x0 != null ? row.x0 : band.x0,
            x1: row.x1 != null ? row.x1 : band.x1,
          })
          open(text)
          continue
        }
        if (!current) open(carried)
        current.lines.push(text)
        let code = clean(row.code)
        let meaning = legendStripSeparator(row.description)
        if (!code || !meaning) {
          const inline = legendSplitInline(text)
          if (inline) { code = inline.code; meaning = inline.meaning }
        }
        if (code && meaning) current.values.push({ code, meaning })
      }
    }
  }
  return sections.filter(section => section.values.length)
}

/**
 * Lines that look like a sample tag, e.g. the `3AABXXYY-CAZ000` a numbering
 * sheet draws its leader lines from.
 *
 * Requiring a digit is what separates a sample tag from a section label:
 * "POWER SUPPLY" has neither digits nor delimiters, and a definition line is
 * excluded outright because it splits into code and meaning.
 */
export function legendSampleTags(pages) {
  const seen = new Set()
  const out = []
  for (const page of pages || []) {
    for (const band of (page && page.bands) || []) {
      for (const row of band.rows || []) {
        const text = clean(row.text)
        if (!text || text.length < 5 || text.length > 40) continue
        if (legendSplitInline(text)) continue
        const upper = text.toUpperCase()
        if (!LEGEND_SAMPLE_TAG.test(upper) || !/\d/.test(upper)) continue
        if (seen.has(upper)) continue
        seen.add(upper)
        out.push({ text, page: Number(page.page) || 0 })
      }
    }
  }
  return out
}
