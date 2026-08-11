import { z } from 'zod';

/**
 * Wire schemas shared by the channel table, the main-process handlers and the
 * renderer (APP.md "IPC contract").
 *
 * ## Why these are not the domain types
 *
 * `@matchline/domain` describes a *published* Site Profile: `equipmentTag` is
 * required, optional sections are absent rather than empty. A wizard draft is
 * the same information mid-decision — no tag property picked yet, an anatomy
 * with no segments taught. Rather than smuggle a half-built profile through the
 * domain type, the wire uses shapes that can represent "not decided yet"
 * explicitly:
 *
 * - optional single values are `null`, never absent (`exactOptionalPropertyTypes`
 *   makes `T | undefined` and "absent" different things, and structured clone
 *   over IPC does not preserve the difference reliably);
 * - optional collections are `[]`;
 * - optional strings are `''`.
 *
 * `electron/services/draft-profile.ts` owns the one conversion between this
 * shape and the domain's, and it is the only place that conversion happens.
 *
 * This module may import nothing but `zod`. It is bundled into the sandboxed
 * preload, which can neither resolve workspace packages nor load `node:sqlite`.
 */

/* ---------------------------------------------------------------- primitives */

/**
 * Mirrors `SOURCE_ROLES` in `@matchline/project-store`. Restated rather than
 * imported because that package reaches `node:sqlite`; `electron/services/
 * sources.ts` asserts the two lists agree at compile time.
 */
export const SOURCE_ROLE_VALUES = [
  'model',
  'easypower',
  'cable-schedule',
  'pmd',
  'mel',
  'p6',
  'prior-ssm',
] as const;

export const sourceRoleSchema = z.enum(SOURCE_ROLE_VALUES);
export type WireSourceRole = z.infer<typeof sourceRoleSchema>;

/** Mirrors `SegmentName` in `@matchline/domain`. */
export const segmentNameSchema = z.enum(['role', 'system', 'unit', 'instance']);
export type WireSegmentName = z.infer<typeof segmentNameSchema>;

/** Mirrors `PropertyRef`: a Navisworks property is only addressable as a pair. */
export const propertyRefSchema = z.object({
  category: z.string(),
  name: z.string().min(1),
});
export type WirePropertyRef = z.infer<typeof propertyRefSchema>;

/* ------------------------------------------------------------ profile pieces */

/**
 * Mirrors `PropertyMappings`, with "not chosen yet" spelled `null`.
 *
 * The last three are register fields the model may already state. Mapped and
 * non-blank, they outrank the learned tables for that field; left `null`, the
 * learned tables answer, exactly as they did before these existed.
 *
 * They carry `.default(null)` because a draft or a profile package written by a
 * build that predates them has no key at all, and an absent key means precisely
 * what a `null` does — nobody mapped it. Without the default an older package
 * would be refused as malformed, which would be a lie about a file that is
 * perfectly good.
 */
export const propertyMappingsSchema = z.object({
  equipmentTag: propertyRefSchema.nullable(),
  description: propertyRefSchema.nullable(),
  equipmentType: propertyRefSchema.nullable(),
  building: propertyRefSchema.nullable(),
  nativeDiscipline: propertyRefSchema.nullable(),
  wbs: propertyRefSchema.nullable().default(null),
  itemMaster: propertyRefSchema.nullable().default(null),
  equipmentClassification: propertyRefSchema.nullable().default(null),
});
export type WirePropertyMappings = z.infer<typeof propertyMappingsSchema>;

/** Mirrors `AssetFilterConfig`, with absent lists spelled `[]`. */
export const assetFiltersSchema = z.object({
  includedClasses: z.array(z.string().min(1)),
  excludedClasses: z.array(z.string().min(1)),
  requireTagProperty: z.boolean(),
  acceptedTagPatterns: z.array(z.string().min(1)),
  selectionSetNames: z.array(z.string().min(1)),
  includedSourceModelFiles: z.array(z.string().min(1)),
  collapseComponents: z.boolean(),
  separatelyCommissionableClasses: z.array(z.string().min(1)),
});
export type WireAssetFilters = z.infer<typeof assetFiltersSchema>;

/** Mirrors `SegmentExtractor`. Token indices are 0-based, as in the engine. */
export const segmentExtractorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('alphaPrefix'), token: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('digitSuffix'), token: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('token'), token: z.number().int().nonnegative() }),
  z.object({
    kind: z.literal('tokenRange'),
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
  }),
  z.object({
    kind: z.literal('charRange'),
    token: z.number().int().nonnegative(),
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative(),
  }),
]);
export type WireSegmentExtractor = z.infer<typeof segmentExtractorSchema>;

/**
 * Mirrors `TagAnatomyConfig`.
 *
 * `segments` is a list rather than a partial record so the row order the user
 * sees is the order that round-trips, and so "no segments taught yet" is an
 * empty array instead of an object whose keys are all absent.
 */
export const tagAnatomySchema = z.object({
  separators: z.array(z.string().min(1)),
  ignoredSuffixes: z.array(z.string().min(1)),
  segments: z.array(
    z.object({ segment: segmentNameSchema, extractor: segmentExtractorSchema }),
  ),
  /** `''` means "not configured". */
  familyKeyTemplate: z.string(),
  /** `''` means "not configured". */
  localFamilyTemplate: z.string(),
});
export type WireTagAnatomy = z.infer<typeof tagAnatomySchema>;

/** Mirrors `NormalizationStep` (PRODUCT.md §5.5). */
export const normalizationStepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('trim') }),
  z.object({ kind: z.literal('uppercase') }),
  z.object({ kind: z.literal('stripPrefix'), prefix: z.string().min(1) }),
  z.object({
    kind: z.literal('padStart'),
    length: z.number().int().positive().max(64),
    fill: z.string().min(1).max(4),
  }),
  z.object({ kind: z.literal('alias'), from: z.string().min(1), to: z.string() }),
]);
export type WireNormalizationStep = z.infer<typeof normalizationStepSchema>;

/** Mirrors `SystemComponentConfig` (PRODUCT.md §5.2). */
export const systemComponentSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('model-field'), property: propertyRefSchema }),
  z.object({ kind: z.literal('tag-segment'), segment: segmentNameSchema }),
  z.object({
    kind: z.literal('mel-lookup'),
    joinBy: z.enum(['equipmentTag', 'systemKey']),
    returnField: z.enum(['systemKey', 'systemDescription']),
  }),
  z.object({ kind: z.literal('direct-column'), property: propertyRefSchema }),
  z.object({ kind: z.literal('composite'), template: z.string().min(1) }),
  z.object({ kind: z.literal('manual') }),
]);
export type WireSystemComponent = z.infer<typeof systemComponentSchema>;

/** Mirrors `SystemResolverConfig`. `labelTemplate: ''` means "use the default". */
export const systemResolverSchema = z.object({
  keyChain: z.array(systemComponentSchema),
  descriptionChain: z.array(systemComponentSchema),
  normalization: z.array(normalizationStepSchema),
  conflictPolicy: z.enum(['review', 'precedence']),
  labelTemplate: z.string(),
});
export type WireSystemResolver = z.infer<typeof systemResolverSchema>;

