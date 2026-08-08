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
 * One configured level of the hierarchy (PRODUCT.md §2.4, §11).
 *
 * `attributeKey` addresses a raw or derived field on the asset -- building,
 * ssmDiscipline, systemKey, anything the profile resolved -- so levels are
 * composed rather than hardcoded.
 */
export interface HierarchyLevelConfig {
  /** Stable id, referenced by review items and demotion records. */
  readonly levelId: string;
  /** What the level is called in the UI and in exports. */
  readonly displayName: string;
  /** Which resolved asset field supplies this level's value. */
  readonly attributeKey: string;
  /**
   * Whether a difference at this level breaks a structural parent.
   *
   * `true` makes the level a hard boundary: the fold removes the parent and
   * demotes it to a dependency (§11.3). No feed-chain exception exists.
   */
  readonly boundary: boolean;
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
