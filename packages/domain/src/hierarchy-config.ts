/**
 * The configurable half of the SSM projection (PRODUCT.md §11, §2.4).
 *
 * Types only: the ladder walk, the boundary fold and the level tree live in
 * `@matchline/ssm-compiler`, and claims assembly lives in
 * `@matchline/relationship-claims`. The shapes live here so a Site Profile can
 * carry them without depending on any engine package.
 *
 * Everything here is site-configurable on purpose. What is *not* configurable
 * is the semantics: a boundary is hard (DECISIONS.md #1), a tier with more than
 * one candidate stops the ladder, and no profile fallback value may drive a
 * structural decision (ENGINE.md binding rule 4).
 */

import type { EquipmentClass } from './equipment-class.js';

/**
 * Which rung of the §11.1 parent candidate ladder produced a claim.
 *
 * One member per evidence-bearing tier. The ladder's final rung -- "root of
 * current grouping" -- is deliberately absent: it produces no claim, it is what
 * happens when every rung above it produced nothing.
 */
export type LadderSourceKind =
  | 'manual'
  | 'explicit-model'
  /** The MEL's own "System Parent" column, which names a parent outright. */
  | 'mel-parent'
  /** The SSM SOP's own nesting rules, read forwards as build rules. */
  | 'sop-rule'
  | 'profile-lookup'
  | 'flow-family'
  | 'family-role'
  | 'learned-description'
  | 'prior-ssm'
  | 'model-tree';

/**
 * The recommended default ladder, strongest rung first (PRODUCT.md §11.1).
 *
 * The order is load-bearing twice over: the compiler walks it to pick a parent,
 * and its index is the `fallbackRung` recorded on every claim's provenance. A
 * site may reorder or disable rungs via {@link ParentLadderConfig}; this array
 * is the default it starts from.
 */
export const LADDER_SOURCE_ORDER = [
  'manual',
  'explicit-model',
  // Immediately under the model's own statement, and above every table and
  // every rule: a MEL "System Parent" cell is an engineer writing the parent
  // down in the document the site maintains for exactly that purpose.
  'mel-parent',
  // Under the two documents that state a parent outright and above every
  // lookup, every family rule and everything learned: the SOP is a written
  // standard, so it outranks a table a site typed and a rule Matchline
  // measured -- but it is still a rule, so a person and the model itself win.
  'sop-rule',
  'profile-lookup',
  'flow-family',
  'family-role',
  'learned-description',
  'prior-ssm',
  'model-tree',
] as const satisfies ReadonlyArray<LadderSourceKind>;

/**
 * The ladder as it was before the MEL rung existed.
 *
 * A profile stored without a ladder of its own is migrated onto THIS list, not
 * onto {@link LADDER_SOURCE_ORDER}: a site that has been compiling for months
 * must not start seeding its hierarchy from a spreadsheet column because the
 * engine learned to read one. A site that wants the rung adds it, which is the
 * same way every other rung is turned on and off.
 */
export const LADDER_SOURCE_ORDER_BEFORE_MEL_PARENT = [
  'manual',
  'explicit-model',
  'profile-lookup',
  'flow-family',
  'family-role',
  'learned-description',
  'prior-ssm',
  'model-tree',
] as const satisfies ReadonlyArray<LadderSourceKind>;

/**
 * Compile-time completeness guard. Adding a member to `LadderSourceKind`
 * without adding it to `LADDER_SOURCE_ORDER` resolves this to `false` and the
 * assignment below stops compiling.
 */
type EveryLadderSourceListed =
  Exclude<LadderSourceKind, (typeof LADDER_SOURCE_ORDER)[number]> extends never ? true : false;

const LADDER_SOURCES_ARE_COMPLETE: EveryLadderSourceListed = true;
void LADDER_SOURCES_ARE_COMPLETE;

/**
 * One site's parent ladder.
 *
 * `tiers` is the walk order, and omitting a rung disables it: a site that does
 * not trust description-driven inference simply leaves `learned-description`
 * out, and claims from that rung never win a slot.
 */
