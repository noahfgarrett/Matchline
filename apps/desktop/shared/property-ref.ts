import type { WirePropertyRef } from './schemas.js';

/**
 * A `PropertyRef` as one `<option value>` string, and back.
 *
 * Lives in `shared/` rather than beside the picker so it can be tested: this
 * codec has already been wrong once. A delimiter-based encoding cannot work —
 * both halves are arbitrary Navisworks text, so a space splits
 * `Dragon Data > Tag` in the wrong place, and a control character survives
 * neither the DOM attribute nor the browser's option matching. When matching
 * fails the `<select>` reports itself as unselected while the mapping behind it
 * is set, which looks broken while behaving correctly — the worst of both.
 *
 * JSON is printable, unambiguous for any pair of strings, and round-trips.
 */

export function encodePropertyRef(ref: WirePropertyRef | null): string {
  return ref === null ? '' : JSON.stringify([ref.category, ref.name]);
}

/** `null` for the empty option and for anything that is not a valid pair. */
export function decodePropertyRef(value: string): WirePropertyRef | null {
  if (value === '') {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed) || parsed.length !== 2) {
    return null;
  }
  const [category, name] = parsed as readonly unknown[];
  if (typeof category !== 'string' || typeof name !== 'string' || name === '') {
    return null;
  }
  return { category, name };
}
