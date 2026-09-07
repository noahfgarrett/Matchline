/**
 * `@matchline/compiler` -- the pipeline orchestrator (ENGINE.md E3).
 *
 * One entry point, {@link compileProject}: a model universe (many
 * {@link ModelSourceInput}s, not one cache), the workbooks a project has, and a
 * Site Profile go in; the asset catalog, the universe property catalog, the
 * property-bag subjects, the System Catalog, system resolution, the identity
 * index, the connectivity observations, the Electrical Flow projection, the
 * assembled claims, the resolved snapshot, the level tree, the generated MEL and
 * one deduped review queue come out.
 *
 * This is the only package that knows the pipeline order. Every other engine
 * package is decoupled from the ones that feed it, and the adapters between
 * them -- most of all the property-bag seam {@link subjectPropertiesFor} -- live
 * here so that no package has to grow a dependency on its neighbour's shape.
 *
 * Pure and deterministic like the rest of the engine: the caches are read, never
 * written, and never closed here.
 */
export { compileProject } from './compile.js';

export { COMPILE_STAGES, DEFAULT_MEL_SHEET } from './types.js';
export type {
  CompiledProject,
  CompileProjectInput,
  CompileStage,
  CompileStageListener,
  CompileStats,
  ConnectivityWorkbookInput,
  DerivedAssetAttributes,
  DerivedAttributeValue,
  GeneratedMel,
  MelWorkbookInput,
  ModelSourceInput,
  SourceAssetCount,
  SsmDisciplineProjection,
} from './types.js';

export { derivedRuleIdOf, validateDerivedAttributes } from './derived.js';

export { buildCompleteness } from './completeness.js';
export type { CompletenessInput, CompletenessResult } from './completeness.js';

export { validateProfile } from './validate.js';

export {
  DerivedAttributeConfigError,
  describeDerivedAttributeConfigReason,
  describeProfileConfigReason,
  ProfileConfigError,
} from './errors.js';
export type { DerivedAttributeConfigReason, ProfileConfigReason } from './errors.js';

export { subjectPropertiesFor } from './properties.js';
export type { SubjectProperties } from './properties.js';

export { ATTRIBUTE_KEYS, ssmDisciplineOf } from './attributes.js';
export type { AttributeKey } from './attributes.js';

export { aggregateReviewItems } from './review.js';

export { ssmAuditReviewItems } from './ssm-audit.js';

/**
 * Which asset the model tree publishes each asset inside.
 *
 * Exported for the same reason `resolveStoredReference` below is: the desktop
 * app has to answer this outside a compile. Quick Setup proposes
 * `parentRole → childRole` rules from the pairings a site's own model already
 * draws, and a second walk of the object tree in the app would be a second
 * answer to "what does the model say this sits inside" — which is the rung this
 * function IS.
 */
export { modelTreeParents } from './model-tree.js';
export type { ModelTreeSource } from './model-tree.js';

/**
 * How a stored reference is re-addressed onto this compile's assets.
 *
 * Exported because the desktop app has to answer the same question outside a
 * compile: a project file's override rows are keyed by whatever spelling the
 * build that wrote them used -- a bare tag, a `tag:` id, a ledger id -- and
 * collapsing two rows that name ONE asset needs exactly this resolution.
 * Answering it a second way in the app is how two rows survive and a phantom
 * `ambiguous-parent` appears.
 */
export { decisionResolverOf, possibleRematches } from './identity-ledger.js';
export type {
  DecisionResolution,
  ResolutionStatus,
  ResolveDecisionRef,
} from './identity-ledger.js';
