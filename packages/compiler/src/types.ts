/**
 * What one compile reads, and everything it produces (ENGINE.md E3).
 *
 * The compiler is the only package that knows the pipeline order, so it is also
 * the only place the whole shape of a project exists. Two rules govern this
 * file:
 *
 * 1. **Every stage's output is published.** The UI consumes intermediates --
 *    the inclusion impact, the resolver's losing claims, the flow projection,
 *    the assembled claims -- not just the snapshot at the end. Nothing is
 *    computed and thrown away.
 * 2. **Configuration the Site Profile cannot yet carry arrives as input.**
 *    `SiteProfile` (`@matchline/domain`) has no parent-tag property and no
 *    discipline projection today. Rather than widen a shared domain type from
 *    here, both arrive on {@link CompileProjectInput} in the shape a profile
 *    section would eventually hold.
 */
import type {
  ConnectivityObservation,
  HierarchyConfig,
  ManualRelationshipOverride,
  ParentLadderConfig,
  PropertyRef,
  ResolvedSnapshot,
  ReviewItem,
  RoleGraphConfig,
  SiteProfile,
  SnapshotStats,
} from '@matchline/domain';
import type { AssetCatalog } from '@matchline/asset-catalog';
import type {
  ConnectivityOverrides,
  ConnectivityWorkbookReport,
} from '@matchline/connectivity-import';
import type { ElectricalFlow, FlowStats } from '@matchline/electrical-flow';
import type { IdentityConfig, IdentityIndex } from '@matchline/identity';
import type { LearnedRuleSet, ProposedNesting } from '@matchline/learned-rules';
import type { CanonicalMelRow, GeneratedMelAsset } from '@matchline/mel-export';
import type { ExtractionCache } from '@matchline/model-schema';
import type {
  AssembledClaims,
  PriorSsmExample,
  ProfileLookupEntry,
} from '@matchline/relationship-claims';
import type { MelMapping } from '@matchline/spreadsheet-import';
import type { CompileSubject, HierarchyTree } from '@matchline/ssm-compiler';
import type {
  ManualAssignments,
  MelCatalogRow,
  ResolveSystemsResult,
  ResolverSubject,
  SystemCatalog,
} from '@matchline/system-resolver';

/**
 * `nativeDiscipline` -> `ssmDiscipline`, stated by the site.
 *
 * A projection is a table of explicit rewrites, not a function, so a Site
 * Profile can carry it as JSON and two runs of the same profile can never
 * disagree. A discipline with no entry keeps its native spelling; see
 * {@link ssmDisciplineOf}.
 */
export type SsmDisciplineProjection = ReadonlyMap<string, string>;

/** One connectivity workbook to import (EasyPower / Cable Schedule / PMD). */
export interface ConnectivityWorkbookInput {
  readonly bytes: Uint8Array;
  /** Recorded in every observation's provenance. */
  readonly sourceFile: string;
  /** Per-sheet replacements for what detection concluded. */
  readonly overrides?: ConnectivityOverrides;
}

/**
 * The MEL to build the System Catalog from.
 *
 * `mapping` is `@matchline/spreadsheet-import`'s explicit column mapping: the
 * caller names the header text behind every field, because E1 does no header
 * detection and guessing a column is how a wrong system key reaches an engineer.
 */
export interface MelWorkbookInput {
  readonly bytes: Uint8Array;
  readonly sourceFile: string;
  /** Defaults to {@link DEFAULT_MEL_SHEET}. */
  readonly sheetName?: string;
  readonly mapping: MelMapping;
  /** Zero-based AoA row holding the headers. Defaults to 0. */
  readonly headerRow?: number;
}

/** The sheet a MEL is read from when the caller names none. */
export const DEFAULT_MEL_SHEET = 'MEL';

/** Everything one compile needs. */
export interface CompileProjectInput {
  /** Already opened by the caller, and still the caller's to close. */
  readonly cache: ExtractionCache;
  readonly profile: SiteProfile;
  readonly hierarchy: HierarchyConfig;
  /** Parent ladder walk order. Defaults to `@matchline/ssm-compiler`'s. */
  readonly ladder?: ParentLadderConfig;
  /** Taught role pairings. Without one, no family rung produces a claim. */
  readonly roleGraph?: RoleGraphConfig;
  readonly connectivityWorkbooks?: ReadonlyArray<ConnectivityWorkbookInput>;
  readonly melWorkbook?: MelWorkbookInput;
  /** Trained rules from a finished SSM. Absent means the learned rung is inert. */
  readonly learnedRules?: LearnedRuleSet;
  /** People's system assignments, which outrank every resolver rung. */
  readonly manualSystemAssignments?: ManualAssignments;
  /** People's parent decisions, which outrank every ladder rung. */
  readonly manualRelationshipOverrides?: ReadonlyArray<ManualRelationshipOverride>;
  /**
   * Accepted parent/child pairs the site wrote down (PRODUCT.md §11.1 tier 3).
   *
   * Spelled as tags, not asset ids, and resolved through the identity index --
   * a lookup table is a document a site maintains, and an internal asset id
   * means nothing in one. A pair naming a tag identity cannot resolve produces
   * no claim and lands in `claims.skipped`.
   */
  readonly profileLookup?: ReadonlyArray<ProfileLookupEntry>;
  /**
   * Parent/child pairs from a previously accepted SSM (PRODUCT.md §11.1 tier 7).
   *
   * The second-weakest rung: an example of what a site did last time, which is
   * evidence but not a rule, so anything above it on the ladder wins.
   */
  readonly priorSsm?: ReadonlyArray<PriorSsmExample>;
  /** Aliases, tag normalization, fuzzy distance. Anatomy defaults to the profile's. */
  readonly identityConfig?: IdentityConfig;
  /**
   * The model property naming an asset's parent, when the site maps one.
   *
   * Read off the same property bag the resolver reads, so a site that states
   * parentage in the model gets the `explicit-model` ladder rung for free.
   */
  readonly parentTagProperty?: PropertyRef;
  /** Explicit discipline rewrites. Absent means ssmDiscipline is nativeDiscipline. */
  readonly ssmDisciplineProjection?: SsmDisciplineProjection;
}

