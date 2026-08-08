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
import type { ResolvedAssetNode, ResolvedSnapshot } from '@matchline/domain';

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
  readonly value: string;
  readonly levels: Map<string, LevelBucket>;
  readonly assets: string[];
}

function newBucket(levelId: string, value: string): LevelBucket {
  return { levelId, value, levels: new Map(), assets: [] };
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

function freeze(bucket: LevelBucket, assets: ReadonlyMap<string, HierarchyAssetNode>): HierarchyLevelNode {
  return {
    levelId: bucket.levelId,
    value: bucket.value,
    levels: [...bucket.levels.values()]
      .sort((left, right) => compareText(left.value, right.value))
      .map((child) => freeze(child, assets)),
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
 * Level values sort in code-unit order under both `sort` settings. `label` and
 * `key` differ only once the Site Profile supplies display labels, which is a
 * later phase; until then the level value *is* the label, and pretending
 * otherwise would be a difference with nothing behind it.
 */
export function hierarchyTree(
  snapshot: ResolvedSnapshot,
  hierarchy: CompileInput['hierarchy'],
  subjects: ReadonlyArray<CompileSubject>,
): HierarchyTree {
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
      const existing = level.get(step.value);
      if (existing === undefined) {
        bucket = newBucket(step.levelId, step.value);
        level.set(step.value, bucket);
      } else {
        bucket = existing;
      }
      level = bucket.levels;
    }
    bucket?.assets.push(assetId);
  }

  return {
    levels: [...top.values()]
      .sort((left, right) => compareText(left.value, right.value))
      .map((bucket) => freeze(bucket, built)),
    assets: [],
  };
}