/**
 * The wizard draft as every build before SiteProfileV2 wrote it.
 *
 * Read-only, and read in exactly one place: the v1 profile package importer.
 * A v1 package is `{draft, config}` and "v1 imports migrate, never refused"
 * (RELEASE-1.0-PLAN), so the shape those files were written in has to stay
 * readable for as long as any site still has one — which is forever.
 */
export const legacyDraftProfileSchema = z.object({
  profileId: z.string().min(1),
  name: z.string().min(1),
  version: z.number().int().positive(),
  propertyMappings: propertyMappingsSchema,
  assetFilters: assetFiltersSchema,
  tagAnatomy: tagAnatomySchema,
  systemResolver: systemResolverSchema,
});
export type WireLegacyDraftProfile = z.infer<typeof legacyDraftProfileSchema>;

/* ------------------------------------------------------------------- project */

/** What the shell shows about the project that is currently open. */
export const projectSummarySchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  schemaVersion: z.number().int().nonnegative(),
  createdAt: z.string().min(1),
  modifiedAt: z.string().min(1),
  sourceCount: z.number().int().nonnegative(),
  /** Newest stored profile revision, or `null` when nothing has been saved. */
  savedRevision: z.number().int().positive().nullable(),
  /** Whether a model extraction cache is open and ready to scan. */
  hasModel: z.boolean(),
});
export type WireProjectSummary = z.infer<typeof projectSummarySchema>;

/** What a migration did to a project file on the way in (schema v2). */
export const projectMigrationSchema = z.object({
  fromVersion: z.number().int().positive(),
  toVersion: z.number().int().positive(),
  /** Where the untouched original was copied to. Shown, never cleaned up. */
  backupPath: z.string().min(1),
});
export type WireProjectMigration = z.infer<typeof projectMigrationSchema>;

/**
 * Everything opening a project had to do to it, as facts the UI can state.
 *
 * Separate from the summary because it is about this one open, not about the
 * project: reopening the same file a second time reports nothing here, and
 * `project:current` has nothing to report at all.
 */
export const openNoticeSchema = z.object({
  /** Set when the file was upgraded from an older schema version. */
  migration: projectMigrationSchema.nullable(),
  /**
   * True when the screens 6-7 sections were copied out of this installation's
   * app-state file and into the project, which happens at most once per project.
   */
  adoptedAppStateConfig: z.boolean(),
  /**
   * True when this open moved the hierarchy, relationships and rules out of the
   * project's `config` table and into a new profile revision (SiteProfileV2).
   *
   * At most once per project, and only for a project written before the
   * consolidation. The revision it wrote carries a note saying so.
   */
  mergedLegacyConfig: z.boolean().default(false),
});
export type WireOpenNotice = z.infer<typeof openNoticeSchema>;

/**
 * What opening a project produced: the project, or a question first.
 *
 * A file written by an older build is **not** upgraded on sight. Upgrading
 * rewrites the only copy of a site's decisions, so it is an answered question
 * rather than a side effect of double-clicking (docs/APP.md: "v1→v2 migration
 * runs only with explicit opt-in"). `migration-needed` carries the two version
 * numbers the confirm card states; the second call sends `acceptMigration`.
 *
 * `backup-blocked` is the one thing the user has to fix outside Matchline: an
 * earlier upgrade attempt left a backup at that exact path, and overwriting it
 * would destroy the evidence it was taken for.
 */
export const projectOpenResultSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('opened'),
    project: projectSummarySchema,
    notice: openNoticeSchema,
  }),
  z.object({
    outcome: z.literal('migration-needed'),
    migrationNeeded: z.object({
      fromVersion: z.number().int().positive(),
      toVersion: z.number().int().positive(),
    }),
  }),
  z.object({
    outcome: z.literal('backup-blocked'),
    backupPath: z.string().min(1),
  }),
]);
export type WireProjectOpenResult = z.infer<typeof projectOpenResultSchema>;

export const recentProjectSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1),
  openedAt: z.string().min(1),
  /** True when the file is no longer where it was. Shown, never auto-pruned. */
  missing: z.boolean(),
});
export type WireRecentProject = z.infer<typeof recentProjectSchema>;

/* ------------------------------------------------------------------- sources */

/**
 * How usable a registered source is right now.
 *
 * `requires-windows-extraction` is not an error: a raw `.nwd` has to go through
 * the Navisworks extractor on Windows (docs/WINDOWS-RUNBOOK.md) before Matchline
 * can read it, and Mac development works from the produced cache files directly.
 *
 * `file-changed` is deliberately distinct from `file-missing`. The file is right
 * where it was, but its bytes no longer hash to what the project recorded, so it
 * is a *different* file wearing the same name — the one case where reading it
 * would quietly compile numbers nobody approved.
 */
export const sourceStatusSchema = z.enum([
  'ready',
  'requires-windows-extraction',
  'needs-attention',
  'file-missing',
  'file-changed',
]);
export type WireSourceStatus = z.infer<typeof sourceStatusSchema>;

/** One recognized sheet inside a workbook source. */
export const sheetSummarySchema = z.object({
  sheet: z.string(),
  kind: z.string().min(1),
  confidence: z.string().min(1),
  /** 1-based worksheet row carrying the headers; `0` when none was found. */
  headerRow: z.number().int().nonnegative(),
  mappedColumnCount: z.number().int().nonnegative(),
});
export type WireSheetSummary = z.infer<typeof sheetSummarySchema>;

/**
 * One registered source, as the renderer sees it. Summary only — no rows, no
 * objects, no cached tables cross IPC (APP.md "IPC contract").
 *
 * Keyed by `sourceId`, never by file name: a project may hold two files called
 * `Level 1.nwc` and both are real (P0-1, hard gate 4). `rawFileName` is what
 * the file called itself and is not unique; `logicalName` is what a person
 * calls this source and starts equal to it.
 */
export const sourceSummarySchema = z.object({
  sourceId: z.string().min(1),
  role: sourceRoleSchema,
  logicalName: z.string().min(1),
  rawFileName: z.string().min(1),
  rawSha256: z.string().length(64),
  rawByteSize: z.number().int().nonnegative(),
  /**
   * The hash of the extraction cache derived from this file, or `null` when
   * none has been associated — which is what a raw `.nwd` is until the
   * extraction service has run (P0-2).
   */
  derivedCacheSha256: z.string().length(64).nullable(),
  addedAt: z.string().min(1),
  status: sourceStatusSchema,
  /** One plain-language line about what this file is and what happens next. */
  note: z.string(),
  sheets: z.array(sheetSummarySchema),
});
export type WireSourceSummary = z.infer<typeof sourceSummarySchema>;

/** Adding a file either registers it or explains why it was not registered. */
export const addSourceResultSchema = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('added'), source: sourceSummarySchema }),
  z.object({
    outcome: z.literal('rejected'),
    fileName: z.string().min(1),
    reason: z.string().min(1),
  }),
]);
export type WireAddSourceResult = z.infer<typeof addSourceResultSchema>;

/* --------------------------------------------------------------- model scan */

