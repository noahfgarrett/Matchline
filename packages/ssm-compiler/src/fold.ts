/**
 * The boundary fold (PRODUCT.md §11.3, DECISIONS.md #1).
 *
 * This is the most consequential twenty lines in the product, so the rules are
 * stated here in full rather than distributed through the walk:
 *
 * 1. **Boundaries are hard. There is no feed-chain exception.** The donor nested
 *    top-down discipline chains across system boundaries; Matchline deliberately
 *    does not (DECISIONS.md #1). A cross-boundary feed always demotes to a
 *    dependency and stays visible in the Electrical Flow projection instead.
 * 2. **Explicit attributes only.** A value the profile would have defaulted is
 *    not a value here (ENGINE.md binding rule 4). `CompileSubject.attributes`
 *    carries what a source actually stated; anything absent -- or blank -- is
 *    unknown.
 * 3. **Unknown never equals unknown.** Two assets that both lack a building are
 *    not in the same building; they are two assets nobody located. The fold
 *    refuses to keep a parent on that basis under every missing-value policy,
 *    `unassigned-group` included: that policy groups assets for *display*, and a
 *    display bucket is not evidence of co-location.
 * 4. **A definite difference outranks an unknown.** When one enabled boundary
 *    differs and another is missing, the parent is wrong regardless of what the
 *    missing one would have said, so the fold demotes. This is the order
 *    §11.3's own pseudocode states the two clauses in.
 *
 * The manual bypass (§11.5) is not implemented here on purpose -- the walk never
 * calls the fold for a manual claim, which keeps "manual outranks everything"
 * one readable branch instead of a special case buried in the comparison.
 */
import type { HierarchyConfig, HierarchyLevelConfig } from '@matchline/domain';

import { compareText } from './order.js';
import type { CompileSubject } from './types.js';

/** The bucket `unassigned-group` collects unstated values into (§2.4). */
export const UNASSIGNED_GROUP = '(unassigned)';

/**
 * The display label the *tree* files a refused level value under.
 *
 * Not a level path value: `review` and `provisional-root` leave the path value
 * empty, and that stays empty so nothing the fold compares changes meaning.
 * This is the projection's own label for that emptiness, and it is deliberately
 * not `(unassigned)` -- that bucket is a grouping the site asked for, this is a
 * value the site refused to group on.
 */
export const NO_VALUE_GROUP = '(no value)';

/**
 * What the fold concluded about one selected parent.
 *
 * - `keep` -- every enabled boundary is known on both sides and equal.
 * - `demote` -- an enabled boundary differs; `levelId` is the first one, in
 *   configured order.
 * - `missing` -- no enabled boundary differs but at least one is unknown on one
 *   side or the other, so no structural decision is safe.
 */
export type FoldOutcome =
  | { readonly kind: 'keep' }
  | { readonly kind: 'demote'; readonly levelId: string }
  | {
      readonly kind: 'missing';
      readonly levelId: string;
      readonly policy: HierarchyLevelConfig['missingValuePolicy'];
      /** The assets that lacked the value: the child, the parent, or both. */
      readonly missingOn: ReadonlyArray<string>;
    };

/**
 * The stated value at one level, or `null` when nobody stated it.
 *
 * A blank string counts as unstated. A source that wrote an empty cell has not
 * told us the building, and treating `''` as a value would let two blanks
 * compare equal -- rule 3 above, at the one place it could actually leak in.
 */
export function explicitValue(subject: CompileSubject, attributeKey: string): string | null {
  const value = subject.attributes.get(attributeKey);
  if (value === undefined || value === '') {
    return null;
  }
  return value;
}

/** The levels a difference is allowed to break a parent over. */
export function boundaryLevels(
  hierarchy: HierarchyConfig,
): ReadonlyArray<HierarchyLevelConfig> {
  return hierarchy.levels.filter((level) => level.boundary);
}

/**
 * Compare a child against the parent the ladder selected.
 *
 * Two passes on purpose. The first looks for a definite difference across every
 * enabled boundary; only if none exists does the second look for an unknown.
 * One pass would let a missing building at level 1 mask a differing system at
 * level 2, and report "we could not tell" about a parent we can tell is wrong.
 */
export function foldBoundaries(
  child: CompileSubject,
  parent: CompileSubject,
  hierarchy: HierarchyConfig,
): FoldOutcome {
  const levels = boundaryLevels(hierarchy);

  for (const level of levels) {
    const childValue = explicitValue(child, level.attributeKey);
    const parentValue = explicitValue(parent, level.attributeKey);
    if (childValue !== null && parentValue !== null && childValue !== parentValue) {
      return { kind: 'demote', levelId: level.levelId };
    }
  }

  for (const level of levels) {
    const childValue = explicitValue(child, level.attributeKey);
    const parentValue = explicitValue(parent, level.attributeKey);
    if (childValue !== null && parentValue !== null) {
      continue;
    }
    const missingOn: string[] = [];
    if (childValue === null) {
      missingOn.push(child.assetId);
    }
    if (parentValue === null) {
      missingOn.push(parent.assetId);
    }
    return {
      kind: 'missing',
      levelId: level.levelId,
      policy: level.missingValuePolicy,
      missingOn: [...missingOn].sort(compareText),
    };
  }

  return { kind: 'keep' };
}

/**
 * The level values that place one asset, outermost first (ENGINE.md E3 step 3).
 *
 * Projection data only. The fold reads `attributes` directly and never consults
 * a level path, so the `(unassigned)` sentinel can be a visible display bucket
 * without ever becoming something two assets could match on.
 *
 * Under `review` and `provisional-root` the value is the empty string: those
 * policies refuse to bucket the asset, and the missing-boundary review item the
 * fold raised is what a person acts on.
 */
export function levelPathOf(
  subject: CompileSubject,
  hierarchy: HierarchyConfig,
): ReadonlyArray<{ readonly levelId: string; readonly value: string }> {
  return hierarchy.levels.map((level) => {
    const value = explicitValue(subject, level.attributeKey);
    if (value !== null) {
      return { levelId: level.levelId, value };
    }
    return {
      levelId: level.levelId,
      value: level.missingValuePolicy === 'unassigned-group' ? UNASSIGNED_GROUP : '',
    };
  });
}
