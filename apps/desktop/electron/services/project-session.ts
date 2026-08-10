import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { buildAssetCatalog, type AssetCatalog } from '@matchline/asset-catalog';
import {
  subjectPropertiesFor,
  type CompiledProject,
  type ConnectivityWorkbookInput,
  type MelWorkbookInput,
} from '@matchline/compiler';
import type { ManualRelationshipOverride, SiteProfile } from '@matchline/domain';
import { validateLearnedRuleSet, type LearnedRuleSet } from '@matchline/learned-rules';
import type { GeneratedMelAsset } from '@matchline/mel-export';
import {
  buildPropertyCatalog,
  openExtractionCache,
  type ExtractionCache,
  type PropertyCatalogEntry,
  type SourceModelNode,
} from '@matchline/model-schema';
import {
  ProjectStoreError,
  createProject,
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
  WireModelScan,
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
  MODEL_SOURCE_ID,
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
  defaultProjectConfig,
  readProjectConfig,
  writeProjectConfig,
} from './project-config.js';
import { describeSections, readPackage, writePackage } from './profile-package.js';
import { catalogPage, type PropertyPageRequest } from './property-page.js';
import {
  digestFile,
  identifySource,
  melSheetDescriptor,
  readMelCatalogRows,
  roleLabel,
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
 * ## Derived state and when it is thrown away
 *
 * - The **extraction cache handle** and its **Property Catalog** belong to the
 *   model source. They are built when a model becomes available and released
 *   when the project closes or the model source is removed.
 * - The **asset catalog** and the **resolver subjects** depend on the draft, so
 *   they are memoized against the exact mappings-and-filters they were built
 *   from and dropped the moment those change. Recomputing is correct but slow;
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
  removeSource(role: SourceRole, fileName: string): boolean;

  modelScan(): WireModelScan | null;
  propertyPage(request: PropertyPageRequest): PropertyPageResult;
  classList(): readonly WireClassCount[];

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

/** What identification learned about one registered source, kept in memory. */
interface SourceDetail {
  readonly absolutePath: string;
  readonly status: WireSourceStatus;
  readonly note: string;
  readonly sheets: readonly WireSheetSummary[];
}

/** The open model, plus the two full-cache scans screen 2 is made of. */
interface ModelState {
  readonly cache: ExtractionCache;
  readonly catalog: readonly PropertyCatalogEntry[];
  readonly classes: readonly WireClassCount[];
  readonly scan: WireModelScan;
}

/** The asset catalog and its subjects, tied to the config that produced them. */
interface DerivedAssets {
  readonly configKey: string;
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
  readonly details: Map<string, SourceDetail>;
  model: ModelState | null;
  melRows: readonly MelCatalogRow[];
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

function detailKey(role: SourceRole, fileName: string): string {
  return `${role} ${fileName}`;
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

  /* ------------------------------------------------------------- lifecycle */

  function requireSession(): Session {
    if (session === null) {
      throw new Error('No project is open. Create or open one first.');
    }
    return session;
  }

  function releaseModel(active: Session): void {
    if (active.model !== null) {
      active.model.cache.close();
      active.model = null;
    }
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
      hasModel: active.model !== null,
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
   * The screens 6-7 sections for a project that is being opened.
   *
   * Three cases, in order: the project file says what it is configured to; an
   * older build left the answer in this installation's state file, in which
   * case it is copied into the project once and taken out of the state file;
   * or nothing has been configured and the wizard opens on its defaults.
   *
   * The copy is deliberately not attempted for a project being *created*: a new
   * file at a path some deleted project once used would silently inherit its
   * configuration, which is a surprise nobody asked for.
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
    writeProjectConfig(store, legacy);
    return { config: legacy, adopted: true };
  }

  function adopt(store: ProjectStore, projectPath: string, config: WireProjectConfig): Session {
    const stored = store.getProfile();
    const active: Session = {
      store,
      projectPath,
      draft:
        stored === undefined
          ? emptyDraft(store.meta().projectName)
          : fromSiteProfile(stored.profile),
      config,
      savedRevision: stored?.revision ?? null,
      details: new Map<string, SourceDetail>(),
      model: null,
      melRows: [],
      derived: null,
      view: null,
      compile: { state: 'never-run' },
    };
    return active;
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
      const knownPath = appState.sourcePath(source.sha256);
      if (knownPath === undefined || !existsSync(knownPath)) {
        active.details.set(detailKey(source.role, source.fileName), {
          absolutePath: '',
          status: 'file-missing',
          note:
            `Matchline recorded ${source.fileName} but cannot find it on this machine. ` +
            'Add the file again to work with it.',
          sheets: [],
        });
        continue;
      }

      if (!bytesStillMatch(knownPath, source.sha256)) {
        active.details.set(detailKey(source.role, source.fileName), {
          absolutePath: '',
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
        active.details.set(detailKey(source.role, source.fileName), {
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
      active.details.set(detailKey(source.role, source.fileName), {
        absolutePath: knownPath,
        status: registration.status,
        note: registration.note,
        sheets: registration.sheets,
      });
    }

    loadModel(active);
    loadMelRows(active);
  }

  /* ----------------------------------------------------------------- model */

  /** Opens the first ready model source, if there is one. Idempotent. */
  function loadModel(active: Session): void {
    releaseModel(active);

    for (const source of active.store.listSources()) {
      if (source.role !== 'model') {
        continue;
      }
      const detail = active.details.get(detailKey(source.role, source.fileName));
      if (detail === undefined || detail.status !== 'ready' || detail.absolutePath === '') {
        continue;
      }

      let cache: ExtractionCache;
      try {
        cache = openExtractionCache(detail.absolutePath);
      } catch {
        continue;
      }
      active.model = describeModel(cache, source.fileName);
      return;
    }
  }

  function describeModel(cache: ExtractionCache, fileName: string): ModelState {
    const catalog = buildPropertyCatalog(cache);
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

    return {
      cache,
      catalog,
      classes,
      scan: {
        fileName,
        objectCount: cache.objectCount(),
        propertyNameCount: catalog.length,
        sourceModels,
        extractedAtUtc: meta.extractedAtUtc,
        navisworksVersion: meta.navisworksVersion,
        warningCount: cache.warnings().length,
      },
    };
  }

  /** Re-reads every MEL source. Screen 5's `mel-lookup` rungs join against these. */
  function loadMelRows(active: Session): void {
    const rows: MelCatalogRow[] = [];
    for (const source of active.store.listSources()) {
      if (source.role !== 'mel') {
        continue;
      }
      const detail = active.details.get(detailKey(source.role, source.fileName));
      if (detail === undefined || detail.absolutePath === '') {
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
   * The asset catalog for the current draft, rebuilt only when the mappings or
   * filters actually changed.
   *
   * @throws Error when there is no model, or no equipment tag property chosen.
   */
  function requireDerived(active: Session): DerivedAssets {
    const model = active.model;
    if (model === null) {
      throw new Error('Add a model extraction cache on screen 1 before previewing assets.');
    }

    const configKey = configKeyOf(active);
    const cached = active.derived;
    if (cached !== null && cached.configKey === configKey) {
      return cached;
    }

    const mappings = toPropertyMappings(active.draft.propertyMappings);
    const filters = toAssetFilters(active.draft.assetFilters);
    // The same universe of one the compile runs on, so the asset ids previewed
    // on screen 3 are the asset ids screen 8 reports.
    const sources = [{ sourceId: MODEL_SOURCE_ID, cache: model.cache }];
    const catalog = buildAssetCatalog(sources, mappings, filters);

    const subjects: ResolverSubject[] = catalog.assets.map((asset) => ({
      assetId: asset.assetId,
      canonicalTag: asset.canonicalTag,
      properties: subjectPropertiesFor(sources, asset, mappings.equipmentTag),
      sourceFile: model.scan.fileName,
      objectId: String(asset.objectIds[0] ?? 0),
    }));

    const derived: DerivedAssets = { configKey, catalog, subjects };
    active.derived = derived;
    return derived;
  }

  /* --------------------------------------------------------------- sources */

  function summarizeSource(source: ProjectSource): WireSourceSummary {
    const detail = session?.details.get(detailKey(source.role, source.fileName));
    return {
      role: source.role,
      fileName: source.fileName,
      sha256: source.sha256,
      byteSize: source.byteSize,
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
    releaseModel(session);
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
      const detail = active.details.get(detailKey(source.role, source.fileName));
      if (detail === undefined || detail.absolutePath === '' || !existsSync(detail.absolutePath)) {
        throw new Error(
          `Matchline cannot find ${source.fileName} on this machine, and it is a ` +
            `${roleLabel(source.role)} source this project compiles from. ` +
            'Add the file again on screen 1, or remove the source.',
        );
      }
      inputs.push({
        bytes: readFileSync(detail.absolutePath),
        sourceFile: source.fileName,
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
      const detail = active.details.get(detailKey(source.role, source.fileName));
      if (detail === undefined || detail.absolutePath === '' || !existsSync(detail.absolutePath)) {
        throw new Error(
          `Matchline cannot find ${source.fileName} on this machine, and it is the master ` +
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
        sourceFile: source.fileName,
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
   */
  function changedSourceNames(active: Session): readonly string[] {
    const names: string[] = [];
    for (const source of active.store.listSources()) {
      const detail = active.details.get(detailKey(source.role, source.fileName));
      if (detail?.status === 'file-changed') {
        names.push(source.fileName);
      }
    }
    return [...new Set(names)];
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
    if (active.model === null) {
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

    let profile: SiteProfile;
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

    let project: CompiledProject;
    try {
      project = runCompile({
        cache: active.model.cache,
        profile,
        config: active.config,
        connectivityWorkbooks: connectivityInputs(active),
        melWorkbook: melInput(active),
        learnedRules: storedNestingRules(active),
        manualRelationshipOverrides: storedRelationshipOverrides(active),
      });
    } catch (error: unknown) {
      active.view = null;
      const status: WireCompileStatus = { state: 'failed', reason: messageOf(error) };
      active.compile = status;
      return status;
    }

    const finishedAtMs = Date.now();
    const finishedAt = new Date(finishedAtMs).toISOString();
    const view = createCompileView(project, active.config);

    const inputHashes: Record<string, string> = {};
    for (const source of active.store.listSources()) {
      inputHashes[`${source.role}/${source.fileName}`] = source.sha256;
    }

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
      const active = adopt(store, projectPath, defaultProjectConfig());
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
      const active = adopt(store, projectPath, config);
      session = active;
      rehydrateSources(active);
      rememberOpened(active);
      return {
        outcome: 'opened',
        project: summarize(active),
        notice: { migration: store.migration, adoptedAppStateConfig: adopted },
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
          active.store.upsertSource({
            role: registration.role,
            fileName,
            sha256: digest.sha256,
            byteSize: digest.byteSize,
          });
          active.details.set(detailKey(registration.role, fileName), {
            absolutePath,
            status: registration.status,
            note: registration.note,
            sheets: registration.sheets,
          });

          const stored = active.store
            .listSources()
            .find(
              (row: ProjectSource): boolean =>
                row.role === registration.role && row.fileName === fileName,
            );
          if (stored !== undefined) {
            results.push({ outcome: 'added', source: summarizeSource(stored) });
          }
        }
      }

      loadModel(active);
      loadMelRows(active);
      return results;
    },

    listSources(): readonly WireSourceSummary[] {
      return requireSession().store.listSources().map(summarizeSource);
    },

    removeSource(role: SourceRole, fileName: string): boolean {
      const active = requireSession();
      const removed = active.store.removeSource(role, fileName);
      active.details.delete(detailKey(role, fileName));
      if (role === 'model') {
        loadModel(active);
      }
      if (role === 'mel') {
        loadMelRows(active);
      }
      return removed;
    },

    modelScan(): WireModelScan | null {
      return requireSession().model?.scan ?? null;
    },

    propertyPage(request: PropertyPageRequest): PropertyPageResult {
      const active = requireSession();
      if (active.model === null) {
        return { total: 0, rows: [] };
      }
      return catalogPage(active.model.catalog, active.model.scan.objectCount, request);
    },

    classList(): readonly WireClassCount[] {
      return requireSession().model?.classes ?? [];
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

      let profile: SiteProfile;
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
      if (active.model === null) {
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
      return buildAssetPreview(requireDerived(active).catalog);
    },

    anatomyPreview(): WireAnatomyPreview {
      const active = requireSession();
      if (active.model === null || !hasMappings(active.draft)) {
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
      if (active.model === null || !hasMappings(active.draft)) {
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
      return attributeChoices(active === null ? null : distinctAttributeValues(active));
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
      if (anatomy === null || active.model === null || !hasMappings(active.draft)) {
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
      if (active.model === null || !hasMappings(active.draft)) {
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
      return describeSections(active.draft, active.config);
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
      const imported = readPackage(filePath);
      // The project keeps its own identity: a package is a set of rules, not a
      // rename. Everything else is adopted whole.
      const draft = { ...imported.draft, profileId: active.draft.profileId, name: active.draft.name };
      writeProjectConfig(active.store, imported.config);
      active.draft = draft;
      active.config = imported.config;
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
