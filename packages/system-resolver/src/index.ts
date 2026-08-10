/**
 * `@matchline/system-resolver` -- PRODUCT.md §5.
 *
 * Builds the System Catalog from an imported MEL, and resolves each asset's
 * system identity from an ordered, site-configured chain of components.
 * Pure, deterministic, zero dependencies outside the workspace.
 */
export { buildSystemCatalog } from './catalog.js';

export { CONFLICT_STATUS_OF, resolveSubject, resolveSystems } from './resolve.js';

export { COMPONENT_EVIDENCE_TIER, lowestTier } from './tiers.js';

/**
 * Published so a second chain evaluator cannot invent a second template
 * vocabulary. `@matchline/compiler`'s derived attributes (P0-7) carry a
 * `composite` rung, and a site that has already learned `{segment:role}` and
 * `{prop:Item.UPN}` for its systems must not have to learn different spellings
 * for its own fields.
 */
export { expandComposite } from './composite.js';
export type { CompositeFilled, CompositeResult, CompositeUnfilled } from './composite.js';

export { normalizeSystemValue } from './normalize.js';
export type { NormalizedValue } from './normalize.js';

export { buildLabel, defaultLabel } from './label.js';

export { UNSTATED_ROW, UNSTATED_SOURCE_FILE, ruleIdOf, sourceKindOf } from './chain.js';

export type {
  ChainName,
  KeyAgreement,
  ManualAssignment,
  ManualAssignments,
  MelCatalogRow,
  ResolveContext,
  ResolveSystemsResult,
  ResolvedConflictStatus,
  ResolverSubject,
  SkipReason,
  SkippedRung,
  SubjectResolution,
  SystemCatalog,
  SystemCatalogEntry,
  SystemCatalogResult,
  SystemClaim,
  SystemComponentKind,
  TransformRecord,
} from './types.js';
