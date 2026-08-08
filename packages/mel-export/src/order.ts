/**
 * The one string comparison every ordered output in this package uses.
 *
 * UTF-16 code-unit comparison — `<` on strings, made explicit. Not
 * `localeCompare`: its order depends on the machine's locale and ICU build, and
 * a byte-stable export cannot depend on either. Two engineers on differently
 * configured machines must get one sheet, and a diff between their exports has
 * to mean a real change.
 */
export function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
