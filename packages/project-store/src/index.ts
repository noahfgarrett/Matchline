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
  DECISION_VALUES,
  DEFAULT_APP_VERSION,
  isDecisionValue,
  isLearnedRuleKind,
  isOverrideKind,
  isSourceRole,
  LEARNED_RULE_KINDS,
  OVERRIDE_KINDS,
  PROJECT_SCHEMA_SQL,
  PROJECT_SCHEMA_VERSION,
  REQUIRED_META_KEYS,
  REQUIRED_TABLES,
  SOURCE_ROLES,
} from './schema.js';
export type {
  DecisionValue,
  LearnedRuleKind,
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
  CreateProjectOptions,
  DecisionInput,
  LatestSnapshot,
  LearnedRuleRecord,
  OpenProjectOptions,
  ProfileRevision,
  ProfileRevisionSummary,
  ProjectMeta,
  ProjectSource,
  ProjectStore,
  ReviewDecision,
  SourceInput,
} from './store.js';
