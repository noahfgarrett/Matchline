import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { detectWorkbook } from '@matchline/connectivity-import';
import { openExtractionCache } from '@matchline/model-schema';
import { SOURCE_ROLES, type SourceRole } from '@matchline/project-store';
import {
  readMelTable,
  readWorkbook,
  sheetAoa,
  type MelMapping,
} from '@matchline/spreadsheet-import';
import type { MelCatalogRow } from '@matchline/system-resolver';

import {
  SOURCE_ROLE_VALUES,
  type WireSheetSummary,
  type WireSourceStatus,
} from '../../shared/schemas.js';

/**
 * Screen 1: work out what a dropped file *is*, and what state it is in.
 *
 * Identification is by extension first, then by opening the file. Nothing is
 * guessed from a file name alone: an `.xlsx` becomes an EasyPower source only
 * because `detectWorkbook` recognized EasyPower headers inside it, and a
 * `.matchline-cache` becomes a model source only because `openExtractionCache`
 * validated it.
 *
 * Every number here is computed in main. The renderer receives one summary line
 * per file (APP.md "IPC contract": no wholesale caches over the wire).
 */

/** The wire role list and the store's list must stay identical. */
const ROLE_LISTS_AGREE: readonly SourceRole[] = SOURCE_ROLE_VALUES;
void ROLE_LISTS_AGREE;
const STORE_ROLES_ARE_WIRE_ROLES: ReadonlyArray<(typeof SOURCE_ROLE_VALUES)[number]> =
  SOURCE_ROLES;
void STORE_ROLES_ARE_WIRE_ROLES;

/** One `(role, fileName)` row a file wants registered. */
export interface SourceRegistration {
  readonly role: SourceRole;
  readonly status: WireSourceStatus;
  readonly note: string;
  readonly sheets: readonly WireSheetSummary[];
  /**
   * True for a raw Navisworks document, which is registered but not read.
   *
   * It decides one thing at the registration site: whether the file's own hash
   * is also the hash of what the engine reads. For a cache or a workbook it is
   * — the file IS the data. For an NWD it is not: the data is the extraction
   * cache the service produces from it, and until then the source has none
   * (P0-2, "a raw NWD is not a ready source until a valid cache is
   * associated").
   */
  readonly needsExtraction: boolean;
}

export type SourceIdentification =
  | { readonly recognized: true; readonly registrations: readonly SourceRegistration[] }
  | { readonly recognized: false; readonly reason: string };

/** Extraction caches produced by the Navisworks extractor (docs/EXTRACTION.md). */
const MODEL_CACHE_EXTENSIONS: readonly string[] = ['.matchline-cache', '.sqlite', '.db'];
/** Raw Navisworks documents. Readable only after a Windows extraction run. */
const NAVISWORKS_EXTENSIONS: readonly string[] = ['.nwd', '.nwf', '.nwc'];
const WORKBOOK_EXTENSIONS: readonly string[] = ['.xlsx', '.xlsm'];
const P6_EXTENSIONS: readonly string[] = ['.xer'];

