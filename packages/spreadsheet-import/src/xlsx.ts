/**
 * The typed boundary around the vendored SheetJS bundle.
 *
 * `vendor/sheetjs.js` is a byte-identical copy of the frozen donor's
 * `packages/legacy-parity/src/vendor/sheetjs.js` (see `vendor/README.md`).
 * Nothing outside this file may touch it, and this file exposes only the four
 * things the engine needs: read a workbook, list its sheets, hand a worksheet
 * to the AoA scan, and write an AoA back out as .xlsx bytes.
 *
 * ## How the bundle is loaded
 *
 * The bundle is the browser build. Its footer picks a load path by sniffing the
 * environment: CommonJS `exports`, then `module.exports`, then AMD `define`,
 * and finally — the browser case — it populates the file-scoped `var XLSX`.
 * The donor is a single-file HTML app, so it has always taken the last path,
 * and the donor's own test harness reproduces that by running the bundle inside
 * a `node:vm` context with no `module`/`require`/`exports`
 * (`packages/legacy-parity/tests/support/harness.mjs`).
 *
 * We do the same with `new Function`, passing `undefined` for every name the
 * footer sniffs. This is not a stylistic choice: under the CommonJS path the
 * bundle's header runs `require('./cpexcel.js')` for the full codepage tables,
 * which the browser build does not ship, so requiring it throws outright — and
 * had it resolved, it would have changed text decoding away from the donor's
 * behavior. `new Function` also keeps every value in this realm, so worksheet
 * objects, `Array.isArray`, and typed arrays behave normally (a `node:vm`
 * context would hand back cross-realm objects).
 *
 * ## Macros are never executed
 *
 * SheetJS contains no formula evaluator and no macro interpreter; it is a
 * parser. Beyond that, {@link READ_OPTIONS} pins `bookVBA: false`, so a
 * workbook's `vbaProject.bin` (where VBA macros live) is not even retained in
 * memory, and `bookFiles: false`, so raw archive entries are dropped too.
 * Formula *text* is still parsed into `cell.f` — that is the donor's behavior,
 * which the AoA scan depends on — but a formula string is never evaluated; the
 * value the scan uses is the cached one Excel wrote into the file.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SpreadsheetReadError } from './errors.js';

/* ---- worksheet shapes ---- */

/**
 * One cell, limited to the fields the AoA scan reads.
 *
 * `v` is the raw value, `w` the formatted text Excel cached, `f` the formula
 * source, `t` the type code. SheetJS attaches more (`h`, `s`, `z`, …); they are
 * deliberately undeclared because nothing here is allowed to depend on them.
 */
export interface WorksheetCell {
  readonly t?: string;
  readonly v?: string | number | boolean | Date | null;
  readonly w?: string;
  readonly f?: string;
}

/** One row of a dense worksheet. Holes are real: Excel leaves gaps. */
export type DenseWorksheetRow = ReadonlyArray<WorksheetCell | null | undefined>;

/** A worksheet read with `dense: true`: an array of row arrays, plus `!ref`. */
export interface DenseWorksheet extends ReadonlyArray<DenseWorksheetRow | undefined> {
  readonly '!ref'?: string;
}

/** A worksheet read without `dense`: cells keyed by A1-style address. */
export interface SparseWorksheet {
  readonly [address: string]: WorksheetCell | string | undefined;
}

/** Either shape. Both must produce identical AoA output — donor invariant. */
export type Worksheet = DenseWorksheet | SparseWorksheet;

/** Dense worksheets are genuine arrays; sparse ones are plain objects. */
export function isDenseWorksheet(worksheet: Worksheet): worksheet is DenseWorksheet {
  return Array.isArray(worksheet);
}

/** The `!ref` range marker, or `undefined` on a sheet that never had cells. */
export function worksheetRef(worksheet: Worksheet): string | undefined {
  const ref: unknown = worksheet['!ref'];
  return typeof ref === 'string' ? ref : undefined;
}

/* ---- workbook handle ---- */

/** A parsed workbook, narrowed to what the engine reads from one. */
export interface WorkbookHandle {
  /** Sheet names in workbook order. */
  readonly sheetNames: readonly string[];
  /** The named sheet, or `undefined` if the workbook has no such sheet. */
  getSheet(name: string): Worksheet | undefined;
}

