/**
 * `@matchline/learned-rules` -- ENGINE.md E3, PRODUCT.md §11.1 tiers 6-7,
 * DECISIONS.md #3.
 *
 * Trains description and nesting rules from a finished SSM / registry export,
 * grades itself against that export's own answers, and emits a plain
 * serializable rule set the Site Profile carries.
 *
 * The invariant the whole package exists to hold: a learned rule may only build
 * hierarchy after it has PROVEN itself -- >=85% precision over >=10 predictions,
 * measured by replaying the identical policy that ships. Everything else is a
 * proposal for the review queue and never a hierarchy write. Inert without
 * training: an empty rule set proposes nothing.
 *
 * Pure, deterministic, no dependencies outside the workspace.
 */
export { trainLearnedRules } from './train.js';
export type { TrainOptions } from './train.js';

export { classifyDescription } from './classify.js';

export { proposeNestings } from './propose.js';

export { validateLearnedRuleSet } from './validate.js';

export {
  CHILD_ONLY_MAX_PARENT_RATE,
  CHILD_ONLY_MIN_SIGHTINGS,
  CLASSIFICATION_MIN_CONFIDENCE,
  CONTAINMENT_MIN_EXTENSION,
  CONTAINMENT_MIN_PARENT_BODY,
  GRADE_MIN_PRECISION,
  GRADE_MIN_PREDICTIONS,
  MIN_AFFINITY_OBSERVATIONS,
  PARENT_CAPABLE_MIN_PARENT_RATE,
  PARENT_CAPABLE_MIN_PARENTINGS,
} from './thresholds.js';

export { descriptionPattern, roleClassOf, sharedRun } from './text.js';

export type {
  AffinityEntry,
  ClassGradeEntry,
  ClassificationEntry,
  ClassificationResult,
  LearnedRuleSet,
  NestingAsset,
  NestingGrade,
  NestingRule,
  ProposedNesting,
  RoleGateEntry,
  TrainingRow,
} from './types.js';
