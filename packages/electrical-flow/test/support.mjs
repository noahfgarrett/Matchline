/** Helpers shared by the flow tests. */

/**
 * The whole projection as a plain, comparable value.
 *
 * `nodes` is a Map, whose iteration order is part of the contract, so it is
 * serialized as an array of pairs rather than an object.
 */
export function snapshot(flow) {
  return JSON.stringify({
    nodes: [...flow.nodes.entries()],
    edges: flow.edges,
    roots: flow.roots,
    reviewItems: flow.reviewItems,
    flowAnomalies: flow.flowAnomalies,
    stats: flow.stats,
  });
}

/**
 * A fixed reordering of a list.
 *
 * Deterministic on purpose: a randomized shuffle would make a determinism
 * failure unreproducible, which is the opposite of the point.
 */
export function reorder(items) {
  const odd = items.filter((_, index) => index % 2 === 1);
  const even = items.filter((_, index) => index % 2 === 0);
  return [...odd.reverse(), ...even.reverse()];
}

/** Every node id a walk yields, in order. */
export function walkIds(visits) {
  return [...visits].map((visit) => visit.node.nodeId);
}
