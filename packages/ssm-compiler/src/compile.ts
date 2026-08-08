/**
 * Parent ladder → boundary fold → snapshot (ENGINE.md E3 steps 1, 2 and 4).
 *
 * The walk is deliberately boring: one asset at a time, one rung at a time,
 * stopping the moment the evidence stops being unambiguous. Three rules run
 * through the whole file and none of them has an exception:
 *
 * 1. **A tie stops the ladder.** A rung offering two candidates raises
 *    `ambiguous-parent` and the walk ends there. Dropping to a weaker rung to
 *    break a tie the stronger evidence could not break is guessing -- the same
 *    rule identity follows at §9.2.
 * 2. **Boundaries are hard** (DECISIONS.md #1). A demoted parent becomes a
 *    dependency and the child keeps looking *below* the rung that produced it,
 *    because a weaker rung may well name a parent on the right side of the
 *    boundary.
 * 3. **Nothing is invented.** No fallback value feeds a comparison, no cycle is
 *    snapped silently, and every claim that lost the slot is retained on the
 *    node that rejected it.
 */
import {
  assertNever,
  LADDER_SOURCE_ORDER,
  type LadderSourceKind,
  type ParentDecision,
  type ParentDemotion,
  type ParentLadderConfig,
  type ResolvedAssetNode,
  type ResolvedDependency,
  type ResolvedSnapshot,
  type ReviewItem,
  type SnapshotStats,
  type SsmRelationshipClaim,
} from '@matchline/domain';
import {
  LADDER_SOURCE_EVIDENCE_TIER,
  LADDER_SOURCE_KIND,
  LADDER_SOURCE_RELATIONSHIP_TYPE,
  LADDER_SOURCE_RULE,
  ladderRung,
} from '@matchline/relationship-claims';

import { foldBoundaries, levelPathOf } from './fold.js';
import {
  compareClaims,
  compareDependencies,
  compareReviewItems,
  compareText,
  reviewKey,
  tierIndex,
} from './order.js';
import type { CompileInput, CompileSubject } from './types.js';

/** The default walk when a site states no ladder of its own (PRODUCT.md §11.1). */
export const DEFAULT_LADDER: ParentLadderConfig = { tiers: LADDER_SOURCE_ORDER };

/**
 * The rule stamped on a dependency the fold created.
 *
 * The demoted claim's own rule is not lost: the claim itself is retained in the
 * node's `losingClaims` with its provenance untouched. What this dependency
 * records is what *made* it a dependency, which is the fold, not the cable
 * schedule that proposed the nesting.
 */
export const BOUNDARY_DEMOTION_RULE = 'ssm.boundaryDemotion';

/** Addresses claims synthesized from the extraction cache's model tree. */
export const MODEL_TREE_SOURCE_FILE = 'extraction-cache';

/** NUL appears in no asset id or relationship type, so composed keys stay unambiguous. */
const KEY_SEPARATOR = '\u0000';

function dependencyKey(parentAssetId: string, relationshipType: string): string {
  return `${parentAssetId}${KEY_SEPARATOR}${relationshipType}`;
}

/**
 * What a missing boundary value means for the child's decision (§11.3).
 *
 * All three policies agree on the important half -- the claim is not kept -- and
 * differ only in what the asset becomes. `unassigned-group` roots it in the
 * visible `(unassigned)` bucket, which is a placement, not a match: see the
 * "unknown never equals unknown" note in fold.ts.
 */
function statusForPolicy(
  policy: 'unassigned-group' | 'review' | 'provisional-root',
): ParentDecision['status'] {
  switch (policy) {
    case 'review':
      return 'unresolved';
    case 'provisional-root':
      return 'provisional-root';
    case 'unassigned-group':
      return 'root';
    default:
      return assertNever(policy, 'unhandled missingValuePolicy');
  }
}

/**
 * The model tree's suggestion, as a claim (PRODUCT.md §11.1 tier 8).
 *
 * `@matchline/relationship-claims` lists `model-tree` in
 * `UNASSEMBLED_LADDER_SOURCES` precisely because the model tree lives in the
 * extraction cache, which only the compiler sees. The rung's stamps are still
 * taken from that package's tables, so a claim synthesized here is
 * indistinguishable from an assembled one everywhere else.
 */
