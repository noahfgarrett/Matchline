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

/** Mirrors `PropertyMappings`, with "not chosen yet" spelled `null`. */
export const propertyMappingsSchema = z.object({
  equipmentTag: propertyRefSchema.nullable(),
  description: propertyRefSchema.nullable(),
  equipmentType: propertyRefSchema.nullable(),
  building: propertyRefSchema.nullable(),
  nativeDiscipline: propertyRefSchema.nullable(),
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
 * The whole draft the main process holds while the wizard runs.
 *
 * Every section is always present. A section counts as *configured* when it
 * carries a decision — a non-null `equipmentTag`, a non-empty `segments`, a
 * non-empty `keyChain` — which is what decides whether it reaches the saved
 * `SiteProfile` at all.
 */
export const draftProfileSchema = z.object({
  profileId: z.string().min(1),
  name: z.string().min(1),
  version: z.number().int().positive(),
  propertyMappings: propertyMappingsSchema,
  assetFilters: assetFiltersSchema,
  tagAnatomy: tagAnatomySchema,
  systemResolver: systemResolverSchema,
});
export type WireDraftProfile = z.infer<typeof draftProfileSchema>;

/** A partial write from one wizard screen. Absent sections are left alone. */
export const draftPatchSchema = z.object({
  name: z.string().min(1).optional(),
  propertyMappings: propertyMappingsSchema.optional(),
  assetFilters: assetFiltersSchema.optional(),
  tagAnatomy: tagAnatomySchema.optional(),
  systemResolver: systemResolverSchema.optional(),
});
export type WireDraftPatch = z.infer<typeof draftPatchSchema>;

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
 */
export const sourceStatusSchema = z.enum([
  'ready',
  'requires-windows-extraction',
  'needs-attention',
  'file-missing',
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
 */
export const sourceSummarySchema = z.object({
  role: sourceRoleSchema,
  fileName: z.string().min(1),
  sha256: z.string().length(64),
  byteSize: z.number().int().nonnegative(),
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

export const modelScanSchema = z.object({
  fileName: z.string().min(1),
  objectCount: z.number().int().nonnegative(),
  propertyNameCount: z.number().int().nonnegative(),
  sourceModels: z.array(sourceModelSummarySchema),
  extractedAtUtc: z.string(),
  navisworksVersion: z.string(),
  warningCount: z.number().int().nonnegative(),
});
export type WireModelScan = z.infer<typeof modelScanSchema>;

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

export const propertyCatalogRowSchema = z.object({
  category: z.string(),
  name: z.string(),
  objectCount: z.number().int().nonnegative(),
  /** `objectCount / totalObjects`, 0..1. */
  coverage: z.number(),
  distinctValueCount: z.number().int().nonnegative(),
  /** Up to three, first-seen in object order. */
  examples: z.array(z.string()),
  suggestedRole: suggestedRoleSchema.nullable(),
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
});
export type WireSampleAsset = z.infer<typeof sampleAssetSchema>;

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
