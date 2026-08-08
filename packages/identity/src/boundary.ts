/**
 * Separator boundaries, for the suffix tier.
 *
 * The tier only ever relates two tags where one continues the other past a
 * separator: `MAH001-10-01` and `MAH001-10-01-SPARE` are related, `MAH001-1`
 * and `MAH001-10` are not. Cutting only at boundaries is what stops the tier
 * from matching a tag to an unrelated one that merely shares a digit run.
 */

/**
 * Boundaries used when no anatomy is configured.
 *
 * The characters sites actually punctuate equipment tags with. A site that
 * punctuates differently teaches it through the anatomy's separators.
 */
export const DEFAULT_TAG_SEPARATORS: ReadonlyArray<string> = ['-', '_', '/', '.', ' '];

/** One place a tag can be cut: everything before a separator, and that separator. */
export interface BoundaryCut {
  readonly prefix: string;
  readonly separator: string;
}

/**
 * Every proper boundary cut of `tag`, left to right.
 *
 * Both sides of a cut must be non-empty: a leading or trailing separator names
 * no extension, so `-A` extends nothing and `A-` is not extended by anything.
 */
export function boundaryCuts(
  tag: string,
  separators: ReadonlyArray<string>,
): ReadonlyArray<BoundaryCut> {
  const usable = separators.filter((separator) => separator.length > 0);
  if (usable.length === 0) {
    return [];
  }

  const cuts: BoundaryCut[] = [];
  const seen = new Set<string>();
  for (let index = 1; index < tag.length; index += 1) {
    for (const separator of usable) {
      if (!tag.startsWith(separator, index)) {
        continue;
      }
      // The extension has to be at least one character wide.
      if (index + separator.length >= tag.length) {
        continue;
      }
      const cut: BoundaryCut = { prefix: tag.slice(0, index), separator };
      const key = `${cut.prefix}\u0000${separator}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      cuts.push(cut);
    }
  }
  return cuts;
}
