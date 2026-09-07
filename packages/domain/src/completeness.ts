/**
 * How much of a compile actually landed somewhere (audit blocker B3).
 *
 * A compile that succeeds and nests nothing is the failure mode the audit
 * found: with the shipped default profile every asset became a root under
 * `(unassigned)`, the compile reported success, and no number anywhere said
 * "0 of 34 assets are nested". Stats answered how much work the engine did;
 * nothing answered how much of the site is actually described.
 *
 * That is what this is. Every field is a count of assets, not of items, and
 * every one of them is derived from what the fold and the resolver already
 * decided -- no stage re-walks the model to produce it, and nothing here can
 * disagree with the snapshot it was read off.
 *
 * Types only. `@matchline/compiler` computes it, because the compiler is the
 * one package holding the hierarchy, the resolutions and the snapshot at once.
 */
import type { LadderSourceKind } from './hierarchy-config.js';

/** One configured level, and how much of the site states a value for it. */
export interface LevelCompleteness {
  readonly levelId: string;
  readonly displayName: string;
  /** Whether a difference here breaks a parent (DECISIONS.md #1). */
  readonly boundary: boolean;
  /** Which attribute the count is about: the boundary's, or the level's key. */
  readonly attributeKey: string;
  /** Assets stating no value for {@link attributeKey}. */
  readonly assetsWithoutValue: number;
  /**
   * Whether those assets are thereby unnestable.
   *
   * True exactly when the level is an enabled boundary: an unstated value at a
   * grouping-only level files the asset under `(unassigned)` and costs it
   * nothing, while the same gap at a boundary stops every structural decision
   * the asset could have taken (§11.3, "unknown never equals unknown").
   */
  readonly blocksNesting: boolean;
}

/** One rung's parents that one boundary level turned into dependencies. */
export interface LevelDemotionCount {
  readonly levelId: string;
  readonly ladderSource: LadderSourceKind;
  readonly count: number;
}

/** One way the System Resolver came up empty, and how many assets it left. */
export interface UnresolvedSystemCount {
  /** The rungs' own skip reasons, joined and sorted: the shape of the failure. */
  readonly skipReasons: ReadonlyArray<string>;
  readonly assetCount: number;
}

/**
 * One approved-vocabulary count, with the tags that failed it.
 *
 * The examples are equipment tags rather than asset ids because this is the
 * one part of the report a person acts on by opening a model and looking at a
 * piece of equipment. `auditRuleId` names the SSM Audit rule that says the same
 * thing in the reviewer's own words: the numbers here are the build's
 * accounting, the audit is the review, and neither restates the other.
 */
export interface ApprovedValueCount {
  readonly assetCount: number;
  /**
   * Up to ten failing tags, code-unit sorted.
   *
   * Sorted rather than first-seen so that the same site read as three model
   * files and as one federated file gives the same answer.
   */
  readonly exampleTags: ReadonlyArray<string>;
  /** The SSM Audit rule covering the same fact, or `''` when none does. */
  readonly auditRuleId: string;
}

/**
 * How much of the register the approved VF Exto vocabulary would accept.
 *
 * Exto validates its gating columns against fixed dropdowns, and an upload
 * carrying a value outside one is refused wholesale. That refusal used to
 * arrive after somebody exported and uploaded; these five counts are the same
 * refusal, computed while the compile is still on screen 8.
 *
 * Every count is of assets, like every other count in this report, and every
 * one is read off the values the compile settled -- no cell is re-derived here.
 */
export interface ApprovedValueReport {
  /** System Key that is not an approved UPN. Exto refuses the upload. */
  readonly upnNotApproved: ApprovedValueCount;
  /** A System Name that is not one of the approved names for its UPN. */
  readonly systemNameNotApproved: ApprovedValueCount;
  /** SSM discipline outside the approved Discipline list. Exto refuses it. */
  readonly disciplineNotApproved: ApprovedValueCount;
  /** Equipment Classification outside the approved list. Informational. */
  readonly classificationNotInList: ApprovedValueCount;
  /** An Item Master that is not one of VF's. Informational. */
  readonly itemMasterNotVf: ApprovedValueCount;
}

/**
 * What a compile actually managed to say about the site.
 *
 * Read top to bottom it answers the three questions a coordinator asks of a
 * fresh compile: is my equipment nested, does it have a system, and if not,
 * which missing field is the reason.
 */
export interface CompletenessReport {
  /** Assets in the universe. Every count below is out of this. */
  readonly assetCount: number;
  /** Assets whose structural parent survived the fold. */
  readonly assetsNested: number;
  /** Assets that are a root or a provisional root of their grouping. */
  readonly assetsRooted: number;
  /**
   * Assets no rung named a parent for at all.
   *
   * Different from rooted: an asset with no claim was never a candidate for
   * nesting, and an asset that was rooted because a boundary refused its parent
   * is a rule to fix. Both are roots in the tree and only one of them is a gap
   * in the evidence.
   */
  readonly assetsWithNoParentCandidate: number;
  /** Assets the System Resolver produced no `SystemResolution` for. */
  readonly assetsWithoutSystem: number;
  /** One entry per configured level, in configured order. */
  readonly levels: ReadonlyArray<LevelCompleteness>;
  /** Boundary demotions by (level, rung), busiest first. */
  readonly demotionsPerLevel: ReadonlyArray<LevelDemotionCount>;
  /** Unresolved systems grouped by the skip reasons that explain them. */
  readonly unresolvedSystemBySkipReason: ReadonlyArray<UnresolvedSystemCount>;
  /**
   * MEL rows that stated no tag, no key and no description.
   *
   * They join to nothing and describe nothing, so they are dropped -- and
   * "your MEL has 900 rows and 400 of them say nothing" is a fact about a
   * workbook that a person can act on, which is why the number is published
   * rather than only the rows that survived.
   */
  readonly melRowsDropped: number;
  /**
   * How much of the register the approved VF Exto vocabulary would accept.
   *
   * Two of these five are publish blockers (`upnNotApproved`,
   * `disciplineNotApproved`); the others are a warning and two notes. The
   * severity lives with the publish gate rather than here, because this is a
   * count of what is true and that is a decision about what to do next.
   */
  readonly approvedValues: ApprovedValueReport;
}
