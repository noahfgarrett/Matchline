import { z } from 'zod';

import {
  addSourceResultSchema,
  anatomyPreviewSchema,
  assetPreviewSchema,
  assignmentPreviewSchema,
  attributeChoiceSchema,
  classCountSchema,
  compileHistoryEntrySchema,
  compileIssueKindSchema,
  compileIssueRowSchema,
  compileStatusSchema,
  configPatchSchema,
  decisionValueSchema,
  derivedAttributeSchema,
  derivedPreviewSchema,
  draftPatchSchema,
  draftProfileSchema,
  exportResultSchema,
  extractionJobSchema,
  flowPageSchema,
  flowRootSchema,
  learnedRuleKindSchema,
  learnedSummarySchema,
  ledgerEventSchema,
  modelUniverseSchema,
  overrideRowSchema,
  profileSectionSchema,
  projectConfigSchema,
  projectOpenResultSchema,
  projectSummarySchema,
  propertyCatalogRowSchema,
  propertySortSchema,
  quickSetupSuggestionsSchema,
  recentProjectSchema,
  reparentPreviewSchema,
  resolverPreviewSchema,
  reviewPageSchema,
  sourceAssignmentRuleSchema,
  sourceSummarySchema,
  systemResolverSchema,
  templateAnalysisSchema,
  templateBindingSchema,
  treeNodeSchema,
  treePageSchema,
} from './schemas.js';

/**
 * The single channel-declaration table (APP.md "IPC contract").
 *
 * Main registers handlers from this table; the preload façade is generated from it. A
 * channel cannot exist without both of its schemas, so there is exactly one place where
 * the wire contract lives.
 *
 * Channel names are `domain:verb`. The façade turns those into
 * `window.matchline.<domain>.<camelCasedVerb>(...)` (APP.md process model).
 */

/** Envelope error codes. Every failure the renderer can observe is one of these. */
export const IPC_ERROR_CODES = [
  'unauthorized-sender',
  'unknown-channel',
  'invalid-request',
  'invalid-response',
  'not-implemented',
  'handler-failed',
  /** A file path the renderer named that no dialog ever handed it. */
  'path-not-granted',
] as const;

export type IpcErrorCode = (typeof IPC_ERROR_CODES)[number];

export interface IpcFailure {
  readonly ok: false;
  readonly error: {
    readonly code: IpcErrorCode;
    readonly message: string;
  };
}

export interface IpcSuccess<TData> {
  readonly ok: true;
  readonly data: TData;
}

/**
 * Every channel resolves to this envelope — invoke never rejects for a contract failure,
 * it resolves with `ok: false`. Renderer code discriminates on `ok`.
 */
export type IpcResult<TData> = IpcSuccess<TData> | IpcFailure;

export interface IpcChannelDeclaration<
  TRequest extends z.ZodType = z.ZodType,
  TResponse extends z.ZodType = z.ZodType,
> {
  readonly request: TRequest;
  readonly response: TResponse;
  /**
   * A valid request/response pair. Exists so the contract test can prove both schemas
   * round-trip without hand-maintaining a second fixture file.
   */
  readonly example: {
    readonly request: z.infer<TRequest>;
    readonly response: z.infer<TResponse>;
  };
}

const fileFilterSchema = z.object({
  name: z.string().min(1),
  extensions: z.array(z.string().min(1)).min(1),
});

const openFileResultSchema = z.discriminatedUnion('cancelled', [
  z.object({ cancelled: z.literal(true) }),
  z.object({ cancelled: z.literal(false), path: z.string().min(1) }),
]);

const openFilesResultSchema = z.discriminatedUnion('cancelled', [
  z.object({ cancelled: z.literal(true) }),
  z.object({ cancelled: z.literal(false), paths: z.array(z.string().min(1)).min(1) }),
]);

/** Reused by every example below so the table reads as one project, not twelve. */
const EXAMPLE_PROJECT = {
  path: '/Users/dragon/Dragon.matchline',
  name: 'Dragon',
  schemaVersion: 2,
  createdAt: '2026-08-08T09:00:00.000Z',
  modifiedAt: '2026-08-08T09:12:00.000Z',
  sourceCount: 2,
  savedRevision: null,
  hasModel: true,
} as const;

/** The common case: a current file, opened without the app having to fix it. */
const EXAMPLE_OPEN_NOTICE = {
  migration: null,
  adoptedAppStateConfig: false,
  mergedLegacyConfig: false,
} as const;

const EXAMPLE_DRAFT = {
  profileId: 'dragon',
  name: 'Dragon',
  version: 1,
  // Chains with per-source overrides since P0-8 (hard gate 5): the building is
  // read from `Dragon Data > Building` everywhere except the controls model,
  // where the same fact lives under `Controls Data > Area`.
  propertyMappings: {
    equipmentTag: { chain: [{ category: 'Dragon Data', name: 'Tag' }], bySource: [] },
    description: { chain: [], bySource: [] },
    equipmentType: { chain: [], bySource: [] },
    building: {
      chain: [{ category: 'Dragon Data', name: 'Building' }],
      bySource: [
        {
          sourceId: 'model:dragon-controls.matchline-cache',
          chain: [{ category: 'Controls Data', name: 'Area' }],
        },
      ],
    },
    nativeDiscipline: { chain: [], bySource: [] },
    wbs: { chain: [], bySource: [] },
    itemMaster: { chain: [], bySource: [] },
    equipmentClassification: { chain: [], bySource: [] },
  },
  assetFilters: {
    includedClasses: [],
    excludedClasses: [],
    requireTagProperty: true,
    acceptedTagPatterns: [],
    selectionSetNames: [],
    includedSourceModelFiles: [],
    collapseComponents: false,
    separatelyCommissionableClasses: [],
  },
  tagAnatomy: {
    separators: ['-'],
    ignoredSuffixes: [],
    segments: [{ segment: 'role', extractor: { kind: 'alphaPrefix', token: 0 } }],
    familyKeyTemplate: '{system}-{token:1}-{token:2}',
    localFamilyTemplate: '',
  },
  systemResolver: {
    keyChain: [{ kind: 'tag-segment', segment: 'system' }],
    descriptionChain: [],
    normalization: [{ kind: 'trim' }],
    conflictPolicy: 'review',
    labelTemplate: '',
  },
  // The sections that used to be the project's `config` rows. They are the
  // profile's since SiteProfileV2, and a site that has defined an attribute of
  // its own (P0-7) and a rule that reads the discipline out of a file name
  // (P0-8) is stated here so the round-trip covers a populated section rather
  // than only an empty one.
  sourceAssignments: [
    {
      scope: 'filename-pattern',
      match: 'Dragon-*.nwc',
      assign: { building: '', nativeDiscipline: '$1', custom: [] },
    },
  ],
  derivedAttributes: [
    {
      attributeId: 'turnover-package',
      displayName: 'Turnover Package',
      resolverChain: [
        { kind: 'model-property', chain: [{ category: 'Dragon Data', name: 'Package' }] },
        { kind: 'tag-segment', segment: 'unit' },
      ],
    },
  ],
  hierarchy: {
    levels: [
      {
        levelId: 'building',
        displayName: 'Building',
        attributeKey: 'building',
        boundary: true,
        missingValuePolicy: 'unassigned-group',
        sort: 'label',
      },
    ],
  },
  roleGraph: { rules: [{ parentRole: 'MAH', childRole: 'PLC' }] },
  ladder: {
    tiers: [
      'manual',
      'explicit-model',
      'profile-lookup',
      'flow-family',
      'family-role',
      'learned-description',
      'prior-ssm',
      'model-tree',
    ],
  },
  ssmDisciplineProjection: [{ from: 'I&C', to: 'Mechanical' }],
  parentTagProperty: null,
  stableIdProperty: { category: 'Dragon Data', name: 'Asset Number' },
  identityConfig: {
    tagNormalization: [{ kind: 'uppercase' }],
    aliases: [{ from: 'MAH-001', to: 'MAH001-10-01' }],
    fuzzyMaxDistance: 0,
  },
  profileLookup: [],
  priorSsm: [],
  authorityRules: [],
  profileTestExamples: [],
} as const;

