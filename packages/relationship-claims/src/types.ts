/**
 * The inputs claims assembly reads and the result it produces.
 *
 * Every input shape here is deliberately decoupled from the packages that will
 * produce it: assembly takes flat, already-resolved facts (asset ids, roles,
 * family keys, flow edges) rather than reaching into the asset catalog, the
 * identity index or the learned rule set. That is what keeps this package
 * testable from a fixture and keeps the pipeline order owned by
 * `@matchline/compiler`.
 */
import type {
  EquipmentClass,
  ManualRelationshipOverride,
  Provenance,
  RelationshipType,
  RoleGraphConfig,
  ReviewItem,
  SopRulesConfig,
  SsmRelationshipClaim,
} from '@matchline/domain';

/**
 * One asset, as much of it as relationship rules need.
 *
 * `role` and `familyKey` are tag-anatomy output (PRODUCT.md §11.2); either may
 * be absent, and an absent one simply disqualifies the asset from the rules
 * that need it. Nothing here is inferred: a subject with no `familyKey` never
 * gets one guessed for it.
 */
export interface ClaimSubject {
  readonly assetId: string;
  readonly canonicalTag: string;
  /** Tag-anatomy `role` segment, e.g. `MAH`. */
  readonly role?: string;
  /** Tag-anatomy composite family key, e.g. `001-10-01`. */
  readonly familyKey?: string;
  /**
   * What the SSM SOP calls this asset (`@matchline/ssm-audit`'s
   * `equipmentClass`), when the caller classified it.
   *
   * Classified upstream rather than here: the classifiers are the vendored
   * rulebook's, and a second implementation of them in this package is exactly
   * the two-apps-disagreeing failure the vendoring exists to prevent. Absent
   * disqualifies the asset from every SOP rule, which is the honest reading of
   * "nobody said what this is".
   */
  readonly equipmentClass?: EquipmentClass;
  /**
   * The UPN the tag carries -- `101` in `MAH101-01` (PRODUCT.md §2.3).
   *
   * From the anatomy's `system` segment where the site taught one, and from the
   * approved Exto list read out of the tag where it did not. Either way it is
   * the caller's to state; this package does not parse tags.
   */
  readonly upn?: string;
  /** The instance the tag carries -- `01` in `MAH101-01`. */
  readonly instance?: string;
  /** The building, for the rules that are about one building rather than one UPN. */
  readonly building?: string;
  /** The parent tag a mapped model relationship property stated, verbatim. */
  readonly explicitParentTag?: string;
  /** Where that property was read. Supply it; assembly synthesizes a weaker
   *  address only when a caller does not. */
  readonly explicitParentProvenance?: Provenance;
}

/**
 * One connectivity edge, already identity-resolved and model-confirmed at both
 * ends (`@matchline/electrical-flow` §10 territory).
 *
 * Direction is physical: `from` feeds, controls or serves `to`.
 */
export interface FlowEdgeInput {
  readonly fromAssetId: string;
  readonly toAssetId: string;
  readonly relationshipType: RelationshipType;
  readonly provenance: Provenance;
}

/**
 * One prediction from the learned description model (`@matchline/learned-rules`).
 *
 * `grade` is the donor invariant made explicit: only a self-graded, claim-grade
 * rule may produce a claim. Proposal grade produces a review item and nothing
 * else, ever.
 */
export interface LearnedClaimInput {
  readonly childAssetId: string;
  readonly parentAssetId: string;
  /** The rule in reviewable words, carried into provenance and review. */
  readonly ruleDetail: string;
  /** Measured precision, 0..1. Recorded, never thresholded here. */
  readonly confidence: number;
  readonly grade: 'claim' | 'proposal';
}

/** One parent/child pair from a previously accepted SSM (PRODUCT.md §11.1 tier 7). */
export interface PriorSsmExample {
  readonly childTag: string;
  readonly parentTag: string;
}

/** One explicit accepted Site Profile lookup row (PRODUCT.md §11.1 tier 3). */
export interface ProfileLookupEntry {
  readonly childTag: string;
  readonly parentTag: string;
}

/**
 * A tag that names more than one asset.
 *
 * Identity resolves a duplicated tag to the first asset id in code-unit order,
 * which is the right answer for enrichment: a description attached to one of
 * two copies is a cosmetic mistake. It is the wrong answer for STRUCTURE. A
 * profile row or a model property naming `PNL001-10-01` where two assets carry
 * that tag has not said which one is the parent, and picking the alphabetically
 * lower one would nest a site's equipment under whichever copy sorted first --
 * silently, and differently after a re-extraction renumbered them.
 *
 * So the bridge says "duplicate" and assembly refuses (ENGINE.md: a tie stops
 * the ladder). The refusal is loud: it lands in `skipped` as
 * {@link SkipReason} `duplicate-target`.
 */
export interface DuplicateTagTarget {
  readonly duplicate: true;
  /** How many assets carry the tag. Always more than one. */
  readonly sharingAssets: number;
}

/**
 * The identity bridge: a source spelling to a canonical asset id, `null` when
 * nothing resolved it, or {@link DuplicateTagTarget} when several assets carry
 * it.
 *
 * `null` is a real answer and it is respected: an unresolvable tag produces no
 * claim and no invented asset (ENGINE.md binding rule 1). A bridge that only
 * ever returns `string | null` is still a valid `ResolveTag` -- the duplicate
 * arm is something a caller opts into by being able to detect one.
 */