export const sourceModelSummarySchema = z.object({
  sourceModelId: z.number().int().nonnegative().nullable(),
  fileName: z.string(),
  objectCount: z.number().int().nonnegative(),
});
export type WireSourceModelSummary = z.infer<typeof sourceModelSummarySchema>;

/** What one open model source's cache contains. One row of the universe. */
export const modelScanSchema = z.object({
  sourceId: z.string().min(1),
  /** What a person calls this source. */
  displayName: z.string().min(1),
  /** The file the cache was registered from. Never unique across sources. */
  rawFileName: z.string().min(1),
  objectCount: z.number().int().nonnegative(),
  propertyNameCount: z.number().int().nonnegative(),
  sourceModels: z.array(sourceModelSummarySchema),
  extractedAtUtc: z.string(),
  navisworksVersion: z.string(),
  warningCount: z.number().int().nonnegative(),
});
export type WireModelScan = z.infer<typeof modelScanSchema>;

/**
 * Every ready model source, and the universe totals over them (P0-1).
 *
 * `propertyNameCount` is the count of distinct `(category, name)` pairs across
 * the whole universe, which is smaller than the sum of the per-source counts
 * whenever two sources carry the same property — the number screen 2's Property
 * Catalog is actually a list of.
 */
export const modelUniverseSchema = z.object({
  sourceCount: z.number().int().nonnegative(),
  objectCount: z.number().int().nonnegative(),
  propertyNameCount: z.number().int().nonnegative(),
  warningCount: z.number().int().nonnegative(),
  sources: z.array(modelScanSchema),
});
export type WireModelUniverse = z.infer<typeof modelUniverseSchema>;

/**
 * The roles Screen 2 is willing to *suggest*.
 *
 * Name-based only, and shown to the user as a suggestion (PRODUCT.md §6.5: the
 * user can map any property regardless of what Matchline suggested). The richer
 * signals §6.5 lists — value shape, tag overlap, per-source consistency — are
 * not here and must not be implied by this field.
 */
export const suggestedRoleSchema = z.enum(['equipment-tag', 'building', 'description']);
export type WireSuggestedRole = z.infer<typeof suggestedRoleSchema>;

/**
 * How much of one model source carries one property.
 *
 * Overall coverage and per-source coverage are different facts and neither can
 * be derived from the other (P0-1): 60% overall reads one way when every source
 * is at 60% and quite another when one is at 100% and the next at 0% — and the
 * second is the case where a person has a file to go and fix.
 */
export const propertySourceCoverageSchema = z.object({
  sourceId: z.string().min(1),
  /** The short name the disclosure prints, derived from the source id in main. */
  label: z.string().min(1),
  objectCount: z.number().int().nonnegative(),
  /** `objectCount` over this source's own object count, 0..1. */
  coverage: z.number(),
});
export type WirePropertySourceCoverage = z.infer<typeof propertySourceCoverageSchema>;

export const propertyCatalogRowSchema = z.object({
  category: z.string(),
  name: z.string(),
  objectCount: z.number().int().nonnegative(),
  /** `objectCount / totalObjects`, 0..1. Across the whole universe. */
  coverage: z.number(),
  distinctValueCount: z.number().int().nonnegative(),
  /** Up to three, first-seen in source-id then object order. */
  examples: z.array(z.string()),
  suggestedRole: suggestedRoleSchema.nullable(),
  /**
   * Coverage per model source, in source-id order. One entry per source that
   * carries the property at all; a source absent from this list is at zero,
   * which is exactly the disclosure a coordinator needs.
   */
  bySource: z.array(propertySourceCoverageSchema),
});
export type WirePropertyCatalogRow = z.infer<typeof propertyCatalogRowSchema>;

export const propertySortSchema = z.enum(['coverage', 'name', 'distinct']);
export type WirePropertySort = z.infer<typeof propertySortSchema>;

export const classCountSchema = z.object({
  className: z.string().min(1),
  objectCount: z.number().int().nonnegative(),
});
export type WireClassCount = z.infer<typeof classCountSchema>;

/* ------------------------------------------------------------ asset preview */

/** One stage of PRODUCT.md §6.6 filtering, with its plain-language label. */
export const filterStageSchema = z.object({
  stage: z.string().min(1),
  label: z.string().min(1),
  inCount: z.number().int().nonnegative(),
  droppedCount: z.number().int().nonnegative(),
  outCount: z.number().int().nonnegative(),
});
export type WireFilterStage = z.infer<typeof filterStageSchema>;

export const sampleAssetSchema = z.object({
  assetId: z.string().min(1),
  canonicalTag: z.string(),
  description: z.string(),
  equipmentType: z.string(),
  building: z.string(),
  objectCount: z.number().int().positive(),
  status: z.string().min(1),
  /** Which model source this asset was read from. */
  sourceId: z.string().min(1),
});
export type WireSampleAsset = z.infer<typeof sampleAssetSchema>;

/**
 * The same inclusion impact for one source (P0-1).
 *
 * "42 objects left" is not actionable in a universe: the first question is
 * which file they left, and that is the only question this answers. No
 * duplicate count — a duplicated tag is a fact about the universe, and a
 * per-source number would read as "this file has duplicates" when the other
 * claimant is in another file entirely.
 */
export const sourceImpactSchema = z.object({
  sourceId: z.string().min(1),
  label: z.string().min(1),
  totalObjects: z.number().int().nonnegative(),
  collapsedCount: z.number().int().nonnegative(),
  finalAssetCount: z.number().int().nonnegative(),
  untaggedDroppedCount: z.number().int().nonnegative(),
});
export type WireSourceImpact = z.infer<typeof sourceImpactSchema>;

export const assetPreviewSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('blocked'), reason: z.string().min(1) }),
  z.object({
    state: z.literal('ready'),
    totalObjects: z.number().int().nonnegative(),
    stages: z.array(filterStageSchema),
    collapsedCount: z.number().int().nonnegative(),
    finalAssetCount: z.number().int().nonnegative(),
    duplicateTagCount: z.number().int().nonnegative(),
    untaggedDroppedCount: z.number().int().nonnegative(),
    samples: z.array(sampleAssetSchema),
    /** The same numbers per model source, in source-id order. */
    bySource: z.array(sourceImpactSchema),
  }),
]);
export type WireAssetPreview = z.infer<typeof assetPreviewSchema>;

/* ---------------------------------------------------------- anatomy preview */

export const anatomySegmentValueSchema = z.object({
  segment: segmentNameSchema,
  /** `null` when this tag produced nothing for the segment. */
  value: z.string().nullable(),
});

export const anatomyExampleSchema = z.object({
  tag: z.string().min(1),
  normalizedTag: z.string(),
  segments: z.array(anatomySegmentValueSchema),
  familyKey: z.string(),
  localFamily: z.string(),
});
export type WireAnatomyExample = z.infer<typeof anatomyExampleSchema>;

export const anatomyMissSchema = z.object({
  tag: z.string(),
  reason: z.string().min(1),
  detail: z.string(),
  /** Why it missed, in words a commissioning engineer can act on. */
  explanation: z.string().min(1),
});
export type WireAnatomyMiss = z.infer<typeof anatomyMissSchema>;