/** What is left of the project's own configuration: its captured EXTO layout. */
const EXAMPLE_CONFIG = {
  extoTemplate: null,
} as const;

const EXAMPLE_COMPILE_SUMMARY = {
  compileId: 1,
  profileRevision: 1,
  finishedAt: '2026-08-08T09:30:00.000Z',
  durationMs: 412,

  assetCount: 34,
  duplicateTagCount: 0,
  resolvedSystemCount: 34,
  missingSystemCount: 0,
  systemConflictCount: 0,

  flowNodeCount: 8,
  modelConfirmedCount: 8,
  flowOnlyCount: 0,
  pmdOnlyCount: 0,
  multiFeedNodeCount: 0,

  rootCount: 30,
  demotionCount: 1,
  ambiguousParentCount: 0,
  cycleCount: 0,
  unresolvedParentCount: 0,

  learnedProposalCount: 0,
  skippedClaimInputCount: 0,
  generatedMelRowCount: 34,
  reviewItemCount: 2,
  undecidedReviewItemCount: 2,

  ledgerNewAssetCount: 0,
  ledgerTagChangedCount: 1,
  ledgerRematchedByTagCount: 0,
  ledgerSplitCount: 0,
  ledgerDisappearedCount: 0,
  orphanedDecisionCount: 0,
} as const;

const EXAMPLE_TREE_NODE = {
  nodeKey: 'asset:tag:MAH001-10-01',
  kind: 'asset',
  label: 'MAH001-10-01',
  detail: 'Dragon Air',
  childCount: 1,
  assetId: 'tag:MAH001-10-01',
  dependencyCount: 0,
  reviewFlagCount: 0,
  parentStatus: 'root',
  overridden: false,
  demoted: false,
} as const;

