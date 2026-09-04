import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import {
  buildAssetCatalog,
  buildUniversePropertyCatalog,
  type AssetCatalog,
  type UniversePropertyCatalogEntry,
} from '@matchline/asset-catalog';
import type { AssetLedger } from '@matchline/asset-identity';
import {
  COMPILE_STAGES,
  subjectPropertiesFor,
  type CompiledProject,
  type CompileStage,
  type ConnectivityWorkbookInput,
  type MelWorkbookInput,
} from '@matchline/compiler';
import type { ManualRelationshipOverride, SiteProfileV2 } from '@matchline/domain';
import { validateLearnedRuleSet, type LearnedRuleSet } from '@matchline/learned-rules';
import type { GeneratedMelAsset } from '@matchline/mel-export';
import {
  openExtractionCache,
  type ExtractionCache,
  type SelectionSetNode,
  type SourceModelNode,
} from '@matchline/model-schema';
import {
  ProjectStoreError,
  createProject,
  deriveSourceId,
  deserializeLedger,
  openProject,
  serializeSnapshot,
  type CompileRecord,
  type ProjectSource,
  type ProjectStore,
  type SourceRole,
} from '@matchline/project-store';
import type { MelCatalogRow, ResolverSubject } from '@matchline/system-resolver';
import { applyAnatomy } from '@matchline/tag-anatomy';

import type {
  WireAddSourceResult,
  WireAnatomyPreview,
  WireAssignmentPreview,
  WireExtractionJob,
  WireAssetPreview,
  WireAttributeChoice,
  WireClassCount,
  WireClassSuggestion,
  WireCompileHistoryEntry,
  WireCompileIssueKind,
  WireCompileIssueRow,
  WireCompileStatus,
  WireConfigPatch,
  WireDecisionValue,
  WireDerivedAttribute,
  WireDerivedPreview,
  WireDraftPatch,
  WireDraftProfile,
  WireExportResult,
  WireFlowNode,
  WireFlowRoot,
  WireLearnedRuleKind,
  WireLearnedSummary,
  WireLedgerEvent,
  WireModelScan,
  WireModelUniverse,
  WireOverrideRow,
  WireProfileSection,
  WireProjectConfig,
  WireProjectOpenResult,
  WirePropertyCatalogRow,
  WireProjectSummary,
  WirePublishBlocker,
  WireQuickSetupSuggestions,
  WireRecentProject,
  WireReparentPreview,
  WireResolverPreview,
  WireReviewPage,
  WireReviewRow,
  WireSheetSummary,
  WireSourceAssignmentRule,
  WireSourceModelSummary,
  WireSourceStatus,
  WireSourceSummary,
  WireSystemResolver,
  WireTemplateAnalysis,
  WireTemplateBinding,
  WireTreeNode,
  WireTreePage,
} from '../../shared/schemas.js';

import { createAppStateStore, type AppStateStore } from './app-store.js';
import {
  createCompileView,
  startCompile,
  type CompileRun,
  type CompileView,
  type Page,
} from './compile-service.js';
import type { CompileWorkerSource } from './compile-worker.js';
import { digestFile, mapBounded, DIGEST_CONCURRENCY } from './digest.js';
import {
  createExtractionService,
  type ExtractionOutcome,
  type ExtractionService,
} from './extraction-service.js';
import { cacheFileName } from './extraction-protocol.js';
import {
  defaultExtractorPath,
  extractionCapability,
  resolveExtractorLauncher,
  type ExtractionCapability,
  type ExtractorLauncher,
} from './extractor-launcher.js';
import { buildAssignmentPreview, type AssignmentDocument } from './assignment-preview.js';
import {
  buildDerivedPreview,
  derivedSubjectsFor,
  indexMelByTag,
} from './derived-preview.js';
import {
  applyPatch,
  DEFAULT_HIERARCHY_LEVELS,
  emptyDraft,
  fromSiteProfile,
  hasAnatomy,
  hasMappings,
  hasResolver,
  liftWireMappings,
  toAssetFilters,
  toPropertyMappings,
  toSiteProfile,
  toTagAnatomy,
} from './draft-profile.js';
import {
  analyzeExtoTemplateFile,
  analyzeMelTemplate,
  defaultExportName,
  exportExto,
  exportGeneratedMel,
  exportPredecessors,
  exportRevisionDiff,
  exportTemplateMel,
  readExtoTemplate,
  readItemMasterTable,
  readLearnedRules,
  readWbsTable,
} from './exports.js';
import {
  summarizeStored,
  trainItemMastersFrom,
  trainNestingFrom,
  trainWbsFrom,
} from './learning.js';
import {
  buildAnatomyPreview,
  buildAssetPreview,
  buildResolverPreview,
  catalogTags,
  resolveSystemMap,
} from './previews.js';
import {
  applyConfigPatch,
  attributeChoices,
  clearLegacyConfigSections,
  defaultProjectConfig,
  readLegacyProjectConfig,
  readProjectConfig,
  writeLegacyProjectConfig,
  writeProjectConfig,
} from './project-config.js';
import {
  describeSections,
  mergeLegacyConfig,
  readPackage,
  writePackage,
} from './profile-package.js';
import { catalogPage, type PropertyPageRequest } from './property-page.js';
import {
  inferAnatomy,
  resolverTemplates,
  suggestClasses,
  suggestFields,
  type ClassTagCount,
} from './suggestions.js';
import {
  identifySource,
  melSheetDescriptor,
  readMelCatalogRows,
  roleLabel,
  shortSourceLabels,
  type SourceRegistration,
} from './sources.js';

/**
 * The main-process project session: one open `.matchline` file, the draft Site
 * Profile being built against it, and every engine object derived from the two.
 *
 * Everything expensive lives here and nothing expensive crosses IPC (APP.md
 * "IPC contract"). The renderer holds screen state and the rows it is currently
 * drawing; the extraction cache, the Property Catalog, the asset catalog and
 * the resolver subjects never leave this process.
 *
 * ## Many model sources, one universe (RELEASE-1.0-PLAN P0-1)
 *
 * A project registers a *set* of model sources, not one file, and every one of
 * them that has a readable cache is open at once. The map is keyed by
 * `sourceId` — the project's own identity for a registered file — because two
 * consultants really do both ship `Level 1.nwc` and keying on the name would
 * silently drop one of them (hard gate 4).
 *
 * ## Derived state and when it is thrown away
 *
 * - An **extraction cache handle** belongs to one source. It is opened when
 *   that source becomes ready and closed when the source is removed, replaced
 *   with different bytes, or the project closes. Reconciliation is per source:
 *   replacing one file never re-opens the caches of the others, which on a
 *   real project is the difference between a keystroke and a coffee.
 * - The **universe Property Catalog** is a streaming pass over every open
 *   cache. It is built on demand and memoized against the universe it was
 *   built from, so screen 2 pays for it once.
 * - The **asset catalog** and the **resolver subjects** depend on the draft AND
 *   on the universe, so they are memoized against both — the exact
 *   mappings-and-filters and the exact set of `(sourceId, cache hash)` pairs —
 *   and dropped the moment either changes. Recomputing is correct but slow;
 *   serving a stale catalog would be fast and wrong.
 */

/** Where files a project refers to are looked up, and where recents live. */
export interface ProjectServiceOptions {
  readonly userDataDir: string;
  readonly appVersion: string;
  /**
   * Where extraction caches are written and looked for. Defaults to
   * `<userDataDir>/cache/models`, which is this installation's own folder and
   * never inside a project.
   */
  readonly extractionCacheDir?: string;
  /**
   * How the extractor is run. Defaults to the real one for this machine — the
   * launcher executable on Windows, and a refusal that explains itself
   * everywhere else. The tests supply a launcher that speaks the same protocol
   * without needing Navisworks (see `extractor-launcher.ts`).
   */
  readonly extractionLauncher?: ExtractorLauncher;
}

export interface PropertyPageResult {
  readonly total: number;
  readonly rows: readonly WirePropertyCatalogRow[];
}

export interface DraftState {
  readonly draft: WireDraftProfile | null;
  readonly savedRevision: number | null;
}

export interface SaveProfileResult {
  readonly revision: number;
  readonly savedAt: string;
}

export interface ExtractionStatusPage {
  readonly total: number;
  /** True while anything is queued or running, so the UI knows to keep asking. */
  readonly active: boolean;
  readonly rows: readonly WireExtractionJob[];
  /**
   * False on a machine that cannot run the extractor at all.
   *
   * Carried with the queue rather than on its own channel because it is the
   * same fact the queue is about, and because screen 1 is already asking this
   * channel every second while anything is running. It lets the screen say "not
   * here, and here is what to do instead" before a file is dropped, rather than
   * only afterwards in a row that reads like a fault.
   */
  readonly extractionAvailable: boolean;
  /** Why not, or `''` when extraction is available. */
  readonly extractionUnavailableReason: string;
}

/**
 * The project, or the question opening it has to ask first.
 *
 * `opened` carries a notice as well as the project because what opening had to
 * do is a fact the user is entitled to: their file was rewritten (and here is
 * the backup), or their screens 6-7 answers just moved out of this machine's
 * state file and into the project.
 *
 * `migration-needed` and `backup-blocked` are results, not throws, because both
 * are answerable: the first by confirming, the second by moving one file.
 */
export type OpenProjectResult = WireProjectOpenResult;

export interface ProjectService {
  create(projectPath: string, name: string): WireProjectSummary;
  /**
   * @param acceptMigration answers a previous `migration-needed` result. The
   * file is upgraded in place (after an automatic backup) only when this is
   * `true` — docs/APP.md, "migration runs only with explicit opt-in".
   */
  open(projectPath: string, acceptMigration: boolean): Promise<OpenProjectResult>;
  close(): boolean;
  current(): WireProjectSummary | null;
  recentProjects(): readonly WireRecentProject[];

  /**
   * Registers files, and starts extracting the Navisworks documents among them.
   *
   * Asynchronous because every registration begins with a streamed sha256, and
   * a source may be a multi-gigabyte model: hashing one on the main loop would
   * stop the window drawing for as long as it took (RELEASE-1.0-PLAN,
   * "Main process never blocked by hashing"). The result is returned once the
   * rows exist; the extraction each raw model needs runs on behind them and is
   * followed through {@link extractionStatus}.
   */
  addSources(paths: readonly string[]): Promise<readonly WireAddSourceResult[]>;
  listSources(): readonly WireSourceSummary[];
  /** Removes one registered source by id. Names cannot be used: they repeat. */
  removeSource(sourceId: string): boolean;

  /* ------------------------------------------------- extraction (P0-2) */

  /** One page of the extraction jobs this session has run, oldest first. */
  extractionStatus(offset: number, limit: number): ExtractionStatusPage;
  /**
   * True while an extraction is queued or running.
   *
   * Asked by the quit path, which needs the answer before it decides whether to
   * interrupt the user, and which must not throw when no project is open.
   */
  extractionRunning(): boolean;
  /** Stops one extraction. The source stays registered, as `cancelled`. */
  cancelExtraction(sourceId: string): boolean;
  /**
   * Resolves when no extraction is queued or running.
   *
   * Not read by any screen. It exists for the same reason `cacheHandleIds`
   * does: the promises this milestone makes — one job at a time, a second add
   * of the same bytes never launching anything — are promises about work that
   * finishes after the call that started it returns, and a test that waited by
   * sleeping would be asserting against a guess.
   */
  extractionIdle(): Promise<void>;

  /** Every ready model source and the totals over them, or `null` when none is. */
  modelUniverse(): WireModelUniverse | null;
  propertyPage(request: PropertyPageRequest): PropertyPageResult;
  /** Navisworks class names with counts, summed across every open cache. */
  classList(): readonly WireClassCount[];
  /**
   * The internal handle id of each open extraction cache, by source id.
   *
   * Not a wire type and not read by any screen. It exists because "replacing
   * one source must not re-open the others" (P0-1) is a promise about cache
   * handles, and the only honest way to test a promise about handles is to be
   * able to see them: a source whose id here is unchanged across a mutation was
   * demonstrably not re-opened.
   */
  cacheHandleIds(): ReadonlyMap<string, number>;

  draftState(): DraftState;
  updateDraft(patch: WireDraftPatch): WireDraftProfile;
  saveProfile(note: string): SaveProfileResult;

  assetPreview(): WireAssetPreview;
  anatomyPreview(): WireAnatomyPreview;
  resolverPreview(): WireResolverPreview;

  /**
   * What one derived attribute would resolve to (P0-7).
   *
   * The definition is passed in rather than read off the draft: screen 6's
   * manager previews the definition being edited, which is not in the draft
   * until somebody saves it.
   */
  derivedPreview(definition: WireDerivedAttribute): WireDerivedPreview;

  /** Which documents one source-assignment rule speaks for (P0-8). */
  assignmentPreview(rule: WireSourceAssignmentRule): WireAssignmentPreview;

  /* ---------------------------------------------------------- quick setup */

  /** Every data-driven proposal the Quick Setup path offers. Applies nothing. */
  quickSetupSuggestions(): WireQuickSetupSuggestions;
  /** One starter template run over the real assets, before it is accepted. */
  resolverTemplatePreview(resolver: WireSystemResolver): WireResolverPreview;

  /* ------------------------------------------------------- screens 6 and 7 */

  attributeChoices(): readonly WireAttributeChoice[];
  config(): WireProjectConfig;
  updateConfig(patch: WireConfigPatch): WireProjectConfig;
  /** Distinct tag `role` values across the catalog, for the role-graph pickers. */
  roleValues(): readonly string[];
  /** Distinct `nativeDiscipline` values, for the projection table. */
  disciplineValues(): readonly string[];
  trainLearnedRules(kind: WireLearnedRuleKind, filePath: string): WireLearnedSummary;
  learnedSummaries(): readonly WireLearnedSummary[];

  /* ------------------------------------------------------------- screen 8 */

