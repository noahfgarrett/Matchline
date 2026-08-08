/**
 * The source-to-load tree (PRODUCT.md §10).
 *
 * A depth-first walk down feed edges from one source. It is a walk over a
 * graph, not a tree: a load fed from two directions is one node, and the walk
 * reports it once rather than duplicating the subtree under every feeder.
 */
import { compareText } from './order.js';
import type { ElectricalFlow, FlowVisit } from './types.js';

interface WalkFrame {
  readonly nodeId: string;
  readonly depth: number;
  readonly viaEdgeId?: string;
}

/**
 * Walks source to load from one root, yielding each node once.
 *
 * Pre-order and depth-first: a node is yielded before what it feeds, which is
 * the order a source-to-load tree is read in. Children are ordered by node id,
 * so two compiles of the same flow walk it identically.
 *
 * Cycle-safe by construction: a node already yielded is never entered again, so
 * a ring feed terminates instead of unrolling forever. The consequence is that
 * a node reachable by two paths appears under whichever the walk reached first
 * -- its full set of feeders is on `fedBy`, which is the honest place for it.
 *
 * PMD relations are reported on each visit and never descended into. An
 * instrument terminating on a panel is a badge on the panel, not another rung.
 *
 * An unknown `rootNodeId` yields nothing. A projection has no standing to throw
 * at a caller browsing it; an empty walk says the same thing.
 */
export function* walkSourceToLoad(
  flow: ElectricalFlow,
  rootNodeId: string,
): Generator<FlowVisit, void, undefined> {
  if (!flow.nodes.has(rootNodeId)) {
    return;
  }

  const visited = new Set<string>();
  const stack: WalkFrame[] = [{ nodeId: rootNodeId, depth: 0 }];

  while (stack.length > 0) {
    const frame = stack.pop();
    if (frame === undefined) {
      break;
    }
    if (visited.has(frame.nodeId)) {
      continue;
    }
    const node = flow.nodes.get(frame.nodeId);
    if (node === undefined) {
      continue;
    }
    visited.add(frame.nodeId);

    yield {
      node,
      depth: frame.depth,
      ...(frame.viaEdgeId === undefined ? {} : { viaEdgeId: frame.viaEdgeId }),
      pmdRelations: node.pmdRelations,
    };

    // One child per downstream node: parallel cables feed the same thing once.
    // The first edge by (nodeId, edgeId) names the way in, matching the order
    // `feeds` is already sorted into.
    const children: WalkFrame[] = [];
    const seen = new Set<string>();
    for (const ref of node.feeds) {
      if (seen.has(ref.nodeId) || visited.has(ref.nodeId)) {
        continue;
      }
      seen.add(ref.nodeId);
      children.push({ nodeId: ref.nodeId, depth: frame.depth + 1, viaEdgeId: ref.edgeId });
    }

    // Pushed in descending id order so the stack pops them ascending.
    children.sort((left, right) => compareText(right.nodeId, left.nodeId));
    stack.push(...children);
  }
}
