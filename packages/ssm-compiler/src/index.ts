/**
 * `@matchline/ssm-compiler` -- parent ladder, boundary fold, projection,
 * snapshot (ENGINE.md E3, PRODUCT.md §11).
 *
 * This is where evidence becomes a hierarchy, and it is the one package whose
 * semantics are not negotiable:
 *
 * - **Boundaries are hard, with no feed-chain exception** (DECISIONS.md #1). A
 *   cross-boundary parent is removed and demoted to a dependency; the physical
 *   chain stays whole in the Electrical Flow projection instead.
 * - **A tie stops the ladder.** A rung with two candidates raises
 *   `ambiguous-parent` and nothing weaker is consulted.
 * - **Explicit attributes only.** No profile fallback value ever feeds a
 *   boundary comparison, and unknown never equals unknown.
 * - **Manual outranks, and still folds** (P0-4). A human-stated parent beats
 *   every rung of the ladder and is then compared against the enabled
 *   boundaries like any other winner: one that crosses becomes a dependency,
 *   with the manual origin, the demotion and a `manual-boundary-demotion`
 *   review item all recorded. A human-stated root is still a root, final (§11.5).
 * - **A level's key is its identity, its label is only words** (P0-6). Grouping
 *   and boundaries compare the key attribute; re-describing a system moves
 *   nothing.
 * - **Deterministic.** Same subjects, same claims, same profile → an identical
 *   snapshot, whatever order the caller supplied them in.
 *
 * Pure, zero dependencies outside the workspace.
 */
export { BOUNDARY_DEMOTION_RULE, compileSnapshot, DEFAULT_LADDER, MODEL_TREE_SOURCE_FILE } from './compile.js';

export {
  boundaryLevels,
  boundaryValue,
  explicitValue,
  foldBoundaries,
  levelPathOf,
  NO_VALUE_GROUP,
  UNASSIGNED_GROUP,
} from './fold.js';
export type { FoldOutcome } from './fold.js';

export { hierarchyTree } from './tree.js';

export { compareReviewItems, reviewKey } from './order.js';

export type {
  CompileClaims,
  CompileInput,
  CompileSubject,
  HierarchyAssetNode,
  HierarchyLevelNode,
  HierarchyTree,
} from './types.js';