export const anatomyPreviewSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('blocked'), reason: z.string().min(1) }),
  z.object({
    state: z.literal('ready'),
    total: z.number().int().nonnegative(),
    matchedCount: z.number().int().nonnegative(),
    coverage: z.number(),
    segmentStats: z.array(
      z.object({ segment: segmentNameSchema, distinctValueCount: z.number().int().nonnegative() }),
    ),
    examples: z.array(anatomyExampleSchema),
    misses: z.array(anatomyMissSchema),
    /** The tag every extractor row is demonstrated against. */
    sample: anatomyExampleSchema.nullable(),
  }),
]);
export type WireAnatomyPreview = z.infer<typeof anatomyPreviewSchema>;

/* --------------------------------------------------------- resolver preview */

export const rungUsageSchema = z.object({
  chain: z.enum(['keyChain', 'descriptionChain']),
  rungIndex: z.number().int().nonnegative(),
  kind: z.string().min(1),
  label: z.string().min(1),
  /** Assets whose answer came from this rung. */
  wonCount: z.number().int().nonnegative(),
  /** Assets where this rung produced a value at all, winning or losing. */
  claimCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
});
export type WireRungUsage = z.infer<typeof rungUsageSchema>;

export const resolvedSampleSchema = z.object({
  assetId: z.string().min(1),
  /** Which model source the subject was read from. */
  sourceId: z.string().min(1),
  canonicalTag: z.string(),
  systemKey: z.string(),
  systemDescription: z.string(),
  systemLabel: z.string(),
  /** Which rung supplied the key, in words. */
  keySource: z.string().min(1),
  conflictStatus: z.string().min(1),
});
export type WireResolvedSample = z.infer<typeof resolvedSampleSchema>;

export const systemConflictSchema = z.object({
  assetId: z.string().min(1),
  canonicalTag: z.string(),
  /** Every competing key, in chain order, with the rung that proposed it. */
  claims: z.array(z.object({ value: z.string(), source: z.string().min(1) })),
});
export type WireSystemConflict = z.infer<typeof systemConflictSchema>;

export const resolverPreviewSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('blocked'), reason: z.string().min(1) }),
  z.object({
    state: z.literal('ready'),
    subjectCount: z.number().int().nonnegative(),
    resolvedCount: z.number().int().nonnegative(),
    coverage: z.number(),
    describedCount: z.number().int().nonnegative(),
    conflictCount: z.number().int().nonnegative(),
    distinctSystemCount: z.number().int().nonnegative(),
    melRowCount: z.number().int().nonnegative(),
    rungUsage: z.array(rungUsageSchema),
    samples: z.array(resolvedSampleSchema),
    conflicts: z.array(systemConflictSchema),
    unresolvedExamples: z.array(z.string()),
  }),
]);
export type WireResolverPreview = z.infer<typeof resolverPreviewSchema>;

/* ============================================================ screen 6: the
 * hierarchy
 *
 * Mirrors `HierarchyConfig` / `HierarchyLevelConfig` in `@matchline/domain`.
 * The wire shape is identical because a level has no "undecided" state: every
 * field is answered the moment the level exists.
 *
 * One name differs. The engine calls a level's grouping attribute
 * `keyAttributeKey` (P0-6); screen 6, the stored project file and this schema
 * call it `attributeKey`, which is what it has always been called here and what
 * every project written before 1.0 spells it. `toHierarchyConfig` is the one
 * place the two meet. A row that arrives spelled the engine's way — an imported
 * profile package, a config written against the domain type — is lifted rather
 * than refused, so neither spelling can lose a project's levels.
 */

export const missingValuePolicySchema = z.enum([
  'unassigned-group',
  'review',
  'provisional-root',
]);
export type WireMissingValuePolicy = z.infer<typeof missingValuePolicySchema>;

export const levelSortSchema = z.enum(['label', 'key']);
export type WireLevelSort = z.infer<typeof levelSortSchema>;

/** Lifts a level that spells its key attribute the engine's way. */
function liftLevelKeySpelling(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  if (record['attributeKey'] !== undefined || record['keyAttributeKey'] === undefined) {
    return value;
  }
  const { keyAttributeKey, ...rest } = record;
  return { ...rest, attributeKey: keyAttributeKey };
}

export const hierarchyLevelSchema = z.preprocess(
  liftLevelKeySpelling,
  z.object({
    levelId: z.string().min(1),
    displayName: z.string().min(1),
    /** The level's KEY attribute: what it groups by, and what a boundary compares. */
    attributeKey: z.string().min(1),
    /** Optional: which attribute supplies the words. Never moves equipment (P0-6). */
    displayAttributeKey: z.string().min(1).optional(),
    /** Optional: which attribute the boundary compares, when it is not the key. */
    boundaryAttributeKey: z.string().min(1).optional(),
    boundary: z.boolean(),
    missingValuePolicy: missingValuePolicySchema,
    sort: levelSortSchema,
  }),
);
export type WireHierarchyLevel = z.infer<typeof hierarchyLevelSchema>;

export const hierarchyConfigSchema = z.object({
  levels: z.array(hierarchyLevelSchema),
});
export type WireHierarchyConfig = z.infer<typeof hierarchyConfigSchema>;

/**
 * One attribute a level can group by, with the plain-language name and the
 * example screen 6 shows for it.
 *
 * Sent from main rather than hardcoded in the renderer so the list is exactly
 * `@matchline/compiler`'s `ATTRIBUTE_KEYS` — a level naming anything else finds
 * no value and silently groups nothing.
 */
export const attributeChoiceSchema = z.object({
  attributeKey: z.string().min(1),
  label: z.string().min(1),
  what: z.string().min(1),
  example: z.string().min(1),
  /** Distinct values this attribute has across the compiled assets, if known. */
  distinctValueCount: z.number().int().nonnegative().nullable(),
});
export type WireAttributeChoice = z.infer<typeof attributeChoiceSchema>;

/* ==================================================== screen 7: relationships */

/** Mirrors `RoleRule`: taught pairings are directional, one rule each way. */
export const roleRuleSchema = z.object({
  parentRole: z.string().min(1),
  childRole: z.string().min(1),
});
export type WireRoleRule = z.infer<typeof roleRuleSchema>;

export const roleGraphSchema = z.object({ rules: z.array(roleRuleSchema) });
export type WireRoleGraph = z.infer<typeof roleGraphSchema>;

/** Mirrors `LadderSourceKind` (PRODUCT.md §11.1). */
export const ladderSourceSchema = z.enum([
  'manual',
  'explicit-model',
  'profile-lookup',
  'flow-family',
  'family-role',
  'learned-description',
  'prior-ssm',
  'model-tree',
]);
export type WireLadderSource = z.infer<typeof ladderSourceSchema>;

/** The walk order. A rung left out of `tiers` is disabled, exactly as in the engine. */
export const ladderConfigSchema = z.object({ tiers: z.array(ladderSourceSchema) });
export type WireLadderConfig = z.infer<typeof ladderConfigSchema>;

