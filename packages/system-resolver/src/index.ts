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