export interface ParentLadderConfig {
  readonly tiers: ReadonlyArray<LadderSourceKind>;
}

/**
 * The exemption from one level's boundary, by child equipment class.
 *
 * The SSM SOP's one approved exception to "a structural child stays inside its
 * parent's discipline", written down as configuration rather than baked into
 * the fold.
 */
export interface BoundaryExceptionConfig {
  /**
   * The child equipment classes exempt from this level's boundary.
   *
   * A class, never a tag and never an asset id: the exception is a statement
   * about what a kind of device does, and a list of assets would be a manual
   * decision wearing a rule's clothes.
   */
  readonly childClasses: ReadonlyArray<EquipmentClass>;
}

/**
 * One configured level of the hierarchy (PRODUCT.md §2.4, §11, P0-6).
 *
 * Each attribute key addresses a raw or derived field on the asset -- building,
 * ssmDiscipline, systemKey, systemLabel, anything the profile resolved -- so
 * levels are composed rather than hardcoded.
 *
 * Three keys rather than one, because a level answers three different questions
 * and a site that has to answer them with one string is forced to make its
 * wording load-bearing:
 *
 * - {@link keyAttributeKey} is the level's **identity**. It is what assets are
 *   grouped by and what a revision diff compares. Nothing else decides where
 *   equipment sits.
 * - {@link displayAttributeKey} is only **words**. Re-typing a description
 *   moves nothing (P0-6: "Description/label edits never move equipment").
 * - {@link boundaryAttributeKey} is what a boundary **compares**, for the rare
 *   site whose structural rule is not the grouping key itself.
 *
 * Both optional keys default to the key, so the simple case stays one field
 * with two names for it.
 */
export interface HierarchyLevelConfig {
  /** Stable id, referenced by review items and demotion records. */
  readonly levelId: string;
  /** What the level is called in the UI and in exports. */
  readonly displayName: string;
  /** Which resolved asset field is this level's grouping identity. */
  readonly keyAttributeKey: string;
  /** Which field supplies the words shown for a group. Defaults to the key. */
  readonly displayAttributeKey?: string;
  /** Which field the boundary compares. Defaults to the key. */
  readonly boundaryAttributeKey?: string;
  /**
   * Whether a difference at this level breaks a structural parent.
   *
   * `true` makes the level a hard boundary: the fold removes the parent and
   * demotes it to a dependency (§11.3). No feed-chain exception exists, and
   * since P0-4 no rung is exempt from it either -- a manual parent wins the
   * ladder and then folds like any other winner.
   */
  readonly boundary: boolean;
  /**
   * Child classes this level's boundary does not apply to.
   *
   * The SSM SOP's one approved exception, made configurable rather than
   * hardcoded: "a structural child stays inside its parent's discipline.
   * Controls devices nesting under the equipment they serve are the approved
   * exception" (`parent.cross-discipline`). A VFD in Electrical under an air
   * handler in Mechanical is the SOP working, not a boundary being crossed, so
   * a site that has adopted the exception lists the classes it holds for and
   * the fold stops demoting them at that level.
   *
   * Narrow on purpose. The exception is keyed on the CHILD's class and on one
   * named level, so it can never become "boundaries are soft": a building
   * boundary with no exception list still demotes every drive that crosses it,
   * and a class not on the list is folded exactly as before.
   *
   * Absent means no exception, which is what every level had before and what
   * {@link DEFAULT_HIERARCHY_LEVELS} keeps (RELEASE-1.0-PLAN P0-5 makes SSM
   * Discipline non-structural instead).
   */
  readonly boundaryExceptions?: BoundaryExceptionConfig;
  /**
   * What to do when an asset has no value at this level.
   *
   * `unassigned-group` collects them under one visible bucket, `review` refuses
   * to place them and raises a review item, `provisional-root` roots them and
   * marks the decision as provisional.
   */
  readonly missingValuePolicy: 'unassigned-group' | 'review' | 'provisional-root';
  /** Sibling order within the level: by display label, or by raw key. */
  readonly sort: 'label' | 'key';
}

