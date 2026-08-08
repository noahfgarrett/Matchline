export { EVIDENCE_TIER } from './evidence.js';
export type { EvidenceTier, SourceKind } from './evidence.js';

export type { Provenance, SourceRef } from './provenance.js';

export { assertNever, RELATIONSHIP_TYPES, relationshipKindOf } from './relationship.js';
export type { RelationshipKind, RelationshipType } from './relationship.js';

export type {
  AttributeClaim,
  AttributeValue,
  RelationshipClaim,
  SourceObservation,
} from './claims.js';

export type { SystemConflictStatus, SystemResolution } from './system.js';

export type { ConnectivityObservation, ConnectivitySourceKind } from './connectivity.js';

export { IDENTITY_TIER_ORDER } from './identity.js';
export type {
  IdentityCandidate,
  IdentityMatch,
  IdentityMiss,
  IdentityOutcome,
  IdentityTier,
} from './identity.js';

export type {
  CanonicalAsset,
  HierarchyAttributes,
  ModelObjectReference,
  ResolvedParent,
  ReviewStatus,
  SourceStatus,
} from './asset.js';

export type { SegmentExtractor, SegmentName, TagAnatomyConfig } from './anatomy.js';

export type {
  AssetFilterConfig,
  PropertyMappings,
  PropertyRef,
  SiteProfile,
} from './profile.js';

export type {
  NormalizationStep,
  SystemComponentConfig,
  SystemResolverConfig,
} from './resolver-config.js';

export { reviewItemSummary } from './review.js';
export type {
  AmbiguousSuffixReviewItem,
  DuplicateModelTagReviewItem,
  FuzzyIdentityCandidate,
  FuzzyIdentityReviewItem,
  ReviewItem,
  SystemCatalogConflictReviewItem,
  SystemConflictReviewItem,
} from './review.js';
