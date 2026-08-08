/**
 * Total orders for every list the projection emits.
 *
 * Determinism is a locked invariant (ENGINE.md, semantics rule 3): the same
 * observations in any order must produce the same flow. Sorting by content
 * rather than by arrival is what makes that true, so every comparator here is a
 * total order down to the last tiebreak -- two values that compare equal must
 * genuinely be indistinguishable.
 */
import type { Provenance, SourceRef } from '@matchline/domain';

import type { FlowEdge, FlowEdgeRef } from './types.js';

/** UTF-16 code-unit order, so ordering never depends on a locale. */
export function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

/** Absent sorts before present: "nothing was said" is the lower value. */
function compareOptionalText(left: string | undefined, right: string | undefined): number {
  if (left === undefined) {
    return right === undefined ? 0 : -1;
  }
  if (right === undefined) {
    return 1;
  }
  return compareText(left, right);
}

function compareOptionalNumber(left: number | undefined, right: number | undefined): number {
  if (left === undefined) {
    return right === undefined ? 0 : -1;
  }
  if (right === undefined) {
    return 1;
  }
  return left - right;
}

/** Sheet rows by (sheet, row); model objects by object id; kinds by name. */
function compareSourceRef(left: SourceRef, right: SourceRef): number {
  if (left.kind !== right.kind) {
    return compareText(left.kind, right.kind);
  }
  if (left.kind === 'sheet-row' && right.kind === 'sheet-row') {
    const bySheet = compareText(left.sheet, right.sheet);
    return bySheet !== 0 ? bySheet : left.row - right.row;
  }
  if (left.kind === 'model-object' && right.kind === 'model-object') {
    return compareText(left.objectId, right.objectId);
  }
  return 0;
}

/**
 * Where a fact came from, as an ordering: file, then address inside it.
 *
 * This is the "provenance row" tiebreak: two cables between the same pair of
 * nodes stay in the order the schedule listed them.
 */
export function compareProvenance(left: Provenance, right: Provenance): number {
  const byFile = compareText(left.sourceFile, right.sourceFile);
  if (byFile !== 0) {
    return byFile;
  }
  const byRef = compareSourceRef(left.sourceRef, right.sourceRef);
  if (byRef !== 0) {
    return byRef;
  }
  const byColumn = compareOptionalText(left.propertyOrColumn, right.propertyOrColumn);
  if (byColumn !== 0) {
    return byColumn;
  }
  const byRule = compareOptionalText(left.rule, right.rule);
  if (byRule !== 0) {
    return byRule;
  }
  return compareOptionalNumber(left.fallbackRung, right.fallbackRung);
}

/**
 * Edges by (fromNodeId, toNodeId, provenance), then by everything else.
 *
 * The trailing comparisons exist so that two observations from the same cell --
 * which the importers can produce when one row states two things -- still have
 * a defined order instead of depending on the sort's stability.
 */
export function compareEdges(left: FlowEdge, right: FlowEdge): number {
  const byFrom = compareText(left.fromNodeId, right.fromNodeId);
  if (byFrom !== 0) {
    return byFrom;
  }
  const byTo = compareText(left.toNodeId, right.toNodeId);
  if (byTo !== 0) {
    return byTo;
  }
  const byProvenance = compareProvenance(left.provenance, right.provenance);
  if (byProvenance !== 0) {
    return byProvenance;
  }
  const byKind = compareText(left.kind, right.kind);
  if (byKind !== 0) {
    return byKind;
  }
  const bySource = compareText(left.sourceKind, right.sourceKind);
  if (bySource !== 0) {
    return bySource;
  }
  const byRelationship = compareText(left.relationshipType, right.relationshipType);
  if (byRelationship !== 0) {
    return byRelationship;
  }
  return compareOptionalText(left.via, right.via);
}

/** Edge references by the far node, then by edge id. */
export function compareEdgeRefs(left: FlowEdgeRef, right: FlowEdgeRef): number {
  const byNode = compareText(left.nodeId, right.nodeId);
  return byNode !== 0 ? byNode : compareText(left.edgeId, right.edgeId);
}

/**
 * Sequences of node ids, element by element; a prefix sorts first.
 *
 * Used for cycle paths, which are compared as whole sequences rather than by a
 * joined string so that a separator character appearing in a tag cannot change
 * the order.
 */
export function comparePaths(
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>,
): number {
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const step = compareText(left[index] ?? '', right[index] ?? '');
    if (step !== 0) {
      return step;
    }
  }
  return left.length - right.length;
}
