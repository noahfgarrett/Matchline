/**
 * `@matchline/project-store` -- the `.matchline` project file.
 *
 * One SQLite database per project holding sources, the versioned Site Profile,
 * learned rules, manual overrides, compile history, the latest resolved
 * snapshot and review decisions (APP.md "Project file", PRODUCT.md §15).
 *
 * Every write is transactional and every timestamp comes from an injected
 * clock, so the same sequence of calls produces the same file twice.
 */
export { backupBeforeMigration } from './backup.js';

export { describeProjectStoreReason, ProjectStoreError } from './errors.js';
export type { ProjectStoreReason } from './errors.js';

export { canonicalJson } from './json.js';

export { validateRelationshipOverride, validateSystemOverride } from './overrides.js';
export type { ManualSystemOverride, StoredOverride } from './overrides.js';

export { validateSiteProfile } from './profile-json.js';

export {
  CONFIG_KEYS,
  CONFIG_TABLE_SQL,
  DECISION_VALUES,
  DEFAULT_APP_VERSION,
  isConfigKey,
  isDecisionValue,
  isLearnedRuleKind,
  isOverrideKind,
  isSourceRole,
  LEARNED_RULE_KINDS,
  LEARNED_TABLE_SQL,
  MIGRATION_STEPS,
  OVERRIDE_KINDS,
  PROJECT_SCHEMA_SQL,
  PROJECT_SCHEMA_VERSION,
  REQUIRED_META_KEYS,
  REQUIRED_TABLES,
  SOURCE_ROLES,
  WIDEN_CHECKS_SQL,
} from './schema.js';
export type {
  ConfigKey,
  DecisionValue,
  LearnedRuleKind,
  MigrationStep,
  OverrideKind,
  SourceRole,
} from './schema.js';

export { deserializeSnapshot, serializeSnapshot } from './snapshot-json.js';
export type { SerializedSnapshot } from './snapshot-json.js';

export { createProject, openProject } from './store.js';
export type {
  Clock,
  CompileInput,
  CompileRecord,
  ConfigEntry,
  CreateProjectOptions,
  DecisionInput,
  LatestSnapshot,
  LearnedRuleRecord,
  MigrationReport,
  OpenProjectOptions,
  ProfileRevision,
  ProfileRevisionSummary,
  ProjectMeta,
  ProjectSource,
  ProjectStore,
  ReviewDecision,
  SourceInput,
} from './store.js';
