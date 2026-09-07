/**
 * Types for the vendored `src/audit/engine.js`: the SSM Audit rulebook.
 *
 * Declarations only, and deliberately narrow — the wrapper reads the rule
 * catalogue, calls {@link runSsmAudit}, and reads the findings it returns.
 * Nothing here restates a rule; the rules are the JavaScript file's, byte for
 * byte, and `test/parity.test.mjs` is what holds them there.
 */
import type { AuditRowSource } from './model.js';

/** How much a finding is claiming. `blocker` is "Exto would refuse this row". */
export type SsmAuditSeverity = 'blocker' | 'error' | 'warning' | 'info';

/** Which body of rules a finding comes from. */
export type SsmAuditSource = 'registry' | 'sop' | 'logic';

export type SsmAuditCategory =
  | 'structure'
  | 'dependencies'
  | 'metadata'
  | 'milestones'
  | 'item-masters'
  | 'headers';

/** How strongly the rulebook stands behind the rule. */
export type SsmAuditConfidence = 'required' | 'strong' | 'description-rated';

/** One rule: a stable id and the plain sentence saying what must be true. */
export interface SsmAuditRule {
  readonly id: string;
  readonly version: number;
  readonly source: SsmAuditSource;
  readonly category: SsmAuditCategory;
  readonly title: string;
  /** What must be true, in an engineer's words. Printed verbatim everywhere. */
  readonly statement: string;
  readonly standardRef: string;
  readonly confidence: SsmAuditConfidence;
  readonly enabled: boolean;
  readonly disabledReason: string;
}

/** A relationship a finding names, for a UI that wants to draw it. */
export interface SsmAuditRelationship {
  readonly kind: 'parent' | 'dependency' | 'loop';
  readonly nodes: ReadonlyArray<{
    readonly tag: string;
    readonly role: 'this' | 'parent' | 'dependency' | 'step';
    readonly upn: string;
    readonly discipline: string;
  }>;
}

/** One thing the rulebook found, about one row. */
export interface SsmAuditFinding {
  readonly schemaVersion: number;
  readonly id: string;
  readonly fingerprint: string;
  readonly rule: SsmAuditRule;
  readonly severity: SsmAuditSeverity;
  readonly category: SsmAuditCategory;
  readonly equipmentId: string;
  readonly row: number;
  readonly sheet: string;
  readonly field: string;
  /** What was seen, in an engineer's words. */
  readonly why: string;
  readonly actual: string;
  readonly expected: string;
  readonly recommendation: string;
  readonly relatedEquipmentId: string;
  readonly relationship: SsmAuditRelationship | null;
  readonly searchKey: string;
}

/**
 * One row as the rulebook reads it: the Rev21 fields, plus where it came from.
 *
 * An index signature rather than 44 named members, because the field list is
 * the vendored contract's (`EXTO_REV21_COLUMNS`) and restating it here would be
 * a second answer to what a row carries. `src/rows.ts` is what fills it, and it
 * fills every field the contract names.
 */
export interface SsmAuditRow {
  readonly _source: AuditRowSource;
  readonly [field: string]: string | AuditRowSource | undefined;
}

/** What {@link runSsmAudit} is handed. Only `rows` is read. */
export interface SsmAuditSnapshot {
  readonly rows: ReadonlyArray<SsmAuditRow>;
}

export interface SsmAuditOptions {
  /**
   * The legal VF Item Master names. Defaults to the bundled list; an explicit
   * empty array turns the vocabulary check off without disabling the rule.
   */
  readonly itemMasterVocabulary?: ReadonlyArray<string>;
}

/** Counts by severity, category and rule source, plus the overall verdict. */
export interface SsmAuditSummary {
  readonly rows: number;
  readonly checks: number;
  readonly findings: number;
  readonly severity: Readonly<Record<SsmAuditSeverity, number>>;
  readonly category: Readonly<Record<SsmAuditCategory, number>>;
  readonly source: Readonly<Record<SsmAuditSource, number>>;
  readonly status: 'blocked' | 'review' | 'ready';
}

export interface SsmAuditResult {
  readonly schemaVersion: number;
  readonly standard: string;
  readonly rows: ReadonlyArray<SsmAuditRow>;
  readonly findings: ReadonlyArray<SsmAuditFinding>;
  readonly headerIds: ReadonlyArray<string>;
  readonly summary: SsmAuditSummary;
}

export declare const SSM_AUDIT_STANDARD: string;
export declare const SSM_AUDIT_SEVERITIES: ReadonlyArray<SsmAuditSeverity>;
export declare const SSM_AUDIT_CATEGORIES: ReadonlyArray<SsmAuditCategory>;
export declare const SSM_AUDIT_SOURCES: ReadonlyArray<{
  readonly id: SsmAuditSource;
  readonly label: string;
  readonly description: string;
}>;
export declare const SSM_AUDIT_RULES: Readonly<Record<string, SsmAuditRule>>;

export declare function runSsmAudit(
  snapshot: SsmAuditSnapshot,
  options?: SsmAuditOptions,
): SsmAuditResult;
