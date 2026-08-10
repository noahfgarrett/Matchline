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
  isSelectionSetKind,
  isWarningSeverity,
  REQUIRED_META_KEYS,
  REQUIRED_TABLES,
  SUPPORTED_SCHEMA_VERSION,
} from './schema.js';
export type {
  BoundingBox,
  CacheWarning,
  ExtractionCacheMeta,
  ModelObject,
  ObjectProperty,
  ObjectPropertyRow,
  SelectionSet,
  SelectionSetKind,
  SelectionSetNode,
  SourceModel,
  SourceModelNode,
  WarningSeverity,
} from './schema.js';
