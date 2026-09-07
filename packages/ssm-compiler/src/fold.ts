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
 * 5. **No rung is exempt, manual included** (P0-4). A person's parent wins the
 *    ladder competition and is then folded like any other winner. The fold does
 *    not know which rung selected the parent it is comparing, and that is the
 *    point: "cross-boundary manual → dependency", not a second set of rules.
 * 6. **One exception exists, and a site has to write it down.** The SSM SOP
 *    says a controls device nests under the equipment it serves even when the
 *    two sit in different disciplines -- SSM-Audit's `parent.cross-discipline`
 *    calls that the approved exception. So a level may carry
 *    `boundaryExceptions.childClasses`, and a CHILD of one of those classes is
 *    not compared at that level at all: not for a difference, and not for a
 *    missing value either, because a level that does not apply cannot be
 *    unknown about anything. It is keyed on the child's class and on one named
 *    level, so it can never widen into "boundaries are soft": a class off the
 *    list, or a level with no list, folds exactly as it always did. The default
 *    preset ships no exception (P0-5 makes SSM Discipline non-structural
 *    instead); the starter profile is what proposes one.
 *
 * What a boundary compares is the level's boundary attribute, which defaults to
 * its key (P0-6). Never its display attribute: a level that compared the words
 * would demote a parent every time somebody re-typed a description.
 *
 * And it compares it FOLDED -- see {@link boundaryValue}. Rule 3 says unknown
 * never equals unknown; it does not say `D1` differs from `d1`, and treating
 * them as two buildings demoted every cross-file parent on a site whose model
 * property and whose assignment rule disagreed only about a capital letter.
 * The fold decides equality and nothing else: the value a level groups by,
 * exports and shows is still exactly what the source wrote.
 */
import {
  boundaryAttributeOf,
  displayAttributeOf,
  unicodeFold,
  type HierarchyConfig,
  type HierarchyLevelConfig,
  type ResolvedLevelPathEntry,
} from '@matchline/domain';

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

/**
 * The same value as {@link explicitValue}, in the spelling a boundary compares.
 *
 * Two assets in building `D1` and building `d1` are in one building. One source
 * writes the model property, another writes an assignment rule, and a third
 * pastes a cell with a trailing space; comparing those three raw would demote
 * every parent between them and say nothing about why. So the comparison folds
 * -- unicode, then whitespace, then case -- and only the comparison does. What
 * is stored, grouped by, exported and shown to a person is the value the source
 * wrote (P0-6: a level's key is its identity, and re-typing it must not move
 * equipment).
 *
 * A value that is only whitespace folds to nothing and is unknown, for the same
 * reason a blank one is: nobody stated a building by pressing space.
 */
export function boundaryValue(subject: CompileSubject, attributeKey: string): string | null {
  const stated = explicitValue(subject, attributeKey);
  if (stated === null) {
    return null;
  }
  const folded = unicodeFold(stated).trim().toLowerCase();
  return folded === '' ? null : folded;
}

/** The levels a difference is allowed to break a parent over. */
export function boundaryLevels(
  hierarchy: HierarchyConfig,
): ReadonlyArray<HierarchyLevelConfig> {
  return hierarchy.levels.filter((level) => level.boundary);
}

/**
 * Whether this level's boundary is waived for this child (rule 6 above).
 *
 * The CHILD's class, never the parent's: the SOP's sentence is "a controls
 * device nests under the equipment it serves", and reading the parent's class
 * instead would let an air handler nest under a drive.
 */
export function boundaryWaived(child: CompileSubject, level: HierarchyLevelConfig): boolean {
  const exceptions = level.boundaryExceptions;
  if (exceptions === undefined) {
    return false;
  }
  const childClass = child.equipmentClass;
  if (childClass === undefined) {
    return false;
  }
  return exceptions.childClasses.includes(childClass);
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
    if (boundaryWaived(child, level)) {
      continue;
    }
    const attributeKey = boundaryAttributeOf(level);
    const childValue = boundaryValue(child, attributeKey);
    const parentValue = boundaryValue(parent, attributeKey);
    if (childValue !== null && parentValue !== null && childValue !== parentValue) {
      return { kind: 'demote', levelId: level.levelId };
    }
  }

  for (const level of levels) {
    if (boundaryWaived(child, level)) {
      continue;
    }
    const attributeKey = boundaryAttributeOf(level);
    const childValue = boundaryValue(child, attributeKey);
    const parentValue = boundaryValue(parent, attributeKey);
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
 *
 * `label` (P0-6) is carried only where a level names a display attribute and
 * the asset states one. An asset that states the key but not the words is
 * labelled by its key rather than by a blank, and an asset with no key at all
 * is labelled by its sentinel -- in both cases by leaving `label` off, so the
 * one string that decides anything stays the one string a reader compares.
 */
export function levelPathOf(
  subject: CompileSubject,
  hierarchy: HierarchyConfig,
): ReadonlyArray<ResolvedLevelPathEntry> {
  return hierarchy.levels.map((level): ResolvedLevelPathEntry => {
    const value = explicitValue(subject, level.keyAttributeKey);
    if (value === null) {
      return {
        levelId: level.levelId,
        value: level.missingValuePolicy === 'unassigned-group' ? UNASSIGNED_GROUP : '',
      };
    }
    const displayKey = displayAttributeOf(level);
    const label = displayKey === null ? null : explicitValue(subject, displayKey);
    if (label === null || label === value) {
      return { levelId: level.levelId, value };
    }
    return { levelId: level.levelId, value, label };
  });
}