/** Options for {@link readWorkbook}. */
export interface ReadWorkbookOptions {
  /**
   * Read worksheets as arrays of row arrays instead of address-keyed objects.
   * Defaults to `true`, matching the donor app's own read
   * (`XLSX.read(bytes, { type: 'array', dense: true })`). Set `false` to
   * exercise the sparse path; both produce identical AoA output.
   */
  readonly dense?: boolean;
}

/**
 * Read options, fixed for every read this package performs.
 *
 * `type: 'array'` matches the donor. The three `false` flags are SheetJS
 * defaults restated explicitly, so the macro and raw-archive posture is
 * readable at the call site rather than inherited silently.
 */
const READ_OPTIONS = {
  type: 'array',
  /** VBA macro storage is discarded, not just left unexecuted. */
  bookVBA: false,
  /** Raw archive entries are not retained. */
  bookFiles: false,
  /** Style records are not parsed; the engine reads values only. */
  cellStyles: false,
} as const;

/** Write options, fixed for every write. Mirrors the donor's export path. */
const WRITE_OPTIONS = {
  bookType: 'xlsx',
  type: 'array',
} as const;

/**
 * Parse workbook bytes.
 *
 * @throws {SpreadsheetReadError} with reason `not-a-workbook` if the bytes are
 * not a workbook SheetJS can parse, or `vendor-unavailable` if the vendored
 * bundle cannot be loaded.
 */
export function readWorkbook(bytes: Uint8Array, options: ReadWorkbookOptions = {}): WorkbookHandle {
  const dense = options.dense ?? true;
  let parsed: unknown;
  try {
    parsed = sheetJs().read(bytes, { ...READ_OPTIONS, dense });
  } catch (error) {
    throw new SpreadsheetReadError({ kind: 'not-a-workbook', detail: messageOf(error) });
  }
  return toWorkbookHandle(parsed);
}

/** A cell value accepted by {@link writeWorkbook}. */
export type CellInput = string | number | boolean | null;

/** One sheet to write: a name and a rectangular-ish array of arrays. */
export interface SheetInput {
  readonly name: string;
  readonly aoa: ReadonlyArray<ReadonlyArray<CellInput>>;
}

/**
 * Write sheets to .xlsx bytes.
 *
 * Strings are written as text cells and numbers as numeric cells, so a string
 * `'001'` survives a round trip as `'001'` rather than collapsing to `1`.
 *
 * @throws {SpreadsheetReadError} with reason `no-sheets-to-write` when handed
 * an empty list — an .xlsx with no sheets is not a valid workbook — or
 * `invalid-sheet-name` for a name Excel will not accept.
 */
export function writeWorkbook(sheets: readonly SheetInput[]): Uint8Array {
  if (sheets.length === 0) throw new SpreadsheetReadError({ kind: 'no-sheets-to-write' });
  const lib = sheetJs();
  const book = lib.utils.book_new();
  for (const sheet of sheets) {
    /* Excel's own rules — 31 characters, no duplicates — are enforced by the
       bundle with a plain Error. Retype it so nothing that leaves this package
       is untyped. */
    try {
      lib.utils.book_append_sheet(book, lib.utils.aoa_to_sheet(sheet.aoa), sheet.name);
    } catch (error) {
      throw new SpreadsheetReadError({
        kind: 'invalid-sheet-name',
        name: sheet.name,
        detail: messageOf(error),
      });
    }
  }
  return toBytes(lib.write(book, WRITE_OPTIONS));
}

/** `XLSX.utils.decode_cell` — an A1 address to zero-based row/column. */
export function decodeCell(address: string): CellPosition {
  return sheetJs().utils.decode_cell(address);
}

/** `XLSX.utils.format_cell` — the display text of a cell with no cached `w`. */
export function formatCell(cell: WorksheetCell): string {
  return sheetJs().utils.format_cell(cell);
}

/** A zero-based cell position. */
export interface CellPosition {
  readonly r: number;
  readonly c: number;
}

/**
 * Absolute path of the vendored bundle. Exported so the integrity test can
 * hash it. `dist/` and `src/` sit at the same depth under the package root, so
 * the same relative walk works whether this module is running as source or as
 * compiled output.
 */
