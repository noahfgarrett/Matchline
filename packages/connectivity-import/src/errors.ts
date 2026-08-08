/**
 * Every way a connectivity import can be refused, as data rather than as a
 * message string. Mirrors `@matchline/spreadsheet-import`'s `errors.ts`: the
 * caller switches on `reason.kind`, and the human-readable text is derived from
 * the reason so the two cannot drift.
 *
 * Imports are refused outright rather than completed partially. A mapping that
 * does not fit the sheet in front of us means the caller's assumption about the
 * workbook is wrong, and a column index that lands past the end of every row
 * would otherwise read as "every row is missing a tag" — a plausible-looking
 * empty result is worse than an error.
 */

import type { SheetKind } from './types.js';

export type ConnectivityImportReason =
  | {
      readonly kind: 'header-row-out-of-range';
      readonly headerRow: number;
      readonly rowCount: number;
    }
  | {
      readonly kind: 'mapped-column-out-of-range';
      readonly role: string;
      readonly columnIndex: number;
      readonly headerWidth: number;
    }
  | {
      readonly kind: 'missing-mapped-column';
      readonly sheet: string;
      readonly sheetKind: SheetKind;
      readonly role: string;
    };

/** Thrown by every importer in this package. */
export class ConnectivityImportError extends Error {
  readonly reason: ConnectivityImportReason;

  constructor(reason: ConnectivityImportReason) {
    super(describeConnectivityImportReason(reason));
    this.name = 'ConnectivityImportError';
    this.reason = reason;
  }
}

/** The message shown for a reason. Exhaustive: a new reason will not compile. */
export function describeConnectivityImportReason(reason: ConnectivityImportReason): string {
  switch (reason.kind) {
    case 'header-row-out-of-range':
      return `header row index ${reason.headerRow} is outside the sheet, which holds ${reason.rowCount} row(s)`;
    case 'mapped-column-out-of-range':
      return `column ${reason.columnIndex} mapped to '${reason.role}' is outside the header row, which is ${reason.headerWidth} column(s) wide`;
    case 'missing-mapped-column':
      return `sheet '${reason.sheet}' was read as ${reason.sheetKind} but its mapping names no '${reason.role}' column`;
    default: {
      const exhaustive: never = reason;
      throw new Error(`unhandled ConnectivityImportReason: ${JSON.stringify(exhaustive)}`);
    }
  }
}
