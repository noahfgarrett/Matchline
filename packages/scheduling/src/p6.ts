/**
 * P6 schedule ingestion (PRODUCT.md §3 input 5, donor `src/io/p6.js`).
 *
 * Two shapes reach this engine, and the donor handled both:
 *
 * - **XER** — P6's native plain-text export. `%T` names a table, `%F` lists its
 *   field names, `%R` is a row. Only `TASK` and `TASKPRED` matter:
 *   {@link readXerSchedule}.
 * - **XLSX activity export** — the sheet an engineer gets out of P6's Activities
 *   view, read under an explicit column mapping:
 *   {@link readP6ActivitySheet}.
 *
 * The two differ in what they can carry, and that difference is what drives the
 * milestone ladder's rungs (`ladder.ts`):
 *
 * | | milestone flag | equipment column | UPN column |
 * |---|---|---|---|
 * | XER | yes, from `task_type` | no | no |
 * | XLSX | no such column | when mapped | when mapped |
 *
 * So an XER alone can only reach rung 3 (a UPN read out of a milestone's name),
 * while a sheet with an Equipment ID column reaches rung 1. That is the donor's
 * behavior, and its own tests assert exactly this split.
 *
 * P6 is strictly optional. Nothing downstream may require it: an absent
 * schedule simply lands every asset on the ladder's bottom rung.
 */

import type { Provenance } from '@matchline/domain';
import { readMappedTable } from '@matchline/spreadsheet-import';
import type { SheetAoa } from '@matchline/spreadsheet-import';

import { clean } from './text.js';

/* ---- activities ---- */

/**
 * One scheduled activity, whichever shape it was read from.
 *
 * Absent values are `''` rather than `undefined`: every field is a string the
 * source either stated or did not, and the ladder's tests read more clearly
 * against `''` than against an optional. This matches the donor's task shape.
 */
export interface P6Activity {
  /** `task_id` in an XER; the Activity ID column in a sheet. */
  readonly activityId: string;
  /** `task_code` in an XER; the same Activity ID in a sheet. */
  readonly activityCode: string;
  readonly name: string;
  /** True only when the source said so — an XER `task_type` of `TT_Mile`/`TT_FinMile`. */
  readonly isMilestone: boolean;
  /** The equipment tag an activity names outright. Sheets only. */
  readonly equipmentTag: string;
  /** The system identifier (UPN) in an explicit column. Sheets only. */
  readonly upn: string;
  /** Display text of the start date cell, carried, never re-parsed. */
  readonly startDate: string;
  /** Display text of the finish date cell, carried, never re-parsed. */
  readonly finishDate: string;
  readonly provenance: Provenance;
}

/**
 * A `TASKPRED` relation: `activityId` cannot start until `predecessorActivityId`
 * is satisfied.
 *
 * Read because it is part of the file format and the donor parsed it. Nothing
 * in this package consumes it — the predecessor matrix is derived from the
 * model's own dependencies (`predecessors.ts`), not from P6's opinion.
 */
export interface P6Link {
  readonly activityId: string;
  readonly predecessorActivityId: string;
  readonly provenance: Provenance;
}

/** What one P6 source contributed. */
export interface P6Schedule {
  readonly activities: ReadonlyArray<P6Activity>;
  readonly links: ReadonlyArray<P6Link>;
  readonly stats: P6ReadStats;
}

/** Counts a reviewer checks after importing a schedule. */
export interface P6ReadStats {
  readonly activityCount: number;
  readonly milestoneCount: number;
  readonly linkCount: number;
  /** Rows that named neither an activity id nor an activity name. */
  readonly skippedRowCount: number;
}

/* ---- XER ---- */

/** Options for {@link readXerSchedule}. */
export interface ReadXerOptions {
  /** File name recorded on every provenance record. */
  readonly sourceFile: string;
}

/** The `task_type` values P6 uses for the two kinds of milestone. */
const MILESTONE_TASK_TYPE = /^TT_(Mile|FinMile)$/i;

/**
 * Parse an XER export.
 *
 * Unknown tables are ignored and a truncated file yields whatever parsed, which
 * is the donor's tolerance: an XER is an optional input, so a malformed one
 * must degrade rather than fail a compile.
 *
 * ## Provenance
 *
 * `Provenance.sourceRef` has two shapes, `model-object` and `sheet-row`
 * (`@matchline/domain`), and an XER record is neither. It is recorded as a
 * `sheet-row` whose `sheet` is the XER table name (`TASK`, `TASKPRED`) and
 * whose `row` is the zero-based line index in the file — the closest true
 * statement the existing vocabulary can make, and enough to navigate back to
 * the line that produced the value.
 */
