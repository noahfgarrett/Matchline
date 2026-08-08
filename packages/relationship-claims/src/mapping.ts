/**
 * What each ladder rung stamps on the claims it produces.
 *
 * Every mapping is a total, named constant rather than a switch buried in the
 * assembler, because these four tables *are* the package's editorial content: a
 * reviewer arguing about how much a family rule is worth should be able to read
 * one file and see the answer.
 *
 * The tiers describe the evidence a rung stands on, not how confident the rung
 * is. Precedence between rungs is the ladder's job (PRODUCT.md §11.1); the tier
 * only breaks ties *within* a rung, so a strong document reached by a weak rule
 * still loses to a stronger rule.
 */
import {
  EVIDENCE_TIER,
  LADDER_SOURCE_ORDER,
  type EvidenceTier,
  type LadderSourceKind,
  type RelationshipType,
  type SourceKind,
} from '@matchline/domain';

/**
 * How strong the evidence under each rung is (PRODUCT.md §4.1).
 *
 * - `manual` takes the top tier because a human is the final authority on every
 *   fact. It is not model evidence; it outranks it.
 * - `explicit-model` is the model stating a relationship itself.
 * - `flow-family` rests on a cable schedule or power study -- an engineered,
 *   stamped document -- even though the nesting is inferred from it.
 * - `profile-lookup` and `prior-ssm` rest on maintained lists that follow the
 *   work: explicit statements, but not stamped engineering.
 * - `family-role`, `learned-description` and `model-tree` are derived by rule
 *   from other evidence, which is exactly what the inferred tier means.
 */
export const LADDER_SOURCE_EVIDENCE_TIER = {
  manual: EVIDENCE_TIER.MODEL,
  'explicit-model': EVIDENCE_TIER.MODEL,
  'profile-lookup': EVIDENCE_TIER.TRACKING_DOCUMENT,
  'flow-family': EVIDENCE_TIER.ENGINEERED_DOCUMENT,
  'family-role': EVIDENCE_TIER.INFERRED,
  'learned-description': EVIDENCE_TIER.INFERRED,
  'prior-ssm': EVIDENCE_TIER.TRACKING_DOCUMENT,
  'model-tree': EVIDENCE_TIER.INFERRED,
} as const satisfies Record<LadderSourceKind, EvidenceTier>;

/**
 * Which source vocabulary each rung reports.
 *
 * `SourceKind` has no member for the learned model or for a prior SSM export.
 * Both arrive as exported spreadsheets, so both report `MEL`, and the claim's
 * `rule` names what actually produced it. `profile-lookup` reports `MANUAL`
 * because a person wrote the lookup table by hand.
 */
export const LADDER_SOURCE_KIND = {
  manual: 'MANUAL',
  'explicit-model': 'MODEL',
  'profile-lookup': 'MANUAL',
  'flow-family': 'FLOW',
  'family-role': 'MODEL',
  'learned-description': 'MEL',
  'prior-ssm': 'MEL',
  'model-tree': 'MODEL',
} as const satisfies Record<LadderSourceKind, SourceKind>;

/**
 * The relationship type a rung's structural claims carry.
 *
 * Every one of these is a `structural-parent` kind under
 * `relationshipKindOf`, which is the invariant that keeps a dependency rung
 * from ever proposing a nesting.
 */
export const LADDER_SOURCE_RELATIONSHIP_TYPE = {
  manual: 'EXPLICIT_PARENT',
  'explicit-model': 'EXPLICIT_PARENT',
  'profile-lookup': 'EXPLICIT_PARENT',
  'flow-family': 'FAMILY_RELATED',
  'family-role': 'FAMILY_RELATED',
  'learned-description': 'STRUCTURAL_PARENT_CANDIDATE',
  'prior-ssm': 'STRUCTURAL_PARENT_CANDIDATE',
  'model-tree': 'STRUCTURAL_PARENT_CANDIDATE',
} as const satisfies Record<LadderSourceKind, RelationshipType>;

/** The rule id stamped on each rung's claims, for provenance and for review. */
export const LADDER_SOURCE_RULE = {
  manual: 'relate.manualOverride',
  'explicit-model': 'relate.explicitModelParent',
  'profile-lookup': 'relate.profileLookup',
  'flow-family': 'relate.flowAnchoredFamily',
  'family-role': 'relate.familyRole',
  'learned-description': 'relate.learnedDescription',
  'prior-ssm': 'relate.priorSsmExample',
  'model-tree': 'relate.modelTree',
} as const satisfies Record<LadderSourceKind, string>;

/**
 * `model-tree` appears in every table above for completeness, but this package
 * never produces it: the model tree lives in the extraction cache, and
 * `@matchline/ssm-compiler` derives ancestry claims from there.
 */
export const UNASSEMBLED_LADDER_SOURCES = ['model-tree'] as const satisfies ReadonlyArray<LadderSourceKind>;

/** The rule id on dependency claims, which no ladder rung competes for. */
export const DEPENDENCY_RULE = 'relate.flowDependency';

/**
 * Position of a rung in the default ladder, 1-based.
 *
 * Recorded as each claim's `provenance.fallbackRung`: "which rung of the
 * resolution ladder produced the value" (`Provenance`).
 */
export function ladderRung(source: LadderSourceKind): number {
  return LADDER_SOURCE_ORDER.indexOf(source) + 1;
}
