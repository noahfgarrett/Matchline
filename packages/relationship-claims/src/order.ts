/**
 * Total orders for every list assembly emits.
 *
 * Determinism is a locked invariant (ENGINE.md, semantics rule 3). Sorting by
 * content rather than by arrival is what makes the output independent of the
 * order the caller happened to hand the inputs over in -- and it is also what
 * makes "keep the first" a defined rule when duplicates collapse.
 */
import type { NestingProposalReviewItem, Provenance, SourceRef, SsmRelationshipClaim } from '@matchline/domain';

import { ladderRung } from './mapping.js';
import type { SkippedClaimInput } from './types.js';

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

/** Where a fact came from, as an ordering: file, then address inside it. */
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
  const byDecision = compareOptionalText(left.manualDecision, right.manualDecision);
  if (byDecision !== 0) {
    return byDecision;
  }
  return compareOptionalNumber(left.fallbackRung, right.fallbackRung);
}

/**
 * Claims by child, then by ladder rung, then by proposed parent.
 *
 * Child first because the consumer walks one asset's competing claims at a
 * time; rung second because within one asset the ladder wants them strongest
 * first. The trailing comparisons exist so two claims that differ only in where
 * they were read still have a defined order.
 */
export function compareClaims(left: SsmRelationshipClaim, right: SsmRelationshipClaim): number {
  const bySubject = compareText(left.subjectAssetId, right.subjectAssetId);
  if (bySubject !== 0) {
    return bySubject;
  }
  const byRung = ladderRung(left.ladderSource) - ladderRung(right.ladderSource);
  if (byRung !== 0) {
    return byRung;
  }
  const byTarget = compareText(left.targetAssetId, right.targetAssetId);
  if (byTarget !== 0) {
    return byTarget;
  }
  const byType = compareText(left.relationshipType, right.relationshipType);
  if (byType !== 0) {
    return byType;
  }
  const byProvenance = compareProvenance(left.provenance, right.provenance);
  return byProvenance !== 0 ? byProvenance : compareText(left.rule, right.rule);
}

/** Proposals by asset, then proposed parent, then rule, then confidence. */
export function compareProposals(
  left: NestingProposalReviewItem,
  right: NestingProposalReviewItem,
): number {
  const byAsset = compareText(left.assetId, right.assetId);
  if (byAsset !== 0) {
    return byAsset;
  }
  const byParent = compareText(left.proposedParentId, right.proposedParentId);
  if (byParent !== 0) {
    return byParent;
  }
  const byRule = compareText(left.ruleDetail, right.ruleDetail);
  return byRule !== 0 ? byRule : left.confidence - right.confidence;
}

/** Skipped inputs by rung, then reason, then the refs they named. */
export function compareSkipped(left: SkippedClaimInput, right: SkippedClaimInput): number {
  const byRung = ladderRung(left.ladderSource) - ladderRung(right.ladderSource);
  if (byRung !== 0) {
    return byRung;
  }
  const byReason = compareText(left.reason, right.reason);
  if (byReason !== 0) {
    return byReason;
  }
  const byChild = compareText(left.childRef, right.childRef);
  if (byChild !== 0) {
    return byChild;
  }
  return compareText(left.parentRef ?? '', right.parentRef ?? '');
}
