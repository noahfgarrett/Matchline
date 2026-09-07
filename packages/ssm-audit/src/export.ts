/**
 * The SSM Audit findings workbook.
 *
 * Two sheets, both carrying SSM-Audit's own columns so that a findings file
 * from Matchline and one from SSM-Audit are the same document about the same
 * project — an engineer works one list, not two shaped differently:
 *
 * - **All Findings**, on the twelve headers of `src/audit/export.js`'s
 *   `AUDIT_EXPORT_FINDING_HEADERS`, with its severity words (`INVALID`,
 *   `RULE BROKEN`, `CHECK THIS`, `NOTE`).
 * - **Rules**, on `AUDIT_EXPORT_RULE_HEADERS`: every rule, its plain statement,
 *   where it comes from, how strongly it is held, and how many times it fired.
 *
 * Two of SSM-Audit's own sheets are deliberately absent. Its Dashboard and
 * Index are built out of formulas, cell styles and internal hyperlinks, which
 * need a post-hoc zip rewrite and a clock; Matchline's exports have to be
 * byte-stable (docs/ENGINE.md rule 3), so every cell here is text and the file
 * is written through the same vendored writer as every other export.
 *
 * The Milestone column is kept — the header list is the shared contract — and
 * reads `No milestone` on every row, which is SSM-Audit's own wording for a row
 * no milestone groups. No P6 schedule reaches a compile, so that is the truth.
 */

import { writeWorkbook } from '@matchline/spreadsheet-import';

import type { SsmAuditSeverity } from '../vendor/audit/engine.js';

import type { AuditFinding, AuditRuleReport, SsmAuditReport } from './audit.js';
import type { AuditableAsset } from './rows.js';

/** SSM-Audit's `AUDIT_EXPORT_FINDING_HEADERS`, in its order. */
export const AUDIT_FINDING_HEADERS: ReadonlyArray<string> = [
  'Severity',
  'Milestone',
  'Equipment ID',
  'Description',
  'Rule',
  'Why',
  'What to do',
  'Field',
  'Found',
  'Expected',
  'Sheet',
  'Row',
];

/** SSM-Audit's `AUDIT_EXPORT_RULE_HEADERS`, in its order. */
export const AUDIT_RULE_HEADERS: ReadonlyArray<string> = [
  'Rule',
  'What must be true',
  'Source',
  'Confidence',
  'Findings count',
];

/** SSM-Audit's `AUDIT_EXPORT_SEVERITY_LABELS`. The words engineers read. */
const SEVERITY_LABELS: Readonly<Record<SsmAuditSeverity, string>> = {
  blocker: 'INVALID',
  error: 'RULE BROKEN',
  warning: 'CHECK THIS',
  info: 'NOTE',
};

/** SSM-Audit's `EXPORT_SOURCE_LABELS`. */
const SOURCE_LABELS: Readonly<Record<string, string>> = {
  registry: 'Registry Integrity',
  sop: 'SSM SOP',
  logic: 'Commissioning Logic',
};

/** SSM-Audit's `EXPORT_CONFIDENCE_LABELS`. */
const CONFIDENCE_LABELS: Readonly<Record<string, string>> = {
  required: 'Required',
  strong: 'Strong pattern',
  'description-rated': 'Description based',
};

/** SSM-Audit's `AUDIT_EXPORT_NO_MILESTONE`. */
const NO_MILESTONE = 'No milestone';

export const AUDIT_FINDINGS_SHEET_NAME = 'All Findings';
export const AUDIT_RULES_SHEET_NAME = 'Rules';

/** Options for {@link writeSsmAuditWorkbook}. */
export interface WriteSsmAuditWorkbookOptions {
  /**
   * The compiled assets, so the Description column can be filled.
   *
   * A finding names equipment by tag; the description lives on the asset. Omit
   * them and the column comes out blank rather than invented.
   */
  readonly assets?: ReadonlyArray<AuditableAsset>;
}

/**
 * Write the findings workbook.
 *
 * Byte-stable: every cell is text, the row order is the report's own, and no
 * clock or path is embedded. An audit with no findings still yields both
 * sheets — the Rules sheet with every count at zero is the evidence that the
 * rules ran, which a header-only file could not give.
 */
export function writeSsmAuditWorkbook(
  report: SsmAuditReport,
  options: WriteSsmAuditWorkbookOptions = {},
): Uint8Array {
  return writeWorkbook([
    { name: AUDIT_FINDINGS_SHEET_NAME, aoa: findingsAoa(report, options.assets ?? []) },
    { name: AUDIT_RULES_SHEET_NAME, aoa: rulesAoa(report) },
  ]);
}

/** Header row, then one row per finding, in the report's order. */
export function findingsAoa(
  report: SsmAuditReport,
  assets: ReadonlyArray<AuditableAsset>,
): ReadonlyArray<ReadonlyArray<string>> {
  const descriptions = new Map<string, string>();
  for (const asset of assets) {
    if (asset.description !== undefined && !descriptions.has(asset.canonicalTag)) {
      descriptions.set(asset.canonicalTag, asset.description);
    }
  }
  return [
    [...AUDIT_FINDING_HEADERS],
    ...report.findings.map((finding: AuditFinding): ReadonlyArray<string> => [
      SEVERITY_LABELS[finding.severity],
      NO_MILESTONE,
      finding.equipmentId,
      descriptions.get(finding.equipmentId) ?? '',
      finding.title,
      finding.why,
      finding.recommendation,
      finding.field,
      finding.actual,
      finding.expected,
      AUDIT_SHEET_LABEL,
      String(finding.row),
    ]),
  ];
}

/**
 * Header row, then one row per rule, most findings first.
 *
 * SSM-Audit sorts its Rules sheet by count descending and then by title, and
 * lists a disabled rule nowhere. Both are kept: a rule a site switched off has
 * no findings to explain, and printing it with a zero would read as a rule that
 * passed.
 */
export function rulesAoa(report: SsmAuditReport): ReadonlyArray<ReadonlyArray<string>> {
  const rules = report.rulesEnabled
    .filter((rule) => rule.enabled)
    .slice()
    .sort(
      (left, right) =>
        right.findingCount - left.findingCount ||
        (left.title < right.title ? -1 : left.title > right.title ? 1 : 0),
    );
  return [
    [...AUDIT_RULE_HEADERS],
    ...rules.map((rule: AuditRuleReport): ReadonlyArray<string> => [
      rule.title,
      rule.statement,
      SOURCE_LABELS[rule.source] ?? rule.source,
      CONFIDENCE_LABELS[rule.confidence] ?? rule.confidence,
      String(rule.findingCount),
    ]),
  ];
}

/** What the Sheet column names: the upload sheet the rows were built from. */
const AUDIT_SHEET_LABEL = 'Exto SSM';
