export { openExtractionCache } from './cache.js';
export type { ExtractionCache } from './cache.js';

export {
  buildPropertyCatalog,
  buildSourceModelCoverage,
  collectPropertyStatistics,
  comparePropertyCoverage,
  MAX_EXAMPLE_VALUES,
} from './catalog.js';
export type {
  CachePropertyStatistics,
  PropertyCatalogEntry,
  PropertyStatistics,
  SourceModelCoverage,
} from './catalog.js';

export { CacheValidationError, describeCacheValidationReason } from './errors.js';
export type { CacheValidationReason } from './errors.js';

export {
  AUTHORING_ID_KINDS,
  CURRENT_SCHEMA_VERSION,
  hasV3Columns,
  isAuthoringIdKind,
  isSelectionSetKind,
  isSupportedSchemaVersion,
  isWarningSeverity,
  readV1MembershipResolved,
  REQUIRED_META_KEYS,
  REQUIRED_TABLES,
  SUPPORTED_SCHEMA_VERSIONS,
} from './schema.js';
export type {
  AuthoringIdKind,
  BoundingBox,
  CacheWarning,
  ExtractionCacheMeta,
  ModelObject,
  ObjectFlags,
  ObjectProperty,
  ObjectPropertyRow,
  SelectionSet,
  SelectionSetKind,
  SelectionSetNode,
  SourceModel,
  SourceModelNode,
  SupportedSchemaVersion,
  WarningSeverity,
} from './schema.js';
