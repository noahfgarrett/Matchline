/**
 * What the SSM compiler reads, and the projection shape it hands the UI.
 *
 * The compiler takes flat, already-resolved facts -- asset ids, explicit level
 * attributes, assembled claims -- rather than reaching into the asset catalog or
 * the identity index. That is what keeps it testable from a fixture and keeps
 * pipeline order owned by `@matchline/compiler`.
 */
import type {
  HierarchyConfig,
  ParentDecision,
  ParentLadderConfig,
  ResolvedDependency,
  SsmRelationshipClaim,
} from '@matchline/domain';
import type { MakeRootDirective } from '@matchline/relationship-claims';

/**
 * One asset, as much of it as the ladder and the fold need.
 *
 * `attributes` carries EXPLICIT level values only -- building, ssmDiscipline,
 * systemKey, whatever the profile resolved from a real source. An absent key
 * means "no source stated it", and the fold treats that as unknown rather than
 * substituting anything (ENGINE.md binding rule 4: no profile fallback value may
 * drive a structural decision). The caller must not pre-fill defaults here.
 *
 * An empty-string value is treated the same as an absent one. A boundary
 * comparison on two blank strings would otherwise report "equal" and nest two
 * assets on the strength of what nobody said.
 */
export interface CompileSubject {
  readonly assetId: string;
  readonly attributes: ReadonlyMap<string, string>;
  /**
   * The model tree's ancestry suggestion for this asset (PRODUCT.md §11.1 tier
   * 8). Synthesized into a `model-tree` claim during the walk; the model tree
   * lives in the extraction cache, so no other package assembles that rung.
   */
  readonly modelTreeParentId?: string;
}

/**
 * The claims half of the input: `AssembledClaims` narrowed to what resolution
 * reads.
 *
 * A full `AssembledClaims` is assignable. `proposals` and `skipped` are
 * deliberately absent: proposal-grade rules never write hierarchy, and a skipped
 * input produced no claim to resolve. Both stay the orchestrator's to surface.
 */
export interface CompileClaims {
  /** Parent proposals: child in `subjectAssetId`, proposed parent in `targetAssetId`. */
  readonly structural: ReadonlyArray<SsmRelationshipClaim>;
  /** Additive relations. They order work and never nest (PRODUCT.md §8.2). */
  readonly dependencies: ReadonlyArray<SsmRelationshipClaim>;
  /** Manual instructions to root an asset. Highest authority there is. */
  readonly makeRoot: ReadonlyArray<MakeRootDirective>;
}

/** Everything one compile needs. */
export interface CompileInput {
  readonly subjects: ReadonlyArray<CompileSubject>;
  readonly claims: CompileClaims;
  /** Walk order. Defaults to `LADDER_SOURCE_ORDER`; omitting a rung disables it. */
  readonly ladder?: ParentLadderConfig;
  readonly hierarchy: HierarchyConfig;
}

/** One asset in the projected tree, with its structural children nested. */
export interface HierarchyAssetNode {
  readonly assetId: string;
  readonly status: ParentDecision['status'];
  /** The structural parent, or `null` for a top-of-grouping asset. */
  readonly parentAssetId: string | null;
  /** Assets whose structural parent is this one, by asset id. */
  readonly children: ReadonlyArray<HierarchyAssetNode>;
  /** Listed by reference, never nested: dependencies sequence, they do not place. */
  readonly dependencies: ReadonlyArray<ResolvedDependency>;
}

/** One configured level's value, and everything filed under it. */
export interface HierarchyLevelNode {
  readonly levelId: string;
  /**
   * The level value, or a sentinel: `(unassigned)` where the site asked for a
   * grouping, `(no value)` where a `review` / `provisional-root` policy refused
   * to state one. Never the empty string.
   */
  readonly value: string;
  /** The next configured level down. Empty at the innermost level. */
  readonly levels: ReadonlyArray<HierarchyLevelNode>;
  /** Top-of-grouping assets, present only at the innermost level. */
  readonly assets: ReadonlyArray<HierarchyAssetNode>;
}

/**
 * The projected level tree (ENGINE.md E3 step 3).
 *
 * `assets` at the root is populated only by a hierarchy with no levels at all;
 * otherwise every asset hangs off a level node.
 */
export interface HierarchyTree {
  readonly levels: ReadonlyArray<HierarchyLevelNode>;
  readonly assets: ReadonlyArray<HierarchyAssetNode>;
}
