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

export { DEFAULT_MEL_SHEET } from './types.js';
export type {
  CompiledProject,
  CompileProjectInput,
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

export {
  DerivedAttributeConfigError,
  describeDerivedAttributeConfigReason,
} from './errors.js';
export type { DerivedAttributeConfigReason } from './errors.js';

export { subjectPropertiesFor } from './properties.js';
export type { SubjectProperties } from './properties.js';

export { ATTRIBUTE_KEYS, ssmDisciplineOf } from './attributes.js';
export type { AttributeKey } from './attributes.js';

export { aggregateReviewItems } from './review.js';
