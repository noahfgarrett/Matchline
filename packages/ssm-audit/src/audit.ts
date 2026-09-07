/**
 * The SSM Audit gate: a compiled project, read by the SSM-Audit rulebook.
 *
 * ## What this package is, and what it deliberately is not
 *
 * The rulebook is not written here. `vendor/` holds SSM-Audit's own
 * `engine.js`, `model.js`, `rev21-contract.js`, `vf-item-masters.js` and
 * `core/text.js`, byte for byte, and `test/parity.test.mjs` fails the moment
 * one of them drifts from the checkout next door. A rule that needs changing
 * is changed in SSM-Audit and re-vendored; a rule changed here would mean two
 * apps quietly disagreeing about the same SOP, which is the one failure a
 * shared rulebook exists to prevent (DECISIONS.md).
 *
 * What is written here is the adapter: compiled assets in, findings out, each
 * one carrying the compiled `assetId` behind the tag so the review queue can
 * point at equipment rather than at a string.
 *
 * ## Disabling a rule
 *
 * The rulebook's own `enabled` flag is baked into frozen rule objects at module
 * load, so it cannot be turned off per project without editing vendored code.
 * A disabled rule is therefore filtered out of the findings here, and reported
 * as absent from {@link SsmAuditReport.rulesEnabled}. The rule still runs —
 * `checksRun` counts every check the engine performed — because what a site
 * switches off is a rule's *findings*, not the engine's arithmetic, and a count
 * that moved when somebody hid a rule would stop being comparable across
 * compiles.
 */

import type { IdentityIndex } from '@matchline/identity';

import type {
  SsmAuditFinding,
  SsmAuditRule,
  SsmAuditSeverity,
} from '../vendor/audit/engine.js';
import { SSM_AUDIT_RULES, runSsmAudit } from '../vendor/audit/engine.js';

import type { AuditableAsset } from './rows.js';
import { buildAuditRows } from './rows.js';

/**
 * What the audit is handed.
 *
 * Structural rather than `CompiledProject` itself: the compiler depends on this
 * package, so importing its type here would be a cycle. Every compiled project
 * satisfies this shape, and so does a hand-built fixture, which is what makes
 * the rules testable without running a compile.
 */
export interface AuditableProject {
  readonly generatedMel: { readonly assets: ReadonlyArray<AuditableAsset> };
  /** Stage 5's lookup, used to put the compiled asset id back on a finding. */
  readonly identityIndex: Pick<IdentityIndex, 'byExactTag'>;
}

/** Options for {@link auditCompiledProject}. */
export interface AuditProjectOptions {
  /**
   * Rule ids whose findings the site has switched off, from
   * `SiteProfileV2.ssmAudit.disabledRuleIds`. Unknown ids are ignored: a
   * profile written against a newer rulebook must not fail a compile.
   */
  readonly disabledRuleIds?: ReadonlyArray<string>;
  /** The trained VF item-master vocabulary, when the project has one. */
  readonly itemMasterVocabulary?: ReadonlyArray<string>;
}

/**
 * One finding, addressed to compiled equipment.
 *
 * Everything the rulebook said, verbatim — its words are written for an
 * engineer reading the report cold, and rewording them here would put a second
 * voice on the same finding — plus the two things only Matchline can add: the
 * asset id behind the tag, and the same for the related equipment.
 */
export interface AuditFinding {
  readonly ruleId: string;
  readonly title: string;
  /** What must be true, in the rulebook's words. */
  readonly statement: string;
  readonly severity: SsmAuditSeverity;
  /** The Equipment ID the finding is about, exactly as the row carries it. */
  readonly equipmentId: string;
  /**
   * The compiled asset behind {@link equipmentId}, or `null`.
   *
   * `null` when the tag names no asset or names more than one — a duplicated
   * tag is precisely what one of these rules reports, and picking one of the
   * two would file the finding against equipment nobody chose.
   */
  readonly assetId: string | null;
  /** The other end of a relationship finding. `''` when there is none. */
  readonly relatedEquipmentId: string;
  readonly relatedAssetId: string | null;
  /** The Rev21 column the finding is about, as the rulebook names it. */
  readonly field: string;
  /** What was seen. */
  readonly why: string;
  /** What was expected instead. */
  readonly expected: string;
  readonly recommendation: string;
  /** The value the row actually carried. Part of what makes a finding unique. */
  readonly actual: string;
  /** Where the row sits in the upload sheet, one-based. */
  readonly row: number;
}

/** One rule, as a screen lists it: the statement, and how often it fired. */
export interface AuditRuleReport {
  readonly ruleId: string;
  readonly title: string;
  readonly statement: string;
  readonly source: SsmAuditRule['source'];
  readonly category: SsmAuditRule['category'];
  readonly confidence: SsmAuditRule['confidence'];
  /** False when the site switched it off. Its findings are then absent. */
  readonly enabled: boolean;
  /** Findings this compile produced. Always `0` for a disabled rule. */
  readonly findingCount: number;
  /**
   * The most severe level this rule's findings carried in this compile, or
   * `null` when it produced none.
   *
   * A rule is not one severity: the rulebook grades several by what it found —
   * an instrument whose tag disagrees with its parent is an `error`, and the
   * same rule drops to `info` when only the tag disagrees. So this is a
   * measurement of this compile, not a property of the rule, which is why it
   * lives here and not on the rule itself.
   */
  readonly severity: SsmAuditSeverity | null;
}

