import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import {
  buildAssetCatalog,
  buildUniversePropertyCatalog,
  type AssetCatalog,
  type UniversePropertyCatalogEntry,
} from '@matchline/asset-catalog';
import type { AssetLedger } from '@matchline/asset-identity';
import {
  subjectPropertiesFor,
  type CompiledProject,
  type ConnectivityWorkbookInput,
  type MelWorkbookInput,
} from '@matchline/compiler';
import type { ManualRelationshipOverride, SiteProfileV2 } from '@matchline/domain';
import { validateLearnedRuleSet, type LearnedRuleSet } from '@matchline/learned-rules';
import type { GeneratedMelAsset } from '@matchline/mel-export';
import {
  openExtractionCache,
  type ExtractionCache,
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
  WireAssetPreview,
  WireAttributeChoice,
  WireClassCount,
  WireCompileHistoryEntry,
  WireCompileIssueKind,
  WireCompileIssueRow,
  WireCompileStatus,
  WireConfigPatch,
  WireDecisionValue,
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
  WireRecentProject,
  WireReparentPreview,
  WireResolverPreview,
  WireReviewPage,
  WireReviewRow,
  WireSheetSummary,
  WireSourceModelSummary,
  WireSourceStatus,
  WireSourceSummary,
  WireTemplateAnalysis,
  WireTemplateBinding,
  WireTreeNode,
  WireTreePage,
} from '../../shared/schemas.js';

import { createAppStateStore, type AppStateStore } from './app-store.js';
import {
  createCompileView,
  runCompile,
  type CompileSource,
  type CompileView,
  type Page,
} from './compile-service.js';
import {
  applyPatch,
  emptyDraft,
  fromSiteProfile,
  hasAnatomy,
  hasMappings,
  hasResolver,
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
import { buildAnatomyPreview, buildAssetPreview, buildResolverPreview } from './previews.js';
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
  digestFile,
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
  open(projectPath: string, acceptMigration: boolean): OpenProjectResult;
  close(): boolean;
  current(): WireProjectSummary | null;
  recentProjects(): readonly WireRecentProject[];

  addSources(paths: readonly string[]): readonly WireAddSourceResult[];
  listSources(): readonly WireSourceSummary[];
  /** Removes one registered source by id. Names cannot be used: they repeat. */
  removeSource(sourceId: string): boolean;

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

  compile(): WireCompileStatus;
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
}

/** One open model source: its cache handle and the object scan over it. */
interface ModelState {
  readonly sourceId: string;
  readonly displayName: string;
  readonly rawFileName: string;
  /** What this handle was opened for. A change here is a different file. */
  readonly cacheSha256: string;
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
function bytesStillMatch(absolutePath: string, expectedSha256: string): boolean {
  try {
    return digestFile(absolutePath).sha256 === expectedSha256;
  } catch {
    return false;
  }
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

export function createProjectService(options: ProjectServiceOptions): ProjectService {
  const appState: AppStateStore = createAppStateStore(options.userDataDir);
  let session: Session | null = null;
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
   */
  function rehydrateSources(active: Session): void {
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
        });
        continue;
      }