/** The canonical generated MEL, as rows and as bytes. */
export interface GeneratedMel {
  readonly rows: ReadonlyArray<CanonicalMelRow>;
  /** Byte-stable: the same compiled project always writes identical bytes. */
  readonly workbookBytes: Uint8Array;
  /**
   * The per-asset inputs the rows were built from — the shape mel-export's
   * template/compare/diff layers consume, so callers never reimplement the
   * asset→MEL adapter.
   */
  readonly assets: ReadonlyArray<GeneratedMelAsset>;
}

/** Counts a reviewer checks before trusting a compile, one group per stage. */
export interface CompileStats {
  /** Assets in the model-first universe. */
  readonly assetCount: number;
  /** Distinct tags carried by more than one asset. */
  readonly duplicateTagCount: number;
  /** Systems the MEL described. Zero when no MEL was supplied. */
  readonly systemCatalogSize: number;
  /** MEL rows that stated something usable. */
  readonly melRowCount: number;
  /** Assets the resolver produced a `SystemResolution` for. */
  readonly resolvedSystemCount: number;
  /** Assets whose resolver rungs disagreed. */
  readonly systemConflictCount: number;
  /** Tag-bearing assets in the identity index. */
  readonly identityAssetCount: number;
  readonly observationCount: number;
  readonly flow: FlowStats;
  readonly structuralClaimCount: number;
  readonly dependencyClaimCount: number;
  /** Proposal-grade learned pairings. Never claims (DECISIONS.md #3). */
  readonly learnedProposalCount: number;
  /** Claim inputs that named something this compile does not know. */
  readonly skippedClaimInputCount: number;
  readonly snapshot: SnapshotStats;
  /** Rows in the generated MEL. One per asset. */
  readonly generatedMelRowCount: number;
  /** Aggregated review items, after dedupe. */
  readonly reviewItemCount: number;
}

/**
 * One compiled project: every stage's output, in pipeline order.
 *
 * Deterministic in full. The same cache, workbooks and profile produce a
 * deep-equal value and byte-identical `generatedMel.workbookBytes`.
 */
export interface CompiledProject {
  /** Stage 1: the model-first asset universe plus the inclusion impact. */
  readonly catalog: AssetCatalog;
  /** Stage 2: one property-bag subject per asset, in catalog order. */
  readonly subjects: ReadonlyArray<ResolverSubject>;
  /** Stage 3: the MEL as the resolver reads it. Empty without a MEL workbook. */
  readonly melRows: ReadonlyArray<MelCatalogRow>;
  /** Stage 3: systemKey -> what the MEL says about it. */
  readonly systemCatalog: SystemCatalog;
  /** Stage 4: per-asset system resolution, with every losing claim retained. */
  readonly systems: ResolveSystemsResult;
  /** Stage 5: the reusable identity lookup for foreign tag spellings. */
  readonly identityIndex: IdentityIndex;
  /** Stage 6: one report per supplied connectivity workbook, in input order. */
  readonly connectivityReports: ReadonlyArray<ConnectivityWorkbookReport>;
  /** Stage 6: every observation from every workbook, in workbook order. */
  readonly observations: ReadonlyArray<ConnectivityObservation>;
  /** Stage 7: the source-to-load projection. No SSM boundary is applied here. */
  readonly flow: ElectricalFlow;
  /** Stage 8: what the learned rules proposed, before grading split them. */
  readonly learnedProposals: ReadonlyArray<ProposedNesting>;
  /** Stage 8: every relationship claim, competing and unresolved. */
  readonly claims: AssembledClaims;
  /**
   * Stage 9: the assets as the SSM compiler sees them -- level attributes, plus
   * the model tree's own ancestry suggestion where the cache states one.
   */
  readonly compileSubjects: ReadonlyArray<CompileSubject>;
  /** Stage 9: the immutable resolved hierarchy. */
  readonly snapshot: ResolvedSnapshot;
  /** Stage 10: the snapshot arranged into the configured level tree. */
  readonly tree: HierarchyTree;
  /** Stage 10: the canonical generated MEL. */
  readonly generatedMel: GeneratedMel;
  /**
   * Stage 11: every stage's review items, deduped and in a stable total order.
   *
   * Deduped by `@matchline/ssm-compiler`'s `reviewKey`, so the same ambiguity
   * reported by two stages is one decision for a person, not two.
   */
  readonly reviewItems: ReadonlyArray<ReviewItem>;
  readonly stats: CompileStats;
}
