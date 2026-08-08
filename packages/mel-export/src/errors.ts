/**
 * Ways the exporter can be asked for something it must not guess at.
 *
 * Every one of these is a caller mistake — a mapping that names a column the
 * §12.1 contract does not have, a template with no header row, a rename hint
 * that does not describe either revision. The alternative to refusing is a
 * workbook full of empty cells or a diff that quietly disagrees with the two
 * revisions it claims to compare, and neither is visible to the engineer
 * holding the file.
 *
 * Reads and writes of *workbooks* still raise `SpreadsheetReadError` from
 * `@matchline/spreadsheet-import` — a bad sheet name or unparseable bytes is
 * that package's vocabulary, not a second one spelled here.
 */

import { CANONICAL_MEL_COLUMNS } from './columns.js';
import type { CanonicalMelField } from './columns.js';

/** Every §12.1 field name, as data, for error messages and runtime checks. */
export const CANONICAL_MEL_FIELDS: ReadonlyArray<CanonicalMelField> = CANONICAL_MEL_COLUMNS.map(
  (column) => column.field,
);

const CANONICAL_MEL_FIELD_SET: ReadonlySet<string> = new Set<string>(CANONICAL_MEL_FIELDS);

/** Whether a string names a §12.1 field. The runtime half of the type. */
export function isCanonicalMelField(value: string): value is CanonicalMelField {
  return CANONICAL_MEL_FIELD_SET.has(value);
}

/** Every way a mapping or a revision hint can fail to fit. */
export type MelExportReason =
  | {
      readonly kind: 'unknown-canonical-field';
      /** The names that are not §12.1 fields, in the order they were given. */
      readonly fields: ReadonlyArray<string>;
      readonly knownFields: ReadonlyArray<string>;
    }
  | { readonly kind: 'empty-template-mapping' }
  | { readonly kind: 'template-has-no-header-row'; readonly sheetName: string }
  | {
      readonly kind: 'comparison-mapping-missing-tag';
      /** The fields the mapping did bind, so the caller can see the gap. */
      readonly mappedFields: ReadonlyArray<CanonicalMelField>;
    }
  | {
      readonly kind: 'inapplicable-rename-hint';
      readonly fromTag: string;
      readonly toTag: string;
      readonly detail: string;
    };

/** Thrown by the template, comparison and revision-diff entry points. */
export class MelExportError extends Error {
  readonly reason: MelExportReason;

  constructor(reason: MelExportReason) {
    super(describeMelExportReason(reason));
    this.name = 'MelExportError';
    this.reason = reason;
  }
}

/** The message shown for a reason. Exhaustive: a new reason will not compile. */
export function describeMelExportReason(reason: MelExportReason): string {
  switch (reason.kind) {
    case 'unknown-canonical-field':
      return `mapping names field(s) ${formatList(reason.fields)} that the canonical MEL does not have (known fields: ${formatList(reason.knownFields)})`;
    case 'empty-template-mapping':
      return 'a template mapping must name at least one column';
    case 'template-has-no-header-row':
      return `sheet '${reason.sheetName}' has no non-empty row to read headers from`;
    case 'comparison-mapping-missing-tag':
      return `a comparison mapping must bind equipmentTag — it is the only join key (mapped: ${formatList(reason.mappedFields)})`;
    case 'inapplicable-rename-hint':
      return `rename hint '${reason.fromTag}' → '${reason.toTag}' does not describe these revisions: ${reason.detail}`;
    default: {
      const exhaustive: never = reason;
      throw new Error(`unhandled MelExportReason: ${JSON.stringify(exhaustive)}`);
    }
  }
}

function formatList(values: ReadonlyArray<string>): string {
  return values.length === 0 ? '<none>' : values.map((value) => `'${value}'`).join(', ');
}
