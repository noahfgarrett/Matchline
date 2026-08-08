/**
 * The vocabulary of the Electrical Flow projection (PRODUCT.md §10).
 *
 * Flow preserves physical and logical source-to-load connectivity. It does NOT
 * enforce SSM structural boundaries: a feed that crosses a system, building or
 * discipline boundary stays visible here exactly as a feed, and the demotion to
 * a dependency belongs to the SSM projection alone (§2.5, DECISIONS.md #1).
 *
 * Two consequences shape every type below:
 *
 * 1. A tag identity could not place is still a node. FLOW_ONLY and PMD_ONLY
 *    records "remain visible and can be promoted through review" (§9.3), so
 *    they are first-class here -- they simply carry no `assetId` and no model
 *    enrichment, because nothing model-authoritative is known about them.
 * 2. One observation is one edge. Two parallel cables between the same pair of
 *    tags are two facts stated by the source, and the flow view has to show
 *    multiple feeds and alternate feeds (§10), so nothing is deduplicated.
 */
import type {
  ConnectivitySourceKind,
  IdentityOutcome,
  IdentityTier,
  Provenance,
  RelationshipType,
  ReviewItem,
  SourceStatus,
} from '@matchline/domain';

/**
 * How much the model has to say about a node.
 *
 * The three values are the §9.3 states that can arise from connectivity
 * evidence, in this projection's vocabulary; {@link sourceStatusOf} maps them
 * back onto the canonical `SourceStatus` union.
 */
export type FlowMatchStatus = 'model-confirmed' | 'flow-only' | 'pmd-only';

/** The §9.3 state a match status corresponds to. */
export function sourceStatusOf(status: FlowMatchStatus): SourceStatus {
  switch (status) {
    case 'model-confirmed':
      return 'MODEL_CONFIRMED';
    case 'flow-only':
      return 'FLOW_ONLY';
    case 'pmd-only':
      return 'PMD_ONLY';
  }
}

/**
 * What the model knows about an asset, for the nodes that matched one.
 *
 * The field list is §10's: "Model assets enrich the nodes with Description,
 * Type, Building, Discipline, System, Model source, Model confirmation status."
 * Confirmation status is not repeated here -- it is {@link FlowNode.matchStatus},
 * which is derived rather than supplied.
 *
 * Every field is optional because enrichment is a courtesy, not a contract: a
 * caller that only has descriptions supplies only descriptions, and §4.2 is
 * explicit that model authority does not require every field to be in the
 * model.
 */
export interface FlowEnrichment {
  readonly description?: string;
  readonly equipmentType?: string;
  readonly building?: string;
  /** Discipline as the model named it, unmapped. */
  readonly nativeDiscipline?: string;
  readonly systemKey?: string;
  readonly systemLabel?: string;
  /** The model file the asset was extracted from. */
  readonly sourceModelFile?: string;
}

/** Which way an edge points, relative to the node holding the reference. */
export type FlowEdgeDirection = 'outgoing' | 'incoming';

/**
 * One edge as seen from one of its endpoints.
 *
 * `nodeId` is always the *other* end, so a reference read off a node answers
 * "what is on the far side of this" without a second map lookup.
 */
export interface FlowEdgeRef {
  readonly edgeId: string;
  readonly nodeId: string;
  readonly direction: FlowEdgeDirection;
}

/**
 * One node in the flow: a physical thing something was said to connect to.
 *
 * `nodeId` is the `assetId` when identity placed the tag, and `tag:<spelling>`
 * when it did not. The prefix is deliberate -- a source-only node must never be
 * mistakable for an asset id, and it carries no `assetId` at all, because
 * asserting one would make a projection into an authority the model never gave
 * it (§2.1).
 */
export interface FlowNode {
  readonly nodeId: string;
  /**
   * The display spelling.
   *
   * Identity reports which asset a spelling means, not what the model calls it,
   * so a node's display tag is always one of the evidence spellings. When
   * several merged, the one that matched at the strongest tier wins -- an exact
   * hit is the model's own spelling, an alias is somebody's shorthand for it --
   * with code-unit order as the tiebreak. `evidenceTags` carries them all.
   */
  readonly tag: string;
  /**
   * Every distinct spelling that resolved to this node, code-unit ascending.
   *
   * More than one means normalization or an alias did its job: two documents
   * wrote the same asset differently and both are recorded rather than one
   * being silently preferred.
   */
  readonly evidenceTags: ReadonlyArray<string>;
  readonly matchStatus: FlowMatchStatus;
  /** Present only on `model-confirmed` nodes. */
  readonly assetId?: string;
  /** The tier that placed the tag; the strongest one, if spellings differ. */
  readonly identityTier?: IdentityTier;
  /** Present only when the caller supplied enrichment for this `assetId`. */
  readonly enrichment?: FlowEnrichment;
  /** Feed edges leaving this node: what it powers. */
  readonly feeds: ReadonlyArray<FlowEdgeRef>;
  /** Feed edges arriving at this node: what powers it. Two or more is multi-fed. */
  readonly fedBy: ReadonlyArray<FlowEdgeRef>;
  /** PMD relations at either end of this node -- instruments hanging off a panel. */
  readonly pmdRelations: ReadonlyArray<FlowEdgeRef>;
}

