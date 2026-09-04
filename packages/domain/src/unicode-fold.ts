/**
 * The one text fold both identity and the System Resolver run.
 *
 * A tag written in Revit and the same tag written in a cable schedule differ by
 * things nobody typed on purpose: an en dash a word processor substituted for a
 * hyphen, a non-breaking space a copy-paste carried in, a zero-width joiner left
 * behind by a PDF. The donor cleaned all of that before comparing anything; the
 * new engine offers only the explicit steps a profile names, so this is the
 * explicit step that means "compare the characters a person would say are the
 * same characters".
 *
 * It lives in `@matchline/domain` because {@link NormalizationStep} does, and
 * because identity and system resolution both run it: two copies of this
 * function is exactly how `MAH001-10-01` ends up matching in one stage and not
 * in the other.
 *
 * What it does, in order:
 *
 * 1. NFKC, so composed and decomposed spellings of one character agree;
 * 2. drops the zero-width characters U+200B-U+200D and U+FEFF, which are
 *    invisible and can therefore never be part of what a person meant;
 * 3. folds the dash family U+2010-U+2015 and the minus sign U+2212 onto the
 *    ASCII hyphen, because a tag separator is a hyphen wherever it was typed;
 * 4. turns a non-breaking space into an ordinary one;
 * 5. removes whitespace either side of a hyphen, so `MAH001 - 10` and
 *    `MAH001-10` are one spelling.
 *
 * What it deliberately does NOT do: trim, change case, or touch anything else.
 * Those are their own steps, and a profile that wants them says so.
 */

/** Characters that are invisible, so they can never be part of a spelling. */
const ZERO_WIDTH = new Set([0x200b, 0x200c, 0x200d, 0xfeff]);

/** Every dash a keyboard, a word processor or a font substitution produces. */
function isDashLike(code: number): boolean {
  return (code >= 0x2010 && code <= 0x2015) || code === 0x2212;
}

/** Whitespace on either side of a hyphen, which a tag never means. */
const AROUND_HYPHEN = /[^\S\r\n]*-[^\S\r\n]*/gu;

/** NFKC, zero-width strip, dash fold, NBSP, whitespace around hyphens. */
export function unicodeFold(value: string): string {
  let folded = '';
  for (const character of value.normalize('NFKC')) {
    const code = character.codePointAt(0);
    if (code === undefined || ZERO_WIDTH.has(code)) {
      continue;
    }
    if (isDashLike(code)) {
      folded += '-';
      continue;
    }
    folded += code === 0x00a0 ? ' ' : character;
  }
  return folded.replaceAll(AROUND_HYPHEN, '-');
}