/** Every severity, with how many findings carried it. */
export type AuditSeverityCounts = Readonly<Record<SsmAuditSeverity, number>>;

/** What one audit run found. */
export interface SsmAuditReport {
  /** Severity first (blocker, error, warning, info), then the engine's order. */
  readonly findings: ReadonlyArray<AuditFinding>;
  readonly bySeverity: AuditSeverityCounts;
  /** Checks the engine performed, disabled rules included. */
  readonly checksRun: number;
  /** Every rule in the rulebook, with its count and whether it is switched on. */
  readonly rulesEnabled: ReadonlyArray<AuditRuleReport>;
  /** Rows audited: one per upload row, which is one per compiled asset. */
  readonly rowCount: number;
}

/** Severities in report order, so a caller never has to spell the order out. */
export const AUDIT_SEVERITY_ORDER: ReadonlyArray<SsmAuditSeverity> = [
  'blocker',
  'error',
  'warning',
  'info',
];

/**
 * Run the SSM Audit rulebook over a compiled project.
 *
 * Pure and total: no input is rejected, and the same project always produces
 * the same report in the same order. A project with no assets produces no
 * findings and a rule list with every count at zero, which is a different — and
 * more useful — answer than an empty report.
 */
export function auditCompiledProject(
  project: AuditableProject,
  options: AuditProjectOptions = {},
): SsmAuditReport {
  const disabled = new Set(options.disabledRuleIds ?? []);

  const rowOptions: { itemMasterVocabulary?: ReadonlyArray<string> } = {};
  if (options.itemMasterVocabulary !== undefined) {
    rowOptions.itemMasterVocabulary = options.itemMasterVocabulary;
  }
  const rows = buildAuditRows(project.generatedMel.assets, rowOptions);

  const result = runSsmAudit({ rows: rows.map((entry) => entry.row) });

  const assetIdOf = assetIdLookup(project.identityIndex);
  const findings: AuditFinding[] = [];
  const counts = new Map<string, number>();
  const worst = new Map<string, SsmAuditSeverity>();
  for (const finding of result.findings) {
    if (disabled.has(finding.rule.id)) {
      continue;
    }
    counts.set(finding.rule.id, (counts.get(finding.rule.id) ?? 0) + 1);
    // The engine sorts by severity, so the first finding a rule produces is
    // already its most severe one.
    if (!worst.has(finding.rule.id)) {
      worst.set(finding.rule.id, finding.severity);
    }
    findings.push(auditFindingOf(finding, assetIdOf));
  }

  const bySeverity: Record<SsmAuditSeverity, number> = {
    blocker: 0,
    error: 0,
    warning: 0,
    info: 0,
  };
  for (const finding of findings) {
    bySeverity[finding.severity] += 1;
  }

  return {
    findings,
    bySeverity,
    checksRun: result.summary.checks,
    rulesEnabled: ruleReports(disabled, counts, worst),
    rowCount: rows.length,
  };
}

/** Every rule the rulebook carries, in id order, with this compile's counts. */
function ruleReports(
  disabled: ReadonlySet<string>,
  counts: ReadonlyMap<string, number>,
  worst: ReadonlyMap<string, SsmAuditSeverity>,
): ReadonlyArray<AuditRuleReport> {
  return Object.values(SSM_AUDIT_RULES)
    .map((rule: SsmAuditRule): AuditRuleReport => ({
      ruleId: rule.id,
      title: rule.title,
      statement: rule.statement,
      source: rule.source,
      category: rule.category,
      confidence: rule.confidence,
      enabled: !disabled.has(rule.id),
      findingCount: counts.get(rule.id) ?? 0,
      severity: worst.get(rule.id) ?? null,
    }))
    .sort((left, right) => (left.ruleId < right.ruleId ? -1 : left.ruleId > right.ruleId ? 1 : 0));
}

/** The rulebook's finding, with the compiled ids put back on it. */
function auditFindingOf(
  finding: SsmAuditFinding,
  assetIdOf: (tag: string) => string | null,
): AuditFinding {
  return {
    ruleId: finding.rule.id,
    title: finding.rule.title,
    statement: finding.rule.statement,
    severity: finding.severity,
    equipmentId: finding.equipmentId,
    assetId: assetIdOf(finding.equipmentId),
    relatedEquipmentId: finding.relatedEquipmentId,
    relatedAssetId: assetIdOf(finding.relatedEquipmentId),
    field: finding.field,
    why: finding.why,
    expected: finding.expected,
    recommendation: finding.recommendation,
    actual: finding.actual,
    row: finding.row,
  };
}

/**
 * Tag -> compiled asset id, or `null`.
 *
 * The exact-tag rung and nothing below it. The register's Equipment ID *is* the
 * canonical tag — Matchline wrote both — so a spelling that does not match
 * exactly is a tag the audit invented from a Closest Parent or a Dependencies
 * cell, and reaching for normalization or edit distance to place it would be
 * guessing at an address on a finding that is already about something being
 * wrong.
 */
function assetIdLookup(
  index: AuditableProject['identityIndex'],
): (tag: string) => string | null {
  return (tag: string): string | null => {
    if (tag === '') {
      return null;
    }
    const matches = index.byExactTag.get(tag);
    if (matches === undefined || matches.length !== 1) {
      return null;
    }
    return matches[0]?.assetId ?? null;
  };
}