export function readXerSchedule(text: string, options: ReadXerOptions): P6Schedule {
  const activities: P6Activity[] = [];
  const links: P6Link[] = [];
  const lines = String(text ?? '').split(/\r?\n/);

  let table = '';
  let fields: string[] = [];
  for (let index = 0; index < lines.length; index++) {
    const cells = (lines[index] ?? '').split('\t');
    const marker = cells[0];
    if (marker === '%T') {
      table = clean(cells[1]).toUpperCase();
      fields = [];
      continue;
    }
    if (marker === '%F') {
      fields = cells.slice(1).map((field) => clean(field).toLowerCase());
      continue;
    }
    if (marker !== '%R') continue;

    const row = new Map<string, string>();
    fields.forEach((field, position) => {
      row.set(field, clean(cells[position + 1]));
    });
    const provenance: Provenance = {
      sourceFile: options.sourceFile,
      sourceRef: { kind: 'sheet-row', sheet: table, row: index },
    };

    if (table === 'TASK') {
      activities.push({
        activityId: row.get('task_id') ?? '',
        activityCode: row.get('task_code') ?? '',
        name: row.get('task_name') ?? '',
        isMilestone: MILESTONE_TASK_TYPE.test(row.get('task_type') ?? ''),
        equipmentTag: '',
        upn: '',
        startDate: '',
        finishDate: '',
        provenance,
      });
    } else if (table === 'TASKPRED') {
      links.push({
        activityId: row.get('task_id') ?? '',
        predecessorActivityId: row.get('pred_task_id') ?? '',
        provenance,
      });
    }
  }

  return { activities, links, stats: statsOf(activities, links, 0) };
}

/* ---- XLSX activity sheet ---- */

/** The fields {@link readP6ActivitySheet} can bind to columns. */
export type P6Field =
  | 'activityId'
  | 'activityName'
  | 'equipmentTag'
  | 'upn'
  | 'startDate'
  | 'finishDate';

/**
 * `{ field: header text }` for one activity sheet.
 *
 * Explicit, never detected. The donor sniffed headers (`detectP6`, matching a
 * normalized `activityid`/`activityname` and an optional `equipmentid`/`upn`);
 * in Matchline that guesswork belongs to the mapping wizard, and the engine is
 * handed the answer — the same split `@matchline/spreadsheet-import` documents
 * for every other workbook read. Reading the wrong column silently is how wrong
 * tags reach an engineer's screen.
 */
export interface P6ColumnMapping {
  readonly activityId: string;
  readonly activityName: string;
  readonly equipmentTag?: string;
  readonly upn?: string;
  readonly startDate?: string;
  readonly finishDate?: string;
}

/** Options for {@link readP6ActivitySheet}. */
export interface ReadP6SheetOptions {
  /** File name recorded on every provenance record. */
  readonly sourceFile: string;
  /** Sheet name recorded on every provenance record. */
  readonly sheetName: string;
  /** Zero-based AoA row holding the headers. Defaults to `0`. */
  readonly headerRow?: number;
}

/**
 * Read a P6 Activities export.
 *
 * Column binding — including the typed `missing-columns` error listing every
 * header the sheet does have — is `readMappedTable`'s. The row walk is done
 * here rather than through that function's records for two reasons: the donor's
 * skip rule is its own (a row is skipped only when it has neither an activity
 * id nor a name, not when every mapped cell is blank), and a record carries no
 * address, so provenance would lose the worksheet row. `SheetAoa.rowNums` is
 * used so the row reported is the one an engineer sees in Excel's gutter, not
 * the index within a scan that skipped blank rows.
 *
 * Every activity from a sheet has `isMilestone: false`: an Activities export has
 * no `task_type` column, so milestone status can only come from the name
 * pattern the ladder applies. That is the donor's behavior, stated outright.
 *
 * @throws {SpreadsheetReadError} from `readMappedTable` when a mapped header is
 * not on the header row, or the header row is not in the sheet.
 */
export function readP6ActivitySheet(
  sheet: SheetAoa,
  columns: P6ColumnMapping,
  options: ReadP6SheetOptions,
): P6Schedule {
  const headerRow = options.headerRow ?? 0;
  const mapping: Record<string, string> = {};
  for (const [field, header] of Object.entries(columns)) {
    if (typeof header === 'string' && header !== '') mapping[field] = header;
  }
  const table = readMappedTable(sheet.aoa, mapping, { headerRow });

  const columnIndex = new Map<string, number>();
  for (const column of table.columns) columnIndex.set(column.field, column.columnIndex);
  const cellAt = (row: ReadonlyArray<string>, field: P6Field): string => {
    const index = columnIndex.get(field);
    return index === undefined ? '' : clean(row[index]);
  };

  const activities: P6Activity[] = [];
  let skippedRowCount = 0;
  for (let index = headerRow + 1; index < sheet.aoa.length; index++) {
    const row = sheet.aoa[index];
    if (row === undefined) continue;
    const activityId = cellAt(row, 'activityId');
    const name = cellAt(row, 'activityName');
    if (activityId === '' && name === '') {
      skippedRowCount++;
      continue;
    }
    activities.push({
      activityId,
      activityCode: activityId,
      name,
      isMilestone: false,
      equipmentTag: cellAt(row, 'equipmentTag'),
      upn: cellAt(row, 'upn'),
      startDate: cellAt(row, 'startDate'),
      finishDate: cellAt(row, 'finishDate'),
      provenance: {
        sourceFile: options.sourceFile,
        sourceRef: {
          kind: 'sheet-row',
          sheet: options.sheetName,
          row: sheet.rowNums[index] ?? index,
        },
      },
    });
  }

  return { activities, links: [], stats: statsOf(activities, [], skippedRowCount) };
}

/** Counts, shared by both readers. */
function statsOf(
  activities: ReadonlyArray<P6Activity>,
  links: ReadonlyArray<P6Link>,
  skippedRowCount: number,
): P6ReadStats {
  return {
    activityCount: activities.length,
    milestoneCount: activities.filter((activity) => activity.isMilestone).length,
    linkCount: links.length,
    skippedRowCount,
  };
}