/**
 * One `nativeDiscipline -> ssmDiscipline` rewrite.
 *
 * A list of pairs rather than a record, so the row order the user sees is the
 * order that round-trips and a half-typed `from` cannot collide with another row.
 */
export const disciplineRewriteSchema = z.object({
  from: z.string().min(1),
  to: z.string(),
});
export type WireDisciplineRewrite = z.infer<typeof disciplineRewriteSchema>;

/**
 * The sections screens 6-7 configure.
 *
 * Deliberately separate from {@link draftProfileSchema}: `SiteProfile` in
 * `@matchline/domain` carries no hierarchy, role graph, ladder, discipline
 * projection or parent-tag property, and `@matchline/compiler` takes all five
 * on `CompileProjectInput` instead. The wire keeps them together in the shape a
 * profile section would eventually hold, so widening the domain type later is a
 * move, not a redesign.
 */
/**
 * A registry layout captured from the site's own workbook (`ExtoTemplate`).
 *
 * Mirrored loosely on purpose: the engine's `validateExtoTemplate` is the real
 * guard and it checks things a schema cannot, such as whether a binding's column
 * index is inside the captured header list. This shape is only what has to
 * survive IPC and the config table intact.
 */
export const extoTemplateSchema = z.object({
  version: z.literal(1),
  sheetName: z.string(),
  headers: z.array(z.string()),
  headerRowIndex: z.number().int().nonnegative(),
  matched: z.array(
    z.object({
      field: z.string().min(1),
      columnIndex: z.number().int().nonnegative(),
      match: z.enum(['exact', 'trimmed-case-insensitive']),
    }),
  ),
  capturedFrom: z.object({ label: z.string() }),
});
export type WireExtoTemplate = z.infer<typeof extoTemplateSchema>;

/* ============================================ derived attributes (P0-7) */

/**
 * Mirrors `PropertyChain`: an ordered fallback list of addresses (P0-8).
 *
 * A list, never a single ref, wherever a chain is what the engine takes. Screen
 * 3's own mappings stay single-ref on the wire — a `PropertyRef` is a legal
 * mapping input and the engine lifts it to one rung — but a derived attribute's
 * `model-property` rung IS a chain, so the wire spells it as one.
 */
export const propertyChainSchema = z.array(propertyRefSchema);
export type WirePropertyChain = z.infer<typeof propertyChainSchema>;

/**
 * Mirrors `AttributeResolver` (P0-7).
 *
 * `manual` carries a list of `{assetId, value}` pairs rather than the engine's
 * map: structured clone does not carry a `Map` reliably across IPC, and the
 * config table stores canonical JSON, which refuses one outright.
 */
export const attributeResolverSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('model-property'), chain: propertyChainSchema }),
  z.object({ kind: z.literal('tag-segment'), segment: segmentNameSchema }),
  z.object({ kind: z.literal('source-assignment'), key: z.string().min(1) }),
  z.object({
    kind: z.literal('system-field'),
    field: z.enum(['systemKey', 'systemDescription', 'systemLabel']),
  }),
  z.object({ kind: z.literal('composite'), template: z.string().min(1) }),
  z.object({
    kind: z.literal('mel-lookup'),
    joinBy: z.literal('equipmentTag'),
    returnField: z.string().min(1),
  }),
  z.object({
    kind: z.literal('manual'),
    assignments: z.array(z.object({ assetId: z.string().min(1), value: z.string() })),
  }),
]);
export type WireAttributeResolver = z.infer<typeof attributeResolverSchema>;

/**
 * Mirrors `DerivedAttributeDefinition` (P0-7).
 *
 * `attributeId` is only shape-checked here. Uniqueness and the collision with a
 * built-in attribute key are the compiler's `validateDerivedAttributes` to
 * refuse, because it is the one place that knows what the built-in keys are.
 */
export const derivedAttributeSchema = z.object({
  attributeId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  displayName: z.string().min(1),
  resolverChain: z.array(attributeResolverSchema),
});
export type WireDerivedAttribute = z.infer<typeof derivedAttributeSchema>;

/* ======================================= source assignment rules (P0-8) */

/** Mirrors `SourceAssignmentScope`. */
export const sourceAssignmentScopeSchema = z.enum([
  'source-model',
  'logical-source',
  'filename-pattern',
]);
export type WireSourceAssignmentScope = z.infer<typeof sourceAssignmentScopeSchema>;

/**
 * Mirrors `SourceAssignmentRule` (P0-8).
 *
 * `custom` is a list of pairs rather than the engine's map, for the reason
 * `attributeResolverSchema`'s `manual` is. `''` is a legal assigned value on
 * the wire and the engine drops it as blank, so a half-typed row cannot assign
 * an empty building to a whole file.
 */
export const sourceAssignmentRuleSchema = z.object({
  scope: sourceAssignmentScopeSchema,
  match: z.string().min(1),
  assign: z.object({
    building: z.string(),
    nativeDiscipline: z.string(),
    custom: z.array(z.object({ key: z.string().min(1), value: z.string() })),
  }),
});
export type WireSourceAssignmentRule = z.infer<typeof sourceAssignmentRuleSchema>;

/* ================================================= identity + carried notes */

/** Mirrors `TagAlias`: an evidence spelling and the canonical tag it means. */
export const tagAliasSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});
export type WireTagAlias = z.infer<typeof tagAliasSchema>;

/**
 * Mirrors `ProfileIdentityConfig` (P0-9).
 *
 * `fuzzyMaxDistance: 0` is the wire spelling of "use the engine's default": a
 * distance of zero would mean the fuzzy tier can only match identical strings,
 * which is what the exact tier above it already does.
 */
export const identityConfigSchema = z.object({
  tagNormalization: z.array(normalizationStepSchema),
  aliases: z.array(tagAliasSchema),
  fuzzyMaxDistance: z.number().int().nonnegative(),
});
export type WireIdentityConfig = z.infer<typeof identityConfigSchema>;

/** Mirrors `ParentPair`: a parent/child pair the site wrote down, as tags. */
export const parentPairSchema = z.object({
  childTag: z.string().min(1),
  parentTag: z.string().min(1),
});
export type WireParentPair = z.infer<typeof parentPairSchema>;

/** Mirrors `AuthorityRule`. Carried in the profile; not enforced by the engine. */
export const authorityRuleSchema = z.object({
  field: z.string().min(1),
  authority: z.enum(['model', 'mel', 'manual', 'learned']),
  note: z.string(),
});
export type WireAuthorityRule = z.infer<typeof authorityRuleSchema>;

/** Mirrors `ProfileTestExample`. Carried in the profile; nothing runs these. */
export const profileTestExampleSchema = z.object({
  description: z.string().min(1),
  expectation: z.string().min(1),
});
export type WireProfileTestExample = z.infer<typeof profileTestExampleSchema>;

/* ============================================================ the profile */

