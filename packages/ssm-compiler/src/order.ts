/**
 * Total orders for every list the compiler emits.
 *
 * Determinism is a locked invariant (ENGINE.md binding rule 3): the same inputs
 * and the same profile must produce an identical snapshot, whatever order the
 * caller happened to hand the subjects and claims over in. Sorting by content
 * rather than by arrival is what buys that, and it is also what makes "keep the
 * lowest" a defined rule when two claims say the same thing.
 */
import { assertNever } from '@matchline/domain';
import type {
  LadderSourceKind,
  ParentLadderConfig,
  ResolvedDependency,
  ReviewItem,
  SourceRef,
  SsmRelationshipClaim,
} from '@matchline/domain';

/**
 * NUL appears in no asset id, tag or level id, so a composed key stays
 * unambiguous: two items whose fields differ only in where a boundary falls can
 * never collide onto one key and silently dedupe each other away.
 */
const KEY_SEPARATOR = '\u0000';

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
function compareProvenance(
  left: SsmRelationshipClaim['provenance'],
  right: SsmRelationshipClaim['provenance'],
): number {
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
 * A rung's position in the configured ladder, or one past the end when the site
 * disabled it.
 *
 * A disabled rung sorting last is the honest answer: its claims can never win,
 * so they belong at the bottom of a losing-claims list.
 */
export function tierIndex(ladder: ParentLadderConfig, source: LadderSourceKind): number {
  const index = ladder.tiers.indexOf(source);
  return index === -1 ? ladder.tiers.length : index;
}

/**
 * Claims by child, then by configured ladder rung, then by proposed parent.
 *
 * The rung comes second because within one asset the ladder wants them
 * strongest first; the trailing comparisons exist so two claims that differ only
 * in where they were read still have a defined order.
 */
export function compareClaims(
  ladder: ParentLadderConfig,
  left: SsmRelationshipClaim,
  right: SsmRelationshipClaim,
): number {
  const bySubject = compareText(left.subjectAssetId, right.subjectAssetId);
  if (bySubject !== 0) {
    return bySubject;
  }
  const byRung = tierIndex(ladder, left.ladderSource) - tierIndex(ladder, right.ladderSource);
  if (byRung !== 0) {
    return byRung;
  }
  const bySource = compareText(left.ladderSource, right.ladderSource);
  if (bySource !== 0) {
    return bySource;
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

/** Dependencies by upstream asset, then by what the relation is. */
export function compareDependencies(left: ResolvedDependency, right: ResolvedDependency): number {
  const byParent = compareText(left.parentAssetId, right.parentAssetId);
  if (byParent !== 0) {
    return byParent;
  }
  const byType = compareText(left.relationshipType, right.relationshipType);
  return byType !== 0 ? byType : compareProvenance(left.provenance, right.provenance);
}

/**
 * One review item flattened to a sortable, dedupable string.
 *
 * No `default` branch on purpose: adding a member to `ReviewItem` without adding
 * a case here stops this function compiling, so a new review kind can never
 * silently land in an arbitrary position.
 */
export function reviewKey(item: ReviewItem): string {
  switch (item.kind) {
    case 'system-conflict':
      return `${item.kind}${KEY_SEPARATOR}${item.assetId}${KEY_SEPARATOR}${item.claims.length}`;
    case 'duplicate-model-tag':
      return `${item.kind}${KEY_SEPARATOR}${item.canonicalTag}${KEY_SEPARATOR}${item.objectIds.join(',')}`;
    case 'system-catalog-conflict':
      return `${item.kind}${KEY_SEPARATOR}${item.systemKey}${KEY_SEPARATOR}${item.descriptions.join(',')}`;
    case 'fuzzy-identity':
      return `${item.kind}${KEY_SEPARATOR}${item.evidenceTag}${KEY_SEPARATOR}${item.candidates
        .map((candidate) => `${candidate.assetId}:${String(candidate.distance)}`)
        .join(',')}`;
    case 'ambiguous-suffix':
      return `${item.kind}${KEY_SEPARATOR}${item.evidenceTag}${KEY_SEPARATOR}${item.candidateAssetIds.join(',')}`;
    case 'ambiguous-parent':
      return `${item.kind}${KEY_SEPARATOR}${item.assetId}${KEY_SEPARATOR}${item.ladderSource}${KEY_SEPARATOR}${item.candidateParentIds.join(',')}`;
    case 'structural-cycle':
      return `${item.kind}${KEY_SEPARATOR}${item.assetIds.join(',')}`;
    case 'missing-boundary':
      return `${item.kind}${KEY_SEPARATOR}${item.assetId}${KEY_SEPARATOR}${item.levelId}`;
    case 'nesting-proposal':
      return `${item.kind}${KEY_SEPARATOR}${item.assetId}${KEY_SEPARATOR}${item.proposedParentId}${KEY_SEPARATOR}${item.ruleDetail}${KEY_SEPARATOR}${String(item.confidence)}`;
  }
  return assertNever(item, 'unhandled ReviewItem');
}

/** Review items by kind, then by their content. Stable across shuffled inputs. */
export function compareReviewItems(left: ReviewItem, right: ReviewItem): number {
  return compareText(reviewKey(left), reviewKey(right));
}