export type ResolveTag = (tag: string) => string | null | DuplicateTagTarget;

/** Which profile document the profile-borne rules came out of. */
export interface ProfileSourceRef {
  readonly sourceFile: string;
  readonly profileRevision?: string;
}

/**
 * One MEL row's "System Parent" statement (PRODUCT.md §11.1, donor priority
 * 900).
 *
 * The MEL is where a site writes down what hangs off what, and the donor's
 * primary structural source was this column. It arrives as tags because a MEL
 * is a document engineers read: the bridge is what turns them into assets.
 *
 * `parentTags` is a list because a row may name several. The FIRST is the
 * structural claim -- an asset has one parent -- and the rest become
 * dependencies, which is the same rule connectivity follows: a real relation
 * that orders work without nesting (§8.2). Listing them in the other order
 * would be a different statement, so the workbook's order is respected.
 */
export interface MelParentInput {
  /** The child, as the MEL's equipment tag column spells it. */
  readonly childTag: string;
  /** The System Parent tags, in the order the row states them. */
  readonly parentTags: ReadonlyArray<string>;
  /** The workbook, sheet and row the statement was read from. */
  readonly provenance: Provenance;
}

/** Everything assembly may read besides the subjects themselves. */
export interface AssembleOptions {
  readonly roleGraph?: RoleGraphConfig;
  readonly flowEdges?: ReadonlyArray<FlowEdgeInput>;
  readonly learned?: ReadonlyArray<LearnedClaimInput>;
  readonly priorSsm?: ReadonlyArray<PriorSsmExample>;
  readonly profileLookup?: ReadonlyArray<ProfileLookupEntry>;
  readonly manualOverrides?: ReadonlyArray<ManualRelationshipOverride>;
  /** The MEL's own System Parent column (§11.1, the `mel-parent` rung). */
  readonly melParents?: ReadonlyArray<MelParentInput>;
  /**
   * The SSM SOP's own rules, and which of them the site switched off.
   *
   * Presence is the switch. The rules run when the caller passes this and not
   * otherwise, so a site whose ladder does not carry the `sop-rule` rung gets
   * no SOP claims at all -- including the dependency claims, which no ladder
   * would have filtered. Passing `{ disabledRuleIds: [] }` is "every SOP rule
   * on"; omitting it is "the SOP does not build this site's hierarchy".
   */
  readonly sopRules?: SopRulesConfig;
  readonly resolveTag: ResolveTag;
  /** Addresses profile-borne claims. Defaults to `DEFAULT_PROFILE_SOURCE`. */
  readonly profileSource?: ProfileSourceRef;
  /** Addresses explicit-model claims whose subject carried no provenance. */
  readonly modelSourceFile?: string;
}

/**
 * A manual instruction to root an asset (`parentAssetId: null` in the override).
 *
 * Kept out of `structural` on purpose: it is not a claim about a pair, it is
 * the absence of a pair, and a consumer that walked structural claims looking
 * for a sentinel target would be one missed check away from parenting an asset
 * to nothing.
 */
export interface MakeRootDirective {
  readonly childAssetId: string;
  readonly provenance: Provenance;
  readonly note?: string;
}

/** Why an input produced no claim at all. */
export type SkipReason =
  /** The child asset id is not among the subjects. */
  | 'unknown-child-asset'
  /** The parent asset id is not among the subjects. */
  | 'unknown-parent-asset'
  /** `resolveTag` returned `null` for the child spelling. */
  | 'unresolvable-child-tag'
  /** `resolveTag` returned `null` for the parent spelling. */
  | 'unresolvable-parent-tag'
  /**
   * The spelling names several assets, so it names no one asset.
   *
   * Never a pick. See {@link DuplicateTagTarget}: the duplicate itself is
   * already a review item from the asset catalog, and this says which rule went
   * dead because of it.
   */
  | 'duplicate-target'
  /** The input parents an asset to itself. */
  | 'self-parent';

/**
 * One input assembly refused to turn into a claim, and why.
 *
 * Skipping is loud by design: a mistyped tag in a profile lookup would
 * otherwise vanish silently, and the site would never learn its rule is dead.
 * An input that produced *something* -- a flow edge that yielded a dependency
 * but no structural claim -- is not skipped.
 */
export interface SkippedClaimInput {
  readonly ladderSource: SsmRelationshipClaim['ladderSource'];
  readonly reason: SkipReason;
  /** The child as the input spelled it: an asset id or a tag. */
  readonly childRef: string;
  /** The parent as the input spelled it, or `null` for a make-root input. */
  readonly parentRef: string | null;
}

/**
 * Everything assembly has to say. Nothing here is resolved: `structural` is a
 * pile of competing proposals, and picking between them is the parent ladder's
 * job in `@matchline/ssm-compiler`.
 */
export interface AssembledClaims {
  /** Parent proposals: child in `subjectAssetId`, proposed parent in `targetAssetId`. */
  readonly structural: ReadonlyArray<SsmRelationshipClaim>;
  /** Additive relations; they order work and never nest (PRODUCT.md §8.2). */
  readonly dependencies: ReadonlyArray<SsmRelationshipClaim>;
  /** `nesting-proposal` items from proposal-grade learned input. */
  readonly proposals: ReadonlyArray<ReviewItem>;
  /** Manual instructions to root an asset. */
  readonly makeRoot: ReadonlyArray<MakeRootDirective>;
  /** Inputs that produced nothing, each with a reason. */
  readonly skipped: ReadonlyArray<SkippedClaimInput>;
}