/**
 * The whole Site Profile the main process holds while the wizard runs.
 *
 * This is `SiteProfileV2` (`@matchline/domain`) with the wizard's "not decided
 * yet" states spelled out: a `null` where the domain has an absent optional, a
 * `[]` where it has an absent list, a `''` where it has an absent string. Every
 * section is always present. A section counts as *configured* when it carries a
 * decision — a non-null `equipmentTag`, a non-empty `segments`, a non-empty
 * `keyChain` — which is what decides whether it reaches the published profile.
 *
 * The sections below `systemResolver` are the ones that used to live in the
 * project's `config` table and arrive on `CompileProjectInput` separately. They
 * are here now because a site's rule set is one document (RELEASE-1.0-PLAN
 * "SiteProfileV2"); `project-config.ts` keeps only what belongs to the PROJECT.
 *
 * Every new section carries a default, because a draft rehydrated from a build
 * that predates the consolidation has no key for it and an absent key means
 * "this site configured none" — not "this file is unreadable".
 */
export const draftProfileSchema = z.object({
  profileId: z.string().min(1),
  name: z.string().min(1),
  version: z.number().int().positive(),

  propertyMappings: propertyMappingsSchema,
  sourceAssignments: z.array(sourceAssignmentRuleSchema).default([]),
  assetFilters: assetFiltersSchema,
  tagAnatomy: tagAnatomySchema,
  systemResolver: systemResolverSchema,
  derivedAttributes: z.array(derivedAttributeSchema).default([]),

  hierarchy: hierarchyConfigSchema.default({ levels: [] }),
  roleGraph: roleGraphSchema.default({ rules: [] }),
  ladder: ladderConfigSchema.default({ tiers: [] }),
  ssmDisciplineProjection: z.array(disciplineRewriteSchema).default([]),
  /** The model property naming an asset's parent, or `null` when unmapped. */
  parentTagProperty: propertyRefSchema.nullable().default(null),
  /** The site-wide asset number identity starts from, or `null` (P0-9). */
  stableIdProperty: propertyRefSchema.nullable().default(null),

  identityConfig: identityConfigSchema.default({
    tagNormalization: [],
    aliases: [],
    fuzzyMaxDistance: 0,
  }),
  profileLookup: z.array(parentPairSchema).default([]),
  priorSsm: z.array(parentPairSchema).default([]),
  authorityRules: z.array(authorityRuleSchema).default([]),
  profileTestExamples: z.array(profileTestExampleSchema).default([]),
});
export type WireDraftProfile = z.infer<typeof draftProfileSchema>;

/** A partial write from one wizard screen. Absent sections are left alone. */
export const draftPatchSchema = z.object({
  name: z.string().min(1).optional(),
  propertyMappings: propertyMappingsSchema.optional(),
  sourceAssignments: z.array(sourceAssignmentRuleSchema).optional(),
  assetFilters: assetFiltersSchema.optional(),
  tagAnatomy: tagAnatomySchema.optional(),
  systemResolver: systemResolverSchema.optional(),
  derivedAttributes: z.array(derivedAttributeSchema).optional(),
  hierarchy: hierarchyConfigSchema.optional(),
  roleGraph: roleGraphSchema.optional(),
  ladder: ladderConfigSchema.optional(),
  ssmDisciplineProjection: z.array(disciplineRewriteSchema).optional(),
  parentTagProperty: propertyRefSchema.nullable().optional(),
  stableIdProperty: propertyRefSchema.nullable().optional(),
  identityConfig: identityConfigSchema.optional(),
  profileLookup: z.array(parentPairSchema).optional(),
  priorSsm: z.array(parentPairSchema).optional(),
  authorityRules: z.array(authorityRuleSchema).optional(),
  profileTestExamples: z.array(profileTestExampleSchema).optional(),
});
export type WireDraftPatch = z.infer<typeof draftPatchSchema>;

/* ------------------------------------------------------- the project config */

/**
 * The sections a project's `config` table held before SiteProfileV2.
 *
 * Read-only, and read in exactly two places: the v1 profile package importer,
 * and the one-time merge that moves these rows into the profile when a project
 * written by an older build is opened. Nothing writes this shape any more.
 */
export const legacyProjectConfigSchema = z.object({
  // Every section is defaulted, without exception. A v1 config was widened three
  // times across schema versions 2, 3 and 6, so which keys a given file carries
  // depends on which build wrote it — and "v1 imports migrate, never refused"
  // does not have an exception for a package written before a section existed.
  // An absent section says nothing, and `mergeLegacyConfig` keeps whatever the
  // profile already stated rather than replacing it with that silence.
  hierarchy: hierarchyConfigSchema.default({ levels: [] }),
  roleGraph: roleGraphSchema.default({ rules: [] }),
  ladder: ladderConfigSchema.default({ tiers: [] }),
  ssmDisciplineProjection: z.array(disciplineRewriteSchema).default([]),
  parentTagProperty: propertyRefSchema.nullable().default(null),
  extoTemplate: extoTemplateSchema.nullable().default(null),
  derivedAttributes: z.array(derivedAttributeSchema).default([]),
  sourceAssignmentRules: z.array(sourceAssignmentRuleSchema).default([]),
});
export type WireLegacyProjectConfig = z.infer<typeof legacyProjectConfigSchema>;

/**
 * What is configuration of the PROJECT rather than of the site.
 *
 * One section, and it is the one the plan names: "Project-specific stays outside
 * (e.g. captured EXTO template)". Everything else this table used to hold is a
 * decision about how the site works, travels in the profile package, and lives
 * in {@link draftProfileSchema} now.
 */
export const projectConfigSchema = z.object({
  /**
   * The captured EXTO layout, or `null` when this project has captured none.
   *
   * Defaulted because a config written before template capture existed has no
   * key here, and that means "no template", not "unreadable".
   */
  extoTemplate: extoTemplateSchema.nullable().default(null),
});
export type WireProjectConfig = z.infer<typeof projectConfigSchema>;

/** A partial write from the exports view. */
export const configPatchSchema = z.object({
  extoTemplate: extoTemplateSchema.nullable().optional(),
});
export type WireConfigPatch = z.infer<typeof configPatchSchema>;

/* ------------------------------------------------------------ learned rules */

export const learnedRuleKindSchema = z.enum(['nesting', 'item-master', 'wbs']);
export type WireLearnedRuleKind = z.infer<typeof learnedRuleKindSchema>;

/** One trained class, as the training panel prints it. */
export const learnedGradeSchema = z.object({
  className: z.string(),
  predicted: z.number().int().nonnegative(),
  correct: z.number().int().nonnegative(),
  precision: z.number(),
  grade: z.string().min(1),
});
export type WireLearnedGrade = z.infer<typeof learnedGradeSchema>;

/**
 * What one training run learned, in numbers a reviewer can judge.
 *
 * `claimGradeCount` is the number that matters: a class only builds hierarchy
 * once it has proven itself (DECISIONS.md #3), and everything else is a
 * proposal for the review queue.
 */
export const learnedSummarySchema = z.object({
  kind: learnedRuleKindSchema,
  label: z.string(),
  savedAt: z.string(),
  rowCount: z.number().int().nonnegative(),
  /** Nesting: description classes. Item master: learned keys. */
  classCount: z.number().int().nonnegative(),
  /** Nesting: role gates. Item master: keys at or above the 0.9 gate. */
  gateCount: z.number().int().nonnegative(),
  affinityCount: z.number().int().nonnegative(),
  claimGradeCount: z.number().int().nonnegative(),
  proposalGradeCount: z.number().int().nonnegative(),
  /** Rows training refused to learn from, with the reason. */
  suspectRowCount: z.number().int().nonnegative(),
  grades: z.array(learnedGradeSchema),
});
export type WireLearnedSummary = z.infer<typeof learnedSummarySchema>;