/** The level stack, outermost first. */
export interface HierarchyConfig {
  readonly levels: ReadonlyArray<HierarchyLevelConfig>;
}

/**
 * A level as everything before P0-6 spelled it: one `attributeKey` doing all
 * three jobs.
 *
 * Kept as an input shape only. Stored project configs, exported profile
 * packages and site fixtures written before the split are read through
 * {@link migrateHierarchyConfig}; nothing inside the engine sees this type.
 */
export interface LegacyHierarchyLevelConfig
  extends Omit<HierarchyLevelConfig, 'keyAttributeKey'> {
  /** The single key that was the identity, the display and the comparison. */
  readonly attributeKey: string;
}

/** A level in either spelling. */
export type HierarchyLevelConfigInput = HierarchyLevelConfig | LegacyHierarchyLevelConfig;

/** A level stack in either spelling, or a mixture of the two. */
export interface HierarchyConfigInput {
  readonly levels: ReadonlyArray<HierarchyLevelConfigInput>;
}

/** Whether a level was written in the pre-P0-6 single-key form. */
function isLegacyLevel(level: HierarchyLevelConfigInput): level is LegacyHierarchyLevelConfig {
  return !('keyAttributeKey' in level);
}

/**
 * One level in the current shape, whichever way it was written.
 *
 * The old single key becomes the identity key and nothing else: a config that
 * predates P0-6 grouped, displayed and compared on one field, and that is
 * exactly what the defaults reproduce.
 */
export function migrateHierarchyLevel(level: HierarchyLevelConfigInput): HierarchyLevelConfig {
  if (!isLegacyLevel(level)) {
    return level;
  }
  const { attributeKey, ...rest } = level;
  return { ...rest, keyAttributeKey: attributeKey };
}

/** {@link migrateHierarchyLevel} over a whole stack. */
export function migrateHierarchyConfig(config: HierarchyConfigInput): HierarchyConfig {
  return { levels: config.levels.map(migrateHierarchyLevel) };
}

/**
 * Which field this level's boundary compares.
 *
 * The key unless the site named a different one: a boundary that compared the
 * words would break a parent every time somebody re-typed a description, which
 * is the failure P0-6 exists to prevent.
 */
export function boundaryAttributeOf(level: HierarchyLevelConfig): string {
  return level.boundaryAttributeKey ?? level.keyAttributeKey;
}

/**
 * Which field supplies this level's words, or `null` when it has none of its
 * own.
 *
 * `null` rather than the key, so a caller can tell "no display attribute is
 * configured" from "the display attribute happens to be the key" -- the first
 * needs no lookup at all.
 */
export function displayAttributeOf(level: HierarchyLevelConfig): string | null {
  return level.displayAttributeKey ?? null;
}

/**
 * One taught nesting: assets whose role is `parentRole` may parent assets whose
 * role is `childRole`.
 *
 * Roles are tag-anatomy `role` segments (PRODUCT.md §11.2), so the MAH → PLC →
 * VFD → TIT ladder is three rules, not one path. Rules are directional; the
 * reverse pairing is a separate rule a site must state on purpose.
 */
export interface RoleRule {
  readonly parentRole: string;
  readonly childRole: string;
}

/** Every taught role pairing for a site. */
export interface RoleGraphConfig {
  readonly rules: ReadonlyArray<RoleRule>;
}

/**
 * A human's parent decision, which outranks every rule (PRODUCT.md §4.1, §11.5).
 *
 * `parentAssetId: null` is not "unknown" -- it is the explicit instruction to
 * make this asset a root of its grouping, which is why the field is nullable
 * rather than optional.
 */
export interface ManualRelationshipOverride {
  readonly childAssetId: string;
  /** The chosen parent, or `null` to root the asset. */
  readonly parentAssetId: string | null;
  /** Why, in the person's own words. Carried into provenance. */
  readonly note?: string;
}