      if (!bytesStillMatch(knownPath, source.rawSha256)) {
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
        });
        continue;
      }

      const identification = identifySource(knownPath);
      if (!identification.recognized) {
        active.details.set(source.sourceId, {
          absolutePath: knownPath,
          status: 'needs-attention',
          note: identification.reason,
          sheets: [],
        });
        continue;
      }

      const registration = identification.registrations.find(
        (candidate: SourceRegistration): boolean => candidate.role === source.role,
      );
      if (registration === undefined) {
        continue;
      }
      active.details.set(source.sourceId, {
        absolutePath: knownPath,
        status: registration.status,
        note: registration.note,
        sheets: registration.sheets,
      });
    }

    syncModels(active);
    loadMelRows(active);
  }

  /* -------------------------------------------------------- model universe */

  /**
   * The extraction cache a model source is currently readable through, or
   * `null` when it is not readable at all.
   *
   * A raw `.nwd` answers `null` today — it is registered but has no cache until
   * the extraction service (P0-2, milestone 5) has produced one, which is what
   * its `requires-windows-extraction` status says on screen 1. Everything else
   * uses the source's own recorded cache hash, so "the file this handle was
   * opened for" is a fact the session can compare against later.
   */
  function readableCacheOf(
    active: Session,
    source: ProjectSource,
  ): { readonly absolutePath: string; readonly cacheSha256: string } | null {
    if (source.role !== 'model' || source.derivedCacheSha256 === null) {
      return null;
    }
    const detail = active.details.get(source.sourceId);
    if (detail === undefined || detail.status !== 'ready' || detail.absolutePath === '') {
      return null;
    }
    return { absolutePath: detail.absolutePath, cacheSha256: source.derivedCacheSha256 };
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
      active.models.set(sourceId, describeModel(target.source, target.cacheSha256, cache));
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

  /** The universe as `@matchline/compiler` and `@matchline/asset-catalog` take it. */
  function compileSources(active: Session): readonly CompileSource[] {
    return orderedModels(active).map((model) => ({
      sourceId: model.sourceId,
      cache: model.cache,
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
    const sources = compileSources(active);
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
    if (session === null) {
      return false;
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
  function connectivityInputs(active: Session): readonly ConnectivityWorkbookInput[] {
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
        bytes: readFileSync(detail.absolutePath),
        sourceFile: source.rawFileName,
      });
    }
    return inputs;
  }

  /** The MEL the compile builds its System Catalog from, or `null`. */
  function melInput(active: Session): MelWorkbookInput | null {
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
      const bytes = readFileSync(detail.absolutePath);
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
   * Runs the whole pipeline and records it.
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
   */
  function compileNow(active: Session): WireCompileStatus {
    const changed = changedSourceNames(active);
    if (changed.length > 0) {
      return {
        state: 'failed',
        reason:
          `${changed.join(', ')} ${changed.length === 1 ? 'has' : 'have'} changed on disk since ` +
          'being added to this project, so compiling would use content this project has not ' +
          'recorded. Add the file again on screen 1, or remove the source.',
      };
    }
    const blocked = unreadableModelSources(active);
    if (blocked.length > 0) {
      return {
        state: 'failed',
        reason:
          `This project compiles from ${String(blocked.length)} model ` +
          `${blocked.length === 1 ? 'source' : 'sources'} it cannot read: ${blocked.join('; ')}. ` +
          'Compiling without them would produce a register missing everything they hold. ' +
          'Add each file again on screen 1, or remove the source.',
      };
    }
    if (active.models.size === 0) {
      return {
        state: 'failed',
        reason: 'Add a model extraction cache on screen 1. Everything else is matched against it.',
      };
    }
    if (!hasMappings(active.draft)) {
      return {
        state: 'failed',
        reason: 'Pick the property that holds the equipment tag on screen 3 before compiling.',
      };
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

    let project: CompiledProject;
    try {
      project = runCompile({
        sources: compileSources(active),
        profile,
        connectivityWorkbooks: connectivityInputs(active),
        melWorkbook: melInput(active),
        learnedRules: storedNestingRules(active),
        manualRelationshipOverrides: storedRelationshipOverrides(active),
        previousLedger,
      });
    } catch (error: unknown) {
      active.view = null;
      const status: WireCompileStatus = { state: 'failed', reason: messageOf(error) };
      active.compile = status;
      return status;
    }

    const finishedAtMs = Date.now();
    const finishedAt = new Date(finishedAtMs).toISOString();
    const view = createCompileView(project, active.draft.hierarchy);

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
    const status: WireCompileStatus = {
      state: 'done',
      summary: view.summary({
        compileId,
        profileRevision,
        finishedAt,
        durationMs: finishedAtMs - startedAtMs,
        undecidedReviewItemCount: undecidedCount(active, view),
      }),
    };
    active.compile = status;
    return status;
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

    open(projectPath: string, acceptMigration: boolean): OpenProjectResult {
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
      rehydrateSources(active);
      rememberOpened(active);
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

    addSources(paths: readonly string[]): readonly WireAddSourceResult[] {
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

        const digest = digestFile(absolutePath);
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
            ...(registration.status === 'requires-windows-extraction'
              ? {}
              : { derivedCacheSha256: digest.sha256 }),
          });
          active.details.set(sourceId, {
            absolutePath,
            status: registration.status,
            note: registration.note,
            sheets: registration.sheets,
          });

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

    listSources(): readonly WireSourceSummary[] {
      return requireSession().store.listSources().map(summarizeSource);
    },

    removeSource(sourceId: string): boolean {
      const active = requireSession();
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
        active.draft,
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

    compile(): WireCompileStatus {
      return compileNow(requireSession());
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