  /**
   * Runs the pipeline on a worker thread and resolves when it has ended.
   *
   * Asynchronous because the compile is no longer on the main loop
   * (RELEASE-1.0-PLAN, "worker_threads (compiler)"): every other channel goes
   * on answering while this is outstanding, which is the whole point. A second
   * call while one is running resolves with the running status rather than
   * starting a second worker.
   */
  compile(): Promise<WireCompileStatus>;
  /** Terminates the running compile. `false` when there was nothing to stop. */
  cancelCompile(): boolean;
  compileStatus(): WireCompileStatus;
  compileIssues(
    kind: WireCompileIssueKind,
    offset: number,
    limit: number,
  ): Page<WireCompileIssueRow>;
  /** One page of the identity log: what the ledger did this compile (P0-9). */
  compileLedgerEvents(offset: number, limit: number): Page<WireLedgerEvent>;
  compileHistory(): readonly WireCompileHistoryEntry[];

  /* ------------------------------------------------------------ workspace */

  treeChildren(nodeKey: string, offset: number, limit: number): WireTreePage;
  treeSearch(query: string, limit: number): readonly WireTreeNode[];
  reparentPreview(childAssetId: string, parentAssetId: string | null): WireReparentPreview;

  setRelationshipOverride(
    childAssetId: string,
    parentAssetId: string | null,
    note: string,
  ): readonly WireOverrideRow[];
  listRelationshipOverrides(): readonly WireOverrideRow[];
  removeRelationshipOverride(childAssetId: string): boolean;

  flowRoots(offset: number, limit: number): Page<WireFlowRoot>;
  flowWalk(rootNodeId: string, offset: number, limit: number): Page<WireFlowNode>;

  reviewPage(kind: string, offset: number, limit: number): WireReviewPage;
  recordDecision(reviewKey: string, decision: WireDecisionValue, note: string): boolean;

  /* -------------------------------------------------- exports and packages */

  exportGeneratedMel(filePath: string): WireExportResult;
  analyzeTemplate(filePath: string): WireTemplateAnalysis;
  exportTemplateMel(filePath: string, bindings: readonly WireTemplateBinding[]): WireExportResult;
  /**
   * Captures a registry workbook's layout into the project's config, so every
   * later EXTO export is written on the site's own sheet. Returns the config as
   * it now stands, which is what the exports view renders.
   */
  captureExtoTemplate(filePath: string): WireProjectConfig;
  /** Forgets the captured layout, returning the export to the generic map. */
  clearExtoTemplate(): WireProjectConfig;
  exportExto(filePath: string): WireExportResult;
  exportPredecessors(filePath: string): WireExportResult;
  exportRevisionDiff(filePath: string, previousCompileId: number): WireExportResult;

  profileSections(): readonly WireProfileSection[];
  /**
   * Why this draft cannot be published, or an empty list when it can.
   *
   * The same check `saveProfile` refuses on, exposed so screen 9 can say it
   * before the button is pressed rather than after (P0-3).
   */
  publishBlockers(): readonly WirePublishBlocker[];
  exportProfilePackage(filePath: string): WireExportResult;
  importProfilePackage(filePath: string): { draft: WireDraftProfile; config: WireProjectConfig };

  /** A save-dialog default name, so every export lands beside its project. */
  suggestExportName(suffix: string, extension: string): string;
}

/**
 * What identification learned about one registered source, kept in memory.
 *
 * `absolutePath` is where this machine last saw the file, and it is recorded
 * even for a source that is not readable right now: it is what tells a re-add
 * of a changed file from the registration of a *different* file that happens to
 * share its basename. Nothing reads the file on the strength of this field —
 * every read requires `status === 'ready'` as well.
 */
interface SourceDetail {
  readonly absolutePath: string;
  readonly status: WireSourceStatus;
  readonly note: string;
  readonly sheets: readonly WireSheetSummary[];
  /**
   * The extraction cache this source is read through, when that is not the
   * file itself.
   *
   * A `.matchline-cache` added by hand IS the data, so this stays `null` and
   * `absolutePath` is used. A raw `.nwd` is not: its data is the cache the
   * extraction service wrote under the app's cache folder, and the user is
   * never told where that is (P0-2, "the user never sees .matchline-cache").
   */
  readonly cachePath: string | null;
}

/**
 * One open model source, as main's own engine calls take it.
 *
 * The shape `@matchline/asset-catalog` and `subjectPropertiesFor` share: an id,
 * an open handle, and the two labels a provenance line prints. It stays in this
 * file because it is what the *session* holds; the compile's own view of a
 * source is `CompileWorkerSource`, which carries a path instead of a handle.
 */
interface OpenSource {
  readonly sourceId: string;
  readonly cache: ExtractionCache;
  readonly displayName: string;
  readonly rawFileName: string;
}

/** One open model source: its cache handle and the object scan over it. */
interface ModelState {
  readonly sourceId: string;
  readonly displayName: string;
  readonly rawFileName: string;
  /** What this handle was opened for. A change here is a different file. */
  readonly cacheSha256: string;
  /**
   * Where that cache is on this machine.
   *
   * Carried because the compile worker opens its own handle — a `node:sqlite`
   * object cannot cross a thread boundary — and a path is the only thing it can
   * be given. Never shown to a person: for an extracted model it is inside the
   * app's own cache folder, which P0-2 says the user never sees.
   */
  readonly cachePath: string;
  /** Distinguishes this handle from the next one opened for the same source. */
  readonly handleId: number;
  readonly cache: ExtractionCache;
  readonly classes: readonly WireClassCount[];
  readonly objectCount: number;
  readonly sourceModels: readonly WireSourceModelSummary[];
  readonly extractedAtUtc: string;
  readonly navisworksVersion: string;
  readonly warningCount: number;
}

/**
 * The universe Property Catalog, tied to the universe it was built from.
 *
 * A streaming pass per cache, so it is built when a screen asks and kept until
 * the set of open caches changes.
 */
interface DerivedCatalog {
  readonly universeKey: string;
  readonly entries: readonly UniversePropertyCatalogEntry[];
}

/**
 * The asset catalog and its subjects, tied to the draft AND the universe that
 * produced them. Either changing invalidates both.
 */
interface DerivedAssets {
  readonly configKey: string;
  readonly universeKey: string;
  readonly catalog: AssetCatalog;
  readonly subjects: readonly ResolverSubject[];
}

interface Session {
  readonly store: ProjectStore;
  readonly projectPath: string;
  draft: WireDraftProfile;
  /** The screens 6-7 sections, mirroring the project's own `config` table. */
  config: WireProjectConfig;
  /**
   * The newest stored profile revision, or `null` when the draft in memory is
   * not the one that revision holds.
   *
   * Nulled by every draft mutation, which is what makes it usable as "this
   * compile may point at this revision" rather than merely "something was saved
   * once". A compile that reused a stale number would label its results with a
   * profile that is not what produced them.
   */
  savedRevision: number | null;
  /** Keyed by `sourceId`, for every registered source of every role. */
  readonly details: Map<string, SourceDetail>;
  /** Keyed by `sourceId`, for every model source with an open cache. */
  readonly models: Map<string, ModelState>;
  melRows: readonly MelCatalogRow[];
  propertyCatalog: DerivedCatalog | null;
  derived: DerivedAssets | null;
  /** The last compile and every index over it, or `null` before the first run. */
  view: CompileView | null;
  compile: WireCompileStatus;
  /** The compile in flight, or `null` when none is. */
  running: RunningCompile | null;
}

/**
 * A compile from the moment it is asked for to the moment it settles.
 *
 * It exists because "a compile is running" has to be true *synchronously*, from
 * the call that started it, and the worker does not exist yet at that point —
 * the request's workbooks are read off disk first, which is asynchronous by
 * design. Without this marker there was a window in which Stop did nothing and
 * a second Compile started a second worker, and neither would have been visible
 * to the person doing it.
 *
 * `cancelRequested` is therefore the authority, not `run`: a Stop that lands
 * before the worker is spawned means the worker is never spawned at all.
 */
interface RunningCompile {
  /** The worker, once it has been started. `null` until then. */
  run: CompileRun | null;
  cancelRequested: boolean;
}

/**
 * What one compile's row in `compiles.stats_json` holds.
 *
 * The project schema (v1) has no column for the generated-MEL assets, and the
 * `snapshots` table is one row keyed `slot = 0` — it holds *the latest*
 * snapshot, not one per compile, so a revision diff cannot read a baseline out
 * of it. `stats_json` is declared `unknown` and is the caller's to shape, so
 * the assets ride alongside the stats there: one row per compile, already
 * keyed by compile id, and a diff against any stored compile is a lookup.
 *
 * The cost is row size — roughly a kilobyte per hundred assets — which is why
 * `assetsOfCompile` reads it back defensively rather than assuming the shape.
 */
interface StoredCompileStats {
  readonly summary: unknown;
  readonly generatedMelAssets: readonly GeneratedMelAsset[];
}

/**
 * The generated-MEL assets a stored compile row carries, or `null`.
 *
 * `CompileRecord.stats` is `unknown` by contract — the store keeps whatever
 * JSON it was handed and never assumes a shape — so this reads it back
 * defensively. A row written before this build simply has no assets, which is
 * what `WireCompileHistoryEntry.diffable` reports, rather than a failure at
 * export time.
 */
