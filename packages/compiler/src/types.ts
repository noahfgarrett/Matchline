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
 * 2. **The rule set arrives as ONE value.** Everything a site decided is
 *    `SiteProfileV2` (`@matchline/domain`) -- mappings, filters, anatomy,
 *    resolver, derived attributes, hierarchy, role graph, ladder, projection,
 *    the explicit parent and stable-id properties, identity. It used to be a
 *    `SiteProfile` plus eleven loose fields here, described as "configuration
 *    the Site Profile cannot yet carry"; it can carry them now, and a second
 *    place to state them would be a second answer to every question.
 *
 *    What remains input is what belongs to the PROJECT rather than to the site:
 *    the sources, its workbooks, its people's decisions and its ledger.
 */
import type {
  AttributeResolverKind,
  CompletenessReport,
  ConnectivityObservation,
  ManualRelationshipOverride,
  Provenance,
  ResolvedSnapshot,
  ReviewItem,
  SiteProfileV2,
  SnapshotStats,
  SourceAssignments,
} from '@matchline/domain';
import type { AssetCatalog, UniversePropertyCatalogEntry } from '@matchline/asset-catalog';
import type { AssetLedger, LedgerEvent } from '@matchline/asset-identity';
import type {
  ConnectivityOverrides,
  ConnectivityWorkbookReport,
} from '@matchline/connectivity-import';
import type { ElectricalFlow, FlowStats } from '@matchline/electrical-flow';
import type { IdentityConfig, IdentityIndex } from '@matchline/identity';
import type { LearnedRuleSet, ProposedNesting } from '@matchline/learned-rules';
import type { CanonicalMelRow, GeneratedMelAsset } from '@matchline/mel-export';
import type { ExtractionCache } from '@matchline/model-schema';
import type { AssembledClaims } from '@matchline/relationship-claims';
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

/**
 * One derived attribute, resolved for one asset (P0-7).
 *
 * Present only when a rung answered: there is no entry meaning "resolved to
 * nothing", because missing has to stay missing all the way to the boundary
 * fold. `rungIndex` and `kind` say which rung answered, so a value that reaches
 * a register can be traced to the line of the profile that produced it without
 * re-running the chain.
 */
export interface DerivedAttributeValue {
  readonly attributeId: string;
  readonly value: string;
  /** Position in the definition's `resolverChain`, counted from 0. */
  readonly rungIndex: number;
  readonly kind: AttributeResolverKind;
  readonly provenance: Provenance;
}

/** Every derived attribute one asset resolved, in definition order. */
export interface DerivedAssetAttributes {
  readonly assetId: string;
  readonly values: ReadonlyArray<DerivedAttributeValue>;
}

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

/**
 * The pipeline's stages, in the one order they are announced in.
 *
 * Fourteen names for `compile.ts`'s eleven numbered sections: the three
 * lettered ones (2b the identity ledger, 2c the stored decisions, 8b the
 * derived attributes) are announced in their own right because each is a pass
 * over every asset and a progress line that hid them would sit still through
 * three of the longest stretches of a large compile.
 *
 * Published so a caller can say "3 of 14" without hard-coding a count the
 * pipeline would then be free to change underneath it. Nothing derives
 * behaviour from these names.
 */
export const COMPILE_STAGES = [
  'asset-catalog',
  'identity-ledger',
  'properties',
  'stored-decisions',
  'mel',
  'systems',
  'identity-index',
  'connectivity',
  'flow',
  'claims',
  'derived-attributes',
  'snapshot',
  'projections',
  'review',
] as const;
export type CompileStage = (typeof COMPILE_STAGES)[number];

/**
 * Told which stage is starting, as it starts.
 *
 * The one impure thing a compile may do, and it is deliberately incapable of
 * changing what the compile decides: nothing reads its return value, no stage
 * consults it, and a compile run with and without one produces a deep-equal
 * `CompiledProject`. It exists because the pipeline is a single synchronous
 * call that can take minutes on a real site, and a progress indicator that
 * cannot say more than "still working" is a progress indicator that teaches a
 * person to force-quit.
 *
 * Called at most once per stage, in {@link COMPILE_STAGES} order, before the
 * stage does any work. A stage that a project does not need — no MEL, no
 * derived attributes — is still announced: skipping the announcement would make
 * the sequence depend on the project, and a caller counting stages would then
 * be counting something different every run.
 */
export type CompileStageListener = (stage: CompileStage) => void;

