/**
 * Types for the vendored `src/exto/rev21-contract.js`: the approved VF Exto
 * Upload Template vocabulary and the helpers over it.
 *
 * Declarations only. The values are the JavaScript file's, byte for byte, and
 * `test/parity.test.mjs` is what holds them there.
 */

/** One Rev21 column of the upload template, as the rulebook numbers them. */
export interface ExtoRev21Column {
  readonly index: number;
  /** The audit row field the column fills. See `src/rows.ts` for the mapping. */
  readonly field: string;
  readonly header: string;
  /** Whether Exto refuses an upload that leaves the column blank. */
  readonly gating: boolean;
  /** The dropdown name the column validates against, or `''`. */
  readonly dropdown: string;
}

export declare const EXTO_REV21_SCHEMA_ID: string;
export declare const EXTO_REV21_COLUMNS: ReadonlyArray<ExtoRev21Column>;
export declare const EXTO_REV21_VOCABULARY: Readonly<Record<string, ReadonlyArray<string>>>;

export declare function extoRev21Norm(value: unknown): string;
export declare function extoRev21IsUpn(value: unknown): boolean;
export declare function extoRev21SystemsForUpn(upn: unknown): string[];
export declare function extoRev21IsSystemName(value: unknown): boolean;
export declare function extoRev21Canonical(field: string, value: unknown): string;
