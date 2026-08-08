/**
 * Building the projection (PRODUCT.md §10).
 *
 * Three passes over the observations, in this order because each depends on the
 * last: what each tag is, which node each tag became, and then the edges
 * between those nodes. Nothing is decided that a source did not say -- the only
 * judgements made here are the two §9.3 states a tag can land in when identity
 * could not place it, and both keep the tag visible.
 */
import {
  IDENTITY_TIER_ORDER,
  type ConnectivityObservation,
  type IdentityOutcome,
  type IdentityTier,
  type ReviewItem,
} from '@matchline/domain';
import { resolveTags, type IdentityIndex } from '@matchline/identity';

import { buildFeedAdjacency, representativeCycle, stronglyConnectedComponents } from './cycles.js';
import { compareEdgeRefs, compareEdges, comparePaths, compareText } from './order.js';
import type {
  ElectricalFlow,
  FlowAnomaly,
  FlowEdge,
  FlowEdgeRef,
  FlowEnrichment,
  FlowIdentity,
  FlowMatchStatus,
  FlowNode,
  FlowStats,
  IdentityLookup,
  SelfLoopAnomaly,
} from './types.js';

/**
 * Marks a node id as a spelling rather than an asset id.
 *
 * Not a namespace guarantee: `@matchline/asset-catalog` names assets `tag:<tag>`
 * too, so an unplaced spelling can land on a node a matched tag also claims.
 * `buildNodeDrafts` handles that collision rather than assuming it away.
 */
export const SOURCE_ONLY_NODE_PREFIX = 'tag:';

function lookupOutcome(lookup: IdentityLookup, evidenceTag: string): IdentityOutcome | undefined {
  return typeof lookup === 'function' ? lookup(evidenceTag) : lookup.get(evidenceTag);
}

/** Position in the §9.2 ladder; lower is stronger. */
function tierRank(tier: IdentityTier): number {
  const rank = IDENTITY_TIER_ORDER.indexOf(tier);
  return rank === -1 ? IDENTITY_TIER_ORDER.length : rank;
}

/** Where a spelling was seen, which is what decides FLOW_ONLY versus PMD_ONLY. */
interface TagAppearance {
  inFeed: boolean;
  inPmd: boolean;
}

interface NodeDraft {
  readonly nodeId: string;
  readonly evidenceTags: Set<string>;
  /** Mutable: an unplaced spelling may create the node a matched tag then joins. */
  matchStatus: FlowMatchStatus;
  /** The spelling shown, and the ladder rank that earned it the position. */
  displayTag: string;
  displayRank: number;
  assetId?: string;
  identityTier?: IdentityTier;
}

/** Rank for a spelling nothing placed: below every real tier. */
const UNMATCHED_RANK = Number.MAX_SAFE_INTEGER;

/**
 * Which spellings appear in feed observations and which in PMD observations.
 *
 * Both flags can be true for one tag: a panel appears in the cable schedule and
 * again in the PMD.
 */
function collectAppearances(
  observations: ReadonlyArray<ConnectivityObservation>,
): ReadonlyMap<string, TagAppearance> {
  const appearances = new Map<string, TagAppearance>();

  const note = (tag: string, kind: ConnectivityObservation['kind']): void => {
    const existing = appearances.get(tag) ?? { inFeed: false, inPmd: false };
    if (kind === 'feed') {
      existing.inFeed = true;
    } else {
      existing.inPmd = true;
    }
    appearances.set(tag, existing);
  };

  for (const observation of observations) {
    note(observation.fromTag, observation.kind);
    note(observation.toTag, observation.kind);
  }

  return appearances;
}

/**
 * The state of an unmatched tag.
 *
 * Feed presence dominates: a tag seen in a cable schedule and again in the PMD
 * is FLOW_ONLY, because the stronger claim is the one that says it carries
 * power. PMD_ONLY is reserved for tags nothing but the instrument list mentions,
 * which is what makes the badge meaningful in the flow view.
 */
function unmatchedStatus(appearance: TagAppearance | undefined): FlowMatchStatus {
  return appearance?.inFeed === true ? 'flow-only' : 'pmd-only';
}

/**
 * Every endpoint spelling, as nodes.
 *
 * Two spellings that resolve to one asset become one node -- that is
 * normalization and aliasing doing their job -- and both spellings are kept on
 * it. An unresolved spelling becomes its own node with no `assetId`: it is real
 * evidence, and it is not model-authoritative.
 */