function modelTreeClaim(childAssetId: string, parentAssetId: string): SsmRelationshipClaim {
  return {
    subjectAssetId: childAssetId,
    targetAssetId: parentAssetId,
    kind: 'structural-parent',
    relationshipType: LADDER_SOURCE_RELATIONSHIP_TYPE['model-tree'],
    source: LADDER_SOURCE_KIND['model-tree'],
    rule: LADDER_SOURCE_RULE['model-tree'],
    evidenceTier: LADDER_SOURCE_EVIDENCE_TIER['model-tree'],
    ladderSource: 'model-tree',
    provenance: {
      sourceFile: MODEL_TREE_SOURCE_FILE,
      sourceRef: { kind: 'model-object', objectId: childAssetId },
      rule: LADDER_SOURCE_RULE['model-tree'],
      fallbackRung: ladderRung('model-tree'),
    },
  };
}

/** One asset's resolution, before cycles are considered. */
interface SubjectResolution {
  readonly node: ResolvedAssetNode;
  readonly reviewItems: ReadonlyArray<ReviewItem>;
  /** Parents this asset's walk demoted. Several are possible in one walk. */
  readonly demotionCount: number;
}

/** Everything the walk reads that is the same for every subject. */
interface WalkContext {
  readonly subjectById: ReadonlyMap<string, CompileSubject>;
  readonly ladder: ParentLadderConfig;
  readonly hierarchy: CompileInput['hierarchy'];
  readonly structuralBySubject: ReadonlyMap<string, ReadonlyArray<SsmRelationshipClaim>>;
  readonly dependenciesBySubject: ReadonlyMap<string, ReadonlyArray<SsmRelationshipClaim>>;
  readonly makeRootIds: ReadonlySet<string>;
}

/**
 * Every structural claim about one asset, strongest rung first.
 *
 * Claims naming a parent outside the compile are kept in the pool -- they can
 * never win, but they are evidence, and dropping them would make a dead rule
 * invisible. The candidate index below is what filters them out of contention.
 */
function claimPool(subject: CompileSubject, ctx: WalkContext): ReadonlyArray<SsmRelationshipClaim> {
  const assembled = ctx.structuralBySubject.get(subject.assetId) ?? [];
  const pool = [...assembled];

  const suggested = subject.modelTreeParentId;
  if (suggested !== undefined && suggested !== '' && suggested !== subject.assetId) {
    const alreadyClaimed = assembled.some(
      (claim) => claim.ladderSource === 'model-tree' && claim.targetAssetId === suggested,
    );
    if (!alreadyClaimed) {
      pool.push(modelTreeClaim(subject.assetId, suggested));
    }
  }

  return pool.sort((left, right) => compareClaims(ctx.ladder, left, right));
}

/** Candidate parents per rung: one entry per distinct parent, lowest claim kept. */
function indexCandidates(
  pool: ReadonlyArray<SsmRelationshipClaim>,
  ctx: WalkContext,
): ReadonlyMap<LadderSourceKind, ReadonlyMap<string, SsmRelationshipClaim>> {
  const byTier = new Map<LadderSourceKind, Map<string, SsmRelationshipClaim>>();
  for (const claim of pool) {
    if (!ctx.subjectById.has(claim.targetAssetId)) {
      continue;
    }
    const existing = byTier.get(claim.ladderSource);
    if (existing === undefined) {
      byTier.set(claim.ladderSource, new Map([[claim.targetAssetId, claim]]));
      continue;
    }
    if (!existing.has(claim.targetAssetId)) {
      existing.set(claim.targetAssetId, claim);
    }
  }
  return byTier;
}

/** The dependency claims for one asset, deduped by (upstream asset, type). */
function baseDependencies(
  subject: CompileSubject,
  ctx: WalkContext,
): Map<string, ResolvedDependency> {
  const claims = [...(ctx.dependenciesBySubject.get(subject.assetId) ?? [])].sort((left, right) =>
    compareClaims(ctx.ladder, left, right),
  );
  const dependencies = new Map<string, ResolvedDependency>();
  for (const claim of claims) {
    const key = dependencyKey(claim.targetAssetId, claim.relationshipType);
    if (dependencies.has(key)) {
      continue;
    }
    dependencies.set(key, {
      parentAssetId: claim.targetAssetId,
      relationshipType: claim.relationshipType,
      provenance: claim.provenance,
    });
  }
  return dependencies;
}

