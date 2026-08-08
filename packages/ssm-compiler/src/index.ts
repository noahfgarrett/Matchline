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
 * - **Manual outranks and bypasses.** A human-stated parent is kept across any
 *   boundary, and a human-stated root is a root (§11.5).
 * - **Deterministic.** Same subjects, same claims, same profile → an identical
 *   snapshot, whatever order the caller supplied them in.
 *
 * Pure, zero dependencies outside the workspace.
 */
export { BOUNDARY_DEMOTION_RULE, compileSnapshot, DEFAULT_LADDER, MODEL_TREE_SOURCE_FILE } from './compile.js';

export {
  boundaryLevels,
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
