/**
 * The level tree (ENGINE.md E3 step 3): configured levels → grouping → one
 * structural parent → additive dependencies.
 *
 * Projection only. Nothing here decides anything; it arranges what
 * `compileSnapshot` already decided into the shape the UI and the exports read.
 *
 * One rule is worth stating because it looks like a bug until you know it is the
 * point: an asset is nested under its structural parent's node **wherever that
 * parent sits**, even when the two have different level paths. That is §11.4 --
 * a PLC keeps its native discipline and still appears under a Mechanical Dry
 * parent, as long as discipline is not an enabled boundary. Only assets with no
 * structural parent are filed by their own level path.
 */
import {
  migrateHierarchyConfig,
  type HierarchyLevelConfig,
  type ResolvedAssetNode,
  type ResolvedSnapshot,
} from '@matchline/domain';

import { NO_VALUE_GROUP } from './fold.js';
import { compareText } from './order.js';
import type {
  CompileInput,
  CompileSubject,
  HierarchyAssetNode,
  HierarchyLevelNode,
  HierarchyTree,
} from './types.js';

/** A level node under construction, before its children are frozen. */
interface LevelBucket {
  readonly levelId: string;
  readonly key: string;
  /** The words for this group. The key itself unless a display attribute said otherwise. */
  label: string;
  readonly levels: Map<string, LevelBucket>;
  readonly assets: string[];
}

function newBucket(levelId: string, key: string, label: string): LevelBucket {
  return { levelId, key, label, levels: new Map(), assets: [] };
}

/**
 * Build one asset's subtree.
 *
 * `guard` is what makes this total on a graph the cycle breaker already made
 * acyclic: a re-entered asset is dropped rather than recursed into, so a
 * malformed snapshot degrades to a truncated tree instead of a stack overflow.
 */
function assetNode(
  assetId: string,
  nodes: ReadonlyMap<string, ResolvedAssetNode>,
  childrenOf: ReadonlyMap<string, ReadonlyArray<string>>,
  guard: Set<string>,
): HierarchyAssetNode | null {
  const node = nodes.get(assetId);
  if (node === undefined || guard.has(assetId)) {
    return null;
  }
  guard.add(assetId);

  const children: HierarchyAssetNode[] = [];
  for (const childId of childrenOf.get(assetId) ?? []) {
    const child = assetNode(childId, nodes, childrenOf, guard);
    if (child !== null) {
      children.push(child);
    }
  }

  return {
    assetId,
    status: node.parent.status,
    parentAssetId: node.parent.parentAssetId,
    children,
    dependencies: node.dependencies,
  };
}

/**
 * Sibling order for one level's buckets (PRODUCT.md §2.4's `sort`).
 *
 * `key` orders by the grouping identity, `label` by the words -- which are the
 * same string until a level configures a display attribute, so this only starts
 * to matter under P0-6. Ties break on the key, because two groups can share a
 * label (two systems described identically) but never a key.
 */
function bucketOrder(
  sort: HierarchyLevelConfig['sort'],
): (left: LevelBucket, right: LevelBucket) => number {
  if (sort === 'key') {
    return (left, right) => compareText(left.key, right.key);
  }
  return (left, right) => compareText(left.label, right.label) || compareText(left.key, right.key);
}

function freeze(
  bucket: LevelBucket,
  assets: ReadonlyMap<string, HierarchyAssetNode>,
  levelById: ReadonlyMap<string, HierarchyLevelConfig>,
): HierarchyLevelNode {
  const children = [...bucket.levels.values()];
  // Every sibling bucket is the same configured level -- one step down the one
  // level stack -- so any of them names the `sort` that orders all of them.
  const childSort = levelById.get(children[0]?.levelId ?? '')?.sort ?? 'label';
  return {
    levelId: bucket.levelId,
    key: bucket.key,
    value: bucket.key,
    label: bucket.label,
    levels: children.sort(bucketOrder(childSort)).map((child) => freeze(child, assets, levelById)),
    assets: bucket.assets
      .map((assetId) => assets.get(assetId))
      .filter((asset): asset is HierarchyAssetNode => asset !== undefined),
  };
}

