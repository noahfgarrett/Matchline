/**
 * Refusals this package raises on its own behalf.
 *
 * Everything about *reading* a workbook — bytes that do not parse, a sheet that
 * is not there, a header row index off the end — is already
 * `SpreadsheetReadError`'s to describe, and is left to it. What is here is the
 * one refusal that is about the EXTO layer's own contract rather than about
 * spreadsheets: a file the user picked as a template that has no header row for
 * this package to capture.
 *
 * A reason is data rather than a message string, so the desktop can decide how
 * to say it and the two can never drift apart. The same shape
 * `@matchline/mel-export`'s `MelExportError` uses, for the same reason.
 */

export type ExtoExportReason = {
  readonly kind: 'template-has-no-header-row';
  readonly sheetName: string;
  readonly scannedRows: number;
};

/** Thrown by the template layer. */
export class ExtoExportError extends Error {
  readonly reason: ExtoExportReason;

  constructor(reason: ExtoExportReason) {
    super(describeExtoExportReason(reason));
    this.name = 'ExtoExportError';
    this.reason = reason;
  }
}

/** The message shown for a reason. Exhaustive: a new reason will not compile. */
export function describeExtoExportReason(reason: ExtoExportReason): string {
  switch (reason.kind) {
    case 'template-has-no-header-row':
      return (
        `sheet '${reason.sheetName}' has no header row in its first ` +
        `${String(reason.scannedRows)} row(s): a template needs a row carrying two or more ` +
        'column headings'
      );
    default: {
      const exhaustive: never = reason.kind;
      throw new Error(`unhandled ExtoExportReason: ${JSON.stringify(exhaustive)}`);
    }
  }
}
