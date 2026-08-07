import { clean } from '../core/text.js'

/** Compiled patterns are cached; a malformed pattern compiles to null and never matches. */
const patternCache = new Map()
function compile(pattern) {
  const source = clean(pattern)
  if (!source) return null
  if (patternCache.has(source)) return patternCache.get(source)
  let re = null
  try { re = new RegExp(source, 'i') } catch (_) { re = null }
  patternCache.set(source, re)
  return re
}

/**
 * Split a tag into named segments by delimiter position.
 * Segments past the end of the tag are omitted, not set to ''.
 */
export function segmentTag(tag, anatomy) {
  const out = {}
  if (!anatomy || !Array.isArray(anatomy.segments)) return out
  const parts = clean(tag).split(anatomy.delimiter || '-')
  for (const segment of anatomy.segments) {
    const value = parts[segment.index]
    if (value !== undefined && value !== '') out[segment.name] = value
  }
  return out
}

/** First anatomy whose pattern matches the RAW tag wins. Never consults attributes. */
export function selectAnatomy(tag, anatomies) {
  const value = clean(tag)
  if (!value) return null
  for (const anatomy of anatomies || []) {
    const re = compile(anatomy && anatomy.pattern)
    if (re && re.test(value)) return anatomy
  }
  return null
}

/** Rebuild the tag from identity-bearing segments only. */
export function canonicalFromAnatomy(tag, anatomy) {
  const value = clean(tag)
  if (!anatomy || !Array.isArray(anatomy.segments)) return value
  const parts = value.split(anatomy.delimiter || '-')
  const drop = new Set(anatomy.segments.filter(s => s.identity === false).map(s => s.index))
  if (!drop.size) return value
  return parts.filter((_, i) => !drop.has(i)).join(anatomy.delimiter || '-')
}