function buildNodeDrafts(
  observations: ReadonlyArray<ConnectivityObservation>,
  identity: FlowIdentity,
): { readonly nodeIdByTag: ReadonlyMap<string, string>; readonly drafts: ReadonlyMap<string, NodeDraft> } {
  const appearances = collectAppearances(observations);
  const nodeIdByTag = new Map<string, string>();
  const drafts = new Map<string, NodeDraft>();

  for (const tag of appearances.keys()) {
    const outcome = lookupOutcome(identity.outcomes, tag);
    const matched = outcome !== undefined && outcome.status === 'matched';
    const nodeId = matched ? outcome.assetId : `${SOURCE_ONLY_NODE_PREFIX}${tag}`;
    nodeIdByTag.set(tag, nodeId);

    const rank = matched ? tierRank(outcome.tier) : UNMATCHED_RANK;
    const existing = drafts.get(nodeId);
    if (existing !== undefined) {
      existing.evidenceTags.add(tag);
      if (
        matched &&
        (existing.identityTier === undefined || rank < tierRank(existing.identityTier))
      ) {
        existing.identityTier = outcome.tier;
      }
      // A node an unplaced spelling created can still turn out to be an asset:
      // `tag:<spelling>` and an asset id share a shape, so which observation
      // arrived first must not decide whether the node is model-authoritative.
      if (matched && existing.assetId === undefined) {
        existing.assetId = outcome.assetId;
        existing.matchStatus = 'model-confirmed';
      }
      const closer = rank - existing.displayRank;
      if (closer < 0 || (closer === 0 && compareText(tag, existing.displayTag) < 0)) {
        existing.displayRank = rank;
        existing.displayTag = tag;
      }
      continue;
    }

    const draft: NodeDraft = {
      nodeId,
      evidenceTags: new Set([tag]),
      matchStatus: matched ? 'model-confirmed' : unmatchedStatus(appearances.get(tag)),
      displayTag: tag,
      displayRank: rank,
    };
    if (matched) {
      draft.assetId = outcome.assetId;
      draft.identityTier = outcome.tier;
    }
    drafts.set(nodeId, draft);
  }

  return { nodeIdByTag, drafts };
}

interface EdgePass {
  readonly edges: ReadonlyArray<FlowEdge>;
  readonly selfLoops: ReadonlyArray<SelfLoopAnomaly>;
}

/**
 * One edge per observation, minus the ones that collapsed onto a single node.
 *
 * The importers already drop rows whose two tags are written identically. What
 * survives to here and still loops is a collapse identity caused: two spellings
 * of one asset, stated as feeding each other. That is not a connection, so the
 * edge goes and the anomaly stays.
 */
function buildEdges(
  observations: ReadonlyArray<ConnectivityObservation>,
  nodeIdByTag: ReadonlyMap<string, string>,
): EdgePass {
  const drafts: Array<Omit<FlowEdge, 'edgeId'>> = [];
  const selfLoops: SelfLoopAnomaly[] = [];

  for (const observation of observations) {
    const fromNodeId = nodeIdByTag.get(observation.fromTag);
    const toNodeId = nodeIdByTag.get(observation.toTag);
    if (fromNodeId === undefined || toNodeId === undefined) {
      continue;
    }

    if (fromNodeId === toNodeId) {
      selfLoops.push({
        kind: 'self-loop',
        nodeId: fromNodeId,
        fromTag: observation.fromTag,
        toTag: observation.toTag,
        edgeKind: observation.kind,
        sourceKind: observation.sourceKind,
        provenance: observation.provenance,
      });
      continue;
    }

    drafts.push({
      fromNodeId,
      toNodeId,
      kind: observation.kind,
      relationshipType: observation.relationshipType,
      ...(observation.via === undefined ? {} : { via: observation.via }),
      sourceKind: observation.sourceKind,
      provenance: observation.provenance,
    });
  }

  // Ids are assigned after sorting so that they name a position in the finished
  // projection rather than a position in whatever order the caller supplied.
  const sorted = drafts
    .map((draft) => ({ ...draft, edgeId: '' }))
    .sort((left, right) => compareEdges(left, right));
  const edges = sorted.map((edge, position) => ({
    ...edge,
    edgeId: `edge-${String(position + 1).padStart(4, '0')}`,
  }));

  selfLoops.sort((left, right) => {
    const byNode = compareText(left.nodeId, right.nodeId);
    if (byNode !== 0) {
      return byNode;
    }
    const byFrom = compareText(left.fromTag, right.fromTag);
    return byFrom !== 0 ? byFrom : compareText(left.toTag, right.toTag);
  });

  return { edges, selfLoops };
}

function push(map: Map<string, FlowEdgeRef[]>, nodeId: string, ref: FlowEdgeRef): void {
  const existing = map.get(nodeId);
  if (existing === undefined) {
    map.set(nodeId, [ref]);
    return;
  }
  existing.push(ref);
}

/**
 * Builds the Electrical Flow projection from connectivity observations.
 *
 * Physical connectivity is preserved exactly as the sources stated it. No SSM
 * boundary is enforced and no cross-system feed is demoted: that is the SSM
 * projection's business, and doing it here would destroy the one view where the
 * physical chain stays intact (§10, DECISIONS.md #1).
 *
 * @param observations Feed and PMD observations, in any order.
 * @param identity Resolved outcomes per evidence tag; a tag with no outcome is
 *   treated as unmatched, which is the same thing said two ways.
 * @param enrichment Model metadata by `assetId`, attached to matched nodes only.
 */
