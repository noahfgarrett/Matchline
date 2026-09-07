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

/** One dropdown value the Upload Template refuses, as `extoRev21ValidatePartial` reports it. */
export interface ExtoRev21Issue {
  /** The audit row field whose value is not in the list. */
  readonly field: string;
  readonly value: string;
  /** The dropdown the value was checked against. */
  readonly dropdown: string;
  readonly reason: string;
}

/** How `extoRev21SystemName` settled — or why it could not. */
export type ExtoRev21SystemNameStatus =
  /** No UPN was supplied, so there was nothing to look up. */
  | 'missing-upn'
  /** `<UPN> <description>` is itself an approved System Name. */
  | 'exact'
  /** The UPN owns exactly one approved name and the caller allowed that shortcut. */
  | 'unique-upn'
  /** The UPN is approved but the description reaches none of its names. */
  | 'description-mismatch'
  /** No approved System Name belongs to this UPN at all. */
  | 'unknown-system';

export interface ExtoRev21SystemNameResult {
  /** The approved spelling, or `''` when the status is not `exact`/`unique-upn`. */
  readonly value: string;
  readonly status: ExtoRev21SystemNameStatus;
  /** Every approved System Name for the UPN, so a refusal can list the choices. */
  readonly candidates: ReadonlyArray<string>;
}

export declare function extoRev21ValidatePartial(record: unknown): ExtoRev21Issue[];
/** Every approved UPN that occurs in `tag` after a nomenclature boundary. */
export declare function extoRev21UpnCandidates(tag: unknown): string[];
export declare function extoRev21SystemName(
  upn: unknown,
  description: unknown,
  allowUniqueUpn?: boolean,
): ExtoRev21SystemNameResult;
/** I&C and Instrumentation both mean FACILITIES MONITORING SYSTEM. */
export declare function extoRev21EffectiveDiscipline(value: unknown): string;
