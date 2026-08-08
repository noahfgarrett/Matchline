/**
 * Composite map keys for the two learned item-master rungs.
 *
 * ## Deliberate deviation from the donor
 *
 * The donor's `compiler/itemmasters.js` declares `const IM_KEYSEP=''` and joins
 * its key parts with it, so `(discipline 'ic', class 'rio', upn '650')` and
 * `(discipline 'ic', class 'rio6', upn '50')` land on the same bucket. That is a
 * latent collision, not a behavior worth preserving, so this port uses U+0001 —
 * the separator the donor itself uses for every other composite key
 * (`state.js`'s `KEYSEP`, ported in `@matchline/learned-rules/src/keys.ts`).
 *
 * Spelled as a `fromCharCode` call rather than a literal byte: the donor's own
 * sources embed the raw control character and they are miserable to grep.
 *
 * Keys are built and never split back apart — every learned entry carries its
 * own pieces as separate fields — so a control character smuggled in through
 * site data can at worst collide a lookup, never corrupt a decoded field.
 */
const KEY_SEPARATOR = String.fromCharCode(1);

/**
 * Donor rung A: `(discipline, equipment classification, UPN)`.
 *
 * `systemKey` is Matchline's spelling of the registry's UPN column
 * (PRODUCT.md §2.3, "System Key = UPN").
 */
export function classRungKey(discipline: string, equipmentClass: string, systemKey: string): string {
  return [discipline, equipmentClass, systemKey].join(KEY_SEPARATOR);
}

/** Donor rung B: `(discipline, UPN, first word of the equipment description)`. */
export function descriptionRungKey(
  discipline: string,
  systemKey: string,
  descriptionWord: string,
): string {
  return [discipline, systemKey, descriptionWord].join(KEY_SEPARATOR);
}
