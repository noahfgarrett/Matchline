/**
 * The learned rule set and the shapes around it.
 *
 * Everything here is JSON-serializable by construction: the rule set is
 * persisted into a Site Profile so later sessions keep classifying and pairing
 * without the training export being re-uploaded (donor: profile-persisted
 * `learnedModels`). No Maps, no Sets, no functions, no `undefined` fields.
 */

/** What a graded rule is allowed to do downstream. */
export type NestingGrade = 'claim' | 'proposal';

/** Which of the two donor rules produced a proposal. */
export type NestingRule = 'containment' | 'role-affinity';

/**
 * One row of a finished SSM / registry export.
 *
 * `parentTag` is the structural parent the finished SSM settled on -- the
 * donor's "Closest Parent" column, and the ground truth the engine grades
 * itself against.
 */
export interface TrainingRow {
  readonly equipmentTag: string;
  readonly description: string;
  readonly parentTag?: string;
  readonly systemKey?: string;
  readonly discipline?: string;
  /**
   * The tag-family key (PRODUCT.md §11.2), when the export carries one.
   *
   * Present so training grades the same policy that later runs: `NestingAsset`
   * can carry a family key, and a dimension the pairing policy uses at
   * application time but never saw during self-grading would make the measured
   * precision a number about a different algorithm.
   */
  readonly familyKey?: string;
}

/**
 * One learned description rule: a digit-masked description pattern, scoped by
 * discipline, and the class it predicts.
 *
 * `confidence` is the dominant class's share of the rows behind the key
 * (donor `lookup`: `topCount / total`), rounded to 2dp for byte-stable
 * serialization exactly as the donor's `serializeDescClass` does.
 */
export interface ClassificationEntry {
  /** Normalized; `''` when the training rows carried no discipline. */
  readonly discipline: string;
  /** Normalized description with every digit run masked to `#`. */
  readonly pattern: string;
  readonly class: string;
  readonly confidence: number;
  /** Rows behind the key, across all classes -- the donor's `total`. */
  readonly sampleCount: number;
}

/**
 * How a class behaved in the training data's own hierarchy.
 *
 * Counts are participations in valid same-system parent links, not row counts:
 * `asParent` is how often a member of the class held the parent slot,
 * `asChild` how often one sat in the child slot (donor `asParent` / `asChild`).
 */
export interface RoleGateEntry {
  readonly class: string;
  readonly asParent: number;
  readonly asChild: number;
  /** `asParent / (asParent + asChild)`, 4dp; `0` when the class never linked. */
  readonly parentRate: number;
  /** Donor `isChildClass`: never proposed as anyone's parent. */
  readonly isChildOnly: boolean;
  /** Donor `isParentCapable`: allowed into the parent candidate pool. */
  readonly isParentCapable: boolean;
}

/** A class pair the training data repeated often enough to be a pairing rule. */
export interface AffinityEntry {
  readonly childClass: string;
  readonly parentClass: string;
  readonly observations: number;
}

/**
 * A class's self-graded precision: the engine replayed its own pairing policy
 * over the training data's real answers and counted.
 */
export interface ClassGradeEntry {
  readonly class: string;
  /** Rows of this class where the policy committed to a role-affinity parent. */
  readonly predicted: number;
  /** Of those, how many matched the finished SSM's parent. */
  readonly correct: number;
  /** `correct / predicted`, 4dp; `0` when nothing was predicted. */
  readonly precision: number;
  readonly grade: NestingGrade;
}

/** The serializable artifact of one training run. */
export interface LearnedRuleSet {
  readonly version: 1;
  readonly classification: ReadonlyArray<ClassificationEntry>;
  readonly roleGates: ReadonlyArray<RoleGateEntry>;
  readonly affinities: ReadonlyArray<AffinityEntry>;
  readonly grades: ReadonlyArray<ClassGradeEntry>;
  readonly trainedFrom: { readonly rowCount: number; readonly label: string };
}

/** What `classifyDescription` returns when the confidence gate is cleared. */
export interface ClassificationResult {
  readonly class: string;
  readonly confidence: number;
}

/**
 * An asset the rules are applied to.
 *
 * `tag` is optional because containment is the only rule that needs the literal
 * spelling; without it the engine simply never proposes a containment parent.
 * `tagNumberRuns` lets a caller that already tokenized the tag hand the digit
 * runs over; when absent they are read off `tag`.
 */
export interface NestingAsset {
  readonly assetId: string;
  readonly description: string;
  readonly tag?: string;
  readonly familyKey?: string;
  readonly systemKey?: string;
  readonly discipline?: string;
  readonly tagNumberRuns?: ReadonlyArray<string>;
}

/**
 * One proposed parent-child pairing.
 *
 * Never a hierarchy write: `grade` says whether the SSM compiler may treat this
 * as a claim-grade candidate (lowest ladder rung -- evidence always outranks it)
 * or must route it to the review queue as a proposal.
 */
export interface ProposedNesting {
  readonly childAssetId: string;
  readonly parentAssetId: string;
  readonly rule: NestingRule;
  readonly ruleDetail: string;
  readonly confidence: number;
  readonly grade: NestingGrade;
}
