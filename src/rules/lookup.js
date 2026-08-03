import { clean } from '../core/text.js'
import { normSep } from '../core/tags.js'

/**
 * An in-memory LookupSource over records shaped
 *   { tag, columns: {…}, attributes: {…} }
 *
 * Match modes mirror the MEL helpers this replaces:
 *   exact      - normalised tag equality            (melRecord)
 *   containing - equality, else endsWith, else includes (melContainingRecord)
 */
export function createMemoryLookup(rows) {
  const records = Array.isArray(rows) ? rows : []
  const byNormalisedTag = new Map()
  const attributeIndexes = new Map()
  const attributeMatchCache = new Map()
  for (const record of records) {
    const key = normSep(record && record.tag)
    if (!key) continue
    const matches=byNormalisedTag.get(key)||[];matches.push(record);byNormalisedTag.set(key,matches)
  }

  function findMatches(value, mode) {
    const key = normSep(value)
    if (!key) return []
    const exact = byNormalisedTag.get(key)||[]
    if (mode === 'exact') return [...exact]
    if (mode !== 'containing') return []
    if (exact.length)return [...exact]
    const suffix=[],contained=[]
    for (const record of records) {
      const recordKey = normSep(record && record.tag)
      if (!recordKey) continue
      if (recordKey.endsWith(key)) suffix.push(record)
      else if (recordKey.includes(key)) contained.push(record)
    }
    return suffix.length?suffix:contained
  }

  function find(value, mode) {
    const matches=findMatches(value,mode)
    return matches.length===1?matches[0]:null
  }

  function attributeIndex(attribute) {
    if (attributeIndexes.has(attribute)) return attributeIndexes.get(attribute)
    const index = new Map()
    for (const record of records) {
      const value = clean(record && record.attributes && record.attributes[attribute]).toLowerCase()
      if (!value) continue
      const matches = index.get(value) || []
      matches.push(record)
      index.set(value, matches)
    }
    attributeIndexes.set(attribute, index)
    return index
  }

  /** Every record whose attributes match all the given key/value pairs. */
  function findAll(attributes) {
    const entries = Object.entries(attributes || {}).filter(([, v]) => clean(v) !== '')
    if (!entries.length) return []
    const normalized = entries.map(([key, value]) => [key, clean(value).toLowerCase()])
    const cacheKey = normalized.slice().sort(([left], [right]) => left.localeCompare(right)).map(([key, value]) => key + '\u001f' + value).join('\u001e')
    if (attributeMatchCache.has(cacheKey)) return [...attributeMatchCache.get(cacheKey)]
    let candidates = records
    for (const [key, value] of normalized) {
      const matches = attributeIndex(key).get(value) || []
      if (matches.length < candidates.length) candidates = matches
      if (!candidates.length) break
    }
    const found = candidates.filter(record => {
      const own = (record && record.attributes) || {}
      return normalized.every(([key, value]) => clean(own[key]).toLowerCase() === value)
    })
    attributeMatchCache.set(cacheKey, found)
    return [...found]
  }

  return { find, findMatches, findAll, size: records.length }
}