/**
 * One registered model source, as a compile reads it (RELEASE-1.0-PLAN P0-1).
 *
 * A project is a universe of these, not one file. `sourceId` is the identity
 * and the only field the engine keys anything on: `rawFileName` is what the
 * file called itself and two consultants really do both ship `Level 1.nwc`, so
 * keying on it would silently drop one of them.
 *
 * `displayName` and `rawFileName` are carried rather than used: the project
 * store records them (`ModelSourceRef`), and taking them here means a caller
 * can hand a stored source straight to a compile instead of projecting it down
 * to the two fields the engine happens to read this milestone.
 */
export interface ModelSourceInput {
  /** Project-assigned and unique within the universe. Never a file name. */
  readonly sourceId: string;
  /** Already opened by the caller, and still the caller's to close. */
  readonly cache: ExtractionCache;
  /** What the project asserts about this whole source (P0-8). */
  readonly assignments?: SourceAssignments;
  /** What a person calls this source in the UI. */
  readonly displayName?: string;
  /** The basename of the file that was extracted. Never unique. */
  readonly rawFileName?: string;
}

/** Everything one compile needs. */
export interface CompileProjectInput {
  /**
   * The model universe. Read in `sourceId` order whatever order they arrive
   * in, so a compile is a function of the project rather than of this array.
   *
   * @throws AssetCatalogConfigError when a `sourceId` is blank or repeated.
   */
  readonly sources: ReadonlyArray<ModelSourceInput>;
  /**
   * The whole site rule set, as one versioned value.
   *
   * Every section a compile reads about *this site* is in here: the mappings and
   * their chains, the filters, the anatomy, the resolver, the derived attribute
   * registry, the level stack, the role graph, the ladder, the discipline
   * projection, the explicit parent and stable-id properties, and identity. A
   * profile stored before the consolidation is lifted by
   * `migrateSiteProfileV1` (`@matchline/domain`), which is the only way a V1
   * reaches this field.
   */
  readonly profile: SiteProfileV2;
  /**
   * Whether to build {@link CompiledProject.propertyCatalog}. Off by default.
   *
   * The catalog is the one stage output nothing downstream consumes, and it
   * costs a full streaming pass over every cache in the universe -- on a
   * multi-cache project that is the single most expensive thing a compile does
   * for a value most compiles throw away. A Site Profile Studio asks for it;
   * screen 8 does not, and neither does an export or a revision diff.
   *
   * Absent means an empty `propertyCatalog`, never a missing field: a consumer
   * that did not ask reads "no entries", which is what it would have to handle
   * for an empty universe anyway.
   */
  readonly includePropertyCatalog?: boolean;
  readonly connectivityWorkbooks?: ReadonlyArray<ConnectivityWorkbookInput>;
  readonly melWorkbook?: MelWorkbookInput;
  /** Trained rules from a finished SSM. Absent means the learned rung is inert. */
  readonly learnedRules?: LearnedRuleSet;
  /** People's system assignments, which outrank every resolver rung. */
  readonly manualSystemAssignments?: ManualAssignments;
  /** People's parent decisions, which outrank every ladder rung. */
  readonly manualRelationshipOverrides?: ReadonlyArray<ManualRelationshipOverride>;
  /**
   * The asset identity ledger the last compile of this project wrote (P0-9).
   *
   * What makes an asset id survive a tag correction. Absent means "this project
   * has never been compiled": every asset is new, every id is minted, and the
   * compile publishes the ledger the next one should hand back.
   *
   * It also decides how stored decisions are read. `manualRelationshipOverrides`
   * and `manualSystemAssignments` name assets by whatever id the compile that
   * showed them published -- or, in an older project, by tag -- and the ledger is
   * what re-addresses those onto this compile's assets. See
   * `identity-ledger.ts`'s `decisionResolverOf` for the resolution rules.
   */
  readonly identityLedger?: AssetLedger;
  /**
   * Told which stage is starting. Absent means nothing is reported.
   *
   * See {@link CompileStageListener}: it observes, it cannot decide, and a
   * compile is deep-equal with and without it.
   */
  readonly onStage?: CompileStageListener;
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

/** How many assets one model source contributed to the universe. */
export interface SourceAssetCount {
  readonly sourceId: string;
  readonly assetCount: number;
}

/** Counts a reviewer checks before trusting a compile, one group per stage. */
export interface CompileStats {
  /** Model sources this compile read. */
  readonly sourceCount: number;
  /** Assets in the model-first universe. */
  readonly assetCount: number;
  /**
   * {@link assetCount} broken down per source, in `sourceId` order.
   *
   * "34 assets" is not actionable in a universe: the question a coordinator
   * asks first is which file the missing 10 were supposed to come from. Read
   * off the catalog's own per-source impact, so it can never disagree with it.
   *
   * An array rather than the `ReadonlyMap` the catalog's own `bySource` uses,
   * because these stats are stored: the desktop writes `CompileStats` straight
   * into a JSON column, and `JSON.stringify` turns a Map into `{}`. Everything
   * else on this interface is a number for the same reason.
   */
  readonly assetCountBySource: ReadonlyArray<SourceAssetCount>;
  /** Distinct tags carried by more than one asset, anywhere in the universe. */
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
 * Deterministic in full. The same sources, workbooks and profile produce a
 * deep-equal value and byte-identical `generatedMel.workbookBytes` -- including
 * when the sources arrive in a different order, because the universe is read in
 * `sourceId` order.
 */
export interface CompiledProject {
  /**
   * Stage 1: the model-first asset universe plus the inclusion impact.
   *
   * Every `assetId` here is the LEDGER's, not the one the catalog derived from
   * the model: stage 2b replaces them before anything reads one, so a corrected
   * tag keeps the id it already had (P0-9).
   */
  readonly catalog: AssetCatalog;
  /**
   * Stage 2b: the asset identity ledger this compile wrote (P0-9).
   *
   * Always published, even for a project with no previous ledger -- that compile
   * is the one that mints the ids, and the caller has to persist the result or
   * the next compile starts over. Plain JSON: the store round-trips it.
   */
  readonly identityLedger: AssetLedger;
  /**
   * Stage 2b: what reconciliation did -- new assets, tag corrections, splits,
   * assets that disappeared.
   *
   * Empty on the ordinary re-compile where nothing moved. A first compile
   * reports one `new-asset` per asset, which is the truthful account of a
   * project that has just learned what it contains.
   */
  readonly identityLedgerEvents: ReadonlyArray<LedgerEvent>;
  /**
   * Stage 1: every `(category, name)` pair the universe carries, with overall
   * and per-source coverage (P0-1, "Property Catalog aggregates across
   * sources").
   *
   * Ordered by overall coverage descending, then category and name. This is the
   * one stage output nothing downstream consumes -- it is published because a
   * Site Profile Studio built on one file's catalog cannot answer "which source
   * is the one missing the tag".
   *
   * Empty unless {@link CompileProjectInput.includePropertyCatalog} asked for
   * it: it costs one streaming pass per cache, and a compile that is not
   * feeding a property picker has no use for it.
   */
  readonly propertyCatalog: ReadonlyArray<UniversePropertyCatalogEntry>;
  /** Stage 2: one property-bag subject per asset, in catalog order. */
  readonly subjects: ReadonlyArray<ResolverSubject>;
  /** Stage 3: the MEL as the resolver reads it. Empty without a MEL workbook. */
  readonly melRows: ReadonlyArray<MelCatalogRow>;
  /** Stage 3: systemKey -> what the MEL says about it. */
  readonly systemCatalog: SystemCatalog;
  /** Stage 4: per-asset system resolution, with every losing claim retained. */
  readonly systems: ResolveSystemsResult;
  /**
   * Stage 8b: every derived attribute this project defines, resolved per asset
   * in catalog order (P0-7).
   *
   * One entry per asset in catalog order, with an empty `values` for an asset no
   * chain answered for -- which is a different statement from the asset being
   * absent. Published rather than folded away into `compileSubjects.attributes`
   * alone: the Composer shows which rung answered, and an export has to be able
   * to say where a site-defined column came from.
   *
   * Empty in full when the project defines no derived attributes: "this project
   * derives none" and "every asset resolved to nothing" are different answers,
   * and only the second needs a row per asset.
   */
  readonly derivedAttributes: ReadonlyArray<DerivedAssetAttributes>;
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
  /**
   * Stage 10b: how much of the site this compile actually described (B3).
   *
   * Counts of assets, not of work done. `stats` answers "what did the engine
   * do"; this answers "is my equipment nested, does it have a system, and which
   * missing field is the reason" -- the questions a compile that succeeds and
   * describes nothing still leaves open.
   */
  readonly completeness: CompletenessReport;
  readonly stats: CompileStats;
}
