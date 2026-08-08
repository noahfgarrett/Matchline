import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { detectWorkbook } from '@matchline/connectivity-import';
import { openExtractionCache } from '@matchline/model-schema';
import { SOURCE_ROLES, type SourceRole } from '@matchline/project-store';
import { readMelTable, readWorkbook, sheetAoa } from '@matchline/spreadsheet-import';
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
}

export type SourceIdentification =
  | { readonly recognized: true; readonly registrations: readonly SourceRegistration[] }
  | { readonly recognized: false; readonly reason: string };

export interface FileDigest {
  readonly sha256: string;
  readonly byteSize: number;
}

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

export function digestFile(absolutePath: string): FileDigest {
  const bytes = readFileSync(absolutePath);
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    byteSize: statSync(absolutePath).size,
  };
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
          'This is the equipment universe every other source is matched against.',
        sheets: [],
      },
    ],
  };
}

/**
 * A raw Navisworks file is registered, not read.
 *
 * Reading one needs Navisworks Manage on Windows (docs/WINDOWS-RUNBOOK.md). The
 * file is still recorded so the project knows which document a site is built
 * from; the extractor produces a `.matchline-cache` that gets added alongside.
 */
function identifyNavisworksFile(fileName: string): SourceIdentification {
  return {
    recognized: true,
    registrations: [
      {
        role: 'model',
        status: 'requires-windows-extraction',
        note:
          `${fileName} is a Navisworks file. Matchline reads models through an ` +
          'extraction cache, which is produced by running the Matchline extractor on a ' +
          'Windows machine with Navisworks Manage. Add the resulting .matchline-cache ' +
          'file here when you have it.',
        sheets: [],
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
