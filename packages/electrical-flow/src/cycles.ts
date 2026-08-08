/**
 * Feed loops: finding them, naming them, and leaving them alone.
 *
 * A ring feed is a real electrical arrangement, so nothing here removes an
 * edge. The job is only to tell a reviewer that the graph closes on itself, and
 * to name each loop the same way every time so the report is diffable.
 *
 * Tarjan's algorithm, written iteratively: a plant's feed graph is deep and a
 * recursive walk would put the compile at the mercy of the stack limit.
 */
import { compareText, comparePaths } from './order.js';

/** Adjacency in code-unit ascending order, which every walk below relies on. */
export type FeedAdjacency = ReadonlyMap<string, ReadonlyArray<string>>;

/**
 * Successor lists for feed edges only, sorted and deduplicated.
 *
 * Parallel cables between one pair are one arc for reachability purposes:
 * repeating the successor cannot create or destroy a loop, and deduplicating
 * keeps the walks below linear in distinct arcs.
 */
export function buildFeedAdjacency(
  nodeIds: ReadonlyArray<string>,
  feedEdges: ReadonlyArray<{ readonly fromNodeId: string; readonly toNodeId: string }>,
): FeedAdjacency {
  const successors = new Map<string, Set<string>>();
  for (const nodeId of nodeIds) {
    successors.set(nodeId, new Set());
  }
  for (const edge of feedEdges) {
    successors.get(edge.fromNodeId)?.add(edge.toNodeId);
  }

  const adjacency = new Map<string, ReadonlyArray<string>>();
  for (const [nodeId, targets] of successors) {
    adjacency.set(nodeId, [...targets].sort(compareText));
  }
  return adjacency;
}

interface TarjanFrame {
  readonly nodeId: string;
  /** How far through this node's successor list the walk has got. */
  next: number;
}

/**
 * Strongly connected components with two or more nodes, each sorted.
 *
 * Single-node components are skipped: a lone node is only "strongly connected"
 * to itself through a self-loop, and self-loops were already dropped as
 * anomalies before this runs.
 */
export function stronglyConnectedComponents(
  nodeIds: ReadonlyArray<string>,
  adjacency: FeedAdjacency,
): ReadonlyArray<ReadonlyArray<string>> {
  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  for (const root of nodeIds) {
    if (index.has(root)) {
      continue;
    }

    const frames: TarjanFrame[] = [{ nodeId: root, next: 0 }];
    index.set(root, counter);
    lowLink.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      if (frame === undefined) {
        break;
      }
      const targets = adjacency.get(frame.nodeId) ?? [];

      if (frame.next < targets.length) {
        const target = targets[frame.next] ?? '';
        frame.next += 1;

        const targetIndex = index.get(target);
        if (targetIndex === undefined) {
          index.set(target, counter);
          lowLink.set(target, counter);
          counter += 1;
          stack.push(target);
          onStack.add(target);
          frames.push({ nodeId: target, next: 0 });
        } else if (onStack.has(target)) {
          lowLink.set(
            frame.nodeId,
            Math.min(lowLink.get(frame.nodeId) ?? targetIndex, targetIndex),
          );
        }
        continue;
      }

      frames.pop();
      const parent = frames[frames.length - 1];
      if (parent !== undefined) {
        lowLink.set(
          parent.nodeId,
          Math.min(lowLink.get(parent.nodeId) ?? 0, lowLink.get(frame.nodeId) ?? 0),
        );
      }

      if (lowLink.get(frame.nodeId) === index.get(frame.nodeId)) {
        const component: string[] = [];
        for (;;) {
          const popped = stack.pop();
          if (popped === undefined) {
            break;
          }
          onStack.delete(popped);
          component.push(popped);
          if (popped === frame.nodeId) {
            break;
          }
        }
        if (component.length > 1) {
          components.push(component.sort(compareText));
        }
      }
    }
  }

  return components.sort(comparePaths);
}

/**
 * Rotates a cycle so it starts at its smallest node id.
 *
 * A cycle has no first node -- `a -> b -> c -> a` and `b -> c -> a -> b` are the
 * same loop -- so one rotation has to be chosen as the name. The smallest one
 * is chosen because it is computable from the cycle alone, with no reference to
 * how the search happened to enter it.
 */
export function smallestRotation(path: ReadonlyArray<string>): ReadonlyArray<string> {
  if (path.length <= 1) {
    return path;
  }
  let best = path;
  for (let offset = 1; offset < path.length; offset += 1) {
    const rotated = [...path.slice(offset), ...path.slice(0, offset)];
    if (comparePaths(rotated, best) < 0) {
      best = rotated;
    }
  }
  return best;
}

/**
 * One representative loop through a component: the shortest one through its
 * smallest node id.
 *
 * A component can hold exponentially many simple cycles, and enumerating them
 * would turn a review hint into a denial of service. One named loop per
 * component is what a reviewer can act on; the component being strongly
 * connected is the fact, and the path is how it is shown.
 *
 * Breadth-first with successors already sorted, so the search is deterministic
 * as well as shortest.
 */
export function representativeCycle(
  component: ReadonlyArray<string>,
  adjacency: FeedAdjacency,
): ReadonlyArray<string> {
  const members = new Set(component);
  const start = component[0];
  if (start === undefined) {
    return [];
  }

  const parents = new Map<string, string>();
  const queue: string[] = [start];
  let head = 0;

  while (head < queue.length) {
    const current = queue[head] ?? '';
    head += 1;

    for (const target of adjacency.get(current) ?? []) {
      if (!members.has(target)) {
        continue;
      }
      if (target === start) {
        const path: string[] = [];
        for (let step: string | undefined = current; step !== undefined; step = parents.get(step)) {
          path.push(step);
        }
        path.reverse();
        return smallestRotation(path);
      }
      if (!parents.has(target) && target !== start) {
        parents.set(target, current);
        queue.push(target);
      }
    }
  }

  // Unreachable for a strongly connected component of size two or more: every
  // member reaches every other by definition, `start` included.
  return smallestRotation(component);
}