/** `Dragon.matchline-cache` has a two-part extension `path.extname` cannot see. */
function extensionOf(filePath: string): string {
  const fileName = path.basename(filePath).toLowerCase();
  for (const candidate of MODEL_CACHE_EXTENSIONS) {
    if (fileName.endsWith(candidate)) {
      return candidate;
    }
  }
  return path.extname(fileName);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A count with its noun, singular or plural. `1 sheet`, `3 sheets`. */
function count(value: number, singular: string, plural: string): string {
  return `${String(value)} ${value === 1 ? singular : plural}`;
}

/* --------------------------------------------------------------- model files */

function identifyExtractionCache(absolutePath: string): SourceIdentification {
  let objectCount: number;
  let sourceModelCount: number;
  let inputFileName: string;

  const cache = (() => {
    try {
      return openExtractionCache(absolutePath);
    } catch (error: unknown) {
      return messageOf(error);
    }
  })();

  if (typeof cache === 'string') {
    return {
      recognized: false,
      reason: `This looks like an extraction cache but Matchline could not read it: ${cache}`,
    };
  }

  try {
    objectCount = cache.objectCount();
    sourceModelCount = cache.sourceModels().length;
    inputFileName = cache.meta().inputFileName;
  } finally {
    cache.close();
  }

  return {
    recognized: true,
    registrations: [
      {
        role: 'model',
        status: 'ready',
        note:
          `Extracted from ${inputFileName}: ${count(objectCount, 'object', 'objects')} ` +
          `across ${count(sourceModelCount, 'source model', 'source models')}. ` +
          // "Joins", not "is": a project may register several model sources and
          // the universe is all of them together (P0-1).
          'It joins the equipment universe every other source is matched against.',
        sheets: [],
        needsExtraction: false,
      },
    ],
  };
}

/**
 * A raw Navisworks file is registered, and then extracted.
 *
 * Registration is instant and extraction is not: the file goes in as a queued
 * source and the extraction service takes it from there, opening Navisworks in
 * the background and associating the cache it produces (P0-2). The user never
 * names a cache file, and never sees one.
 *
 * Extraction runs on Windows, because that is where Navisworks runs. On any
 * other machine the queued job fails immediately with a message that says so —
 * the honest answer arrives from the job, in the row, rather than being
 * guessed at here from `process.platform`.
 */
function identifyNavisworksFile(fileName: string): SourceIdentification {
  return {
    recognized: true,
    registrations: [
      {
        role: 'model',
        status: 'queued',
        note:
          `${fileName} is a Navisworks model. Matchline is extracting it — that opens the file ` +
          'in Navisworks in the background and can take a few minutes on a large model. The ' +
          'row updates as it goes.',
        sheets: [],
        needsExtraction: true,
      },
    ],
  };
}

/* ------------------------------------------------------------------ workbooks */

/** Which document family a recognized sheet makes the file a source of. */
const KIND_TO_ROLE: Readonly<Record<string, SourceRole>> = {
  easypower: 'easypower',
  'cable-schedule': 'cable-schedule',
  pmd: 'pmd',
  mel: 'mel',
};

/** Plain-language names, so the list does not make the user learn our vocabulary. */
const ROLE_LABELS: Readonly<Record<SourceRole, string>> = {
  model: 'Model',
  easypower: 'EasyPower one-line',
  'cable-schedule': 'Cable schedule',
  pmd: 'PMD',
  mel: 'Master equipment list',
  p6: 'P6 schedule',
  'prior-ssm': 'Previous SSM',
};

export function roleLabel(role: SourceRole): string {
  return ROLE_LABELS[role];
}

/* --------------------------------------------------------- short source names */

/** `model:level-1.nwc-2` -> base `level-1.nwc`, duplicate suffix `2`. */
const DUPLICATE_SUFFIX = /-(\d+)$/;

/**
 * Compact per-source names for the places a row has to name several sources at
 * once — the Property Catalog's coverage disclosure, the inclusion impact.
 *
 * A `sourceId` is `role:slug` (`@matchline/project-store`'s `deriveSourceId`),
 * and printing it whole turns "which file is missing the tag" into a line of
 * mostly-extension. So the role prefix and the extension come off, and the
 * duplicate-basename suffix stays: `level-1-2` is a different file from
 * `level-1` and a label that hid the difference would be worse than a long one.
 *
 * Computed for the whole set rather than one id at a time because shortening is
 * only safe if it stays unique: two sources whose stems collide (`A.nwd` and
 * `A.nwc`) both keep their full slug instead. Every source gets a non-empty
 * label, and no two sources get the same one.
 */
export function shortSourceLabels(sourceIds: Iterable<string>): ReadonlyMap<string, string> {
  const withoutRole = new Map<string, string>();
  const stems = new Map<string, string>();
  const stemUsers = new Map<string, number>();

  for (const sourceId of sourceIds) {
    const colon = sourceId.indexOf(':');
    const slug = colon < 0 ? sourceId : sourceId.slice(colon + 1);
    const bare = slug === '' ? sourceId : slug;
    withoutRole.set(sourceId, bare);

    const suffix = DUPLICATE_SUFFIX.exec(bare);
    const base = suffix === null ? bare : bare.slice(0, bare.length - suffix[0].length);
    const dot = base.lastIndexOf('.');
    const trimmed = dot > 0 ? base.slice(0, dot) : base;
    const stem =
      trimmed === '' ? bare : suffix === null ? trimmed : `${trimmed}-${suffix[1] ?? ''}`;

    stems.set(sourceId, stem);
    stemUsers.set(stem, (stemUsers.get(stem) ?? 0) + 1);
  }

  const labels = new Map<string, string>();
  for (const [sourceId, stem] of stems) {
    const bare = withoutRole.get(sourceId) ?? sourceId;
    labels.set(sourceId, (stemUsers.get(stem) ?? 0) > 1 ? bare : stem);
  }
  return labels;
}

function identifyWorkbook(absolutePath: string, fileName: string): SourceIdentification {
  let detections: ReturnType<typeof detectWorkbook>;
  try {
    detections = detectWorkbook(readFileSync(absolutePath));
  } catch (error: unknown) {
    return {
      recognized: false,
      reason: `Matchline could not open ${fileName} as a workbook: ${messageOf(error)}`,
    };
  }

  const byRole = new Map<SourceRole, WireSheetSummary[]>();
  const unrecognized: string[] = [];

  for (const { sheet, detection } of detections) {
    const role = KIND_TO_ROLE[detection.kind];
    if (role === undefined) {
      unrecognized.push(sheet);
      continue;
    }
    const summaries = byRole.get(role) ?? [];
    summaries.push({
      sheet,
      kind: detection.kind,
      confidence: detection.confidence,
      // Detection counts AoA rows from 0 and uses -1 for "no header row found";
      // the UI shows worksheet rows, which start at 1.
      headerRow: detection.headerRow < 0 ? 0 : detection.headerRow + 1,
      mappedColumnCount: Object.keys(detection.mappedColumns).length,
    });
    byRole.set(role, summaries);
  }

  if (byRole.size === 0) {
    const listed = unrecognized.length === 0 ? 'no sheets' : unrecognized.join(', ');
    return {
      recognized: false,
      reason:
        `${fileName} opened, but none of its sheets look like an EasyPower export, ` +
        `a cable schedule, a PMD or a master equipment list (${listed}). ` +
        'Matchline reads these by their column headers, so check the header row.',
    };
  }

  const registrations: SourceRegistration[] = [];
  for (const [role, sheets] of byRole) {
    const headerless = sheets.filter(
      (summary: WireSheetSummary): boolean => summary.headerRow === 0,
    ).length;
    registrations.push({
      role,
      status: headerless === sheets.length ? 'needs-attention' : 'ready',
      note:
        headerless === sheets.length
          ? `Recognized as ${ROLE_LABELS[role]} by sheet name, but no header row matched. ` +
            'Matchline will not read it until the headers are found.'
          : `${ROLE_LABELS[role]}: ${count(sheets.length, 'sheet', 'sheets')} recognized ` +
            `by their column headers (${sheets
              .map((summary: WireSheetSummary): string => summary.sheet)
              .join(', ')}).`,
      sheets,
      needsExtraction: false,
    });
  }
  // Deterministic order regardless of sheet order inside the workbook.
  registrations.sort((left, right) => (left.role < right.role ? -1 : 1));
  return { recognized: true, registrations };
}

/* ---------------------------------------------------------------- the switch */

export function identifySource(absolutePath: string): SourceIdentification {
  const fileName = path.basename(absolutePath);
  const extension = extensionOf(absolutePath);

  if (MODEL_CACHE_EXTENSIONS.includes(extension)) {
    return identifyExtractionCache(absolutePath);
  }
  if (NAVISWORKS_EXTENSIONS.includes(extension)) {
    return identifyNavisworksFile(fileName);
  }
  if (WORKBOOK_EXTENSIONS.includes(extension)) {
    return identifyWorkbook(absolutePath, fileName);
  }
  if (P6_EXTENSIONS.includes(extension)) {
    return {
      recognized: true,
      registrations: [
        {
          role: 'p6',
          status: 'ready',
          note:
            'Primavera P6 export. Used later for milestone dates and sequencing; ' +
            'it plays no part in screens 1-5.',
          sheets: [],
          needsExtraction: false,
        },
      ],
    };
  }

  return {
    recognized: false,
    reason:
      `Matchline does not read "${extension === '' ? fileName : extension}" files. ` +
      'It reads extraction caches (.matchline-cache), Navisworks files (.nwd), ' +
      'workbooks (.xlsx, .xlsm) and P6 exports (.xer).',
  };
}

/* ------------------------------------------------------- dropped-path intake */

/** Every extension `identifySource` knows how to do something with. */
const ACCEPTED_EXTENSIONS: readonly string[] = [
  ...MODEL_CACHE_EXTENSIONS,
  ...NAVISWORKS_EXTENSIONS,
  ...WORKBOOK_EXTENSIONS,
  ...P6_EXTENSIONS,
];

/**
 * The largest file a drop may name, in bytes, for the files main reads whole.
 *
 * Not a product limit — a real extraction cache is tens of megabytes. It is
 * here so that a path main did not choose cannot make it read something
 * unbounded: workbooks go through `readFileSync`, and "read this 40 GB file
 * into a Buffer" is a denial of service one `invoke` long.
 */
const MAX_DROPPED_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * The same cap for a raw Navisworks document, which is a different number
 * because it is a different risk.
 *
 * Nothing ever reads an NWD into memory: main hashes it in a stream and hands
 * the path to the extractor (P0-2). So the cap here is not protecting a buffer
 * — it is only refusing something absurd — and it has to sit above the real
 * models people drop, which on a large site genuinely pass two gigabytes.
 * Refusing one of those would refuse the whole feature for the projects that
 * need it most.
 */
const MAX_DROPPED_MODEL_BYTES = 64 * 1024 * 1024 * 1024;

/** A dropped path main declined to hand to the project, and why. */
export interface RejectedDroppedPath {
  readonly fileName: string;
  readonly reason: string;
}

export interface DroppedPathScreening {
  /** Paths that survived every check, absolute and de-duplicated. */
  readonly accepted: readonly string[];
  readonly rejected: readonly RejectedDroppedPath[];
}

/**
 * What main will accept from a drag, and why it is safe to accept it at all.
 *
 * A drop is a real user gesture, but the *path* does not come from one. The OS
 * hands the renderer a `File`, the preload turns it into a string with
 * `webUtils.getPathForFile`, and by the time it reaches main it is
 * indistinguishable from a string the renderer made up — which is exactly the
 * assumption `security/path-grants.ts` is built on.
 *
 * So this channel does not trust the string, and it does not mint a grant
 * either. Two decisions, for two different reasons:
 *
 * 1. **No grant.** A grant is not only a read capability: `export:generated-mel`
 *    and friends *write* to a granted path. Granting whatever the renderer calls
 *    a drop would let a compromised renderer nominate any `.xlsx` on the disk
 *    and then overwrite it, with no dialog anywhere in the story. Nothing in the
 *    drop flow needs a lasting grant — the project stores the path itself and
 *    main re-reads it from there — so the capability is never created.
 * 2. **Screened here, in main.** Only regular files, only extensions
 *    `identifySource` has a reader for, only under a size cap. What is left is
 *    the worst case worth accepting: a renderer that lies gets a source file
 *    registered in the open project, which is the one thing this channel is for,
 *    and is recoverable with the Remove button.
 *
 * `~/.ssh/id_rsa` has no accepted extension and never reaches a reader. A
 * directory dragged in is refused rather than walked.
 */
export function screenDroppedPaths(paths: readonly string[]): DroppedPathScreening {
  const accepted: string[] = [];
  const rejected: RejectedDroppedPath[] = [];
  const seen = new Set<string>();

  for (const candidate of paths) {
    const absolutePath = path.resolve(candidate);
    const fileName = path.basename(absolutePath);
    const extension = extensionOf(absolutePath);

    if (seen.has(absolutePath)) {
      continue;
    }
    seen.add(absolutePath);

    if (!ACCEPTED_EXTENSIONS.includes(extension)) {
      rejected.push({
        fileName,
        reason:
          `Matchline does not read ${fileName}. Drop extraction caches ` +
          '(.matchline-cache), Navisworks files (.nwd), workbooks (.xlsx, .xlsm) ' +
          'or P6 exports (.xer).',
      });
      continue;
    }

    const stats = (() => {
      try {
        return statSync(absolutePath);
      } catch {
        return null;
      }
    })();

    if (stats === null || !stats.isFile()) {
      rejected.push({
        fileName,
        reason: `${fileName} is not a file Matchline can open. Drop the file itself, not a folder.`,
      });
      continue;
    }

    const sizeCap = NAVISWORKS_EXTENSIONS.includes(extension)
      ? MAX_DROPPED_MODEL_BYTES
      : MAX_DROPPED_BYTES;
    if (stats.size > sizeCap) {
      rejected.push({
        fileName,
        reason:
          `${fileName} is larger than Matchline will read from a drop. ` +
          'Use the Choose files button if it really is a source file.',
      });
      continue;
    }

    accepted.push(absolutePath);
  }

  return { accepted, rejected };
}

/* ------------------------------------------------------------------ MEL rows */

/** MEL columns the System Resolver can use. Everything else is ignored here. */
interface MelColumnNames {
  readonly equipmentTag: string;
  readonly upn?: string;
  readonly systemDescription?: string;
}

/**
 * The MEL rows a resolver `mel-lookup` rung joins against.
 *
 * The detector reports column *indices*; `readMelTable` maps by header *text*.
 * The header row is read once to translate between them, so the workbook is
 * parsed by the shared reader rather than by a second ad-hoc scan here.
 */
export function readMelCatalogRows(
  absolutePath: string,
  sheets: readonly WireSheetSummary[],
): readonly MelCatalogRow[] {
  const fileName = path.basename(absolutePath);
  const bytes = readFileSync(absolutePath);
  const workbook = readWorkbook(bytes);
  const rows: MelCatalogRow[] = [];

  for (const summary of sheets) {
    if (summary.kind !== 'mel' || summary.headerRow === 0) {
      continue;
    }
    // Back to the 0-based AoA index the readers use.
    const headerRow = summary.headerRow - 1;
    const { aoa } = sheetAoa(workbook.getSheet(summary.sheet));
    const headers = aoa[headerRow];
    if (headers === undefined) {
      continue;
    }

    const names = melColumnNames(headers);
    if (names === null) {
      continue;
    }

    const mapping: { equipmentTag: string; upn?: string; systemDescription?: string } = {
      equipmentTag: names.equipmentTag,
    };
    if (names.upn !== undefined) {
      mapping.upn = names.upn;
    }
    if (names.systemDescription !== undefined) {
      mapping.systemDescription = names.systemDescription;
    }

    const table = readMelTable(bytes, summary.sheet, mapping, headerRow);
    table.rows.forEach((row: Readonly<Record<string, string>>, index: number): void => {
      const equipmentTag = (row['equipmentTag'] ?? '').trim();
      const systemKey = (row['upn'] ?? '').trim();
      const systemDescription = (row['systemDescription'] ?? '').trim();
      if (equipmentTag === '' && systemKey === '') {
        return;
      }
      const entry: {
        equipmentTag?: string;
        systemKey?: string;
        systemDescription?: string;
        sourceFile: string;
        sheet: string;
        row: number;
      } = {
        sourceFile: fileName,
        sheet: summary.sheet,
        // `headerRow` is 0-based; the first data row is the one after it, and
        // the wire counts worksheet rows from 1.
        row: headerRow + index + 2,
      };
      if (equipmentTag !== '') {
        entry.equipmentTag = equipmentTag;
      }
      if (systemKey !== '') {
        entry.systemKey = systemKey;
      }
      if (systemDescription !== '') {
        entry.systemDescription = systemDescription;
      }
      rows.push(entry);
    });
  }

  return rows;
}

/**
 * The MEL sheet a compile joins against, addressed the way
 * `@matchline/compiler`'s `MelWorkbookInput` wants it.
 *
 * `readMelCatalogRows` above answers screen 5's live preview from an already
 * loaded file; this answers screen 8, which hands the compiler the bytes and
 * the explicit column mapping instead. Both read the same headers through the
 * same {@link melColumnNames}, so the preview and the compile can never join on
 * different columns.
 */
export interface MelSheetDescriptor {
  readonly sheetName: string;
  readonly mapping: MelMapping;
  /** Zero-based AoA row holding the headers, as the compiler counts them. */
  readonly headerRow: number;
}

/** `null` when no recognized sheet carries a readable equipment-tag column. */
export function melSheetDescriptor(
  bytes: Uint8Array,
  sheets: readonly WireSheetSummary[],
): MelSheetDescriptor | null {
  const workbook = readWorkbook(bytes);

  for (const summary of sheets) {
    if (summary.kind !== 'mel' || summary.headerRow === 0) {
      continue;
    }
    const headerRow = summary.headerRow - 1;
    const { aoa } = sheetAoa(workbook.getSheet(summary.sheet));
    const headers = aoa[headerRow];
    if (headers === undefined) {
      continue;
    }
    const names = melColumnNames(headers);
    if (names === null) {
      continue;
    }

    const mapping: { equipmentTag: string; upn?: string; systemDescription?: string } = {
      equipmentTag: names.equipmentTag,
    };
    if (names.upn !== undefined) {
      mapping.upn = names.upn;
    }
    if (names.systemDescription !== undefined) {
      mapping.systemDescription = names.systemDescription;
    }
    return { sheetName: summary.sheet, mapping, headerRow };
  }

  return null;
}

/**
 * Which header text carries the tag, the UPN and the system description.
 *
 * Deliberately narrow and literal: these three are the only MEL columns the
 * resolver reads, and a header that does not match one of the known spellings
 * is left alone rather than guessed at.
 */
function melColumnNames(headers: readonly string[]): MelColumnNames | null {
  const fold = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, '');

  let equipmentTag: string | undefined;
  let upn: string | undefined;
  let systemDescription: string | undefined;

  for (const header of headers) {
    const folded = fold(header);
    if (equipmentTag === undefined && (folded === 'equipmenttag' || folded === 'tag')) {
      equipmentTag = header;
      continue;
    }
    if (upn === undefined && (folded === 'upn' || folded === 'systemkey')) {
      upn = header;
      continue;
    }
    if (
      systemDescription === undefined &&
      (folded === 'systemdescription' || folded === 'description')
    ) {
      systemDescription = header;
    }
  }

  if (equipmentTag === undefined) {
    return null;
  }
  const names: { equipmentTag: string; upn?: string; systemDescription?: string } = {
    equipmentTag,
  };
  if (upn !== undefined) {
    names.upn = upn;
  }
  if (systemDescription !== undefined) {
    names.systemDescription = systemDescription;
  }
  return names;
}
