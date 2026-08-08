/**
 * Composite map keys, the donor's `KEYSEP` (U+0001).
 *
 * Spelled as a `fromCharCode` call rather than a literal byte: the donor's own
 * sources embed the raw control character and they are miserable to grep.
 *
 * Keys are built and never split back apart -- every bucket carries its own
 * pieces -- so a control character smuggled in through site data can at worst
 * collide a lookup, never corrupt a decoded field.
 */
const KEY_SEPARATOR = String.fromCharCode(1);

/** The key a (discipline, digit-masked description) pair is learned under. */
export function classificationKey(discipline: string, pattern: string): string {
  return `${discipline}${KEY_SEPARATOR}${pattern}`;
}

/** The key a (child class, parent class) affinity is counted under. */
export function affinityKey(childClass: string, parentClass: string): string {
  return `${childClass}${KEY_SEPARATOR}${parentClass}`;
}