function storedAssetsOf(record: CompileRecord): readonly GeneratedMelAsset[] | null {
  const stats: unknown = record.stats;
  if (typeof stats !== 'object' || stats === null) {
    return null;
  }
  const assets: unknown = (stats as Record<string, unknown>)['generatedMelAssets'];
  if (!Array.isArray(assets)) {
    return null;
  }
  for (const candidate of assets as readonly unknown[]) {
    if (typeof candidate !== 'object' || candidate === null) {
      return null;
    }
    const row = candidate as Record<string, unknown>;
    if (typeof row['canonicalTag'] !== 'string' || typeof row['inclusionStatus'] !== 'string') {
      return null;
    }
  }
  return assets as readonly GeneratedMelAsset[];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Whether the file at `absolutePath` still hashes to what the project recorded.
 *
 * A file that cannot be read at all counts as not matching: the caller has
 * already established the path exists, so a read failure here means the bytes
 * are not available to prove anything with.
 */
async function bytesStillMatch(absolutePath: string, expectedSha256: string): Promise<boolean> {
  try {
    // The streaming digest, always. Opening a project used to hash every
    // registered file synchronously on the main loop, which on a project
    // holding a 700 MB model meant the window did not draw until the last byte
    // had been read (RELEASE-1.0-PLAN, "Main process never blocked by
    // hashing"). There is no synchronous digest left to reach for.
    return (await digestFile(absolutePath)).sha256 === expectedSha256;
  } catch {
    return false;
  }
}

/**
 * Whether a source in this state has a cache the engine may read.
 *
 * `cache-hit` sits beside `ready` because it is the same fact with a shorter
 * story: the bytes had been extracted before, so nothing was launched. Both
 * mean a validated cache is associated.
 */
function isReadableStatus(status: WireSourceStatus): boolean {
  return status === 'ready' || status === 'cache-hit';
}

/**
 * The two ways opening a project stops that are questions rather than errors.
 *
 * `migration-required` is the file asking permission to be upgraded, and
 * `backup-exists` is an earlier upgrade attempt's backup still sitting where
 * the next one would go. Both are returned as results the UI can act on;
 * everything else is `null` and becomes a message.
 */
function openRefusal(error: unknown): WireProjectOpenResult | null {
  if (!(error instanceof ProjectStoreError)) {
    return null;
  }
  const reason = error.reason;
  if (reason.kind === 'migration-required') {
    return {
      outcome: 'migration-needed',
      migrationNeeded: { fromVersion: reason.found, toVersion: reason.supported },
    };
  }
  if (reason.kind === 'backup-exists') {
    return { outcome: 'backup-blocked', backupPath: reason.path };
  }
  return null;
}

/**
 * Where extraction caches go when nobody named a folder.
 *
 * On Windows that is `%LOCALAPPDATA%\\Matchline\\cache\\models`, not the
 * `userData` folder every other piece of app state lives in. `userData` on
 * Windows is `%APPDATA%` — the *roaming* profile — and on a domain-joined
 * machine roaming means copied to and from a file server at every sign-in. An
 * extraction cache is hundreds of megabytes to several gigabytes per model,
 * re-creatable from the model at any time, and belongs to this machine; putting
 * it on the roaming path is how a user ends up waiting ten minutes to log in.
 * It is also the folder the launcher itself defaults to
 * (`ExtractorArguments.DefaultCacheDirectory`) and the one every doc names.
 *
 * `userData` is still the fallback, for the one case where the environment
 * variable is missing: a folder that is definitely writable beats a path built
 * from an empty string.
 */
function defaultExtractionCacheDir(userDataDir: string): string {
  if (process.platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA'];
    if (localAppData !== undefined && localAppData !== '') {
      return path.join(localAppData, 'Matchline', 'cache', 'models');
    }
  }
  return path.join(userDataDir, 'cache', 'models');
}

export function createProjectService(options: ProjectServiceOptions): ProjectService {
  const appState: AppStateStore = createAppStateStore(options.userDataDir);
  const extractionCacheDir = options.extractionCacheDir ?? defaultExtractionCacheDir(options.userDataDir);
  const launcherOptions = {
    platform: process.platform,
    executablePath: defaultExtractorPath(),
  } as const;
  const extractionLauncher: ExtractorLauncher =
    options.extractionLauncher ?? resolveExtractorLauncher(launcherOptions);
  /**
   * What this machine can honestly offer, reported with the queue.
   *
   * A caller that supplied its own launcher is the tests and nothing else, and
   * it has by definition supplied a working one — asking the real machine about
   * it would answer for a launcher nobody is using.
   */
  const capability: ExtractionCapability =
    options.extractionLauncher === undefined
      ? extractionCapability(launcherOptions)
      : { available: true, code: '', reason: '' };
  let session: Session | null = null;
  /**
   * The extraction queue for the open project, or `null` when none is open.
   *
   * One per session rather than one per installation, because cancelling
   * everything is part of closing a project: a Navisworks the user can no
   * longer see the progress of is a Navisworks nobody asked for.
   */
  let extraction: ExtractionService | null = null;
  /**
   * Distinguishes one opened cache handle from the next.
   *
   * Process-wide and never reset, so an id is unique across projects too: a
   * handle that survived a mutation and a handle that replaced it can never
   * accidentally compare equal.
   */
  let nextCacheHandleId = 1;

  /* ------------------------------------------------------------- lifecycle */

  function requireSession(): Session {
    if (session === null) {
      throw new Error('No project is open. Create or open one first.');
    }
    return session;
  }

  /* ------------------------------------------------------------ extraction */

  /**
   * Mirrors a running job into the source row it belongs to.
   *
   * Status and note only. The cache is associated in {@link settleExtraction},
   * once there is a validated one to associate — a row that said `ready`
   * before then would be a model source the compile could not open.
   */
  function trackExtraction(job: WireExtractionJob): void {
    const active = session;
    if (active === null || job.status === 'ready' || job.status === 'cache-hit') {
      return;
    }
    const detail = active.details.get(job.sourceId);
    if (detail === undefined) {
      return;
    }
    active.details.set(job.sourceId, { ...detail, status: job.status, note: job.note });
  }

  /**
   * Records what a finished extraction produced.
   *
   * The success path is the whole of P0-2's "associate automatically": the
   * project records the cache hash against the source, the session learns
   * where the cache is, and `syncModels` opens it — after which the universe,
   * the Property Catalog and every preview include it, with nobody having
   * named a cache file.
   */
  function settleExtraction(job: WireExtractionJob, outcome: ExtractionOutcome | null): void {
    const active = session;
    if (active === null) {
      return;
    }
    const detail = active.details.get(job.sourceId);
    if (detail === undefined) {
      return;
    }
    if (outcome === null) {
      active.details.set(job.sourceId, { ...detail, status: job.status, note: job.note });
      return;
    }

    try {
      active.store.setSourceCache(job.sourceId, outcome.cacheSha256);
    } catch {
      // The source was removed while its extraction ran. The cache stays on
      // disk under its content hash and costs one file; re-adding the model
      // finds it again as a cache hit.
      return;
    }
    active.details.set(job.sourceId, {
      ...detail,
      status: job.status,
      note: job.note,
      cachePath: outcome.cachePath,
    });
    syncModels(active);
  }

  /** Starts a queue for the project being opened, and retires the previous one. */
  function startExtraction(): ExtractionService {
    let created: ExtractionService | null = null;
    const isCurrent = (): boolean => extraction === created;
    created = createExtractionService({
      cacheDirectory: extractionCacheDir,
      launcher: extractionLauncher,
      onChanged(job: WireExtractionJob): void {
        if (isCurrent()) {
          trackExtraction(job);
        }
      },
      onSettled(job: WireExtractionJob, outcome: ExtractionOutcome | null): void {
        if (isCurrent()) {
          settleExtraction(job, outcome);
        }
      },
    });
    return created;
  }

  function requireExtraction(): ExtractionService {
    if (extraction === null) {
      throw new Error('No project is open. Create or open one first.');
    }
    return extraction;
  }

  /** Closes every open cache. Used when the project closes, never per source. */
  function releaseModels(active: Session): void {
    for (const model of active.models.values()) {
      model.cache.close();
    }
    active.models.clear();
    active.propertyCatalog = null;
    active.derived = null;
  }

  function summarize(active: Session): WireProjectSummary {
    const meta = active.store.meta();
    return {
      path: active.projectPath,
      name: meta.projectName,
      schemaVersion: meta.schemaVersion,
      createdAt: meta.createdAt,
      modifiedAt: meta.modifiedAt,
      sourceCount: active.store.listSources().length,
      savedRevision: active.savedRevision,
      hasModel: active.models.size > 0,
    };
  }

  function rememberOpened(active: Session): void {
    appState.rememberProject({
      path: active.projectPath,
      name: active.store.meta().projectName,
      openedAt: new Date().toISOString(),
    });
  }

  /**
   * The project's own configuration for a project that is being opened.
   *
   * Three cases, in order: the project file says what it is configured to; an
   * older build left the answer in this installation's state file, in which
   * case it is copied into the project once and taken out of the state file;
   * or nothing has been configured and the wizard opens on its defaults.
   *
   * The copy is deliberately not attempted for a project being *created*: a new
   * file at a path some deleted project once used would silently inherit its
   * configuration, which is a surprise nobody asked for.
   *
   * Only the EXTO template is left in this table. The sections that used to
   * share it are profile material and are moved by {@link mergeLegacyConfig}
   * below, the first time a pre-SiteProfileV2 project is opened.
   */
  function adoptConfig(
    store: ProjectStore,
    projectPath: string,
  ): { config: WireProjectConfig; adopted: boolean } {
    const stored = readProjectConfig(store);
    if (stored !== null) {
      return { config: stored, adopted: false };
    }
    if (store.listConfig().length > 0) {
      // Rows this build cannot read. Left exactly where they are rather than
      // overwritten from a machine-local file that is probably older still.
      return { config: defaultProjectConfig(), adopted: false };
    }

    const legacy = appState.takeLegacyProjectConfig(projectPath);
    if (legacy === undefined) {
      return { config: defaultProjectConfig(), adopted: false };
    }
    // Written back verbatim, sections and all: the merge below is what moves
    // the profile material out of this table, and running it through the one
    // migration is what keeps a state-file project and a v6 project from taking
    // two different routes into the profile.
    writeLegacyProjectConfig(store, legacy);
    return { config: { extoTemplate: legacy.extoTemplate }, adopted: true };
  }

  /**
   * Moves a pre-SiteProfileV2 project's `config` sections into its profile.
   *
   * Runs at most once per project, on open, and only when there is something to
   * move: the `config` table still holds a `hierarchy` row. The flow is
   * deliberately in this order, and nothing about it is optional --
   *
   * 1. read the sections out of `config`;
   * 2. join them onto the draft the stored profile rehydrated to;
   * 3. save that as a NEW profile revision, with a note that says what happened;
   * 4. only then delete the rows that moved.
   *
   * A new revision rather than an edit, because a profile is republished and
   * never edited in place -- the revision the last compile ran against stays
   * exactly as it was, and the merge is a visible line in the profile history
   * rather than a silent rewrite. The rows are removed last so that a crash
   * between steps leaves the decisions in the place this function will look
   * again; a value in two places is a value that can disagree with itself, and
   * a value in no place is a decision destroyed.
   */
  function mergeLegacyConfigSections(
    store: ProjectStore,
    draft: WireDraftProfile,
  ): { draft: WireDraftProfile; revision: number | null; merged: boolean } {
    const legacy = readLegacyProjectConfig(store);
    if (legacy === null) {
      return { draft, revision: null, merged: false };
    }

    const merged = mergeLegacyConfig(draft, legacy);
    let revision: number;
    try {
      revision = store.saveProfile(
        toSiteProfile(merged),
        'Site Profile v2: the hierarchy, relationships and rules this project kept in its ' +
          'configuration are now sections of the profile itself.',
      );
    } catch {
      // The merged profile is not publishable -- most often because this
      // project never picked an equipment tag property, so there is no valid
      // profile to write at all. The sections stay exactly where they are and
      // the wizard opens on them; the merge is retried on the next open, once
      // the draft is complete enough to save.
      return { draft: merged, revision: null, merged: false };
    }
    clearLegacyConfigSections(store);
    return { draft: merged, revision, merged: true };
  }

  function adopt(
    store: ProjectStore,
    projectPath: string,
    config: WireProjectConfig,
  ): { session: Session; mergedLegacyConfig: boolean } {
    const stored = store.getProfile();
    const rehydrated =
      stored === undefined
        ? emptyDraft(store.meta().projectName)
        : fromSiteProfile(stored.profile);
    const moved = mergeLegacyConfigSections(store, rehydrated);
    // Before the session exists, because rehydrating one is what queues the
    // extractions a reopened project still owes.
    extraction = startExtraction();
    const active: Session = {
      store,
      projectPath,
      draft: moved.draft,
      config,
      savedRevision: moved.revision ?? stored?.revision ?? null,
      details: new Map<string, SourceDetail>(),
      models: new Map<string, ModelState>(),
      melRows: [],
      propertyCatalog: null,
      derived: null,
      view: null,
      compile: { state: 'never-run' },
      running: null,
    };
    return { session: active, mergedLegacyConfig: moved.merged };
  }

  /**
   * Re-finds the files a reopened project refers to, and re-proves they are the
   * same files.
   *
   * A project stores names and hashes, never directories (PRODUCT.md §13.3), so
   * the installation's sha256 index is the only way back to the bytes. That
   * index is a convenience and never authority (app-store.ts): the path it
   * hands back is re-digested here, and a file whose bytes no longer match the
   * hash the project recorded is `file-changed` — the same file name holding
   * different content is exactly the case where reading it anyway would compile
   * numbers nobody approved.
   *
   * A row whose file cannot be found at all is not an error either: it is shown
   * as `file-missing` and the user re-adds it. Re-adding is also the fix for
   * `file-changed`, because `source:add` re-digests and updates the hash.
   *
   * ## Why this is asynchronous, and why it is only four at a time
   *
   * Re-proving means hashing every registered file, and a project's files are
   * models: opening a ten-model project used to read every byte of every one of
   * them on the main loop before the window could draw again
   * (RELEASE-1.0-PLAN, "Main process never blocked by hashing"). The digests
   * run concurrently now, bounded by {@link DIGEST_CONCURRENCY}, because forty
   * streams at one disk is slower than four and holds forty buffers alive.
   *
   * Every row is marked `hashing` before the first digest starts, so a screen
   * that asks what the project holds while the proving is still going gets the
   * truth — "being checked" — rather than a stale `ready` from a previous
   * session or an invented `needs-attention`.
   */
  async function rehydrateSources(active: Session): Promise<void> {
    /** One stored row, and the path this machine last saw it at. */
    interface Candidate {
      readonly source: ProjectSource;
      readonly knownPath: string;
    }

    const candidates: Candidate[] = [];
    for (const source of active.store.listSources()) {
      const knownPath = appState.sourcePath(source.rawSha256);
      if (knownPath === undefined || !existsSync(knownPath)) {
        active.details.set(source.sourceId, {
          absolutePath: '',
          status: 'file-missing',
          note:
            `Matchline recorded ${source.rawFileName} but cannot find it on this machine. ` +
            'Add the file again to work with it.',
          sheets: [],
          cachePath: null,
        });
        continue;
      }
      active.details.set(source.sourceId, {
        absolutePath: knownPath,
        status: 'hashing',
        note: `Checking that ${source.rawFileName} is still the file this project recorded.`,
        sheets: [],
        cachePath: null,
      });
      candidates.push({ source, knownPath });
    }

    const proven = await mapBounded(
      candidates,
      DIGEST_CONCURRENCY,
      async (candidate): Promise<boolean> =>
        bytesStillMatch(candidate.knownPath, candidate.source.rawSha256),
    );

    // The project can be closed, or another one opened, while the digests run.
    // Writing this project's answers into whatever session is current now would
    // be worse than dropping them: the rows would describe a different file.
    if (session !== active) {
      return;
    }

    candidates.forEach(({ source, knownPath }, index): void => {
      if (proven[index] !== true) {
        active.details.set(source.sourceId, {
          // The path is kept even though nothing may read it: re-adding this
          // same file has to land on this same source rather than register a
          // second one, and the path is what proves it is the same file.
          absolutePath: knownPath,
          status: 'file-changed',
          note:
            `The file at ${knownPath} has changed since it was added to this project. ` +
            'Add it again to use the new version.',
          sheets: [],
          cachePath: null,
        });
        return;
      }

      const identification = identifySource(knownPath);
      if (!identification.recognized) {
        active.details.set(source.sourceId, {
          absolutePath: knownPath,
          status: 'needs-attention',
          note: identification.reason,
          sheets: [],
          cachePath: null,
        });
        return;
      }

      const registration = identification.registrations.find(
        (candidate: SourceRegistration): boolean => candidate.role === source.role,
      );
      if (registration === undefined) {
        return;
      }
      if (registration.needsExtraction) {
        restoreExtraction(active, source, knownPath);
        return;
      }
      active.details.set(source.sourceId, {
        absolutePath: knownPath,
        status: registration.status,
        note: registration.note,
        sheets: registration.sheets,
        cachePath: null,
      });
    });

    syncModels(active);
    loadMelRows(active);
  }

  /**
   * Puts a reopened raw model source back where it was.
   *
   * Three cases, and the third is why this is not simply "queue everything
   * again": the cache is still on disk and is picked up without touching
   * Navisworks; the cache the project recorded is gone, so the model is
   * re-extracted; or nothing was ever extracted, so it is extracted now. The
   * queue's own cache-hit check makes the second and third cheap when the
   * bytes have in fact been extracted before, so reopening a project never
   * launches Navisworks for work already done.
   */
  function restoreExtraction(active: Session, source: ProjectSource, rawPath: string): void {
    const cachePath = path.join(extractionCacheDir, cacheFileName(source.rawSha256));
    if (source.derivedCacheSha256 !== null && existsSync(cachePath)) {
      active.details.set(source.sourceId, {
        absolutePath: rawPath,
        status: 'ready',
        note:
          `Extracted from ${source.rawFileName}. It joins the equipment universe every other ` +
          'source is matched against.',
        sheets: [],
        cachePath,
      });
      return;
    }

    active.details.set(source.sourceId, {
      absolutePath: rawPath,
      status: 'queued',
      note: `${source.rawFileName} is queued for extraction.`,
      sheets: [],
      cachePath: null,
    });
    extraction?.enqueue({
      sourceId: source.sourceId,
      fileName: source.rawFileName,
      inputPath: rawPath,
      rawSha256: source.rawSha256,
      rawByteSize: source.rawByteSize,
    });
  }

  /* -------------------------------------------------------- model universe */

  /**
   * The extraction cache a model source is currently readable through, or
   * `null` when it is not readable at all.
   *
   * A raw `.nwd` answers `null` until its extraction has produced a cache and
   * the session has recorded where it went (P0-2) — which is what its queued,
   * extracting or failed status says on screen 1. Everything else uses the
   * source's own recorded cache hash, so "the file this handle was opened for"
   * is a fact the session can compare against later.
   */
  function readableCacheOf(
    active: Session,
    source: ProjectSource,
  ): { readonly absolutePath: string; readonly cacheSha256: string } | null {
    if (source.role !== 'model' || source.derivedCacheSha256 === null) {
      return null;
    }
    const detail = active.details.get(source.sourceId);
    if (detail === undefined || !isReadableStatus(detail.status)) {
      return null;
    }
    // The cache, not the file: a raw model is read through the extraction the
    // service wrote for it, and only a hand-added cache is its own data.
    const cachePath = detail.cachePath ?? detail.absolutePath;
    if (cachePath === '') {
      return null;
    }
    return { absolutePath: cachePath, cacheSha256: source.derivedCacheSha256 };
  }

  /**
   * Brings the open caches in line with the registered model sources, opening
   * and closing only what actually changed.
   *
   * This is the heart of P0-1's "replacing one source invalidates only its
   * cache". A source whose id and cache hash are both unchanged keeps the very
   * handle it had — not an equal one, the same one — so re-adding one file in a
   * ten-file project costs one open, not ten. Derived state is dropped only
   * when something did change, because the universe key it is memoized against
   * is exactly the set this function reconciles.
   */
  function syncModels(active: Session): void {
    const wanted = new Map<string, { source: ProjectSource; absolutePath: string; cacheSha256: string }>();
    for (const source of active.store.listSources()) {
      const readable = readableCacheOf(active, source);
      if (readable !== null) {
        wanted.set(source.sourceId, { source, ...readable });
      }
    }

    let changed = false;

    for (const [sourceId, model] of [...active.models]) {
      const target = wanted.get(sourceId);
      if (target === undefined || target.cacheSha256 !== model.cacheSha256) {
        model.cache.close();
        active.models.delete(sourceId);
        changed = true;
      }
    }

    for (const [sourceId, target] of wanted) {
      const existing = active.models.get(sourceId);
      if (existing !== undefined) {
        // Same source, same bytes: the handle stays open and untouched. Only
        // the labels are refreshed, because a rename is not a re-extraction.
        if (
          existing.displayName !== target.source.logicalName ||
          existing.rawFileName !== target.source.rawFileName
        ) {
          active.models.set(sourceId, {
            ...existing,
            displayName: target.source.logicalName,
            rawFileName: target.source.rawFileName,
          });
        }
        continue;
      }

      let cache: ExtractionCache;
      try {
        cache = openExtractionCache(target.absolutePath);
      } catch {
        // Reported through the source's status on screen 1, not by failing
        // every other source in the universe.
        continue;
      }
      active.models.set(
        sourceId,
        describeModel(target.source, target.cacheSha256, target.absolutePath, cache),
      );
      changed = true;
    }

    if (changed) {
      active.propertyCatalog = null;
      active.derived = null;
    }
  }

  /** One object pass over a newly opened cache: classes, source models, counts. */
  function describeModel(
    source: ProjectSource,
    cacheSha256: string,
    cachePath: string,
    cache: ExtractionCache,
  ): ModelState {
    const meta = cache.meta();

    const objectsPerModel = new Map<number | null, number>();
    const classCounts = new Map<string, number>();
    for (const object of cache.allObjects()) {
      objectsPerModel.set(object.sourceModelId, (objectsPerModel.get(object.sourceModelId) ?? 0) + 1);
      if (object.className !== null && object.className !== '') {
        classCounts.set(object.className, (classCounts.get(object.className) ?? 0) + 1);
      }
    }

    const fileNames = new Map<number, string>();
    const visit = (nodes: readonly SourceModelNode[]): void => {
      for (const node of nodes) {
        fileNames.set(node.id, node.fileName ?? node.displayName ?? `Source model ${String(node.id)}`);
        visit(node.children);
      }
    };
    visit(cache.sourceModels());

    const sourceModels = [...objectsPerModel.entries()]
      .map(([sourceModelId, objectCount]) => ({
        sourceModelId,
        fileName:
          sourceModelId === null
            ? 'Not attributed to a source model'
            : (fileNames.get(sourceModelId) ?? `Source model ${String(sourceModelId)}`),
        objectCount,
      }))
      .sort((left, right) => right.objectCount - left.objectCount);

    const classes: WireClassCount[] = [...classCounts.entries()]
      .map(([className, objectCount]) => ({ className, objectCount }))
      .sort((left, right) =>
        left.objectCount === right.objectCount
          ? left.className.localeCompare(right.className)
          : right.objectCount - left.objectCount,
      );

    const handleId = nextCacheHandleId;
    nextCacheHandleId += 1;

    return {
      sourceId: source.sourceId,
      displayName: source.logicalName,
      rawFileName: source.rawFileName,
      cacheSha256,
      cachePath,
      handleId,
      cache,
      classes,
      objectCount: cache.objectCount(),
      sourceModels,
      extractedAtUtc: meta.extractedAtUtc,
      navisworksVersion: meta.navisworksVersion,
      warningCount: cache.warnings().length,
    };
  }

  /** Every open model source, in `sourceId` order — the order the engine reads. */
  function orderedModels(active: Session): readonly ModelState[] {
    return [...active.models.values()].sort((left, right) =>
      left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0,
    );
  }

  /**
   * The identity of the universe as it stands: every open source and the bytes
   * behind it.
   *
   * Everything derived from the caches is memoized against this. Replacing one
   * source changes it; renaming one does not, because a rename is not new
   * content and re-deriving on one would be work for nothing.
   */
  function universeKeyOf(active: Session): string {
    return orderedModels(active)
      .map((model) => `${model.sourceId}@${model.cacheSha256}`)
      .join('|');
  }

  /** Compact per-source names for the rows that name several sources at once. */
  function modelLabels(active: Session): ReadonlyMap<string, string> {
    return shortSourceLabels(orderedModels(active).map((model) => model.sourceId));
  }

  /**
   * Whether naming this set in a filter would name something nobody resolved.
   *
   * A folder means its contents, so the whole subtree is walked: an unresolved
   * saved search inside a named folder makes that folder's membership
   * incomplete too. Deliberately the same reading `@matchline/asset-catalog`'s
   * own `selectionSetMembers` performs — the point of this function is to refuse
   * BEFORE the engine has to, and a gate that disagreed with the engine would
   * either block a profile that compiles or pass one that cannot.
   */
  function unresolvedSetsBeneath(roots: readonly SelectionSetNode[], name: string): boolean {
    const stack: SelectionSetNode[] = [...roots];
    const seen = new Set<number>();
    /** Set to true by the first unresolved node in a subtree that matched. */
    let unresolved = false;
    while (stack.length > 0) {
      const node = stack.pop();
      if (node === undefined || seen.has(node.id)) {
        continue;
      }
      seen.add(node.id);
      if (node.name === name) {
        // Several sets may share a name; naming it means all of them, so the
        // whole of each matching subtree has to answer.
        const subtree: SelectionSetNode[] = [node];
        const walked = new Set<number>();
        while (subtree.length > 0) {
          const inner = subtree.pop();
          if (inner === undefined || walked.has(inner.id)) {
            continue;
          }
          walked.add(inner.id);
          if (!inner.membershipResolved) {
            unresolved = true;
          }
          subtree.push(...inner.children);
        }
      }
      stack.push(...node.children);
    }
    return unresolved;
  }

  /**
   * Every reason this project's draft cannot be published (P0-3).
   *
   * One reason today: an asset filter naming a selection set that at least one
   * open source recorded WITHOUT its membership — a saved search Navisworks
   * would not run, which schema v2 stores as `membership_resolved = 0` and
   * which a v1 cache expresses by having recorded a search with no members at
   * all. The compiler already refuses such a profile
   * (`AssetCatalogConfigReason.unresolved-selection-set`), so publishing one
   * would store a revision that can never produce a register; this is the same
   * refusal, moved to the moment the person can still do something about it.
   *
   * A set no open source has is NOT a blocker here. That is `unknown-selection-
   * set` in the engine, and it is a different situation: a project whose model
   * sources are not all added yet has filters naming sets that will exist once
   * they are, and refusing to publish over one would make the wizard unusable
   * in the order people actually work.
   */
  function publishBlockersFor(active: Session): readonly WirePublishBlocker[] {
    const names = active.draft.assetFilters.selectionSetNames;
    if (names.length === 0 || active.models.size === 0) {
      return [];
    }
    const labels = modelLabels(active);
    const blockers: WirePublishBlocker[] = [];
    for (const name of names) {
      const sourceNames: string[] = [];
      for (const model of orderedModels(active)) {
        if (unresolvedSetsBeneath(model.cache.selectionSets(), name)) {
          sourceNames.push(labels.get(model.sourceId) ?? model.displayName);
        }
      }
      if (sourceNames.length === 0) {
        continue;
      }
      const where =
        sourceNames.length === 1
          ? `${sourceNames.join('')} has it`
          : `${sourceNames.join(', ')} have it`;
      blockers.push({
        kind: 'unresolved-selection-set',
        setName: name,
        sourceNames,
        message:
          `This profile keeps only the equipment in the set '${name}', and ${where} recorded ` +
          'without its contents — it is a saved search, and the extraction never got Navisworks ' +
          'to run it. Matchline will not treat a set nobody resolved as an empty one, so a ' +
          'compile against this profile is refused rather than returning no equipment at all. ' +
          'Open the model in Navisworks, check the search still finds what it should, and ' +
          `extract it again — or take '${name}' off the filter on screen 3 and keep the ` +
          'equipment some other way.',
      });
    }
    return blockers;
  }

  /**
   * The universe as `@matchline/asset-catalog` takes it: open handles, in
   * `sourceId` order.
   *
   * Main's own reads only — the wizard's catalog preview and its subjects. A
   * compile never sees these handles; it gets {@link workerSources} instead,
   * because `node:sqlite` objects do not cross a thread boundary.
   */
  function openSources(active: Session): readonly OpenSource[] {
    return orderedModels(active).map((model) => ({
      sourceId: model.sourceId,
      cache: model.cache,
      displayName: model.displayName,
      rawFileName: model.rawFileName,
    }));
  }

  /** The same universe as the compile worker takes it: paths and their hashes. */
  function workerSources(active: Session): readonly CompileWorkerSource[] {
    return orderedModels(active).map((model) => ({
      sourceId: model.sourceId,
      cachePath: model.cachePath,
      cacheSha256: model.cacheSha256,
      displayName: model.displayName,
      rawFileName: model.rawFileName,
    }));
  }

  /**
   * The aggregated Property Catalog, built once per universe.
   *
   * One streaming pass per open cache, which is why it is built on demand and
   * kept: screen 2 pages it, screen 3's pickers read it, and neither should pay
   * for it twice.
   */
  function universeCatalog(active: Session): readonly UniversePropertyCatalogEntry[] {
    const universeKey = universeKeyOf(active);
    const cached = active.propertyCatalog;
    if (cached !== null && cached.universeKey === universeKey) {
      return cached.entries;
    }
    const entries = buildUniversePropertyCatalog(
      orderedModels(active).map((model) => ({ sourceId: model.sourceId, cache: model.cache })),
    );
    active.propertyCatalog = { universeKey, entries };
    return entries;
  }

  /**
   * Every document a source-assignment rule could speak for (P0-8).
   *
   * One row per SOURCE MODEL rather than per source, because a federated cache
   * holds several models and a `source-model` or `filename-pattern` rule speaks
   * for one of them. A source model the cache attributes no file name to still
   * gets a row — a `logical-source` rule can name it — with an empty file name,
   * which is what says the two file-name scopes cannot reach it.
   */
  function assignmentDocuments(active: Session): readonly AssignmentDocument[] {
    const labels = modelLabels(active);
    const documents: AssignmentDocument[] = [];
    for (const model of orderedModels(active)) {
      for (const sourceModel of model.sourceModels) {
        documents.push({
          sourceId: model.sourceId,
          label: labels.get(model.sourceId) ?? model.sourceId,
          sourceModelFile: sourceModel.sourceModelId === null ? '' : sourceModel.fileName,
          objectCount: sourceModel.objectCount,
        });
      }
    }
    return documents;
  }

  /** Every non-blank canonical tag the current draft produces, for inference. */
  function catalogTagsOf(active: Session): readonly string[] {
    return catalogTags(requireDerived(active).catalog);
  }

  /**
   * Objects per Navisworks class, and how many of them carry an equipment tag.
   *
   * Read straight off the caches rather than off the asset catalog, and that is
   * deliberate: the catalog has already applied this project's class filters, so
   * counting through it would tell a person that the classes they excluded carry
   * no tags — which is true, circular, and useless. A suggestion has to be a
   * fact about the model, not about the settings it is proposing to change.
   *
   * One pass over each cache's properties and one over its objects. Run when the
   * Quick Setup class screen is opened, not on every keystroke.
   */
  function classSuggestions(active: Session): readonly WireClassSuggestion[] {
    const mappings = liftWireMappings(active.draft.propertyMappings);
    const objectCounts = new Map<string, number>();
    const taggedCounts = new Map<string, number>();

    for (const model of orderedModels(active)) {
      const override = mappings.equipmentTag.bySource.find(
        (entry) => entry.sourceId === model.sourceId && entry.chain.length > 0,
      );
      const chain = override?.chain ?? mappings.equipmentTag.chain;
      const addresses = new Set(chain.map((ref) => `${ref.category} ${ref.name}`));

      const tagged = new Set<number>();
      if (addresses.size > 0) {
        for (const row of model.cache.allProperties()) {
          if (row.valueText === null || row.valueText.trim() === '') {
            continue;
          }
          if (addresses.has(`${row.category} ${row.name}`)) {
            tagged.add(row.objectId);
          }
        }
      }

      for (const object of model.cache.allObjects()) {
        const className = object.className;
        if (className === null || className === '') {
          continue;
        }
        objectCounts.set(className, (objectCounts.get(className) ?? 0) + 1);
        if (tagged.has(object.id)) {
          taggedCounts.set(className, (taggedCounts.get(className) ?? 0) + 1);
        }
      }
    }

    const counts: ClassTagCount[] = [...objectCounts.entries()].map(
      ([className, objectCount]) => ({
        className,
        objectCount,
        taggedCount: taggedCounts.get(className) ?? 0,
      }),
    );
    return suggestClasses(counts);
  }

  /** Re-reads every MEL source. Screen 5's `mel-lookup` rungs join against these. */
  function loadMelRows(active: Session): void {
    const rows: MelCatalogRow[] = [];
    for (const source of active.store.listSources()) {
      if (source.role !== 'mel') {
        continue;
      }
      const detail = active.details.get(source.sourceId);
      if (detail === undefined || detail.status !== 'ready' || detail.absolutePath === '') {
        continue;
      }
      try {
        rows.push(...readMelCatalogRows(detail.absolutePath, detail.sheets));
      } catch {
        // A MEL that cannot be re-read is reported through its source status,
        // not by failing every later preview.
      }
    }
    active.melRows = rows;
  }

  /* ------------------------------------------------------- derived assets */

  function configKeyOf(active: Session): string {
    return JSON.stringify([active.draft.propertyMappings, active.draft.assetFilters]);
  }

  /**
   * The asset catalog for the current draft over the current universe, rebuilt
   * only when the mappings, the filters or the universe actually changed.
   *
   * @throws Error when no model source is readable, or no equipment tag
   * property has been chosen.
   */
  function requireDerived(active: Session): DerivedAssets {
    if (active.models.size === 0) {
      throw new Error('Add a model extraction cache on screen 1 before previewing assets.');
    }

    const configKey = configKeyOf(active);
    const universeKey = universeKeyOf(active);
    const cached = active.derived;
    if (cached !== null && cached.configKey === configKey && cached.universeKey === universeKey) {
      return cached;
    }

    const mappings = toPropertyMappings(active.draft.propertyMappings);
    const filters = toAssetFilters(active.draft.assetFilters);
    // The same universe the compile runs on, so the asset ids previewed on
    // screen 3 are the asset ids screen 8 reports.
    const sources = openSources(active);
    const catalog = buildAssetCatalog(sources, mappings, filters);

    const fileOf = new Map(sources.map((source) => [source.sourceId, source.rawFileName]));
    const subjects: ResolverSubject[] = catalog.assets.map((asset) => ({
      assetId: asset.assetId,
      canonicalTag: asset.canonicalTag,
      properties: subjectPropertiesFor(sources, asset, mappings.equipmentTag),
      // The asset's own source, never the first one: a subject that named the
      // wrong file would put a wrong document behind every claim it makes.
      sourceFile: fileOf.get(asset.sourceId) ?? asset.sourceId,
      objectId: String(asset.objectIds[0] ?? 0),
    }));

    const derived: DerivedAssets = { configKey, universeKey, catalog, subjects };
    active.derived = derived;
    return derived;
  }

  /* --------------------------------------------------------------- sources */

  /**
   * The `sourceId` a file being added belongs to: an existing source it *is*,
   * or a fresh one.
   *
   * Three cases, and the difference between them is the whole of P0-1's
   * "same-basename files coexist":
   *
   * 1. **The same bytes, again.** Same role, same basename, same hash — this is
   *    the source that is already registered, being re-added. It replaces
   *    itself and nothing else moves.
   * 2. **The same file, changed.** Same role, same basename, and the path this
   *    machine last saw that source at. New bytes for a file that is still the
   *    same file, so it keeps its id and its cache is invalidated — which is
   *    also how a `file-changed` row is cleared: re-adding re-digests it.
   * 3. **A different file wearing the same name.** Anything else. Four
   *    consultants each ship `Level 1.nwc` and all four are real equipment, so
   *    this becomes a NEW source and `deriveSourceId` suffixes the id.
   *
   * The path is what separates 2 from 3, and it is the only thing that can:
   * the bytes differ in both cases and the names are equal in both.
   */
  function sourceIdFor(
    active: Session,
    role: SourceRole,
    fileName: string,
    absolutePath: string,
    sha256: string,
  ): string {
    const rows = active.store.listSources();
    const sameName = rows.filter(
      (row: ProjectSource): boolean => row.role === role && row.rawFileName === fileName,
    );

    const sameBytes = sameName.find((row: ProjectSource): boolean => row.rawSha256 === sha256);
    if (sameBytes !== undefined) {
      return sameBytes.sourceId;
    }
    const samePath = sameName.find(
      (row: ProjectSource): boolean =>
        active.details.get(row.sourceId)?.absolutePath === absolutePath,
    );
    if (samePath !== undefined) {
      return samePath.sourceId;
    }
    // Every id in the project, not just this name's: an id has to dodge
    // whatever else is registered, whatever role it holds.
    return deriveSourceId(role, fileName, rows.map((row: ProjectSource): string => row.sourceId));
  }

  function summarizeSource(source: ProjectSource): WireSourceSummary {
    const detail = session?.details.get(source.sourceId);
    return {
      sourceId: source.sourceId,
      role: source.role,
      logicalName: source.logicalName,
      rawFileName: source.rawFileName,
      rawSha256: source.rawSha256,
      rawByteSize: source.rawByteSize,
      derivedCacheSha256: source.derivedCacheSha256,
      addedAt: source.addedAt,
      status: detail?.status ?? 'needs-attention',
      note: detail?.note ?? `${roleLabel(source.role)} source recorded in this project.`,
      sheets: [...(detail?.sheets ?? [])],
    };
  }

  function closeSession(): boolean {
    // Unconditionally, and first: a project that failed to finish opening can
    // still have left a queue behind, and a Navisworks nobody can see the
    // progress of must not outlive the project that started it.
    extraction?.shutdown();
    extraction = null;
    if (session === null) {
      return false;
    }
    // Same rule for the compile worker: a thread reading the caches of a
    // project nobody has open is work no result will ever be adopted from.
    if (session.running !== null) {
      session.running.cancelRequested = true;
      session.running.run?.cancel();
      session.running = null;
    }
    releaseModels(session);
    session.store.close();
    session = null;
    return true;
  }

  /* ------------------------------------------------- screens 6-7: the config */

  /** Distinct values of one compile-subject attribute, for the level menu. */
  function distinctAttributeValues(active: Session): ReadonlyMap<string, number> | null {
    const view = active.view;
    if (view === null) {
      return null;
    }
    const seen = new Map<string, Set<string>>();
    for (const subject of view.project.compileSubjects) {
      for (const [key, value] of subject.attributes) {
        const values = seen.get(key) ?? new Set<string>();
        values.add(value);
        seen.set(key, values);
      }
    }
    const counts = new Map<string, number>();
    for (const [key, values] of seen) {
      counts.set(key, values.size);
    }
    return counts;
  }

  /* ------------------------------------------------- screen 8: the compile */

  /**
   * Every connectivity workbook, re-read from disk.
   *
   * A project stores names and hashes, never directories, so a source whose
   * file this machine can no longer find is a refusal with the file named — not
   * a compile that silently produces a flow graph with a third of the edges
   * missing.
   */
  async function connectivityInputs(
    active: Session,
  ): Promise<readonly ConnectivityWorkbookInput[]> {
    const wanted: readonly SourceRole[] = ['easypower', 'cable-schedule', 'pmd'];
    const inputs: ConnectivityWorkbookInput[] = [];

    for (const source of active.store.listSources()) {
      if (!wanted.includes(source.role)) {
        continue;
      }
      const detail = active.details.get(source.sourceId);
      if (
        detail === undefined ||
        detail.status !== 'ready' ||
        detail.absolutePath === '' ||
        !existsSync(detail.absolutePath)
      ) {
        throw new Error(
          `Matchline cannot read ${source.rawFileName} on this machine, and it is a ` +
            `${roleLabel(source.role)} source this project compiles from. ` +
            'Add the file again on screen 1, or remove the source.',
        );
      }
      inputs.push({
        // Read off the loop. A cable schedule is small next to a model, but
        // "small" is the site's opinion, not ours, and the whole point of this
        // milestone is that no compile input is read synchronously in main.
        bytes: await readFile(detail.absolutePath),
        sourceFile: source.rawFileName,
      });
    }
    return inputs;
  }

  /** The MEL the compile builds its System Catalog from, or `null`. */
  async function melInput(active: Session): Promise<MelWorkbookInput | null> {
    for (const source of active.store.listSources()) {
      if (source.role !== 'mel') {
        continue;
      }
      const detail = active.details.get(source.sourceId);
      if (
        detail === undefined ||
        detail.status !== 'ready' ||
        detail.absolutePath === '' ||
        !existsSync(detail.absolutePath)
      ) {
        throw new Error(
          `Matchline cannot read ${source.rawFileName} on this machine, and it is the master ` +
            'equipment list this project resolves systems against. Add it again on screen 1, ' +
            'or remove the source.',
        );
      }
      const bytes = await readFile(detail.absolutePath);
      const descriptor = melSheetDescriptor(bytes, detail.sheets);
      if (descriptor === null) {
        continue;
      }
      return {
        bytes,
        sourceFile: source.rawFileName,
        sheetName: descriptor.sheetName,
        mapping: descriptor.mapping,
        headerRow: descriptor.headerRow,
      };
    }
    return null;
  }

  /**
   * The trained nesting rules, or `null` when nothing has been trained.
   *
   * A rule set this build cannot read is inert rather than fatal: the learned
   * rung simply produces nothing, which is what an untrained project does too.
   */
  function storedNestingRules(active: Session): LearnedRuleSet | null {
    const stored: unknown = active.store.getLearnedRules('nesting')?.rules;
    return validateLearnedRuleSet(stored) ? stored : null;
  }

  /**
   * The asset identity ledger this project last wrote, validated (P0-9).
   *
   * `null` means the project has never compiled — or was last compiled by a
   * build older than schema v5 — and the next compile mints the ids. Both are
   * ordinary; what is not ordinary is a ledger that is *there* and unreadable,
   * which throws rather than degrading to `null`. Compiling past it would mint a
   * fresh id for every asset and orphan every decision recorded against the old
   * ones, which is the precise failure the ledger exists to prevent, so
   * `compileNow` turns the throw into a refusal the user can read.
   */
  function storedLedger(active: Session): AssetLedger | null {
    return active.store.getLedger(deserializeLedger)?.ledger ?? null;
  }

  function storedRelationshipOverrides(active: Session): readonly ManualRelationshipOverride[] {
    return active.store
      .listOverrides()
      .flatMap((stored): readonly ManualRelationshipOverride[] =>
        stored.kind === 'relationship' ? [stored.override] : [],
      );
  }

  function overrideRows(active: Session): readonly WireOverrideRow[] {
    const tagOf = (assetId: string): string => active.view?.tagOf(assetId) ?? '';
    return active.store.listOverrides().flatMap((stored): readonly WireOverrideRow[] => {
      if (stored.kind !== 'relationship') {
        return [];
      }
      const parentAssetId = stored.override.parentAssetId;
      return [
        {
          childAssetId: stored.override.childAssetId,
          childTag: tagOf(stored.override.childAssetId),
          parentAssetId: parentAssetId ?? '',
          parentTag: parentAssetId === null ? '' : tagOf(parentAssetId),
          note: stored.override.note ?? '',
          updatedAt: stored.updatedAt,
        },
      ];
    });
  }

  /** The newest decision per review key. Earlier ones are kept but not shown. */
  function decisionsByKey(active: Session): ReadonlyMap<string, { decision: WireDecisionValue; decidedAt: string; note: string }> {
    const latest = new Map<string, { decision: WireDecisionValue; decidedAt: string; note: string }>();
    for (const decision of active.store.listDecisions()) {
      latest.set(decision.reviewKey, {
        decision: decision.decision,
        decidedAt: decision.decidedAt,
        note: decision.note ?? '',
      });
    }
    return latest;
  }

  function undecidedCount(active: Session, view: CompileView): number {
    const decided = decisionsByKey(active);
    return view.reviewRows().filter((row) => !decided.has(row.reviewKey)).length;
  }

  /**
   * The file names of every source whose bytes no longer match the project.
   *
   * A compile is refused while any of these exist. Silently skipping them would
   * produce a register with a third of the edges missing; reading them anyway
   * would put content the project never recorded behind an approved compile id.
   *
   * Named `rawFileName (sourceId)` when two sources share a basename, because
   * "Level 1.nwc has changed" is not actionable in a project holding four of
   * them.
   */
  function changedSourceNames(active: Session): readonly string[] {
    const rows = active.store.listSources();
    const nameUses = new Map<string, number>();
    for (const source of rows) {
      nameUses.set(source.rawFileName, (nameUses.get(source.rawFileName) ?? 0) + 1);
    }

    const names: string[] = [];
    for (const source of rows) {
      if (active.details.get(source.sourceId)?.status !== 'file-changed') {
        continue;
      }
      names.push(
        (nameUses.get(source.rawFileName) ?? 0) > 1
          ? `${source.rawFileName} (${source.sourceId})`
          : source.rawFileName,
      );
    }
    return names;
  }

  /**
   * Every model source this project cannot read right now, and why.
   *
   * A compile over a universe with a hole in it is not a smaller compile — it
   * is a register that quietly lost a building. So the refusal names the
   * sources rather than dropping them, and it says which of "changed" and
   * "missing" each one is, because the fix differs: a changed file is re-added,
   * a missing one is found.
   *
   * A raw `.nwd` awaiting extraction is not in here. It has never contributed
   * to a compile, its status says so on screen 1, and refusing every compile
   * until milestone 5 lands would be a different product.
   */
  function unreadableModelSources(active: Session): readonly string[] {
    const blocked: string[] = [];
    for (const source of active.store.listSources()) {
      if (source.role !== 'model' || source.derivedCacheSha256 === null) {
        continue;
      }
      const status = active.details.get(source.sourceId)?.status;
      if (status === 'file-changed') {
        blocked.push(`${source.logicalName} has changed on disk`);
      } else if (status === 'file-missing') {
        blocked.push(`${source.logicalName} cannot be found on this machine`);
      } else if (!active.models.has(source.sourceId)) {
        blocked.push(`${source.logicalName} could not be opened`);
      }
    }
    return blocked;
  }

  function requireView(active: Session): CompileView {
    if (active.view === null) {
      throw new Error('Nothing has been compiled yet. Run Compile on screen 8 first.');
    }
    return active.view;
  }

  /**
   * Applies one config patch: to the table and to the live object, together.
   *
   * Both, always. `active.config` is what every compile reads, and the table is
   * what the next session reads; writing one without the other is how a project
   * comes back tomorrow configured differently from how it ran today.
   */
  function writeConfig(active: Session, patch: WireConfigPatch): WireProjectConfig {
    const updated = applyConfigPatch(active.config, patch);
    writeProjectConfig(active.store, updated);
    active.config = updated;
    return active.config;
  }

  /** The generated-MEL assets a stored compile row carries, or `null`. */
  function assetsOfCompile(active: Session, compileId: number): readonly GeneratedMelAsset[] | null {
    const record = active.store
      .listCompiles()
      .find((entry: CompileRecord): boolean => entry.compileId === compileId);
    if (record === undefined) {
      return null;
    }
    return storedAssetsOf(record);
  }

  /**
   * What a compile refuses to run over, or `null` when it may go ahead.
   *
   * Every one of these is a fact about the project rather than about the
   * engine, which is why they are settled in main before a worker is spawned:
   * a thread started only to be told there is no tag property is a thread
   * nobody needed.
   */
  function compileRefusal(active: Session): string | null {
    const changed = changedSourceNames(active);
    if (changed.length > 0) {
      return (
        `${changed.join(', ')} ${changed.length === 1 ? 'has' : 'have'} changed on disk since ` +
        'being added to this project, so compiling would use content this project has not ' +
        'recorded. Add the file again on screen 1, or remove the source.'
      );
    }
    const blocked = unreadableModelSources(active);
    if (blocked.length > 0) {
      return (
        `This project compiles from ${String(blocked.length)} model ` +
        `${blocked.length === 1 ? 'source' : 'sources'} it cannot read: ${blocked.join('; ')}. ` +
        'Compiling without them would produce a register missing everything they hold. ' +
        'Add each file again on screen 1, or remove the source.'
      );
    }
    if (active.models.size === 0) {
      return 'Add a model extraction cache on screen 1. Everything else is matched against it.';
    }
    if (!hasMappings(active.draft)) {
      return 'Pick the property that holds the equipment tag on screen 3 before compiling.';
    }
    return null;
  }

  /** Plain-language stage names, so main owns the wording the wire carries. */
  const STAGE_NOTES: Readonly<Record<CompileStage, string>> = {
    'asset-catalog': 'Reading the model and working out which objects are equipment.',
    'identity-ledger':
      'Matching this run to the asset ids the project already has.',
    properties: 'Reading every asset\u2019s properties out of its own model.',
    'stored-decisions': 'Re-addressing the manual decisions this project has recorded.',
    mel: 'Reading the master equipment list.',
    systems: 'Resolving a system for every asset.',
    'identity-index': 'Indexing tags, so foreign spellings can be matched.',
    connectivity: 'Reading the connectivity workbooks.',
    flow: 'Building the source-to-load projection.',
    claims: 'Assembling every relationship claim.',
    'derived-attributes': 'Resolving the attributes this site defines for itself.',
    snapshot: 'Walking the ladder and folding the boundaries.',
    projections: 'Arranging the level tree and writing the generated MEL.',
    review: 'Collecting everything that still needs a decision.',
  };

  /** The running status for a stage that has just started. */
  function runningStatus(stage: CompileStage | null): WireCompileStatus {
    if (stage === null) {
      return {
        state: 'running',
        stageIndex: 0,
        stageCount: COMPILE_STAGES.length,
        note: 'Starting the compile.',
      };
    }
    return {
      state: 'running',
      // One-based, and it counts stages *started*: a bar that showed 0 while
      // the first stage was running would sit still through the longest part
      // of a large compile.
      stageIndex: COMPILE_STAGES.indexOf(stage) + 1,
      stageCount: COMPILE_STAGES.length,
      note: STAGE_NOTES[stage],
    };
  }

  /**
   * Runs the whole pipeline on a worker thread and records what it produced.
   *
   * `compiles.profile_revision` is a foreign key into `profile`, so a compile
   * needs a saved revision to point at. Rather than refuse, an unsaved draft is
   * saved first with a note that says why — the alternative is a modal telling
   * the user to press a different button before the one they pressed.
   *
   * "Unsaved" here means `savedRevision === null`, which every draft mutation
   * sets. That is the whole point of the nulling: the recorded revision is the
   * one that produced this compile, never the one that happened to be saved
   * before the user changed something.
   *
   * ## The one write, and where it is
   *
   * Nothing durable happens until the worker has returned a project. The
   * compile row, the snapshot and the ledger go in together, in one
   * transaction, after the await — so a cancelled compile, a worker that died
   * and a compile that threw all leave the project file exactly as they found
   * it, and the workspace goes on showing the last compile that did finish.
   *
   * The auto-saved profile revision is the deliberate exception, and it is
   * taken before the compile because the compile has to be able to name it. A
   * cancelled run therefore leaves a spare revision behind; a revision is a row
   * and a visible line in the profile history, which is the same trade
   * `updateDraft` already makes.
   *
   * ## What may have changed while it ran
   *
   * A compile is now the one long-running thing a person can keep using the app
   * during. The project can be closed, another opened, a source removed, the
   * draft edited. So the result is only adopted if this is still the session
   * that asked for it and still the run it started; otherwise it is dropped,
   * because a view built from one project's compile and shown against another's
   * is worse than no view at all.
   */
  async function compileNow(active: Session): Promise<WireCompileStatus> {
    if (active.running !== null) {
      // Already running. Answering with the running status rather than starting
      // a second worker: two compiles of one project would race over the ledger
      // and over which `compiles` row is the newest.
      return active.compile;
    }

    const refusal = compileRefusal(active);
    if (refusal !== null) {
      return { state: 'failed', reason: refusal };
    }

    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();

    let profile: SiteProfileV2;
    let profileRevision: number;
    try {
      profile = toSiteProfile(active.draft);
      profileRevision =
        active.savedRevision ??
        active.store.saveProfile(profile, 'Saved automatically so this compile has a revision');
      active.savedRevision = profileRevision;
    } catch (error: unknown) {
      return { state: 'failed', reason: messageOf(error) };
    }

    let previousLedger: AssetLedger | null;
    try {
      previousLedger = storedLedger(active);
    } catch (error: unknown) {
      return {
        state: 'failed',
        reason:
          'This project carries an asset identity ledger that this build cannot read ' +
          `(${messageOf(error)}). Compiling would give every asset a new id and orphan every ` +
          'manual system, parent and review decision recorded against the old ones, so nothing ' +
          'was run. Open the project with the version of Matchline that wrote it, or restore ' +
          'the backup taken when it was last upgraded.',
      };
    }

    // The hierarchy the view is indexed against, taken now: the draft is the
    // user's to edit while the compile runs, and indexing the result against a
    // level stack it was not compiled with would mislabel every tree row.
    const hierarchy = active.draft.hierarchy;

    // Set BEFORE the first await, and this is the whole reason `RunningCompile`
    // exists: from here on `cancelCompile` has something to aim at and a second
    // `compile()` has something to see, even though the worker does not exist
    // yet.
    const marker: RunningCompile = { run: null, cancelRequested: false };
    active.running = marker;
    active.compile = runningStatus(null);

    /** Whether this call still owns the session's compile. */
    const stillMine = (): boolean => session === active && active.running === marker;
    /** Settles this run, if it is still the one the session is waiting on. */
    const settle = (status: WireCompileStatus): WireCompileStatus => {
      if (!stillMine()) {
        return active.compile;
      }
      active.running = null;
      active.compile = status;
      return status;
    };

    let sources: readonly CompileWorkerSource[];
    let connectivityWorkbooks: readonly ConnectivityWorkbookInput[];
    let melWorkbook: MelWorkbookInput | null;
    try {
      sources = workerSources(active);
      connectivityWorkbooks = await connectivityInputs(active);
      melWorkbook = await melInput(active);
    } catch (error: unknown) {
      // A workbook this machine can no longer read. Named rather than skipped.
      return settle({ state: 'failed', reason: messageOf(error) });
    }

    if (!stillMine()) {
      // The project was closed while its workbooks were being read, and closing
      // cancels. Nothing was started and nothing was written.
      return { state: 'cancelled' };
    }
    if (marker.cancelRequested) {
      // Stopped while its inputs were being read. The worker is never started,
      // which is the cheapest possible way to honour a cancellation.
      return settle({ state: 'cancelled' });
    }

    let run: CompileRun;
    try {
      run = startCompile(
        {
          sources,
          profile,
          connectivityWorkbooks,
          melWorkbook,
          learnedRules: storedNestingRules(active),
          manualRelationshipOverrides: storedRelationshipOverrides(active),
          previousLedger,
        },
        (stage: CompileStage): void => {
          if (stillMine() && !marker.cancelRequested) {
            active.compile = runningStatus(stage);
          }
        },
      );
    } catch (error: unknown) {
      // A thread that could not be started at all.
      return settle({ state: 'failed', reason: messageOf(error) });
    }
    marker.run = run;

    const outcome = await run.finished;

    if (!stillMine()) {
      // The project was closed while the worker ran, which cancels it. Whatever
      // it produced describes a project nobody is looking at, and it is dropped
      // rather than written.
      return { state: 'cancelled' };
    }

    if (outcome.kind === 'cancelled') {
      // The view is left exactly as it was: a cancelled compile is not a failed
      // one, and throwing away the workspace the user still has open would make
      // Stop more destructive than waiting.
      return settle({ state: 'cancelled' });
    }
    if (outcome.kind === 'failed') {
      active.view = null;
      return settle({ state: 'failed', reason: outcome.reason });
    }

    const project: CompiledProject = outcome.project;
    const finishedAtMs = Date.now();
    const finishedAt = new Date(finishedAtMs).toISOString();
    const view = createCompileView(project, hierarchy);

    // Keyed by `sourceId`, which is unique by construction — two sources of one
    // basename used to collapse into a single entry here, recording one hash
    // for two files.
    const inputHashes: Record<string, string> = {};
    for (const source of active.store.listSources()) {
      inputHashes[source.sourceId] = source.rawSha256;
    }

    // One transaction for all three, because they are one fact: this compile
    // happened, this is what it resolved, and these are the asset ids it minted.
    // A ledger committed without its compile would hand the next compile ids
    // nothing can date; a compile committed without its ledger would re-mint
    // every id on the next run and orphan every decision (P0-9).
    const compileId = active.store.withTransaction((): number => {
      const id = active.store.recordCompile({
        inputHashes,
        profileRevision,
        statsJson: {
          summary: project.stats,
          // See StoredCompileStats: the assets ride here because v1 has no
          // per-compile slot for them and the snapshot table holds one row.
          generatedMelAssets: view.assets,
        } satisfies StoredCompileStats,
        startedAt,
        finishedAt,
      });
      active.store.saveSnapshot(id, serializeSnapshot(project.snapshot));
      active.store.saveLedger(id, project.identityLedger);
      return id;
    });

    active.view = view;
    return settle({
      state: 'done',
      summary: view.summary({
        compileId,
        profileRevision,
        finishedAt,
        durationMs: finishedAtMs - startedAtMs,
        undecidedReviewItemCount: undecidedCount(active, view),
      }),
    });
  }

  /* ------------------------------------------------------------------- API */

  return {
    create(projectPath: string, name: string): WireProjectSummary {
      closeSession();
      // Checked here rather than left to the save dialog's overwrite prompt:
      // creating a project never overwrites, so a prompt offering to would
      // promise something that does not happen (dialog.ts).
      if (existsSync(projectPath)) {
        throw new Error(
          `There is already a file called ${path.basename(projectPath)} in that folder, and ` +
            'Matchline never writes over an existing file. Choose a different name or folder.',
        );
      }

      let store: ProjectStore;
      try {
        store = createProject(projectPath, { name, appVersion: options.appVersion });
      } catch (error: unknown) {
        throw new Error(`Matchline could not create that project: ${messageOf(error)}`);
      }
      const { session: active } = adopt(store, projectPath, defaultProjectConfig());
      session = active;
      rememberOpened(active);
      return summarize(active);
    },

    async open(projectPath: string, acceptMigration: boolean): Promise<OpenProjectResult> {
      closeSession();
      let store: ProjectStore;
      try {
        // Only migrate when the user has said so. An unanswered older file
        // comes back as `migration-needed` below, untouched.
        store = openProject(projectPath, { migrate: acceptMigration });
      } catch (error: unknown) {
        const refusal = openRefusal(error);
        if (refusal !== null) {
          return refusal;
        }
        throw new Error(`Matchline could not open that project: ${messageOf(error)}`);
      }
      const { config, adopted } = adoptConfig(store, projectPath);
      const { session: active, mergedLegacyConfig } = adopt(store, projectPath, config);
      session = active;
      // Recorded before the files are re-proved, because "this installation
      // opened this project" is true from here whatever the hashing finds.
      rememberOpened(active);
      // Awaited rather than left running: `open` answering before the project
      // knows which of its files are readable would hand the wizard a source
      // list it has to poll to find out. The hashing itself is off the loop,
      // which is the part that used to freeze the window.
      await rehydrateSources(active);
      if (session !== active) {
        // Something closed this project, or opened another, while its files
        // were being re-proved. Refused rather than answered: the summary below
        // would be read off a store that is already closed.
        throw new Error(
          `${path.basename(projectPath)} was closed while Matchline was checking its files. ` +
            'Open it again.',
        );
      }
      return {
        outcome: 'opened',
        project: summarize(active),
        notice: {
          migration: store.migration,
          adoptedAppStateConfig: adopted,
          mergedLegacyConfig,
        },
      };
    },

    close(): boolean {
      return closeSession();
    },

    current(): WireProjectSummary | null {
      return session === null ? null : summarize(session);
    },

    recentProjects(): readonly WireRecentProject[] {
      return appState.recentProjects().map((entry) => ({
        path: entry.path,
        name: entry.name,
        openedAt: entry.openedAt,
        missing: !existsSync(entry.path),
      }));
    },

    async addSources(paths: readonly string[]): Promise<readonly WireAddSourceResult[]> {
      const active = requireSession();
      const results: WireAddSourceResult[] = [];

      for (const candidate of paths) {
        const absolutePath = path.resolve(candidate);
        const fileName = path.basename(absolutePath);

        if (!existsSync(absolutePath)) {
          results.push({
            outcome: 'rejected',
            fileName,
            reason: `Matchline could not find ${fileName}.`,
          });
          continue;
        }

        const identification = identifySource(absolutePath);
        if (!identification.recognized) {
          results.push({ outcome: 'rejected', fileName, reason: identification.reason });
          continue;
        }

        // Streamed, never read whole: this is the one place a gigabyte-scale
        // model enters the app, and the window keeps drawing while it hashes.
        const digest = await digestFile(absolutePath);
        appState.rememberSourcePath(digest.sha256, absolutePath);

        for (const registration of identification.registrations) {
          const sourceId = sourceIdFor(
            active,
            registration.role,
            fileName,
            absolutePath,
            digest.sha256,
          );
          const existing = active.store.getSource(sourceId);
          active.store.upsertSourceV4({
            sourceId,
            role: registration.role,
            // The logical name and the added-at of an existing source are left
            // alone: the first is what a person calls this source and the
            // second is when the project took it on. Re-adding a file is
            // neither a rename nor a new registration.
            logicalName: existing?.logicalName ?? fileName,
            rawFileName: fileName,
            rawSha256: digest.sha256,
            rawByteSize: digest.byteSize,
            addedAt: existing?.addedAt ?? new Date().toISOString(),
            // A cache or a workbook IS the bytes the engine reads, so the file's
            // own hash is also the hash of what was derived from it. A raw
            // Navisworks file is not: it has no cache until the extraction
            // service produces one (P0-2), so the key is left out entirely and
            // `upsertSourceV4` records "no cache associated".
            ...(registration.needsExtraction ? {} : { derivedCacheSha256: digest.sha256 }),
          });
          active.details.set(sourceId, {
            absolutePath,
            status: registration.status,
            note: registration.note,
            sheets: registration.sheets,
            cachePath: null,
          });

          if (registration.needsExtraction) {
            // Adding a raw model IS asking for it to be extracted; there is no
            // second button, and the queue is what the row reports from here on
            // (P0-2). Re-adding a changed file lands on the same source id, so
            // this also supersedes any run still going for the old bytes.
            extraction?.enqueue({
              sourceId,
              fileName,
              inputPath: absolutePath,
              rawSha256: digest.sha256,
              rawByteSize: digest.byteSize,
            });
          }

          const stored = active.store.getSource(sourceId);
          if (stored !== undefined) {
            results.push({ outcome: 'added', source: summarizeSource(stored) });
          }
        }
      }

      syncModels(active);
      loadMelRows(active);
      return results;
    },

    extractionStatus(offset: number, limit: number): ExtractionStatusPage {
      const jobs = requireExtraction().jobs();
      return {
        total: jobs.length,
        active: jobs.some(
          (job: WireExtractionJob): boolean => job.cancellable,
        ),
        rows: jobs.slice(offset, offset + limit),
        extractionAvailable: capability.available,
        extractionUnavailableReason: capability.reason,
      };
    },

    extractionRunning(): boolean {
      // No project open is not "nothing is running" by accident: closing a
      // project shuts its queue down, so there is genuinely nothing to lose.
      return extraction !== null && extraction.jobs().some((job) => job.cancellable);
    },

    cancelExtraction(sourceId: string): boolean {
      return requireExtraction().cancel(sourceId);
    },

    extractionIdle(): Promise<void> {
      return extraction === null ? Promise.resolve() : extraction.whenIdle();
    },

    listSources(): readonly WireSourceSummary[] {
      return requireSession().store.listSources().map(summarizeSource);
    },

    removeSource(sourceId: string): boolean {
      const active = requireSession();
      // Before the row goes: an extraction still running for a source that no
      // longer exists would have nothing to associate its cache with, and
      // would go on holding a Navisworks open to produce it.
      extraction?.forget(sourceId);
      const removed = active.store.removeSource(sourceId);
      active.details.delete(sourceId);
      // Both, unconditionally: which role the row held is no longer knowable
      // once it is gone, and both reconcilers are no-ops when nothing changed.
      syncModels(active);
      loadMelRows(active);
      return removed;
    },

    modelUniverse(): WireModelUniverse | null {
      const active = requireSession();
      const models = orderedModels(active);
      if (models.length === 0) {
        return null;
      }

      // Read off the aggregated catalog rather than summed per source: two
      // sources carrying `Dragon Data > Tag` are ONE property on screen 2, and
      // a total that said two would not be the length of the list below it.
      const catalog = universeCatalog(active);
      const perSourcePropertyCount = new Map<string, number>();
      for (const entry of catalog) {
        for (const sourceId of entry.bySource.keys()) {
          perSourcePropertyCount.set(sourceId, (perSourcePropertyCount.get(sourceId) ?? 0) + 1);
        }
      }

      const sources: WireModelScan[] = models.map((model) => ({
        sourceId: model.sourceId,
        displayName: model.displayName,
        rawFileName: model.rawFileName,
        objectCount: model.objectCount,
        propertyNameCount: perSourcePropertyCount.get(model.sourceId) ?? 0,
        sourceModels: [...model.sourceModels],
        extractedAtUtc: model.extractedAtUtc,
        navisworksVersion: model.navisworksVersion,
        warningCount: model.warningCount,
      }));

      return {
        sourceCount: sources.length,
        objectCount: sources.reduce((total, source) => total + source.objectCount, 0),
        propertyNameCount: catalog.length,
        warningCount: sources.reduce((total, source) => total + source.warningCount, 0),
        sources,
      };
    },

    propertyPage(request: PropertyPageRequest): PropertyPageResult {
      const active = requireSession();
      if (active.models.size === 0) {
        return { total: 0, rows: [] };
      }
      return catalogPage(universeCatalog(active), modelLabels(active), request);
    },

    classList(): readonly WireClassCount[] {
      const active = requireSession();
      // Summed across the universe: a class filter is a decision about the
      // project, and a count from whichever cache opened first would understate
      // what excluding it removes.
      const counts = new Map<string, number>();
      for (const model of active.models.values()) {
        for (const entry of model.classes) {
          counts.set(entry.className, (counts.get(entry.className) ?? 0) + entry.objectCount);
        }
      }
      return [...counts.entries()]
        .map(([className, objectCount]) => ({ className, objectCount }))
        .sort((left, right) =>
          left.objectCount === right.objectCount
            ? left.className.localeCompare(right.className)
            : right.objectCount - left.objectCount,
        );
    },

    cacheHandleIds(): ReadonlyMap<string, number> {
      const active = requireSession();
      return new Map([...active.models].map(([sourceId, model]) => [sourceId, model.handleId]));
    },

    draftState(): DraftState {
      if (session === null) {
        return { draft: null, savedRevision: null };
      }
      return { draft: session.draft, savedRevision: session.savedRevision };
    },

    /**
     * Writes one or more sections and marks the draft unsaved.
     *
     * The revision is dropped even when the patch happens to be a no-op: the
     * cheap comparison would be a deep one over five sections, and a spare
     * revision costs a row, while a missed one mislabels a compile.
     */
    updateDraft(patch: WireDraftPatch): WireDraftProfile {
      const active = requireSession();
      active.draft = applyPatch(active.draft, patch);
      active.savedRevision = null;
      return active.draft;
    },

    saveProfile(note: string): SaveProfileResult {
      const active = requireSession();
      if (!hasMappings(active.draft)) {
        throw new Error(
          'Pick the property that holds the equipment tag on screen 3 before saving. ' +
            'Everything else can be filled in later.',
        );
      }

      // Checked here rather than only on screen 9, because screen 9 is not the
      // only way in: Quick Setup, an imported profile package and a headless
      // call all reach this method, and a gate that lived in the renderer would
      // be a gate one of them walks around.
      const blockers = publishBlockersFor(active);
      const blocked = blockers[0];
      if (blocked !== undefined) {
        throw new Error(blocked.message);
      }

      let profile: SiteProfileV2;
      try {
        profile = toSiteProfile(active.draft);
      } catch (error: unknown) {
        throw new Error(`This profile is not ready to save: ${messageOf(error)}`);
      }

      const revision = active.store.saveProfile(profile, note === '' ? undefined : note);
      active.savedRevision = revision;

      const saved = active.store
        .listProfileRevisions()
        .find((entry) => entry.revision === revision);
      return { revision, savedAt: saved?.savedAt ?? active.store.meta().modifiedAt };
    },

    assetPreview(): WireAssetPreview {
      const active = requireSession();
      if (active.models.size === 0) {
        return {
          state: 'blocked',
          reason: 'Add a model extraction cache on screen 1 to see which objects become assets.',
        };
      }
      if (!hasMappings(active.draft)) {
        return {
          state: 'blocked',
          reason: 'Choose the property that holds the equipment tag to see the inclusion impact.',
        };
      }
      return buildAssetPreview(requireDerived(active).catalog, modelLabels(active));
    },

    anatomyPreview(): WireAnatomyPreview {
      const active = requireSession();
      if (active.models.size === 0 || !hasMappings(active.draft)) {
        return {
          state: 'blocked',
          reason: 'Finish screen 3 first — the anatomy is previewed against your real asset tags.',
        };
      }
      if (!hasAnatomy(active.draft)) {
        return {
          state: 'blocked',
          reason: 'Add at least one segment below to see it run against every tag in the model.',
        };
      }
      return buildAnatomyPreview(active.draft.tagAnatomy, requireDerived(active).catalog);
    },

    resolverPreview(): WireResolverPreview {
      const active = requireSession();
      if (active.models.size === 0 || !hasMappings(active.draft)) {
        return {
          state: 'blocked',
          reason: 'Finish screen 3 first — systems are resolved for the assets it defines.',
        };
      }
      if (!hasResolver(active.draft)) {
        return {
          state: 'blocked',
          reason: 'Add at least one System Key source below to see what it resolves.',
        };
      }
      const derived = requireDerived(active);
      return buildResolverPreview(
        active.draft.systemResolver,
        active.draft.tagAnatomy,
        derived.subjects,
        derived.catalog,
        active.melRows,
      );
    },

    derivedPreview(definition: WireDerivedAttribute): WireDerivedPreview {
      const active = requireSession();
      if (active.models.size === 0 || !hasMappings(active.draft)) {
        return {
          state: 'blocked',
          reason:
            'Finish screen 3 first — a derived attribute is resolved for the assets it defines.',
        };
      }
      const derived = requireDerived(active);
      // The System Resolver's answers, because a `system-field` rung reads them
      // (P0-7). Computed here rather than cached: the definition being edited
      // changes on every keystroke and the resolution does not, but a project
      // whose resolver is unconfigured resolves nothing at all and the map is
      // empty either way.
      const systems = resolveSystemMap(
        active.draft.systemResolver,
        active.draft.tagAnatomy,
        derived.subjects,
        active.melRows,
      );
      const contexts = derivedSubjectsFor(
        derived.catalog,
        derived.subjects,
        toTagAnatomy(active.draft.tagAnatomy),
        systems,
      );
      return buildDerivedPreview(definition, contexts, indexMelByTag(active.melRows));
    },

    assignmentPreview(rule: WireSourceAssignmentRule): WireAssignmentPreview {
      const active = requireSession();
      return buildAssignmentPreview(
        rule,
        assignmentDocuments(active),
        [...active.models.values()].reduce((total, model) => total + model.objectCount, 0),
      );
    },

    /* ---------------------------------------------------------- quick setup */

    quickSetupSuggestions(): WireQuickSetupSuggestions {
      const active = requireSession();
      const hierarchy = { levels: [...DEFAULT_HIERARCHY_LEVELS] };

      if (active.models.size === 0) {
        return {
          ready: false,
          blockedReason:
            'Add a model on screen 1 first. Every suggestion below is read out of the model ' +
            'you loaded, so there is nothing to propose until there is one.',
          objectCount: 0,
          sourceCount: 0,
          fields: [],
          anatomy: null,
          resolverTemplates: [],
          classes: [],
          hierarchy,
        };
      }

      const catalog = universeCatalog(active);
      const fields = suggestFields(catalog);

      // The anatomy and the class proposals both need real tags, which need a
      // tag mapping. Before one is accepted they are honestly absent rather
      // than guessed from a property nobody chose.
      const tags = hasMappings(active.draft) ? catalogTagsOf(active) : [];
      const anatomy = inferAnatomy(tags);

      const systemProperty =
        fields
          .find(
            (field) =>
              field.target.kind === 'derived-attribute' &&
              field.target.attributeId === 'system-upn',
          )
          ?.candidates[0]?.property ?? null;

      return {
        ready: true,
        blockedReason: '',
        objectCount: [...active.models.values()].reduce(
          (total, model) => total + model.objectCount,
          0,
        ),
        sourceCount: active.models.size,
        fields: [...fields],
        anatomy,
        resolverTemplates: [
          ...resolverTemplates({
            hasSystemSegment:
              anatomy !== null ||
              active.draft.tagAnatomy.segments.some((row) => row.segment === 'system'),
            hasMel: active.melRows.length > 0,
            systemProperty,
          }),
        ],
        classes: [...classSuggestions(active)],
        hierarchy,
      };
    },

    resolverTemplatePreview(resolver: WireSystemResolver): WireResolverPreview {
      const active = requireSession();
      if (active.models.size === 0 || !hasMappings(active.draft)) {
        return {
          state: 'blocked',
          reason: 'Choose the equipment tag property first — systems resolve for assets.',
        };
      }
      const derived = requireDerived(active);
      return buildResolverPreview(
        resolver,
        active.draft.tagAnatomy,
        derived.subjects,
        derived.catalog,
        active.melRows,
      );
    },

    /* ----------------------------------------------------- screens 6 and 7 */

    attributeChoices(): readonly WireAttributeChoice[] {
      const active = session;
      // The site's own derived attributes belong in the same menu as the
      // built-ins (P0-7): a level addresses either one the same way, so a
      // Composer that offered only the built-ins would leave a configured
      // attribute unreachable.
      return attributeChoices(
        active === null ? null : distinctAttributeValues(active),
        active === null ? [] : active.draft.derivedAttributes,
      );
    },

    config(): WireProjectConfig {
      return requireSession().config;
    },

    /**
     * Writes the screens 6-7 sections to the project file, then to memory.
     *
     * That order matters: a write that fails leaves the session showing what
     * the file actually holds, rather than an in-memory configuration the next
     * compile would use and the file would not have.
     *
     * The profile revision is untouched — the config is not part of the Site
     * Profile, is stored in its own table, and is passed to every compile
     * live from memory, so it cannot go stale the way the revision could.
     */
    updateConfig(patch: WireConfigPatch): WireProjectConfig {
      return writeConfig(requireSession(), patch);
    },

    /**
     * Distinct `role` segments over every catalog tag.
     *
     * Read through the taught anatomy rather than guessed from the tag text:
     * a role is whatever screen 4 says it is, and a second opinion here would
     * offer the user pairings the compiler could never match.
     */
    roleValues(): readonly string[] {
      const active = requireSession();
      const anatomy = toTagAnatomy(active.draft.tagAnatomy);
      if (anatomy === null || active.models.size === 0 || !hasMappings(active.draft)) {
        return [];
      }
      const roles = new Set<string>();
      for (const asset of requireDerived(active).catalog.assets) {
        if (asset.canonicalTag === '') {
          continue;
        }
        const result = applyAnatomy(anatomy, asset.canonicalTag);
        if (result.matched) {
          const role = result.segments.role;
          if (role !== undefined && role !== '') {
            roles.add(role);
          }
        }
      }
      return [...roles].sort();
    },

    disciplineValues(): readonly string[] {
      const active = requireSession();
      if (active.models.size === 0 || !hasMappings(active.draft)) {
        return [];
      }
      const disciplines = new Set<string>();
      for (const asset of requireDerived(active).catalog.assets) {
        const discipline = asset.nativeDiscipline?.trim();
        if (discipline !== undefined && discipline !== '') {
          disciplines.add(discipline);
        }
      }
      return [...disciplines].sort();
    },

    trainLearnedRules(kind: WireLearnedRuleKind, filePath: string): WireLearnedSummary {
      const active = requireSession();
      if (!existsSync(filePath)) {
        throw new Error(`Matchline could not find ${path.basename(filePath)}.`);
      }
      const savedAt = new Date().toISOString();

      if (kind === 'nesting') {
        const trained = trainNestingFrom(filePath, savedAt);
        active.store.saveLearnedRules('nesting', trained.rules);
        return trained.summary;
      }
      if (kind === 'wbs') {
        const trained = trainWbsFrom(filePath, savedAt);
        active.store.saveLearnedRules('wbs', trained.table);
        return trained.summary;
      }
      const trained = trainItemMastersFrom(filePath, savedAt);
      active.store.saveLearnedRules('item-master', trained.table);
      return trained.summary;
    },

    learnedSummaries(): readonly WireLearnedSummary[] {
      const active = requireSession();
      const summaries: WireLearnedSummary[] = [];
      for (const kind of ['nesting', 'item-master', 'wbs'] as const) {
        const record = active.store.getLearnedRules(kind);
        if (record === undefined) {
          continue;
        }
        const summary = summarizeStored(kind, record.rules, record.savedAt);
        if (summary !== null) {
          summaries.push(summary);
        }
      }
      return summaries;
    },

    /* ------------------------------------------------------------ screen 8 */

    compile(): Promise<WireCompileStatus> {
      return compileNow(requireSession());
    },

    cancelCompile(): boolean {
      const marker = session?.running ?? null;
      if (marker === null) {
        return false;
      }
      // The flag first, the worker second: a Stop that lands before the worker
      // has been spawned has to be honoured by never spawning it, and the flag
      // is the only thing that can carry that.
      marker.cancelRequested = true;
      marker.run?.cancel();
      return true;
    },

    compileStatus(): WireCompileStatus {
      return session?.compile ?? { state: 'never-run' };
    },

    compileIssues(
      kind: WireCompileIssueKind,
      offset: number,
      limit: number,
    ): Page<WireCompileIssueRow> {
      return requireView(requireSession()).issues(kind, offset, limit);
    },

    compileLedgerEvents(offset: number, limit: number): Page<WireLedgerEvent> {
      return requireView(requireSession()).ledgerEvents(offset, limit);
    },

    compileHistory(): readonly WireCompileHistoryEntry[] {
      const active = requireSession();
      return active.store.listCompiles().map((record: CompileRecord): WireCompileHistoryEntry => {
        const assets = storedAssetsOf(record);
        return {
          compileId: record.compileId,
          profileRevision: record.profileRevision,
          finishedAt: record.finishedAt,
          assetCount: assets?.length ?? 0,
          diffable: assets !== null,
        };
      });
    },

    /* ----------------------------------------------------------- workspace */

    treeChildren(nodeKey: string, offset: number, limit: number): WireTreePage {
      const page = requireView(requireSession()).treeChildren(nodeKey, offset, limit);
      return { total: page.total, rows: [...page.rows] };
    },

    treeSearch(query: string, limit: number): readonly WireTreeNode[] {
      return requireView(requireSession()).treeSearch(query, limit);
    },

    reparentPreview(childAssetId: string, parentAssetId: string | null): WireReparentPreview {
      return requireView(requireSession()).reparentPreview(childAssetId, parentAssetId);
    },

    /**
     * A drag becomes a persistent override, never a tree-local edit (§11.5).
     *
     * The tree the user is looking at does not move until the next compile,
     * and that is deliberate: the override is one input to a ladder walk, and
     * showing its effect before running the walk would be a second, weaker
     * implementation of the compiler drawn on top of the real one.
     */
    setRelationshipOverride(
      childAssetId: string,
      parentAssetId: string | null,
      note: string,
    ): readonly WireOverrideRow[] {
      const active = requireSession();
      const override: { childAssetId: string; parentAssetId: string | null; note?: string } = {
        childAssetId,
        parentAssetId,
      };
      if (note.trim() !== '') {
        override.note = note.trim();
      }
      active.store.setRelationshipOverride(override);
      return overrideRows(active);
    },

    listRelationshipOverrides(): readonly WireOverrideRow[] {
      return overrideRows(requireSession());
    },

    removeRelationshipOverride(childAssetId: string): boolean {
      const active = requireSession();
      return active.store.removeOverride('relationship', childAssetId);
    },

    flowRoots(offset: number, limit: number): Page<WireFlowRoot> {
      return requireView(requireSession()).flowRoots(offset, limit);
    },

    flowWalk(rootNodeId: string, offset: number, limit: number): Page<WireFlowNode> {
      return requireView(requireSession()).flowWalk(rootNodeId, offset, limit);
    },

    reviewPage(kind: string, offset: number, limit: number): WireReviewPage {
      const active = requireSession();
      const view = requireView(active);
      const decided = decisionsByKey(active);

      const all: WireReviewRow[] = view.reviewRows().map((row): WireReviewRow => {
        const decision = decided.get(row.reviewKey);
        return decision === undefined
          ? row
          : {
              ...row,
              decision: decision.decision,
              decidedAt: decision.decidedAt,
              note: decision.note,
            };
      });

      const counts = new Map<string, number>();
      for (const row of all) {
        counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
      }

      const filtered = kind === '' ? all : all.filter((row) => row.kind === kind);
      return {
        total: filtered.length,
        rows: filtered.slice(offset, offset + limit),
        kinds: [...counts.entries()]
          .map(([name, count]) => ({ kind: name, count }))
          .sort((left, right) => (left.kind < right.kind ? -1 : 1)),
        undecidedCount: all.filter((row) => row.decision === null).length,
      };
    },

    recordDecision(reviewKey: string, decision: WireDecisionValue, note: string): boolean {
      const active = requireSession();
      const input: {
        reviewKey: string;
        decision: WireDecisionValue;
        note?: string;
        decidedAt: string;
      } = { reviewKey, decision, decidedAt: new Date().toISOString() };
      if (note.trim() !== '') {
        input.note = note.trim();
      }
      active.store.recordDecision(input);
      return true;
    },

    /* ---------------------------------------------- exports and packages */

    exportGeneratedMel(filePath: string): WireExportResult {
      return exportGeneratedMel(requireView(requireSession()).project, filePath);
    },

    analyzeTemplate(filePath: string): WireTemplateAnalysis {
      requireSession();
      if (!existsSync(filePath)) {
        throw new Error(`Matchline could not find ${path.basename(filePath)}.`);
      }
      return analyzeMelTemplate(readFileSync(filePath), filePath);
    },

    exportTemplateMel(
      filePath: string,
      bindings: readonly WireTemplateBinding[],
    ): WireExportResult {
      return exportTemplateMel(requireView(requireSession()).assets, bindings, filePath);
    },

    captureExtoTemplate(filePath: string): WireProjectConfig {
      const active = requireSession();
      if (!existsSync(filePath)) {
        throw new Error(`Matchline could not find ${path.basename(filePath)}.`);
      }
      const template = analyzeExtoTemplateFile(readFileSync(filePath), path.basename(filePath));
      return writeConfig(active, { extoTemplate: template });
    },

    clearExtoTemplate(): WireProjectConfig {
      return writeConfig(requireSession(), { extoTemplate: null });
    },

    exportExto(filePath: string): WireExportResult {
      const active = requireSession();
      const view = requireView(active);
      return exportExto(
        view.project,
        view.assets,
        {
          itemMasterTable: readItemMasterTable(
            active.store.getLearnedRules('item-master')?.rules,
          ),
          wbsTable: readWbsTable(active.store.getLearnedRules('wbs')?.rules),
          nestingRules: readLearnedRules(active.store.getLearnedRules('nesting')?.rules),
          // The live config, not a re-read: `updateConfig` keeps it current and
          // a compile already runs against this same object.
          template: readExtoTemplate(active.config.extoTemplate),
        },
        filePath,
      );
    },

    exportPredecessors(filePath: string): WireExportResult {
      return exportPredecessors(requireView(requireSession()).project, filePath);
    },

    exportRevisionDiff(filePath: string, previousCompileId: number): WireExportResult {
      const active = requireSession();
      const view = requireView(active);
      const previous = assetsOfCompile(active, previousCompileId);
      if (previous === null) {
        return {
          written: false,
          reason:
            `Compile ${String(previousCompileId)} did not store the register it produced, ` +
            'so there is nothing to compare against. Compile again and the next diff will work.',
        };
      }
      return exportRevisionDiff(previous, view.assets, filePath);
    },

    profileSections(): readonly WireProfileSection[] {
      const active = requireSession();
      return describeSections(active.draft);
    },

    publishBlockers(): readonly WirePublishBlocker[] {
      return publishBlockersFor(requireSession());
    },

    exportProfilePackage(filePath: string): WireExportResult {
      const active = requireSession();
      return writePackage(
        active.draft,
        active.config,
        options.appVersion,
        new Date().toISOString(),
        filePath,
      );
    },

    importProfilePackage(filePath: string): {
      draft: WireDraftProfile;
      config: WireProjectConfig;
    } {
      const active = requireSession();
      // A v1 package is migrated on the way in rather than refused; `readPackage`
      // is where that happens, so nothing below has two shapes to handle.
      const imported = readPackage(filePath);
      // The project keeps its own identity: a package is a set of rules, not a
      // rename. Everything else is adopted whole. The project's own captured
      // EXTO template is untouched — a package carries none, by design.
      active.draft = {
        ...imported.profile,
        profileId: active.draft.profileId,
        name: active.draft.name,
      };
      // A wholesale replacement of the draft, so the stored revision is no
      // longer what is in memory (see Session.savedRevision).
      active.savedRevision = null;
      active.derived = null;
      active.view = null;
      active.compile = { state: 'never-run' };
      return { draft: active.draft, config: active.config };
    },

    suggestExportName(suffix: string, extension: string): string {
      return defaultExportName(requireSession().projectPath, suffix, extension);
    },
  };
}
