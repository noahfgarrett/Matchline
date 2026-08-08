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
});
export type WireOpenNotice = z.infer<typeof openNoticeSchema>;

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

/* ============================================================ screen 6: the
 * hierarchy
 *
 * Mirrors `HierarchyConfig` / `HierarchyLevelConfig` in `@matchline/domain`.
 * The wire shape is identical because a level has no "undecided" state: every
 * field is answered the moment the level exists.
 */

export const missingValuePolicySchema = z.enum([
  'unassigned-group',
  'review',
  'provisional-root',
]);
export type WireMissingValuePolicy = z.infer<typeof missingValuePolicySchema>;

export const levelSortSchema = z.enum(['label', 'key']);
export type WireLevelSort = z.infer<typeof levelSortSchema>;

export const hierarchyLevelSchema = z.object({
  levelId: z.string().min(1),
  displayName: z.string().min(1),
  attributeKey: z.string().min(1),
  boundary: z.boolean(),
  missingValuePolicy: missingValuePolicySchema,
  sort: levelSortSchema,
});
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
export const projectConfigSchema = z.object({
  hierarchy: hierarchyConfigSchema,
  roleGraph: roleGraphSchema,
  ladder: ladderConfigSchema,
  ssmDisciplineProjection: z.array(disciplineRewriteSchema),
  /** The model property naming an asset's parent, or `null` when unmapped. */
  parentTagProperty: propertyRefSchema.nullable(),
});
export type WireProjectConfig = z.infer<typeof projectConfigSchema>;

/** A partial write from screen 6 or 7. Absent sections are left alone. */
export const configPatchSchema = z.object({
  hierarchy: hierarchyConfigSchema.optional(),
  roleGraph: roleGraphSchema.optional(),
  ladder: ladderConfigSchema.optional(),
  ssmDisciplineProjection: z.array(disciplineRewriteSchema).optional(),
  parentTagProperty: propertyRefSchema.nullable().optional(),
});
export type WireConfigPatch = z.infer<typeof configPatchSchema>;

/* ------------------------------------------------------------ learned rules */

export const learnedRuleKindSchema = z.enum(['nesting', 'item-master']);
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
});
export type WireCompileSummary = z.infer<typeof compileSummarySchema>;

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
 * The portable profile package (PRODUCT.md §13.3).
 *
 * A superset of the domain `SiteProfile`: the wizard's own draft plus the
 * sections screens 6-7 configure, which the domain type cannot carry yet. Raw
 * model files and spreadsheet rows are never in here — only decisions.
 */
export const profilePackageSchema = z.object({
  formatVersion: z.literal(1),
  exportedAt: z.string().min(1),
  appVersion: z.string(),
  draft: draftProfileSchema,
  config: projectConfigSchema,
});
export type WireProfilePackage = z.infer<typeof profilePackageSchema>;

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