/**
 * One stated connection, kept whole.
 *
 * There is exactly one edge per surviving {@link ConnectivityObservation}: no
 * merging of duplicates, no collapsing of parallel cables. Two rows saying the
 * same thing are two pieces of evidence, and provenance on each is what makes
 * a disagreement reviewable rather than silent (§8.4).
 */
export interface FlowEdge {
  readonly edgeId: string;
  readonly fromNodeId: string;
  readonly toNodeId: string;
  readonly kind: 'feed' | 'pmd-relation';
  readonly relationshipType: RelationshipType;
  /** Cable tag, when the source named the conductor. */
  readonly via?: string;
  readonly sourceKind: ConnectivitySourceKind;
  readonly provenance: Provenance;
}

/**
 * A connection the projection could not represent as drawn.
 *
 * These are not `ReviewItem`s: the domain's review union describes identity and
 * resolver disagreements, and neither variant fits "the graph says a thing
 * feeds itself". Rather than widen a shared type from a projection, flow
 * reports its own anomalies alongside the review items it passes through.
 */
export interface SelfLoopAnomaly {
  readonly kind: 'self-loop';
  /** The node both ends collapsed onto. */
  readonly nodeId: string;
  readonly fromTag: string;
  readonly toTag: string;
  readonly edgeKind: 'feed' | 'pmd-relation';
  readonly sourceKind: ConnectivitySourceKind;
  readonly provenance: Provenance;
}

/**
 * A feed loop: power that comes back round to where it started.
 *
 * The edges are KEPT. A ring feed is a real arrangement and §10 requires
 * alternate feeds to stay visible; the anomaly exists so a reviewer is told the
 * loop is there, not so the graph can be pruned into a tree.
 *
 * `path` is one representative cycle as node ids, without repeating the first
 * node: `[a, b, c]` means `a -> b -> c -> a`. It is the shortest cycle through
 * the component's smallest node id, rotated to its smallest rotation, so the
 * same graph always names the same loop the same way.
 */
export interface CycleAnomaly {
  readonly kind: 'cycle';
  readonly path: ReadonlyArray<string>;
}

export type FlowAnomaly = SelfLoopAnomaly | CycleAnomaly;

/** Counts a flow view can show without walking the graph itself. */
export interface FlowStats {
  readonly nodeCount: number;
  /** Edges kept; self-loops are dropped and so are not counted. */
  readonly edgeCount: number;
  readonly modelConfirmedCount: number;
  readonly flowOnlyCount: number;
  readonly pmdOnlyCount: number;
  /**
   * Nodes with two or more incoming feed edges, counted once each.
   *
   * Two parallel cables from one switchgear make their load multi-fed once, not
   * twice: the count is of nodes, not of surplus edges.
   */
  readonly multiFeedNodeCount: number;
  readonly cycleCount: number;
}

/** The projection. */
export interface ElectricalFlow {
  /** Keyed by `nodeId`, iterating in code-unit ascending id order. */
  readonly nodes: ReadonlyMap<string, FlowNode>;
  readonly edges: ReadonlyArray<FlowEdge>;
  /**
   * Node ids that feed something and are fed by nothing: the sources.
   *
   * A node with no edges at all is not a root -- it is not a source of
   * anything. A node inside a ring is not a root either, which is what makes
   * {@link CycleAnomaly} worth reporting.
   */
  readonly roots: ReadonlyArray<string>;
  /**
   * Review items carried through from identity reconciliation.
   *
   * The projection raises none of its own: what it cannot represent arrives in
   * {@link flowAnomalies} instead.
   */
  readonly reviewItems: ReadonlyArray<ReviewItem>;
  readonly flowAnomalies: ReadonlyArray<FlowAnomaly>;
  readonly stats: FlowStats;
}

/**
 * How the caller answers "which asset is this spelling".
 *
 * A map or a function, because the two callers differ: a compile that already
 * resolved every tag has a map, and an interactive caller resolving lazily has
 * a function. Either way the answer is the identity package's, not this one's.
 */
export type IdentityLookup =
  | ReadonlyMap<string, IdentityOutcome>
  | ((evidenceTag: string) => IdentityOutcome | undefined);

/**
 * Identity input, deliberately not the identity package's index type.
 *
 * The projection needs outcomes, not a matcher, so it asks for outcomes. See
 * `buildElectricalFlowFromIndex` for the convenience path that takes an
 * `IdentityIndex` and does the resolution for you.
 */
export interface FlowIdentity {
  readonly outcomes: IdentityLookup;
  /**
   * What identity reconciliation left for a person, passed through untouched.
   * A missing entry means nothing needed deciding, not that nothing was checked.
   */
  readonly reviewItems?: ReadonlyArray<ReviewItem>;
}

/** One node reached by {@link walkSourceToLoad}. */
export interface FlowVisit {
  readonly node: FlowNode;
  /** Edges followed from the root to get here; the root itself is 0. */
  readonly depth: number;
  /** The feed edge that reached this node. Absent at the root. */
  readonly viaEdgeId?: string;
  /**
   * PMD relations at this node, listed but never descended into.
   *
   * An instrument terminating on a panel is a badge on the panel (§10), not
   * another rung of the source-to-load tree.
   */
  readonly pmdRelations: ReadonlyArray<FlowEdgeRef>;
}
