import { z } from 'zod';

import {
  addSourceResultSchema,
  anatomyPreviewSchema,
  assetPreviewSchema,
  classCountSchema,
  draftPatchSchema,
  draftProfileSchema,
  modelScanSchema,
  projectSummarySchema,
  propertyCatalogRowSchema,
  propertySortSchema,
  recentProjectSchema,
  resolverPreviewSchema,
  sourceRoleSchema,
  sourceSummarySchema,
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
  schemaVersion: 1,
  createdAt: '2026-08-08T09:00:00.000Z',
  modifiedAt: '2026-08-08T09:12:00.000Z',
  sourceCount: 2,
  savedRevision: null,
  hasModel: true,
} as const;

const EXAMPLE_DRAFT = {
  profileId: 'dragon',
  name: 'Dragon',
  version: 1,
  propertyMappings: {
    equipmentTag: { category: 'Dragon Data', name: 'Tag' },
    description: null,
    equipmentType: null,
    building: null,
    nativeDiscipline: null,
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

  /** Opens an existing project and restores its most recent saved profile. */
  'project:open': {
    request: z.object({ path: z.string().min(1) }),
    response: z.object({ project: projectSummarySchema }),
    example: {
      request: { path: '/Users/dragon/Dragon.matchline' },
      response: { project: EXAMPLE_PROJECT },
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
      request: { paths: ['/Users/dragon/Dragon.matchline-cache'] },
      response: {
        results: [
          {
            outcome: 'added',
            source: {
              role: 'model',
              fileName: 'Dragon.matchline-cache',
              sha256: 'a'.repeat(64),
              byteSize: 262144,
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

  'source:list': {
    request: z.void(),
    response: z.object({ sources: z.array(sourceSummarySchema) }),
    example: {
      request: undefined,
      response: {
        sources: [
          {
            role: 'mel',
            fileName: 'Dragon-MEL.xlsx',
            sha256: 'b'.repeat(64),
            byteSize: 8192,
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

  'source:remove': {
    request: z.object({ role: sourceRoleSchema, fileName: z.string().min(1) }),
    response: z.object({ removed: z.boolean() }),
    example: {
      request: { role: 'mel', fileName: 'Dragon-MEL.xlsx' },
      response: { removed: true },
    },
  },

  /* -------------------------------- screen 2: model scan + Property Catalog */

  'model:scan': {
    request: z.void(),
    response: z.object({ scan: modelScanSchema.nullable() }),
    example: {
      request: undefined,
      response: {
        scan: {
          fileName: 'Dragon.nwd',
          objectCount: 42,
          propertyNameCount: 11,
          sourceModels: [
            { sourceModelId: 1, fileName: 'Dragon-Mechanical.nwc', objectCount: 18 },
          ],
          extractedAtUtc: '2026-08-01T00:00:00Z',
          navisworksVersion: '2025',
          warningCount: 0,
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

  /** Placeholder until the compile service lands. */
  'compile:run': {
    request: z.object({ projectPath: z.string().min(1) }),
    response: z.object({
      compileId: z.string().min(1),
      assetCount: z.number().int().nonnegative(),
    }),
    example: {
      request: { projectPath: '/Users/dragon/Dragon.matchline' },
      response: { compileId: 'compile-1', assetCount: 0 },
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