export const IPC_CHANNELS = {
  'app:version': {
    request: z.void(),
    response: z.object({ version: z.string().min(1) }),
    example: {
      request: undefined,
      response: { version: '0.1.0' },
    },
  },

  'dialog:open-file': {
    request: z.object({ filters: z.array(fileFilterSchema).min(1) }),
    response: openFileResultSchema,
    example: {
      request: { filters: [{ name: 'Matchline project', extensions: ['matchline'] }] },
      response: { cancelled: false, path: '/Users/dragon/Dragon.matchline' },
    },
  },

  'dialog:save-file': {
    request: z.object({
      defaultName: z.string().min(1),
      filters: z.array(fileFilterSchema).min(1),
    }),
    response: openFileResultSchema,
    example: {
      request: {
        defaultName: 'Dragon.matchline',
        filters: [{ name: 'Matchline project', extensions: ['matchline'] }],
      },
      response: { cancelled: false, path: '/Users/dragon/Dragon.matchline' },
    },
  },

  'dialog:open-files': {
    request: z.object({ filters: z.array(fileFilterSchema).min(1) }),
    response: openFilesResultSchema,
    example: {
      request: { filters: [{ name: 'Sources', extensions: ['xlsx', 'nwd'] }] },
      response: { cancelled: false, paths: ['/Users/dragon/Dragon-EasyPower.xlsx'] },
    },
  },

  /* ------------------------------------------------------ project lifecycle */

  /** Creates the `.matchline` file and leaves it open as the session project. */
  'project:create': {
    request: z.object({ path: z.string().min(1), name: z.string().min(1) }),
    response: z.object({ project: projectSummarySchema }),
    example: {
      request: { path: '/Users/dragon/Dragon.matchline', name: 'Dragon' },
      response: { project: EXAMPLE_PROJECT },
    },
  },

  /**
   * Opens an existing project and restores its saved profile and configuration.
   *
   * A file written by an older build is **not** upgraded on sight: the response
   * comes back as `migration-needed` instead of a project, the UI asks, and the
   * second call carries `acceptMigration: true`. Upgrading rewrites the only
   * copy of a site's decisions, so it is a decision the user makes.
   */
  'project:open': {
    request: z.object({
      path: z.string().min(1),
      /** Answers a `migration-needed` result. Absent means "ask me first". */
      acceptMigration: z.boolean().optional(),
    }),
    response: projectOpenResultSchema,
    example: {
      request: { path: '/Users/dragon/Dragon.matchline' },
      response: {
        outcome: 'opened',
        project: EXAMPLE_PROJECT,
        notice: EXAMPLE_OPEN_NOTICE,
      },
    },
  },

  /** Releases the SQLite handle and any open extraction cache. */
  'project:close': {
    request: z.void(),
    response: z.object({ closed: z.boolean() }),
    example: { request: undefined, response: { closed: true } },
  },

  /** The open project, or `null`. Lets a reloaded renderer find its place. */
  'project:current': {
    request: z.void(),
    response: z.object({ project: projectSummarySchema.nullable() }),
    example: { request: undefined, response: { project: EXAMPLE_PROJECT } },
  },

  /** Most-recently-opened projects, newest first, from the app's userData. */
  'project:recent': {
    request: z.void(),
    response: z.object({ projects: z.array(recentProjectSchema) }),
    example: {
      request: undefined,
      response: {
        projects: [
          {
            path: '/Users/dragon/Dragon.matchline',
            name: 'Dragon',
            openedAt: '2026-08-08T09:00:00.000Z',
            missing: false,
          },
        ],
      },
    },
  },

  /* ------------------------------------------------- screen 1: the sources */

  /** Identifies each path, registers what it can, and reports on all of them. */
  'source:add': {
    request: z.object({ paths: z.array(z.string().min(1)).min(1) }),
    response: z.object({ results: z.array(addSourceResultSchema) }),
    example: {
      request: { paths: ['/Users/dragon/Dragon-Mechanical.matchline-cache'] },
      response: {
        results: [
          {
            outcome: 'added',
            source: {
              sourceId: 'model:dragon-mechanical.matchline-cache',
              role: 'model',
              logicalName: 'Dragon-Mechanical.matchline-cache',
              rawFileName: 'Dragon-Mechanical.matchline-cache',
              rawSha256: 'a'.repeat(64),
              rawByteSize: 262144,
              derivedCacheSha256: 'a'.repeat(64),
              addedAt: '2026-08-08T09:01:00.000Z',
              status: 'ready',
              note: 'Extraction cache with 42 objects from 3 source models.',
              sheets: [],
            },
          },
        ],
      },
    },
  },

  /**
   * The same registration as `source:add`, for paths that came off a drag.
   *
   * A separate channel because the two have different provenance and therefore
   * different rules. `source:add` takes paths a dialog handed the renderer and
   * refuses anything else (electron/security/path-grants.ts). A drop never goes
   * through a dialog: the renderer reads the path out of the drag payload
   * itself, so the string arrives with nothing proving a person produced it and
   * there is no grant to check it against. This channel is what main does
   * instead — it re-derives everything it needs from the filesystem and admits
   * only what screens as a source file. `screenDroppedPaths` in
   * electron/services/sources.ts carries the full reasoning.
   */
  'source:add-dropped': {
    request: z.object({ paths: z.array(z.string().min(1)).min(1) }),
    response: z.object({ results: z.array(addSourceResultSchema) }),
    example: {
      request: { paths: ['/Users/dragon/Dragon-MEL.xlsx'] },
      response: {
        results: [
          {
            outcome: 'rejected',
            fileName: 'Dragon-MEL.xlsx',
            reason: 'Matchline could not find Dragon-MEL.xlsx.',
          },
        ],
      },
    },
  },

  'source:list': {
    request: z.void(),
    response: z.object({ sources: z.array(sourceSummarySchema) }),
    example: {
      request: undefined,
      response: {
        sources: [
          {
            sourceId: 'mel:dragon-mel.xlsx',
            role: 'mel',
            logicalName: 'Dragon-MEL.xlsx',
            rawFileName: 'Dragon-MEL.xlsx',
            rawSha256: 'b'.repeat(64),
            rawByteSize: 8192,
            derivedCacheSha256: 'b'.repeat(64),
            addedAt: '2026-08-08T09:02:00.000Z',
            status: 'ready',
            note: 'Workbook with 1 recognized sheet.',
            sheets: [
              {
                sheet: 'MEL',
                kind: 'mel',
                confidence: 'exact-headers',
                headerRow: 1,
                mappedColumnCount: 3,
              },
            ],
          },
        ],
      },
    },
  },

  /**
   * Removes one source, by id.
   *
   * By id rather than by `(role, fileName)`: two sources may honestly share a
   * basename (P0-1, hard gate 4), and a remove keyed on the name would take
   * away whichever one the store happened to find first.
   */
  'source:remove': {
    request: z.object({ sourceId: z.string().min(1) }),
    response: z.object({ removed: z.boolean() }),
    example: {
      request: { sourceId: 'mel:dragon-mel.xlsx' },
      response: { removed: true },
    },
  },

  /* ------------------------------------------ screen 1: extraction progress */

  /**
   * Every extraction this session has run, queued, or failed (P0-2).
   *
   * Polled rather than pushed, which is what the rest of this table does with
   * long-running work: main owns the state, the renderer asks for it, and there
   * is exactly one shape for "what is happening" whether the window has been
   * open the whole time or was just reopened on a project mid-extraction.
   *
   * Paged like every other list channel. A project with forty models
   * re-extracting after a re-add is a real page, not a hypothetical one.
   */
  'extraction:status': {
    request: z.object({
      offset: z.number().int().nonnegative(),
      limit: z.number().int().positive().max(200),
    }),
    response: z.object({
      total: z.number().int().nonnegative(),
      /** True while any job is queued or running, so the UI knows to keep polling. */
      active: z.boolean(),
      rows: z.array(extractionJobSchema),
    }),
    example: {
      request: { offset: 0, limit: 50 },
      response: {
        total: 1,
        active: true,
        rows: [
          {
            sourceId: 'model:dragon-coordination.nwd',
            fileName: 'Dragon-Coordination.nwd',
            status: 'extracting',
            progress: null,
            detail: '48,213 records read from the model so far.',
            note: 'Reading the equipment and properties out of Dragon-Coordination.nwd.',
            errorCode: null,
            warnings: [
              {
                code: 'ADAPTER_UNVERIFIED',
                message:
                  'This Navisworks version has not been proven against a real install yet. ' +
                  'The extraction ran; treat its counts as unconfirmed until that version is verified.',
              },
            ],
            objectCount: null,
            startedAt: '2026-08-11T09:00:00.000Z',
            finishedAt: null,
            cancellable: true,
          },
        ],
      },
    },
  },

  /**
   * Stops one extraction, by source id.
   *
   * The source stays registered and becomes `cancelled` rather than
   * disappearing: the user asked to stop reading the file, not to forget they
   * added it. Answers `false` when there was nothing left to stop.
   */
  'extraction:cancel': {
    request: z.object({ sourceId: z.string().min(1) }),
    response: z.object({ cancelled: z.boolean() }),
    example: {
      request: { sourceId: 'model:dragon-coordination.nwd' },
      response: { cancelled: true },
    },
  },

  /* -------------------------------- screen 2: model scan + Property Catalog */

  /**
   * Every ready model source, with the universe totals over them (P0-1).
   *
   * A project is a universe of caches, not one file, so this answers with the
   * list and the totals rather than with "the model".
   */
  'model:scan': {
    request: z.void(),
    response: z.object({ universe: modelUniverseSchema.nullable() }),
    example: {
      request: undefined,
      response: {
        universe: {
          sourceCount: 1,
          objectCount: 42,
          propertyNameCount: 11,
          warningCount: 0,
          sources: [
            {
              sourceId: 'model:dragon.matchline-cache',
              displayName: 'Dragon.matchline-cache',
              rawFileName: 'Dragon.matchline-cache',
              objectCount: 42,
              propertyNameCount: 11,
              sourceModels: [
                { sourceModelId: 1, fileName: 'Dragon-Mechanical.nwc', objectCount: 18 },
              ],
              extractedAtUtc: '2026-08-01T00:00:00Z',
              navisworksVersion: '2025',
              warningCount: 0,
            },
          ],
        },
      },
    },
  },

  /**
   * One window of the Property Catalog (PRODUCT.md §6.5). The catalog itself
   * stays in main — the renderer only ever holds the rows it is drawing.
   */
  'model:property-page': {
    request: z.object({
      offset: z.number().int().nonnegative(),
      limit: z.number().int().positive().max(500),
      sortBy: propertySortSchema,
      descending: z.boolean(),
      search: z.string(),
    }),
    response: z.object({
      total: z.number().int().nonnegative(),
      rows: z.array(propertyCatalogRowSchema),
    }),
    example: {
      request: { offset: 0, limit: 50, sortBy: 'coverage', descending: true, search: '' },
      response: {
        total: 11,
        rows: [
          {
            category: 'Dragon Data',
            name: 'Tag',
            objectCount: 24,
            coverage: 0.5714285714285714,
            distinctValueCount: 24,
            examples: ['MAH001-10-01', 'TIT001-10-01', 'PLC001-10-01'],
            suggestedRole: 'equipment-tag',
            bySource: [
              {
                sourceId: 'model:dragon-mechanical.matchline-cache',
                label: 'dragon-mechanical',
                objectCount: 24,
                coverage: 0.5714285714285714,
              },
            ],
          },
        ],
      },
    },
  },

  /** Distinct Navisworks class names with counts, for the include/exclude lists. */
  'model:class-list': {
    request: z.void(),
    response: z.object({ classes: z.array(classCountSchema) }),
    example: {
      request: undefined,
      response: { classes: [{ className: 'Equipment', objectCount: 24 }] },
    },
  },

  /* ------------------------------------------- screens 3-5: live previews */

  /** Inclusion impact for the draft's mappings and filters (PRODUCT.md §6.6). */
  'asset:preview': {
    request: z.void(),
    response: z.object({ preview: assetPreviewSchema }),
    example: {
      request: undefined,
      response: {
        preview: {
          state: 'ready',
          totalObjects: 42,
          stages: [
            {
              stage: 'tag-presence',
              label: 'Objects without an equipment tag',
              inCount: 42,
              droppedCount: 18,
              outCount: 24,
            },
          ],
          collapsedCount: 0,
          finalAssetCount: 24,
          duplicateTagCount: 0,
          untaggedDroppedCount: 18,
          samples: [
            {
              assetId: 'tag:MAH001-10-01',
              canonicalTag: 'MAH001-10-01',
              description: 'Dragon Air',
              equipmentType: 'Air Handler',
              building: 'B14',
              objectCount: 1,
              status: 'MODEL_CONFIRMED',
              sourceId: 'model:dragon-mechanical.matchline-cache',
            },
          ],
          bySource: [
            {
              sourceId: 'model:dragon-mechanical.matchline-cache',
              label: 'dragon-mechanical',
              totalObjects: 42,
              collapsedCount: 0,
              finalAssetCount: 24,
              untaggedDroppedCount: 18,
            },
          ],
        },
      },
    },
  },

  /** Anatomy coverage over the draft's real catalog tags (PRODUCT.md §7 s4). */
  'anatomy:preview': {
    request: z.void(),
    response: z.object({ preview: anatomyPreviewSchema }),
    example: {
      request: undefined,
      response: {
        preview: {
          state: 'ready',
          total: 24,
          matchedCount: 24,
          coverage: 1,
          segmentStats: [{ segment: 'role', distinctValueCount: 4 }],
          examples: [
            {
              tag: 'MAH001-10-01',
              normalizedTag: 'MAH001-10-01',
              segments: [{ segment: 'role', value: 'MAH' }],
              familyKey: '001-10-01',
              localFamily: '',
            },
          ],
          misses: [],
          sample: {
            tag: 'MAH001-10-01',
            normalizedTag: 'MAH001-10-01',
            segments: [{ segment: 'role', value: 'MAH' }],
            familyKey: '001-10-01',
            localFamily: '',
          },
        },
      },
    },
  },

  /** System resolution over the draft's compiled subjects (PRODUCT.md §5). */
  'resolver:preview': {
    request: z.void(),
    response: z.object({ preview: resolverPreviewSchema }),
    example: {
      request: undefined,
      response: {
        preview: {
          state: 'ready',
          subjectCount: 24,
          resolvedCount: 24,
          coverage: 1,
          describedCount: 24,
          conflictCount: 0,
          distinctSystemCount: 3,
          melRowCount: 4,
          rungUsage: [
            {
              chain: 'keyChain',
              rungIndex: 0,
              kind: 'tag-segment',
              label: 'Tag segment "system"',
              wonCount: 24,
              claimCount: 24,
              skippedCount: 0,
            },
          ],
          samples: [
            {
              assetId: 'tag:MAH001-10-01',
              sourceId: 'model:dragon-mechanical.matchline-cache',
              canonicalTag: 'MAH001-10-01',
              systemKey: '001',
              systemDescription: 'Mechanical Dry Air Handling',
              systemLabel: '001 Mechanical Dry Air Handling',
              keySource: 'Tag segment "system"',
              conflictStatus: 'AGREED',
            },
          ],
          conflicts: [],
          unresolvedExamples: [],
        },
      },
    },
  },

  /**
   * What one derived attribute would resolve to, over the whole universe (P0-7).
   *
   * The definition travels in the request rather than being read off the draft:
   * screen 6's manager previews the definition being EDITED, which is not in the
   * draft until somebody saves it, and a preview of the saved one would answer a
   * question nobody asked.
   */
  'derived:preview': {
    request: z.object({ definition: derivedAttributeSchema }),
    response: z.object({ preview: derivedPreviewSchema }),
    example: {
      request: {
        definition: {
          attributeId: 'turnover-package',
          displayName: 'Turnover Package',
          resolverChain: [{ kind: 'tag-segment', segment: 'unit' }],
        },
      },
      response: {
        preview: {
          state: 'ready',
          assetCount: 34,
          resolvedCount: 34,
          coverage: 1,
          distinctValueCount: 2,
          rungUsage: [
            {
              rungIndex: 0,
              kind: 'tag-segment',
              label: 'Tag segment "unit"',
              wonCount: 34,
              claimCount: 34,
            },
          ],
          samples: [
            {
              assetId: 'tag:MAH001-10-01',
              canonicalTag: 'MAH001-10-01',
              value: '10',
              from: 'Tag segment "unit"',
            },
          ],
          unresolvedExamples: [],
        },
      },
    },
  },

  /** Which documents one source-assignment rule speaks for (P0-8). */
  'assignment:preview': {
    request: z.object({ rule: sourceAssignmentRuleSchema }),
    response: z.object({ preview: assignmentPreviewSchema }),
    example: {
      request: {
        rule: {
          scope: 'filename-pattern',
          match: 'Dragon-*.nwc',
          assign: { building: '', nativeDiscipline: '$1', custom: [] },
        },
      },
      response: {
        preview: {
          state: 'ready',
          matches: [
            {
              sourceId: 'model:dragon-mechanical.matchline-cache',
              label: 'dragon-mechanical',
              sourceModelFile: 'Dragon-Mechanical.nwc',
              objectCount: 51,
              capture: 'Mechanical',
            },
          ],
          matchedObjectCount: 51,
          universeObjectCount: 76,
          assigned: [{ field: 'Discipline', value: 'Mechanical' }],
          problem: '',
          candidates: ['Dragon-Mechanical.nwc', 'Dragon-Controls.nwc'],
        },
      },
    },
  },

  /* ------------------------------------------------------------ quick setup */

  /**
   * Everything the Quick Setup path proposes, over the real universe.
   *
   * One channel rather than one per screen: the signals are computed from a
   * single pass over the Property Catalog and the class counts, and splitting
   * them would make five screens pay for it five times. Nothing here is
   * applied — accepting is a `profile:update` like any other edit.
   */
  'setup:suggest': {
    request: z.void(),
    response: z.object({ suggestions: quickSetupSuggestionsSchema }),
    example: {
      request: undefined,
      response: {
        suggestions: {
          ready: true,
          blockedReason: '',
          objectCount: 76,
          sourceCount: 1,
          fields: [
            {
              target: { kind: 'mapped-field', field: 'equipmentTag' },
              label: 'Equipment tag',
              what: 'The property Matchline reads the equipment tag from.',
              example: 'Dragon Data > Tag holding MAH001-10-01',
              confidence: 'strong',
              candidates: [
                {
                  property: { category: 'Dragon Data', name: 'Tag' },
                  score: 0.94,
                  coverage: 0.45,
                  distinctValueCount: 34,
                  objectCount: 34,
                  examples: ['MAH001-10-01', 'MAH001-10-02'],
                  reasons: ['Named “Tag”', 'Every value distinct', 'Values are shaped like tags'],
                },
              ],
            },
          ],
          anatomy: null,
          resolverTemplates: [],
          classes: [],
          hierarchy: { levels: [] },
        },
      },
    },
  },

  /**
   * One starter template previewed before it is accepted.
   *
   * Separate from `resolver:preview`, which previews the draft: a template has
   * not been written to the draft and must not be, because writing it to find
   * out what it does is exactly the silent publication the plan forbids.
   */
  'setup:resolver-preview': {
    request: z.object({ resolver: systemResolverSchema }),
    response: z.object({ preview: resolverPreviewSchema }),
    example: {
      request: {
        resolver: {
          keyChain: [{ kind: 'tag-segment', segment: 'system' }],
          descriptionChain: [],
          normalization: [{ kind: 'trim' }],
          conflictPolicy: 'review',
          labelTemplate: '',
        },
      },
      response: {
        preview: {
          state: 'ready',
          subjectCount: 34,
          resolvedCount: 34,
          coverage: 1,
          describedCount: 0,
          conflictCount: 0,
          distinctSystemCount: 3,
          melRowCount: 0,
          rungUsage: [],
          samples: [],
          conflicts: [],
          unresolvedExamples: [],
        },
      },
    },
  },

  /* --------------------------------------------------- the wizard's draft */

  'profile:draft': {
    request: z.void(),
    response: z.object({
      draft: draftProfileSchema.nullable(),
      savedRevision: z.number().int().positive().nullable(),
    }),
    example: {
      request: undefined,
      response: { draft: EXAMPLE_DRAFT, savedRevision: null },
    },
  },

  /** Writes one or more sections. Sections not named are left untouched. */
  'profile:update': {
    request: z.object({ patch: draftPatchSchema }),
    response: z.object({ draft: draftProfileSchema }),
    example: {
      request: { patch: { name: 'Dragon' } },
      response: { draft: EXAMPLE_DRAFT },
    },
  },

  /** Validates the draft and stores it as a new revision (PRODUCT.md §13.3). */
  'profile:save': {
    request: z.object({ note: z.string() }),
    response: z.object({
      revision: z.number().int().positive(),
      savedAt: z.string().min(1),
    }),
    example: {
      request: { note: 'Screens 1-5 complete' },
      response: { revision: 1, savedAt: '2026-08-08T09:20:00.000Z' },
    },
  },

  /* ------------------------------------- screens 6-7: hierarchy and rules */

  /**
   * Every attribute a hierarchy level may group by.
   *
   * Exactly `@matchline/compiler`'s `ATTRIBUTE_KEYS`, with the plain-language
   * name and one real example each. Sent rather than hardcoded so a level can
   * never name a key the engine does not populate.
   */
  'hierarchy:attributes': {
    request: z.void(),
    response: z.object({ attributes: z.array(attributeChoiceSchema) }),
    example: {
      request: undefined,
      response: {
        attributes: [
          {
            attributeKey: 'building',
            label: 'Building',
            what: 'Which building the model puts the equipment in.',
            example: 'D1',
            distinctValueCount: 2,
          },
        ],
      },
    },
  },

  /** The screens 6-7 sections. Always answers, defaults included. */
  'config:get': {
    request: z.void(),
    response: z.object({ config: projectConfigSchema }),
    example: { request: undefined, response: { config: EXAMPLE_CONFIG } },
  },

  /** Writes one or more sections. Sections not named are left untouched. */
  'config:update': {
    request: z.object({ patch: configPatchSchema }),
    response: z.object({ config: projectConfigSchema }),
    example: {
      request: { patch: { extoTemplate: null } },
      response: { config: EXAMPLE_CONFIG },
    },
  },

  /** Distinct tag `role` values across the catalog, for the role-graph pickers. */
  'config:roles': {
    request: z.void(),
    response: z.object({ roles: z.array(z.string().min(1)) }),
    example: { request: undefined, response: { roles: ['MAH', 'PLC', 'TIT', 'VFD'] } },
  },

  /** Distinct `nativeDiscipline` values, for the projection table's left column. */
  'config:disciplines': {
    request: z.void(),
    response: z.object({ disciplines: z.array(z.string().min(1)) }),
    example: { request: undefined, response: { disciplines: ['I&C', 'Mechanical'] } },
  },

  /**
   * Trains a rule set from a finished SSM / registry export and stores it.
   *
   * The workbook is read in main and never crosses IPC; the renderer gets the
   * summary a reviewer judges the training by.
   */
  'learned:train': {
    request: z.object({ kind: learnedRuleKindSchema, path: z.string().min(1) }),
    response: z.object({ summary: learnedSummarySchema }),
    example: {
      request: { kind: 'nesting', path: '/Users/dragon/Prior-SSM.xlsx' },
      response: {
        summary: {
          kind: 'nesting',
          label: 'Prior-SSM.xlsx',
          savedAt: '2026-08-08T09:25:00.000Z',
          rowCount: 120,
          classCount: 6,
          gateCount: 6,
          affinityCount: 4,
          claimGradeCount: 2,
          proposalGradeCount: 4,
          suspectRowCount: 0,
          grades: [
            { className: 'VFD', predicted: 12, correct: 11, precision: 0.9167, grade: 'claim' },
          ],
        },
      },
    },
  },

  /** Whatever training the project already carries, newest per kind. */
  'learned:list': {
    request: z.void(),
    response: z.object({ summaries: z.array(learnedSummarySchema) }),
    example: { request: undefined, response: { summaries: [] } },
  },

  /* --------------------------------------------------- screen 8: compiling */

  /**
   * Runs the whole pipeline and records it (PRODUCT.md §7 screen 8).
   *
   * The compiled project stays in main. What comes back is the checklist; the
   * lists behind each card are paged through `compile:issues`.
   */
  'compile:run': {
    request: z.void(),
    response: z.object({ status: compileStatusSchema }),
    example: {
      request: undefined,
      response: { status: { state: 'done', summary: EXAMPLE_COMPILE_SUMMARY } },
    },
  },

  /**
   * Stops the compile that is running, if one is.
   *
   * A separate channel rather than an argument to `compile:run`, because the
   * two are concurrent by construction: `compile:run` does not resolve until
   * the worker has returned, so the only invoke that can cancel it is one made
   * while it is still outstanding. `cancelled: false` means there was nothing
   * to stop — the compile had already finished, or none had started.
   */
  'compile:cancel': {
    request: z.void(),
    response: z.object({ cancelled: z.boolean() }),
    example: { request: undefined, response: { cancelled: true } },
  },

  /** The current compile, so a reopened workspace knows what it is looking at. */
  'compile:status': {
    request: z.void(),
    response: z.object({ status: compileStatusSchema }),
    example: { request: undefined, response: { status: { state: 'never-run' } } },
  },

  /** One page of the list behind a screen-8 card. */
  'compile:issues': {
    request: z.object({
      kind: compileIssueKindSchema,
      offset: z.number().int().nonnegative(),
      limit: z.number().int().positive().max(500),
    }),
    response: z.object({
      total: z.number().int().nonnegative(),
      rows: z.array(compileIssueRowSchema),
    }),
    example: {
      request: { kind: 'demotions', offset: 0, limit: 50 },
      response: {
        total: 1,
        rows: [
          {
            id: 'tag:RIO603-10-01',
            title: 'RIO603-10-01',
            detail: 'PNL603-10-01 became a dependency: System differs.',
            badge: 'system',
          },
        ],
      },
    },
  },

  /**
   * One page of the identity log: what the ledger did this compile (P0-9).
   *
   * Its own channel rather than another `compile:issues` kind, because these
   * rows are not issues. Nothing here needs deciding and most of it is good
   * news — an id that survived a tag correction is the feature working. The
   * summary carries the counts; this carries the lines behind them.
   */
  'compile:ledger-events': {
    request: z.object({
      offset: z.number().int().nonnegative(),
      limit: z.number().int().positive().max(500),
    }),
    response: z.object({
      total: z.number().int().nonnegative(),
      rows: z.array(ledgerEventSchema),
    }),
    example: {
      request: { offset: 0, limit: 100 },
      response: {
        total: 1,
        rows: [
          {
            kind: 'tag-changed',
            assetId: 'asset-17',
            tag: 'MAH002-10-01',
            previousTag: 'MAH002-10-1',
            tier: 'instance-guid',
            detail: 'MAH002-10-1 is now MAH002-10-01; matched on instance-guid.',
          },
        ],
      },
    },
  },

  /** Compile history, newest first. The revision diff picks its baseline here. */
  'compile:history': {
    request: z.void(),
    response: z.object({ compiles: z.array(compileHistoryEntrySchema) }),
    example: {
      request: undefined,
      response: {
        compiles: [
          {
            compileId: 1,
            profileRevision: 1,
            finishedAt: '2026-08-08T09:30:00.000Z',
            assetCount: 34,
            diffable: true,
          },
        ],
      },
    },
  },

  /* ------------------------------------------------- workspace: the SSM tree */

  /** One page of a node's children. `nodeKey: ''` asks for the top level. */
  'tree:children': {
    request: z.object({
      nodeKey: z.string(),
      offset: z.number().int().nonnegative(),
      limit: z.number().int().positive().max(500),
    }),
    response: treePageSchema,
    example: {
      request: { nodeKey: '', offset: 0, limit: 100 },
      response: { total: 1, rows: [EXAMPLE_TREE_NODE] },
    },
  },

  /** Assets whose tag contains `query`, so a big tree stays navigable. */
  'tree:search': {
    request: z.object({ query: z.string(), limit: z.number().int().positive().max(200) }),
    response: z.object({ rows: z.array(treeNodeSchema) }),
    example: {
      request: { query: 'MAH001', limit: 50 },
      response: { rows: [EXAMPLE_TREE_NODE] },
    },
  },

  /**
   * What a drag would do, before it is written.
   *
   * `parentAssetId: null` is the make-root question, not "unknown" — the same
   * distinction `ManualRelationshipOverride` draws.
   */
  'tree:reparent-preview': {
    request: z.object({
      childAssetId: z.string().min(1),
      parentAssetId: z.string().min(1).nullable(),
    }),
    response: z.object({ preview: reparentPreviewSchema }),
    example: {
      request: { childAssetId: 'tag:TIT005-10-01', parentAssetId: 'tag:MAH005-10-01' },
      response: {
        preview: {
          allowed: true,
          explanation: 'Both are in Building D1 and System 005, so this nests.',
          boundaryLevelId: '',
          wouldDemote: false,
        },
      },
    },
  },

  /* -------------------------------------------- workspace: manual overrides */

  'override:set': {
    request: z.object({
      childAssetId: z.string().min(1),
      parentAssetId: z.string().min(1).nullable(),
      note: z.string(),
    }),
    response: z.object({ overrides: z.array(overrideRowSchema) }),
    example: {
      request: {
        childAssetId: 'tag:TIT005-10-01',
        parentAssetId: 'tag:MAH005-10-01',
        note: 'Commissioned as one skid.',
      },
      response: {
        overrides: [
          {
            childAssetId: 'tag:TIT005-10-01',
            childTag: 'TIT005-10-01',
            parentAssetId: 'tag:MAH005-10-01',
            parentTag: 'MAH005-10-01',
            note: 'Commissioned as one skid.',
            updatedAt: '2026-08-08T09:35:00.000Z',
          },
        ],
      },
    },
  },

  'override:list': {
    request: z.void(),
    response: z.object({ overrides: z.array(overrideRowSchema) }),
    example: { request: undefined, response: { overrides: [] } },
  },

  /** Removing an override is the undo: remove, then recompile. */
  'override:remove': {
    request: z.object({ childAssetId: z.string().min(1) }),
    response: z.object({
      removed: z.boolean(),
      overrides: z.array(overrideRowSchema),
    }),
    example: {
      request: { childAssetId: 'tag:TIT005-10-01' },
      response: { removed: true, overrides: [] },
    },
  },

  /* ------------------------------------------ workspace: Electrical Flow */

  /** Sources: nodes that feed something and are fed by nothing. */
  'flow:roots': {
    request: z.object({
      offset: z.number().int().nonnegative(),
      limit: z.number().int().positive().max(500),
    }),
    response: z.object({
      total: z.number().int().nonnegative(),
      rows: z.array(flowRootSchema),
    }),
    example: {
      request: { offset: 0, limit: 100 },
      response: {
        total: 1,
        rows: [
          {
            nodeId: 'tag:MAH005-10-01',
            tag: 'MAH005-10-01',
            matchStatus: 'model-confirmed',
            reachableCount: 4,
          },
        ],
      },
    },
  },

  /** One page of the source-to-load walk from one root, in pre-order. */
  'flow:walk': {
    request: z.object({
      rootNodeId: z.string().min(1),
      offset: z.number().int().nonnegative(),
      limit: z.number().int().positive().max(500),
    }),
    response: flowPageSchema,
    example: {
      request: { rootNodeId: 'tag:MAH005-10-01', offset: 0, limit: 100 },
      response: {
        total: 1,
        rows: [
          {
            nodeId: 'tag:MAH005-10-01',
            tag: 'MAH005-10-01',
            matchStatus: 'model-confirmed',
            depth: 0,
            viaCable: '',
            description: '',
            systemLabel: '005',
            building: 'D1',
            pmdInstruments: [],
            feedCount: 1,
            fedByCount: 0,
            multiFed: false,
          },
        ],
      },
    },
  },

  /* -------------------------------------------------- workspace: review */

  /** One page of the review queue. `kind: ''` means every kind. */
  'review:page': {
    request: z.object({
      kind: z.string(),
      offset: z.number().int().nonnegative(),
      limit: z.number().int().positive().max(500),
    }),
    response: reviewPageSchema,
    example: {
      request: { kind: '', offset: 0, limit: 50 },
      response: { total: 0, rows: [], kinds: [], undecidedCount: 0 },
    },
  },

  /**
   * Records a decision. Earlier decisions for the key are kept, never replaced.
   *
   * The key is whatever `reviewKey` in `@matchline/ssm-compiler` produced for the
   * item: the kind, then that kind's identifying fields, joined by U+241F SYMBOL
   * FOR UNIT SEPARATOR, with list members inside a field joined by `,`. A system
   * conflict is `kind ␟ assetId ␟ the proposed values, type-tagged and sorted` —
   * the values themselves rather than how many there were, so two different
   * conflicts over the same asset cannot inherit each other's decision.
   *
   * The renderer never assembles one of these. It sends back the key the row
   * arrived with, and `ipc-table.test.mjs` holds this example to what the
   * compiler actually emits.
   */
  'review:decide': {
    request: z.object({
      reviewKey: z.string().min(1),
      decision: decisionValueSchema,
      note: z.string(),
    }),
    response: z.object({ recorded: z.boolean() }),
    example: {
      request: {
        reviewKey: 'system-conflict␟tag:MAH001-10-01␟string:001,string:002',
        decision: 'accepted',
        note: '',
      },
      response: { recorded: true },
    },
  },

  /* ------------------------------------------------- workspace: exports */

  'export:generated-mel': {
    request: z.object({ path: z.string().min(1) }),
    response: z.object({ result: exportResultSchema }),
    example: {
      request: { path: '/Users/dragon/Dragon-MEL.xlsx' },
      response: {
        result: {
          written: true,
          path: '/Users/dragon/Dragon-MEL.xlsx',
          byteSize: 8192,
          note: '34 rows on the canonical column set.',
        },
      },
    },
  },

  /** Reads a site's own MEL layout and suggests a binding per column (§12.2). */
  'export:template-analyze': {
    request: z.object({ path: z.string().min(1) }),
    response: z.object({ analysis: templateAnalysisSchema }),
    example: {
      request: { path: '/Users/dragon/Site-Template.xlsx' },
      response: {
        analysis: {
          path: '/Users/dragon/Site-Template.xlsx',
          sheetName: 'Site Template',
          sheetNames: ['Site Template'],
          headerRow: 1,
          columns: [{ index: 0, header: 'UPN', suggestedField: 'systemKey', match: 'synonym' }],
          fieldChoices: ['systemKey', 'blank'],
        },
      },
    },
  },

  'export:template-mel': {
    request: z.object({
      path: z.string().min(1),
      bindings: z.array(templateBindingSchema).min(1),
    }),
    response: z.object({ result: exportResultSchema }),
    example: {
      request: {
        path: '/Users/dragon/Dragon-Site-MEL.xlsx',
        bindings: [{ templateColumn: 'UPN', field: 'systemKey' }],
      },
      response: {
        result: {
          written: true,
          path: '/Users/dragon/Dragon-Site-MEL.xlsx',
          byteSize: 6144,
          note: '34 rows on the site template’s own 1 columns.',
        },
      },
    },
  },

  /**
   * Captures a registry workbook's layout into the project, so every later EXTO
   * export comes out on the site's own columns.
   *
   * Returns the whole config rather than the template alone: the exports view
   * renders what is now stored, and a partial answer would let it show a
   * template the project does not actually hold.
   */
  'export:exto-template-capture': {
    request: z.object({ path: z.string().min(1) }),
    response: z.object({ config: projectConfigSchema }),
    example: {
      request: { path: '/Users/dragon/Dragon-Cx-Registry.xlsx' },
      response: {
        config: {
          ...EXAMPLE_CONFIG,
          extoTemplate: {
            version: 1,
            sheetName: 'data',
            headers: ['UPN', 'Equipment ID'],
            headerRowIndex: 0,
            matched: [
              { field: 'upn', columnIndex: 0, match: 'exact' },
              { field: 'equipmentId', columnIndex: 1, match: 'exact' },
            ],
            capturedFrom: { label: 'Dragon-Cx-Registry.xlsx' },
          },
        },
      },
    },
  },

  /** Forgets the captured layout; the export returns to the generic Rev21 map. */
  'export:exto-template-clear': {
    request: z.object({}),
    response: z.object({ config: projectConfigSchema }),
    example: {
      request: {},
      response: { config: EXAMPLE_CONFIG },
    },
  },

  'export:exto': {
    request: z.object({ path: z.string().min(1) }),
    response: z.object({ result: exportResultSchema }),
    example: {
      request: { path: '/Users/dragon/Dragon-EXTO.xlsx' },
      response: {
        result: {
          written: true,
          path: '/Users/dragon/Dragon-EXTO.xlsx',
          byteSize: 12288,
          note: '34 rows on the Rev21 upload sheet. No P6 schedule, so the milestone column is blank.',
        },
      },
    },
  },

  'export:predecessors': {
    request: z.object({ path: z.string().min(1) }),
    response: z.object({ result: exportResultSchema }),
    example: {
      request: { path: '/Users/dragon/Dragon-Predecessors.xlsx' },
      response: {
        result: {
          written: true,
          path: '/Users/dragon/Dragon-Predecessors.xlsx',
          byteSize: 4096,
          note: '3 systems, 1 predecessor edge.',
        },
      },
    },
  },

  /** §12.4: this compile against a stored earlier one. */
  'export:revision-diff': {
    request: z.object({
      path: z.string().min(1),
      previousCompileId: z.number().int().positive(),
    }),
    response: z.object({ result: exportResultSchema }),
    example: {
      request: { path: '/Users/dragon/Dragon-Revision-Diff.xlsx', previousCompileId: 1 },
      response: {
        result: {
          written: true,
          path: '/Users/dragon/Dragon-Revision-Diff.xlsx',
          byteSize: 5120,
          note: '1 added, 1 removed, 1 description changed, 1 parent moved.',
        },
      },
    },
  },

  /* ----------------------------------------- screen 9: profile packages */

  /** What is configured and what is not, in the wizard's own words. */
  'profile:sections': {
    request: z.void(),
    response: z.object({ sections: z.array(profileSectionSchema) }),
    example: {
      request: undefined,
      response: {
        sections: [
          {
            name: 'Tag anatomy',
            what: 'How a tag decomposes into role, system and family.',
            configured: true,
            detail: '4 segments taught.',
          },
        ],
      },
    },
  },

  /** Writes the portable JSON package (PRODUCT.md §13.3). */
  'profile:export': {
    request: z.object({ path: z.string().min(1) }),
    response: z.object({ result: exportResultSchema }),
    example: {
      request: { path: '/Users/dragon/Dragon.matchline-profile.json' },
      response: {
        result: {
          written: true,
          path: '/Users/dragon/Dragon.matchline-profile.json',
          byteSize: 2048,
          note: 'Profile package written. It carries decisions only — no model or spreadsheet rows.',
        },
      },
    },
  },

  /** Reads a package back into the draft and the screens 6-7 sections. */
  'profile:import': {
    request: z.object({ path: z.string().min(1) }),
    response: z.object({
      draft: draftProfileSchema,
      config: projectConfigSchema,
    }),
    example: {
      request: { path: '/Users/dragon/Dragon.matchline-profile.json' },
      response: { draft: EXAMPLE_DRAFT, config: EXAMPLE_CONFIG },
    },
  },

  /** Echo channel. Exists so the transport can be exercised end to end. */
  'dev:ping': {
    request: z.object({ message: z.string() }),
    response: z.object({ message: z.string() }),
    example: {
      request: { message: 'dragon' },
      response: { message: 'dragon' },
    },
  },
} as const satisfies Record<string, IpcChannelDeclaration>;

export type IpcChannelTable = typeof IPC_CHANNELS;
export type IpcChannelName = keyof IpcChannelTable & string;

export type IpcRequest<TChannel extends IpcChannelName> = z.infer<
  IpcChannelTable[TChannel]['request']
>;
export type IpcResponse<TChannel extends IpcChannelName> = z.infer<
  IpcChannelTable[TChannel]['response']
>;

/**
 * Channel names in declaration order. Derived from the table — never hand-written, so a
 * new channel is registered and exposed the moment its schemas exist.
 */
export const IPC_CHANNEL_NAMES: readonly IpcChannelName[] = Object.keys(
  IPC_CHANNELS,
) as IpcChannelName[];
