/**
 * Bounded Levenshtein distance, for proposals only.
 *
 * Edit distance never decides anything in Matchline (PRODUCT.md §9.2), so this
 * only has to answer "is it within `max`, and by how much" -- which lets the
 * whole computation abandon a row once every cell in it has exceeded the bound.
 */

/**
 * Distance between `left` and `right`, or `max + 1` when it exceeds `max`.
 *
 * Comparison is over UTF-16 code units, matching every other ordering and
 * equality decision in the engine.
 */
export function boundedDistance(left: string, right: string, max: number): number {
  if (max < 0) {
    return left === right ? 0 : 1;
  }
  if (left === right) {
    return 0;
  }
  if (Math.abs(left.length - right.length) > max) {
    return max + 1;
  }

  // Two rolling rows over the shorter string keeps the working set small and
  // the loop bounds obvious.
  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  let previous: number[] = Array.from({ length: short.length + 1 }, (_unused, index) => index);
  let current: number[] = new Array<number>(short.length + 1).fill(0);

  for (let longIndex = 1; longIndex <= long.length; longIndex += 1) {
    current[0] = longIndex;
    let rowMinimum = longIndex;
    for (let shortIndex = 1; shortIndex <= short.length; shortIndex += 1) {
      const substitutionCost = long[longIndex - 1] === short[shortIndex - 1] ? 0 : 1;
      const deletion = (previous[shortIndex] ?? 0) + 1;
      const insertion = (current[shortIndex - 1] ?? 0) + 1;
      const substitution = (previous[shortIndex - 1] ?? 0) + substitutionCost;
      const best = Math.min(deletion, insertion, substitution);
      current[shortIndex] = best;
      if (best < rowMinimum) {
        rowMinimum = best;
      }
    }
    if (rowMinimum > max) {
      return max + 1;
    }
    const swap = previous;
    previous = current;
    current = swap;
  }

  return previous[short.length] ?? max + 1;
}
