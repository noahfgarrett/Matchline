/** Types for the vendored `src/audit/model.js`. Only what the wrapper uses. */

/**
 * Where one audit row came from, as the rulebook prints it on a finding.
 *
 * SSM-Audit fills this from the workbook a person picked. Matchline has no
 * workbook to point at, so `src/rows.ts` fills `sheet` with the register name
 * and `row` with the row's position in the built upload sheet.
 */
export interface AuditRowSource {
  readonly file: string;
  readonly sheet: string;
  /** One-based, as a spreadsheet counts. */
  readonly row: number;
  readonly columns: Readonly<Record<string, number>>;
}

export declare const SSM_AUDIT_SCHEMA_VERSION: number;
export declare function auditNormId(value: unknown): string;
export declare function auditSplitReferences(value: unknown): string[];
export declare function auditColumnName(index: number): string;
export declare function auditFingerprint(value: unknown): string;