/**
 * Arrange a snapshot into the configured level tree.
 *
 * `subjects` is the compile's asset universe and is what the walk iterates: an
 * asset the snapshot has no node for is not placed, which keeps a tree built
 * from mismatched inputs honest rather than half-invented.
 *
 * Level values sort in code-unit order under both `sort` settings; which string
 * is compared is the level's own `sort` (P0-6). A level with no display
 * attribute has label = key, so the two settings agree and the order is what it
 * has always been.
 */
export function hierarchyTree(
  snapshot: ResolvedSnapshot,
  hierarchyInput: CompileInput['hierarchy'],
  subjects: ReadonlyArray<CompileSubject>,
): HierarchyTree {
  const hierarchy = migrateHierarchyConfig(hierarchyInput);
  const levelById = new Map(hierarchy.levels.map((level) => [level.levelId, level] as const));
  const placeable: string[] = [];
  const seen = new Set<string>();
  for (const subject of subjects) {
    if (seen.has(subject.assetId) || !snapshot.nodes.has(subject.assetId)) {
      continue;
    }
    seen.add(subject.assetId);
    placeable.push(subject.assetId);
  }
  placeable.sort(compareText);

  const childrenOf = new Map<string, string[]>();
  const roots: string[] = [];
  for (const assetId of placeable) {
    const node = snapshot.nodes.get(assetId);
    if (node === undefined) {
      continue;
    }
    const parentId = node.parent.parentAssetId;
    if (parentId === null || !seen.has(parentId)) {
      roots.push(assetId);
      continue;
    }
    const siblings = childrenOf.get(parentId);
    if (siblings === undefined) {
      childrenOf.set(parentId, [assetId]);
      continue;
    }
    siblings.push(assetId);
  }
  for (const siblings of childrenOf.values()) {
    siblings.sort(compareText);
  }

  const guard = new Set<string>();
  const built = new Map<string, HierarchyAssetNode>();
  for (const assetId of roots) {
    const asset = assetNode(assetId, snapshot.nodes, childrenOf, guard);
    if (asset !== null) {
      built.set(assetId, asset);
    }
  }

  if (hierarchy.levels.length === 0) {
    return {
      levels: [],
      assets: roots
        .map((assetId) => built.get(assetId))
        .filter((asset): asset is HierarchyAssetNode => asset !== undefined),
    };
  }

  const top = new Map<string, LevelBucket>();
  for (const assetId of roots) {
    const node = snapshot.nodes.get(assetId);
    if (node === undefined) {
      continue;
    }
    let level = top;
    let bucket: LevelBucket | undefined;
    for (const step of node.levelPath) {
      // A refused value is filed under a named bucket rather than an empty one.
      // The empty string is a real level path value (§11.3's `review` and
      // `provisional-root` policies produce it), but as a *node title* it
      // renders as a blank heading that sorts above every real building -- a
      // rendering bug to look at, and indistinguishable from a level the tree
      // failed to label. Only the projection's label changes; `levelPath` still
      // reads empty, so the fold and the boundary comparisons are untouched.
      const key = step.value === '' ? NO_VALUE_GROUP : step.value;
      const existing = level.get(key);
      if (existing === undefined) {
        // The key is the bucket's identity; the label is only what it is called.
        // Assets arrive in asset-id order, so the first stated label wins and a
        // group whose members disagree about the wording still reads the same
        // way on every compile (ENGINE.md binding rule 3).
        bucket = newBucket(step.levelId, key, step.label ?? key);
        level.set(key, bucket);
      } else {
        bucket = existing;
        if (bucket.label === bucket.key && step.label !== undefined) {
          bucket.label = step.label;
        }
      }
      level = bucket.levels;
    }
    bucket?.assets.push(assetId);
  }

  return {
    levels: [...top.values()]
      .sort(bucketOrder(hierarchy.levels[0]?.sort ?? 'label'))
      .map((bucket) => freeze(bucket, built, levelById)),
    assets: [],
  };
}
