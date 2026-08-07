import { clean } from '../core/text.js'

/**
 * Resolve an expression to a string.
 * If any non-literal part cannot resolve, the whole expression yields ''
 * so the caller can fall through rather than emit a partial value.
 */
export function evaluateExpression(parts, context) {
  if (!Array.isArray(parts) || !parts.length) return ''
  const segments = (context && context.segments) || {}
  const lookup = (context && context.lookup) || {}
  let out = ''
  for (const part of parts) {
    if (!part) return ''
    if (part.kind === 'literal') { out += String(part.text == null ? '' : part.text); continue }
    const value = part.kind === 'segment' ? segments[part.name]
      : part.kind === 'lookup' ? lookup[part.column]
      : undefined
    const resolved = clean(value)
    if (!resolved) return ''
    out += resolved
  }
  return out
}

/** Read-only display form. Never parsed back — authoring is click-driven. */
export function expressionPreview(parts) {
  if (!Array.isArray(parts)) return ''
  return parts.map(part => {
    if (!part) return ''
    if (part.kind === 'literal') return String(part.text == null ? '' : part.text)
    if (part.kind === 'segment') return '{@' + part.name + '}'
    if (part.kind === 'lookup') return '{' + part.column + '}'
    return ''
  }).join('')
}