/**
 * Walk the ladder for one asset and fold whatever it selects.
 *
 * The loop index is the whole reason demotion works: continuing at `i + 1` is
 * "the parent that rung named is on the wrong side of a boundary, so ask the
 * next-weakest rung", which is exactly what §11.3's "the child resolves under a
 * valid parent in its own boundary or becomes a root" asks for.
 */
function resolveSubject(subject: CompileSubject, ctx: WalkContext): SubjectResolution {
  const pool = claimPool(subject, ctx);
  const levelPath = levelPathOf(subject, ctx.hierarchy);
  const dependencies = baseDependencies(subject, ctx);
  const reviewItems: ReviewItem[] = [];

  let status: ParentDecision['status'] = 'root';
  let parentAssetId: string | null = null;
  let winningSource: LadderSourceKind | null = null;
  let winningClaim: SsmRelationshipClaim | undefined;
  let firstDemotion: ParentDemotion | undefined;
  /**
   * Distinct parents this walk demoted. One parent can be named by two rungs;
   * that is one parent the fold took away, not two, and the stat has to agree
   * with the dependency list a reviewer is looking at.
   */
  const demotedParents = new Set<string>();

  // A manual make-root is not a claim about a pair, it is a person stating there
  // is no pair. It outranks every rung, so nothing below is consulted (§11.5).
  if (!ctx.makeRootIds.has(subject.assetId)) {
    const byTier = indexCandidates(pool, ctx);

    for (let index = 0; index < ctx.ladder.tiers.length; index += 1) {
      const tier = ctx.ladder.tiers[index];
      if (tier === undefined) {
        continue;
      }
      const candidates = byTier.get(tier);
      if (candidates === undefined || candidates.size === 0) {
        continue;
      }

      if (candidates.size > 1) {
        reviewItems.push({
          kind: 'ambiguous-parent',
          assetId: subject.assetId,
          ladderSource: tier,
          candidateParentIds: [...candidates.keys()].sort(compareText),
        });
        status = 'unresolved';
        break;
      }

      let selectedParentId: string | undefined;
      let selectedClaim: SsmRelationshipClaim | undefined;
      for (const [candidateId, claim] of candidates) {
        selectedParentId = candidateId;
        selectedClaim = claim;
      }
      if (selectedParentId === undefined || selectedClaim === undefined) {
        continue;
      }

      // §11.5: a manual parent bypasses the fold entirely. A person who reparents
      // across a building boundary has said something the rules may not overrule
      // -- manual outranks, and outranking means the fold is not consulted at all.
      if (tier === 'manual') {
        status = 'resolved';
        parentAssetId = selectedParentId;
        winningSource = tier;
        winningClaim = selectedClaim;
        break;
      }

      const parentSubject = ctx.subjectById.get(selectedParentId);
      if (parentSubject === undefined) {
        continue;
      }

      const outcome = foldBoundaries(subject, parentSubject, ctx.hierarchy);
      if (outcome.kind === 'keep') {
        status = 'resolved';
        parentAssetId = selectedParentId;
        winningSource = tier;
        winningClaim = selectedClaim;
        break;
      }

      if (outcome.kind === 'demote') {
        demotedParents.add(selectedParentId);
        if (firstDemotion === undefined) {
          // The strongest rung the fold took a parent away from is the one a
          // reviewer asks about ("why is this not under panel 603?"), so that is
          // the demotion the decision carries when a walk demotes more than once.
          firstDemotion = {
            parentAssetId: selectedParentId,
            boundaryLevelId: outcome.levelId,
          };
        }
        // The relationship remains real; it just stops nesting (§2.5).
        //
        // First writer wins, the same rule `baseDependencies` follows. The walk
        // runs strongest rung first, so when two rungs name one out-of-boundary
        // parent the first demotion is the strongest one -- and that is the
        // provenance `demotedFrom` already carries. Overwriting it with the
        // weaker rung's would leave the decision and the dependency it produced
        // pointing at two different rows.
        const key = dependencyKey(selectedParentId, 'DEPENDENCY');
        if (!dependencies.has(key)) {
          dependencies.set(key, {
            parentAssetId: selectedParentId,
            relationshipType: 'DEPENDENCY',
            provenance: { ...selectedClaim.provenance, rule: BOUNDARY_DEMOTION_RULE },
          });
        }
        continue;
      }

      // Missing: no structural decision is safe, from this claim or any weaker
      // one. Walking on would be asking a worse rung to resolve an unknown the
      // better rung could not, which is the guess §11.3 forbids. Nor does the
      // parent become a dependency -- the fold never established that the two
      // are related the way a demotion establishes it. The claim is retained.
      for (const assetId of outcome.missingOn) {
        reviewItems.push({ kind: 'missing-boundary', assetId, levelId: outcome.levelId });
      }
      status = statusForPolicy(outcome.policy);
      break;
    }
  }

  const losingClaims = pool.filter((claim) => claim !== winningClaim);
  const decision: ParentDecision = {
    parentAssetId,
    ladderSource: winningSource,
    status,
    ...(winningClaim === undefined ? {} : { winningClaim }),
    ...(firstDemotion === undefined ? {} : { demotedFrom: firstDemotion }),
  };

  return {
    node: {
      assetId: subject.assetId,
      parent: decision,
      dependencies: [...dependencies.values()].sort(compareDependencies),
      levelPath,
      losingClaims,
    },
    reviewItems,
    demotionCount: demotedParents.size,
  };
}

