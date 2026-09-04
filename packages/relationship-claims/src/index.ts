/**
 * `@matchline/relationship-claims` -- claims assembly (ENGINE.md E3,
 * PRODUCT.md §11.1).
 *
 * Every source that has anything to say about how equipment nests says it here,
 * as a `SsmRelationshipClaim` carrying provenance, an evidence tier and the
 * ladder rung it arrived on. Competing claims all survive; connectivity always
 * yields at least a dependency; proposal-grade learned rules never become
 * claims at all.
 *
 * What this package deliberately does not do: resolve. No claim wins here, no
 * boundary is applied and no hierarchy is written -- that is
 * `@matchline/ssm-compiler`'s job, and it consumes this output. Pure,
 * deterministic, zero dependencies outside the workspace.
 */
export {
  assembleRelationshipClaims,
  DEFAULT_MODEL_SOURCE_FILE,
  DEFAULT_PROFILE_SOURCE,
} from './assemble.js';

export {
  DEPENDENCY_RULE,
  LADDER_SOURCE_EVIDENCE_TIER,
  LADDER_SOURCE_KIND,
  LADDER_SOURCE_RELATIONSHIP_TYPE,
  LADDER_SOURCE_RULE,
  ladderRung,
  UNASSEMBLED_LADDER_SOURCES,
} from './mapping.js';

export type {
  AssembleOptions,
  AssembledClaims,
  ClaimSubject,
  DuplicateTagTarget,
  FlowEdgeInput,
  LearnedClaimInput,
  MakeRootDirective,
  MelParentInput,
  PriorSsmExample,
  ProfileLookupEntry,
  ProfileSourceRef,
  ResolveTag,
  SkipReason,
  SkippedClaimInput,
} from './types.js';
