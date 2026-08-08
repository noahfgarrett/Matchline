/**
 * `@matchline/electrical-flow` -- PRODUCT.md §10.
 *
 * The connectivity projection: EasyPower, Cable Schedule and PMD observations
 * plus identity outcomes, as a source-to-load graph. Model assets enrich the
 * nodes they matched; tags nothing matched stay visible as FLOW_ONLY and
 * PMD_ONLY nodes rather than vanishing into a failed join.
 *
 * What this package deliberately does not do: enforce SSM structural
 * boundaries. A feed that crosses a system, building or discipline boundary is
 * shown as a feed, because Electrical Flow is the one view where the physical
 * chain stays intact (DECISIONS.md #1). Pure, deterministic, zero dependencies
 * outside the workspace.
 */
export { buildElectricalFlow, buildElectricalFlowFromIndex, SOURCE_ONLY_NODE_PREFIX } from './build.js';

export { walkSourceToLoad } from './walk.js';

export { sourceStatusOf } from './types.js';
export type {
  CycleAnomaly,
  ElectricalFlow,
  FlowAnomaly,
  FlowEdge,
  FlowEdgeDirection,
  FlowEdgeRef,
  FlowEnrichment,
  FlowIdentity,
  FlowMatchStatus,
  FlowNode,
  FlowStats,
  FlowVisit,
  IdentityLookup,
  SelfLoopAnomaly,
} from './types.js';
