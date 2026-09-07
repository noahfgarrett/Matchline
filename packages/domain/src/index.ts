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

export {
  escapeSourceId,
  modelObjectKeyToString,
  parseModelObjectKey,
  SOURCE_ASSIGNMENT_FIELDS,
  SOURCE_ASSIGNMENT_SCOPES,
  unescapeSourceId,
} from './model-universe.js';
export type {
  ModelObjectKey,
  ModelSourceRef,
  SourceAssignmentField,
  SourceAssignmentRule,
  SourceAssignmentScope,
  SourceAssignments,
} from './model-universe.js';

export {
  chainFor,
  MAPPED_PROPERTY_FIELDS,
  migrateMappedProperty,
  migratePropertyMappings,
} from './profile.js';
export type {
  AssetFilterConfig,
  MappedProperty,
  MappedPropertyChainInput,
  MappedPropertyField,
  MappedPropertyInput,
  PropertyChain,
  PropertyMappings,
  PropertyMappingsInput,
  PropertyRef,
  SiteProfile,
  SourcePropertyChain,
} from './profile.js';

export {
  emptyIdentityConfig,
  isSiteProfileV2,
  migrateAttributeResolver,
  migrateDerivedAttributes,
  migrateSiteProfileV1,
  migrateSourceAssignmentRules,
  migrateSourceAssignments,
} from './profile-v2.js';
export type {
  AttributeResolverInput,
  AuthorityRule,
  DerivedAttributeDefinitionInput,
  DisciplineRewrite,
  ManualAttributeAssignment,
  ParentPair,
  ProfileIdentityConfig,
  ProfileMapEntry,
  ProfileTestExample,
  SiteProfileV2,
  SiteProfileV2Sections,
  SsmAuditConfig,
  SourceAssignmentRuleInput,
  SourceAssignmentsInput,
  TagAlias,
} from './profile-v2.js';

export {
  ATTRIBUTE_RESOLVER_KINDS,
  DERIVED_ATTRIBUTE_ID_PATTERN,
  isDerivedAttributeId,
} from './derived-attributes.js';
export type {
  AttributeResolver,
  AttributeResolverKind,
  DerivedAttributeDefinition,
} from './derived-attributes.js';

export type {
  NormalizationStep,
  SystemComponentConfig,
  SystemResolverConfig,
} from './resolver-config.js';

export type {
  ApprovedValueCount,
  ApprovedValueReport,
  CompletenessReport,
  LevelCompleteness,
  LevelDemotionCount,
  UnresolvedSystemCount,
} from './completeness.js';

export { unicodeFold } from './unicode-fold.js';

export { reviewItemSummary } from './review.js';
export type {
  AbsorbedTaggedComponentReviewItem,
  AmbiguousParentReviewItem,
  AmbiguousSuffixReviewItem,
  BoundaryDemotionReviewItem,
  DeadClaimRuleReviewItem,
  DuplicateModelTagReviewItem,
  DuplicateModelTagSource,
  FuzzyIdentityCandidate,
  FuzzyIdentityReviewItem,
  ManualBoundaryDemotionReviewItem,
  MissingBoundaryLevelReviewItem,
  MissingBoundaryReviewItem,
  NestingProposalReviewItem,
  OrphanedDecisionKind,
  OrphanedDecisionReason,
  OrphanedDecisionReviewItem,
  PossibleRematchReason,
  PossibleRematchReviewItem,
  ReviewItem,
  SsmAuditReviewItem,
  SsmAuditSeverity,
  StructuralCycleReviewItem,
  SystemCatalogConflictReviewItem,
  SystemConflictReviewItem,
  UnresolvableAliasReviewItem,
  UnresolvedSystemReviewItem,
} from './review.js';

export {
  boundaryAttributeOf,
  displayAttributeOf,
  LADDER_SOURCE_ORDER,
  LADDER_SOURCE_ORDER_BEFORE_MEL_PARENT,
  migrateHierarchyConfig,
  migrateHierarchyLevel,
} from './hierarchy-config.js';
export type {
  HierarchyConfig,
  HierarchyConfigInput,
  HierarchyLevelConfig,
  HierarchyLevelConfigInput,
  LadderSourceKind,
  LegacyHierarchyLevelConfig,
  ManualRelationshipOverride,
  ParentLadderConfig,
  RoleGraphConfig,
  RoleRule,
} from './hierarchy-config.js';

export type { SsmRelationshipClaim } from './ssm-claims.js';

export type {
  ParentDecision,
  ParentDemotion,
  ResolvedAssetNode,
  ResolvedDependency,
  ResolvedLevelPathEntry,
  ResolvedSnapshot,
  SnapshotStats,
} from './snapshot.js';
