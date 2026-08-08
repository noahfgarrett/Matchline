/**
 * Every way a spreadsheet read can be refused, as data rather than as a
 * message string.
 *
 * Callers switch on `reason.kind`; the human-readable message is derived from
 * the reason so the two can never drift apart. Reads are refused outright
 * rather than completed partially — a mapping that does not fit the sheet in
 * front of us means the caller's assumption about the workbook is wrong, and
 * guessing a column would put the wrong tags in front of an engineer.
 */
export type SpreadsheetReadReason =
  | { readonly kind: 'vendor-unavailable'; readonly path: string; readonly detail: string }
  | { readonly kind: 'not-a-workbook'; readonly detail: string }
  | {
      readonly kind: 'sheet-not-found';
      readonly sheetName: string;
      readonly availableSheets: readonly string[];
    }
  | { readonly kind: 'empty-mapping' }
  | {
      readonly kind: 'unknown-mel-fields';
      readonly fields: readonly string[];
      readonly knownFields: readonly string[];
    }
  | {
      readonly kind: 'header-row-out-of-range';
      readonly headerRow: number;
      readonly rowCount: number;
    }
  | {
      readonly kind: 'missing-columns';
      readonly missing: readonly MissingColumn[];
      readonly availableHeaders: readonly string[];
    }
  | { readonly kind: 'no-sheets-to-write' }
  | { readonly kind: 'invalid-sheet-name'; readonly name: string; readonly detail: string };

/** One mapped field whose header was not found on the header row. */
export interface MissingColumn {
  readonly field: string;
  readonly header: string;
}

/** Thrown by every reader and writer in this package. */
export class SpreadsheetReadError extends Error {
  readonly reason: SpreadsheetReadReason;

  constructor(reason: SpreadsheetReadReason) {
    super(describeSpreadsheetReadReason(reason));
    this.name = 'SpreadsheetReadError';
    this.reason = reason;
  }
}

/** The message shown for a reason. Exhaustive: a new reason will not compile. */
export function describeSpreadsheetReadReason(reason: SpreadsheetReadReason): string {
  switch (reason.kind) {
    case 'vendor-unavailable':
      return `cannot load the vendored SheetJS bundle at ${reason.path}: ${reason.detail}`;
    case 'not-a-workbook':
      return `the supplied bytes did not parse as a workbook: ${reason.detail}`;
    case 'sheet-not-found':
      return `workbook has no sheet named '${reason.sheetName}' (available: ${formatList(reason.availableSheets)})`;
    case 'empty-mapping':
      return 'a column mapping must name at least one field';
    case 'unknown-mel-fields':
      return `MEL mapping names field(s) ${formatList(reason.fields)} that this reader does not know (known fields: ${formatList(reason.knownFields)})`;
    case 'header-row-out-of-range':
      return `header row index ${reason.headerRow} is outside the sheet, which holds ${reason.rowCount} row(s)`;
    case 'missing-columns':
      return `header row is missing mapped column(s) ${reason.missing
        .map((column) => `${column.field} → '${column.header}'`)
        .join(', ')} (available headers: ${formatList(reason.availableHeaders)})`;
    case 'no-sheets-to-write':
      return 'a workbook must contain at least one sheet';
    case 'invalid-sheet-name':
      return `sheet name '${reason.name}' was refused: ${reason.detail}`;
    default: {
      const exhaustive: never = reason;
      throw new Error(`unhandled SpreadsheetReadReason: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function formatList(values: readonly string[]): string {
  return values.length === 0 ? '<none>' : values.map((value) => `'${value}'`).join(', ');
}
