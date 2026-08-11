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

/** Two addresses are the same address. Category and name, both exactly. */
export function propertyRefEquals(
  left: WirePropertyRef | null,
  right: WirePropertyRef | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.category === right.category && left.name === right.name;
}

/**
 * Whether the loaded model sources carry this address at all.
 *
 * The question the pickers ask before they draw. A profile is a site's rule set
 * and outlives any one model: a mapping is perfectly valid while the source
 * that carries it is being re-extracted, has been swapped for a newer issue, or
 * simply is not in this project yet. What must never happen is the picker
 * showing "Not mapped" for it (M4c) — that reads as a decision nobody made, and
 * the next interaction commits the lie.
 */
export function isPropertyInCatalog(
  ref: WirePropertyRef | null,
  properties: readonly { readonly category: string; readonly name: string }[],
): boolean {
  if (ref === null) {
    return false;
  }
  return properties.some((row): boolean => propertyRefEquals(row, ref));
}

/**
 * How a mapped-but-absent address names itself in the picker.
 *
 * States the mapping first and the absence second, because the mapping is the
 * fact and the absence is this moment's circumstance.
 */
export function missingPropertyLabel(ref: WirePropertyRef): string {
  return `Mapped: ${ref.category} > ${ref.name} — not present in the current model sources`;
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