/* ======================================================= screen 8: the compile */

/**
 * Where a compile is right now.
 *
 * `running` is honest rather than decorative: `compileProject` is synchronous
 * in the main process, so the renderer sets `running` itself when it asks and
 * replaces it with whatever main answers.
 */
export const compileStateSchema = z.enum(['never-run', 'running', 'done', 'failed']);
export type WireCompileState = z.infer<typeof compileStateSchema>;

/** One drill-down list screen 8's cards open. */
export const compileIssueKindSchema = z.enum([
  'assets',
  'flow-nodes',
  'demotions',
  'duplicate-tags',
  'ambiguous-parents',
  'cycles',
  'missing-systems',
  'system-conflicts',
  'unresolved-parents',
  'review-items',
]);
export type WireCompileIssueKind = z.infer<typeof compileIssueKindSchema>;

/** One row of any drill-down list. Deliberately one shape for all of them. */
export const compileIssueRowSchema = z.object({
  /** Stable within its list; the asset id, the tag, or a review key. */
  id: z.string().min(1),
  title: z.string().min(1),
  detail: z.string(),
  badge: z.string(),
});
export type WireCompileIssueRow = z.infer<typeof compileIssueRowSchema>;

/** Everything screen 8's checklist prints (PRODUCT.md §7 screen 8). */
export const compileSummarySchema = z.object({
  compileId: z.number().int().positive(),
  profileRevision: z.number().int().positive(),
  finishedAt: z.string().min(1),
  durationMs: z.number().int().nonnegative(),

  assetCount: z.number().int().nonnegative(),
  duplicateTagCount: z.number().int().nonnegative(),
  resolvedSystemCount: z.number().int().nonnegative(),
  missingSystemCount: z.number().int().nonnegative(),
  systemConflictCount: z.number().int().nonnegative(),

  flowNodeCount: z.number().int().nonnegative(),
  modelConfirmedCount: z.number().int().nonnegative(),
  flowOnlyCount: z.number().int().nonnegative(),
  pmdOnlyCount: z.number().int().nonnegative(),
  multiFeedNodeCount: z.number().int().nonnegative(),

  rootCount: z.number().int().nonnegative(),
  demotionCount: z.number().int().nonnegative(),
  ambiguousParentCount: z.number().int().nonnegative(),
  cycleCount: z.number().int().nonnegative(),
  unresolvedParentCount: z.number().int().nonnegative(),

  learnedProposalCount: z.number().int().nonnegative(),
  skippedClaimInputCount: z.number().int().nonnegative(),
  generatedMelRowCount: z.number().int().nonnegative(),
  reviewItemCount: z.number().int().nonnegative(),
  undecidedReviewItemCount: z.number().int().nonnegative(),

  /**
   * What the asset identity ledger did this compile (P0-9).
   *
   * One number per {@link ledgerEventSchema} kind, plus the orphaned decisions
   * that fell out of re-addressing stored decisions through it. A first compile
   * reports every asset as new and nothing else; an ordinary recompile of an
   * unchanged project reports zero across the board, which is the answer that
   * says identity held.
   */
  ledgerNewAssetCount: z.number().int().nonnegative(),
  ledgerTagChangedCount: z.number().int().nonnegative(),
  ledgerRematchedByTagCount: z.number().int().nonnegative(),
  ledgerSplitCount: z.number().int().nonnegative(),
  ledgerDisappearedCount: z.number().int().nonnegative(),
  /** Stored decisions the ledger could not re-address. They are review items. */
  orphanedDecisionCount: z.number().int().nonnegative(),
});
export type WireCompileSummary = z.infer<typeof compileSummarySchema>;

/**
 * One thing reconciliation did to one asset, as the identity log prints it.
 *
 * Mirrors `LedgerEvent` in `@matchline/asset-identity` with its optional fields
 * spelled `''`, which is this app's wire convention: a renderer that has to tell
 * `undefined` from a missing key to decide whether to draw a cell is a renderer
 * that will eventually get it wrong.
 */
export const ledgerEventSchema = z.object({
  /** `new-asset`, `tag-changed`, `rematched-by-tag`, `split` or `disappeared`. */
  kind: z.string().min(1),
  assetId: z.string().min(1),
  /** The tag after this compile. `''` when the asset carries none. */
  tag: z.string(),
  /** `tag-changed` only: the spelling that became an alias. `''` otherwise. */
  previousTag: z.string(),
  /** Which evidence tier tied this compile to the previous ledger. `''` if new. */
  tier: z.string(),
  /** One line a person can read. Written by the engine, not by the app. */
  detail: z.string().min(1),
});
export type WireLedgerEvent = z.infer<typeof ledgerEventSchema>;

export const compileStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('never-run') }),
  z.object({ state: z.literal('running') }),
  z.object({ state: z.literal('done'), summary: compileSummarySchema }),
  z.object({ state: z.literal('failed'), reason: z.string().min(1) }),
]);
export type WireCompileStatus = z.infer<typeof compileStatusSchema>;

/** One entry of the compile history, for the revision-diff picker. */
export const compileHistoryEntrySchema = z.object({
  compileId: z.number().int().positive(),
  profileRevision: z.number().int().positive(),
  finishedAt: z.string().min(1),
  assetCount: z.number().int().nonnegative(),
  /** Whether this compile stored the generated-MEL assets a diff needs. */
  diffable: z.boolean(),
});
export type WireCompileHistoryEntry = z.infer<typeof compileHistoryEntrySchema>;

/* ==================================================== workspace: the SSM tree */

export const treeNodeKindSchema = z.enum(['level', 'asset']);
export type WireTreeNodeKind = z.infer<typeof treeNodeKindSchema>;

/**
 * One row of the SSM tree.
 *
 * `nodeKey` addresses the row for a children-of request; it is opaque to the
 * renderer, which never constructs one. `''` is the root.
 */
export const treeNodeSchema = z.object({
  nodeKey: z.string().min(1),
  kind: treeNodeKindSchema,
  label: z.string().min(1),
  /** The level's display name, or the asset's description. */
  detail: z.string(),
  childCount: z.number().int().nonnegative(),
  /** Assets only; `''` on level rows. */
  assetId: z.string(),
  dependencyCount: z.number().int().nonnegative(),
  reviewFlagCount: z.number().int().nonnegative(),
  /** `resolved`, `root`, `provisional-root`, `unresolved`, or `''` on levels. */
  parentStatus: z.string(),
  /** True when this asset's parent came from a manual override. */
  overridden: z.boolean(),
  /** True when the boundary fold took this asset's selected parent away. */
  demoted: z.boolean(),
});
export type WireTreeNode = z.infer<typeof treeNodeSchema>;

export const treePageSchema = z.object({
  total: z.number().int().nonnegative(),
  rows: z.array(treeNodeSchema),
});
export type WireTreePage = z.infer<typeof treePageSchema>;