/**
 * Every structural cycle in the resolved parent graph.
 *
 * Each asset has at most one structural parent, so the graph is functional and
 * every cycle is simple: walking parents from any node either terminates or
 * closes exactly one loop. That is what makes "downgrade one node" a complete
 * fix rather than a heuristic.
 */
function findCycles(
  nodes: ReadonlyMap<string, ResolvedAssetNode>,
  orderedIds: ReadonlyArray<string>,
): ReadonlyArray<ReadonlyArray<string>> {
  const parentOf = new Map<string, string>();
  for (const [assetId, node] of nodes) {
    const parentId = node.parent.parentAssetId;
    if (parentId !== null && nodes.has(parentId)) {
      parentOf.set(assetId, parentId);
    }
  }

  const settled = new Set<string>();
  const cycles: string[][] = [];

  for (const startId of orderedIds) {
    if (settled.has(startId)) {
      continue;
    }
    const path: string[] = [];
    const positionInPath = new Map<string, number>();
    let current: string | undefined = startId;

    while (current !== undefined && !settled.has(current) && !positionInPath.has(current)) {
      positionInPath.set(current, path.length);
      path.push(current);
      current = parentOf.get(current);
    }

    if (current !== undefined) {
      const start = positionInPath.get(current);
      if (start !== undefined) {
        cycles.push(path.slice(start));
      }
    }

    for (const visited of path) {
      settled.add(visited);
    }
  }

  return cycles;
}

/**
 * The member of a cycle whose parent is least worth keeping.
 *
 * Weakest winning rung first (latest in the configured ladder), then the largest
 * asset id in code-unit order. Both halves are arbitrary in the sense that no
 * evidence prefers one edge -- which is exactly why the rule has to be stated
 * and stable rather than left to iteration order.
 */
function weakestMember(
  cycle: ReadonlyArray<string>,
  nodes: ReadonlyMap<string, ResolvedAssetNode>,
  ladder: ParentLadderConfig,
): string | undefined {
  let chosen: string | undefined;
  let chosenRank = -1;

  for (const assetId of cycle) {
    const node = nodes.get(assetId);
    if (node === undefined) {
      continue;
    }
    const source = node.parent.ladderSource;
    const rank = source === null ? ladder.tiers.length : tierIndex(ladder, source);
    if (chosen === undefined || rank > chosenRank) {
      chosen = assetId;
      chosenRank = rank;
      continue;
    }
    if (rank === chosenRank && compareText(assetId, chosen) > 0) {
      chosen = assetId;
    }
  }

  return chosen;
}

/** Strip a node's structural parent, keeping the claim that produced it as a loser. */
function downgrade(node: ResolvedAssetNode, ladder: ParentLadderConfig): ResolvedAssetNode {
  const rejected = node.parent.winningClaim;
  const losingClaims =
    rejected === undefined
      ? node.losingClaims
      : [...node.losingClaims, rejected].sort((left, right) => compareClaims(ladder, left, right));

  return {
    ...node,
    parent: {
      parentAssetId: null,
      ladderSource: null,
      status: 'unresolved',
      ...(node.parent.demotedFrom === undefined ? {} : { demotedFrom: node.parent.demotedFrom }),
    },
    losingClaims,
  };
}