export const VENDOR_SHEETJS_PATH: string = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'vendor',
  'sheetjs.js',
);

/* ---- vendor loading ---- */

/** The slice of the bundle's surface this file calls. Nothing else is typed. */
interface SheetJsUtils {
  decode_cell(address: string): CellPosition;
  format_cell(cell: WorksheetCell): string;
  aoa_to_sheet(aoa: ReadonlyArray<ReadonlyArray<CellInput>>): unknown;
  book_new(): unknown;
  book_append_sheet(book: unknown, sheet: unknown, name: string): void;
}

interface SheetJsLib {
  readonly version: string;
  readonly utils: SheetJsUtils;
  read(data: Uint8Array, options: Readonly<Record<string, unknown>>): unknown;
  write(book: unknown, options: Readonly<Record<string, unknown>>): unknown;
}

let loaded: SheetJsLib | undefined;

/** The bundle, evaluated once per process on first use. */
function sheetJs(): SheetJsLib {
  if (loaded !== undefined) return loaded;
  let produced: unknown;
  try {
    const source = readFileSync(VENDOR_SHEETJS_PATH, 'utf8');
    /* Every parameter shadows a name the bundle's footer sniffs, so the
       browser branch is the only one it can take. See the file header. */
    const factory = new Function(
      'module',
      'exports',
      'require',
      'define',
      'window',
      'self',
      'document',
      'cptable',
      `${source}\n;return XLSX;`,
    );
    produced = factory(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
  } catch (error) {
    throw new SpreadsheetReadError({
      kind: 'vendor-unavailable',
      path: VENDOR_SHEETJS_PATH,
      detail: messageOf(error),
    });
  }
  if (!isSheetJsLib(produced)) {
    throw new SpreadsheetReadError({
      kind: 'vendor-unavailable',
      path: VENDOR_SHEETJS_PATH,
      detail: 'the bundle evaluated but did not expose read/write/utils',
    });
  }
  loaded = produced;
  return loaded;
}

function isSheetJsLib(value: unknown): value is SheetJsLib {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate['read'] !== 'function') return false;
  if (typeof candidate['write'] !== 'function') return false;
  if (typeof candidate['version'] !== 'string') return false;
  const utils = candidate['utils'];
  if (typeof utils !== 'object' || utils === null) return false;
  const members = utils as Record<string, unknown>;
  for (const name of [
    'decode_cell',
    'format_cell',
    'aoa_to_sheet',
    'book_new',
    'book_append_sheet',
  ]) {
    if (typeof members[name] !== 'function') return false;
  }
  return true;
}

/* ---- boundary conversions ---- */

function toWorkbookHandle(parsed: unknown): WorkbookHandle {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new SpreadsheetReadError({ kind: 'not-a-workbook', detail: 'parser returned no object' });
  }
  const book = parsed as Record<string, unknown>;
  const names = book['SheetNames'];
  const sheets = book['Sheets'];
  if (!Array.isArray(names) || !names.every((name): name is string => typeof name === 'string')) {
    throw new SpreadsheetReadError({ kind: 'not-a-workbook', detail: 'SheetNames is not a string[]' });
  }
  if (typeof sheets !== 'object' || sheets === null) {
    throw new SpreadsheetReadError({ kind: 'not-a-workbook', detail: 'Sheets is not an object' });
  }
  const bySheetName = sheets as Record<string, unknown>;
  const sheetNames: readonly string[] = [...names];
  return {
    sheetNames,
    getSheet(name: string): Worksheet | undefined {
      if (!sheetNames.includes(name)) return undefined;
      const sheet = bySheetName[name];
      if (typeof sheet !== 'object' || sheet === null) return undefined;
      return sheet as Worksheet;
    },
  };
}

/**
 * `XLSX.write` with `type: 'array'` returns an ArrayBuffer in this build; older
 * ones returned a Uint8Array. Both are normalized to bytes we own.
 */
function toBytes(written: unknown): Uint8Array {
  if (written instanceof Uint8Array) return new Uint8Array(written);
  if (written instanceof ArrayBuffer) return new Uint8Array(written);
  if (Array.isArray(written)) return Uint8Array.from(written as readonly number[]);
  throw new SpreadsheetReadError({
    kind: 'not-a-workbook',
    detail: 'the writer returned neither bytes nor a buffer',
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