export function buildElectricalFlow(
  observations: ReadonlyArray<ConnectivityObservation>,
  identity: FlowIdentity,
  enrichment?: ReadonlyMap<string, FlowEnrichment>,
): ElectricalFlow {
  const { nodeIdByTag, drafts } = buildNodeDrafts(observations, identity);
  const { edges, selfLoops } = buildEdges(observations, nodeIdByTag);

  const feeds = new Map<string, FlowEdgeRef[]>();
  const fedBy = new Map<string, FlowEdgeRef[]>();
  const pmdRelations = new Map<string, FlowEdgeRef[]>();

  for (const edge of edges) {
    const outgoing: FlowEdgeRef = {
      edgeId: edge.edgeId,
      nodeId: edge.toNodeId,
      direction: 'outgoing',
    };
    const incoming: FlowEdgeRef = {
      edgeId: edge.edgeId,
      nodeId: edge.fromNodeId,
      direction: 'incoming',
    };
    if (edge.kind === 'feed') {
      push(feeds, edge.fromNodeId, outgoing);
      push(fedBy, edge.toNodeId, incoming);
    } else {
      push(pmdRelations, edge.fromNodeId, outgoing);
      push(pmdRelations, edge.toNodeId, incoming);
    }
  }

  const nodeIds = [...drafts.keys()].sort(compareText);
  const nodes = new Map<string, FlowNode>();
  const roots: string[] = [];
  let modelConfirmedCount = 0;
  let flowOnlyCount = 0;
  let pmdOnlyCount = 0;
  let multiFeedNodeCount = 0;

  for (const nodeId of nodeIds) {
    const draft = drafts.get(nodeId);
    if (draft === undefined) {
      continue;
    }

    const evidenceTags = [...draft.evidenceTags].sort(compareText);
    const outgoing = (feeds.get(nodeId) ?? []).sort(compareEdgeRefs);
    const incoming = (fedBy.get(nodeId) ?? []).sort(compareEdgeRefs);
    const instruments = (pmdRelations.get(nodeId) ?? []).sort(compareEdgeRefs);
    const attached = draft.assetId === undefined ? undefined : enrichment?.get(draft.assetId);

    nodes.set(nodeId, {
      nodeId,
      tag: draft.displayTag,
      evidenceTags,
      matchStatus: draft.matchStatus,
      ...(draft.assetId === undefined ? {} : { assetId: draft.assetId }),
      ...(draft.identityTier === undefined ? {} : { identityTier: draft.identityTier }),
      ...(attached === undefined ? {} : { enrichment: attached }),
      feeds: outgoing,
      fedBy: incoming,
      pmdRelations: instruments,
    });

    if (outgoing.length > 0 && incoming.length === 0) {
      roots.push(nodeId);
    }
    if (incoming.length >= 2) {
      multiFeedNodeCount += 1;
    }
    switch (draft.matchStatus) {
      case 'model-confirmed':
        modelConfirmedCount += 1;
        break;
      case 'flow-only':
        flowOnlyCount += 1;
        break;
      case 'pmd-only':
        pmdOnlyCount += 1;
        break;
    }
  }

  const adjacency = buildFeedAdjacency(
    nodeIds,
    edges.filter((edge) => edge.kind === 'feed'),
  );
  const cycles = stronglyConnectedComponents(nodeIds, adjacency)
    .map((component) => representativeCycle(component, adjacency))
    .sort(comparePaths);

  const flowAnomalies: FlowAnomaly[] = [
    ...selfLoops,
    ...cycles.map((path) => ({ kind: 'cycle' as const, path })),
  ];

  const stats: FlowStats = {
    nodeCount: nodes.size,
    edgeCount: edges.length,
    modelConfirmedCount,
    flowOnlyCount,
    pmdOnlyCount,
    multiFeedNodeCount,
    cycleCount: cycles.length,
  };

  return {
    nodes,
    edges,
    roots,
    reviewItems: identity.reviewItems ?? [],
    flowAnomalies,
    stats,
  };
}

/**
 * The same projection, resolving identity from an index on the caller's behalf.
 *
 * Convenience only: it collects the distinct endpoint spellings, resolves them
 * once through `@matchline/identity`, and carries the resulting review items
 * onto the flow. Callers that already resolved every tag as part of a compile
 * should use {@link buildElectricalFlow} directly rather than resolving twice.
 */
export function buildElectricalFlowFromIndex(
  observations: ReadonlyArray<ConnectivityObservation>,
  index: IdentityIndex,
  enrichment?: ReadonlyMap<string, FlowEnrichment>,
): ElectricalFlow {
  const tags = [...collectAppearances(observations).keys()].sort(compareText);
  const resolved = resolveTags(index, tags);

  const outcomes = new Map<string, IdentityOutcome>();
  tags.forEach((tag, position) => {
    const outcome = resolved.outcomes[position];
    if (outcome !== undefined) {
      outcomes.set(tag, outcome);
    }
  });

  const reviewItems: ReadonlyArray<ReviewItem> = resolved.reviewItems;
  return buildElectricalFlow(observations, { outcomes, reviewItems }, enrichment);
}