/**
 * Resolve every asset into one immutable snapshot.
 *
 * Subjects are processed in asset-id order and every emitted list is sorted by
 * content, so a shuffled input produces a byte-identical snapshot (ENGINE.md
 * binding rule 3). Subjects sharing an asset id collapse to the first, matching
 * how `@matchline/relationship-claims` treats them.
 */
export function compileSnapshot(input: CompileInput): ResolvedSnapshot {
  const subjectById = new Map<string, CompileSubject>();
  for (const subject of input.subjects) {
    if (!subjectById.has(subject.assetId)) {
      subjectById.set(subject.assetId, subject);
    }
  }
  const orderedIds = [...subjectById.keys()].sort(compareText);
  const ladder = input.ladder ?? DEFAULT_LADDER;

  const structuralBySubject = new Map<string, SsmRelationshipClaim[]>();
  for (const claim of input.claims.structural) {
    const existing = structuralBySubject.get(claim.subjectAssetId);
    if (existing === undefined) {
      structuralBySubject.set(claim.subjectAssetId, [claim]);
      continue;
    }
    existing.push(claim);
  }

  const dependenciesBySubject = new Map<string, SsmRelationshipClaim[]>();
  for (const claim of input.claims.dependencies) {
    const existing = dependenciesBySubject.get(claim.subjectAssetId);
    if (existing === undefined) {
      dependenciesBySubject.set(claim.subjectAssetId, [claim]);
      continue;
    }
    existing.push(claim);
  }

  const makeRootIds = new Set<string>();
  for (const directive of input.claims.makeRoot) {
    if (subjectById.has(directive.childAssetId)) {
      makeRootIds.add(directive.childAssetId);
    }
  }

  const ctx: WalkContext = {
    subjectById,
    ladder,
    hierarchy: input.hierarchy,
    structuralBySubject,
    dependenciesBySubject,
    makeRootIds,
  };

  const nodes = new Map<string, ResolvedAssetNode>();
  const reviewItems: ReviewItem[] = [];
  let demotedToDependencyCount = 0;

  for (const assetId of orderedIds) {
    const subject = subjectById.get(assetId);
    if (subject === undefined) {
      continue;
    }
    const resolution = resolveSubject(subject, ctx);
    nodes.set(assetId, resolution.node);
    reviewItems.push(...resolution.reviewItems);
    demotedToDependencyCount += resolution.demotionCount;
  }

  const cycles = findCycles(nodes, orderedIds);
  for (const cycle of cycles) {
    reviewItems.push({ kind: 'structural-cycle', assetIds: [...cycle].sort(compareText) });
    const weakest = weakestMember(cycle, nodes, ladder);
    if (weakest === undefined) {
      continue;
    }
    const node = nodes.get(weakest);
    if (node === undefined) {
      continue;
    }
    nodes.set(weakest, downgrade(node, ladder));
  }

  const deduped = new Map<string, ReviewItem>();
  for (const item of [...reviewItems].sort(compareReviewItems)) {
    const key = reviewKey(item);
    if (!deduped.has(key)) {
      deduped.set(key, item);
    }
  }
  const finalReviewItems = [...deduped.values()];

  let rootCount = 0;
  let unresolvedCount = 0;
  let ambiguousCount = 0;
  for (const node of nodes.values()) {
    if (node.parent.status === 'root' || node.parent.status === 'provisional-root') {
      rootCount += 1;
    }
    if (node.parent.status === 'unresolved') {
      unresolvedCount += 1;
    }
  }
  for (const item of finalReviewItems) {
    if (item.kind === 'ambiguous-parent') {
      ambiguousCount += 1;
    }
  }

  const stats: SnapshotStats = {
    nodeCount: nodes.size,
    rootCount,
    demotedToDependencyCount,
    unresolvedCount,
    cycleCount: cycles.length,
    ambiguousCount,
  };

  return { nodes, reviewItems: finalReviewItems, stats };
}