/** What a drag reparent would do, checked in main before anything is written. */
export const reparentPreviewSchema = z.object({
  allowed: z.boolean(),
  /** One sentence, always present — a refusal and an approval both explain themselves. */
  explanation: z.string().min(1),
  /** The level whose value differs, when a boundary is what stops it. */
  boundaryLevelId: z.string(),
  /** True when the parent survives the ladder but the fold would demote it. */
  wouldDemote: z.boolean(),
});
export type WireReparentPreview = z.infer<typeof reparentPreviewSchema>;

/** One stored manual relationship override, as the overrides panel lists it. */
export const overrideRowSchema = z.object({
  childAssetId: z.string().min(1),
  childTag: z.string(),
  /** `''` when the override is "make this a root". */
  parentAssetId: z.string(),
  parentTag: z.string(),
  note: z.string(),
  updatedAt: z.string(),
});
export type WireOverrideRow = z.infer<typeof overrideRowSchema>;

/* =============================================== workspace: Electrical Flow */

export const flowNodeSchema = z.object({
  nodeId: z.string().min(1),
  tag: z.string().min(1),
  /** `model-confirmed`, `flow-only` or `pmd-only`. */
  matchStatus: z.string().min(1),
  depth: z.number().int().nonnegative(),
  /** The cable the feed came in on, when the source named one. */
  viaCable: z.string(),
  description: z.string(),
  systemLabel: z.string(),
  building: z.string(),
  /** Instruments terminating here. Listed, never descended into (PRODUCT.md §10). */
  pmdInstruments: z.array(z.string()),
  feedCount: z.number().int().nonnegative(),
  fedByCount: z.number().int().nonnegative(),
  /** Two or more incoming feeds: an alternate or parallel supply. */
  multiFed: z.boolean(),
});
export type WireFlowNode = z.infer<typeof flowNodeSchema>;

export const flowPageSchema = z.object({
  total: z.number().int().nonnegative(),
  rows: z.array(flowNodeSchema),
});
export type WireFlowPage = z.infer<typeof flowPageSchema>;

export const flowRootSchema = z.object({
  nodeId: z.string().min(1),
  tag: z.string().min(1),
  matchStatus: z.string().min(1),
  /** Nodes reachable from this root, the root included. */
  reachableCount: z.number().int().nonnegative(),
});
export type WireFlowRoot = z.infer<typeof flowRootSchema>;

/* ======================================================== workspace: review */

export const decisionValueSchema = z.enum(['accepted', 'rejected', 'deferred']);
export type WireDecisionValue = z.infer<typeof decisionValueSchema>;

export const reviewRowSchema = z.object({
  reviewKey: z.string().min(1),
  kind: z.string().min(1),
  /** `reviewItemSummary`'s own sentence, never reworded here. */
  summary: z.string().min(1),
  /** The tags behind the ids, so the queue reads in site vocabulary. */
  detail: z.string(),
  /** `null` until somebody decides. */
  decision: decisionValueSchema.nullable(),
  decidedAt: z.string(),
  note: z.string(),
});
export type WireReviewRow = z.infer<typeof reviewRowSchema>;

export const reviewPageSchema = z.object({
  total: z.number().int().nonnegative(),
  rows: z.array(reviewRowSchema),
  /** Every kind present in this compile with its count, for the filter. */
  kinds: z.array(
    z.object({ kind: z.string().min(1), count: z.number().int().nonnegative() }),
  ),
  undecidedCount: z.number().int().nonnegative(),
});
export type WireReviewPage = z.infer<typeof reviewPageSchema>;

/* ======================================================= workspace: exports */

/** Where an export went, and what it contains. */
export const exportResultSchema = z.discriminatedUnion('written', [
  z.object({ written: z.literal(false), reason: z.string().min(1) }),
  z.object({
    written: z.literal(true),
    path: z.string().min(1),
    byteSize: z.number().int().nonnegative(),
    /** One plain-language line: what was written and how much of it. */
    note: z.string().min(1),
  }),
]);
export type WireExportResult = z.infer<typeof exportResultSchema>;

/** One column of a picked site-template MEL, with what Matchline suggests for it. */
export const templateColumnSchema = z.object({
  index: z.number().int().nonnegative(),
  header: z.string(),
  /** A §12.1 field name, `'blank'`, or `''` when nothing was suggested. */
  suggestedField: z.string(),
  /** `exact`, `trimmed-case-insensitive`, `synonym`, or `''`. */
  match: z.string(),
});
export type WireTemplateColumn = z.infer<typeof templateColumnSchema>;

export const templateAnalysisSchema = z.object({
  path: z.string().min(1),
  sheetName: z.string(),
  sheetNames: z.array(z.string()),
  headerRow: z.number().int().nonnegative(),
  columns: z.array(templateColumnSchema),
  /** Every §12.1 field a column may be bound to, plus `blank`. */
  fieldChoices: z.array(z.string().min(1)),
});
export type WireTemplateAnalysis = z.infer<typeof templateAnalysisSchema>;

/** One column binding, as the mapping table sends it back. */
export const templateBindingSchema = z.object({
  templateColumn: z.string(),
  /** A §12.1 field name or `'blank'`. */
  field: z.string().min(1),
});
export type WireTemplateBinding = z.infer<typeof templateBindingSchema>;

/* ================================================ screen 9: profile packages */

/**
 * The portable profile package, format version 2 (PRODUCT.md §13.3).
 *
 * ONE versioned profile, not a `{draft, config}` pair: the whole site rule set
 * is `SiteProfileV2` now, and a package that still carried two halves would be
 * carrying the split this milestone removed. Raw model files and spreadsheet
 * rows are never in here — only decisions — and neither is the project's own
 * configuration: the captured EXTO template is this project's export layout,
 * not a rule another site should inherit.
 */
export const profilePackageSchema = z.object({
  formatVersion: z.literal(2),
  exportedAt: z.string().min(1),
  appVersion: z.string(),
  profile: draftProfileSchema,
});
export type WireProfilePackage = z.infer<typeof profilePackageSchema>;

/**
 * A package as every build before SiteProfileV2 wrote it.
 *
 * "v1 imports migrate, never refused" (RELEASE-1.0-PLAN). This schema is how
 * the importer recognizes one; `migrateProfilePackage` in
 * `electron/services/profile-package.ts` is how it joins the two halves back
 * into one profile. Nothing writes this shape.
 */
export const profilePackageV1Schema = z.object({
  formatVersion: z.literal(1),
  exportedAt: z.string().min(1),
  appVersion: z.string(),
  draft: legacyDraftProfileSchema,
  config: legacyProjectConfigSchema,
});
export type WireProfilePackageV1 = z.infer<typeof profilePackageV1Schema>;

/** What screen 9 prints about the profile as it stands. */
export const profileSectionSchema = z.object({
  name: z.string().min(1),
  /** One line about what this section decides. */
  what: z.string().min(1),
  configured: z.boolean(),
  /** What it is set to, in words. `''` when nothing is set. */
  detail: z.string(),
});
export type WireProfileSection = z.infer<typeof profileSectionSchema>;
