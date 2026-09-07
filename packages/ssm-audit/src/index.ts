/**
 * `@matchline/ssm-audit` — the SSM Audit rulebook, as a post-compile gate.
 *
 * Matchline builds a register; SSM-Audit judges one. This package is the seam:
 * it hands the rulebook the rows the EXTO upload sheet would carry, and hands
 * back findings addressed to compiled assets.
 *
 * ## The rulebook is vendored, never edited here
 *
 * `vendor/` holds SSM-Audit's `src/audit/engine.js`, `src/audit/model.js`,
 * `src/exto/rev21-contract.js`, `src/exto/vf-item-masters.js` and
 * `src/core/text.js` byte for byte, with their relative imports untouched.
 * `test/parity.test.mjs` compares them against the SSM-Audit checkout whenever
 * one is present and fails on any difference. Two shims complete the graph:
 * `vendor/io/workbook.js`, which the rulebook's model layer imports and the
 * audit path never calls, and `vendor/xlsx-global.js`, which supplies the one
 * SheetJS utility a browser page would have put on `globalThis`.
 *
 * A rule that needs changing is changed in SSM-Audit and re-vendored. Changing
 * one here would leave two apps quietly disagreeing about the same SOP.
 *
 * ## Layers
 *
 * - {@link buildAuditRows} — compiled assets → the rulebook's row shape,
 *   through `@matchline/exto-export`'s own flattening, so the audit reads what
 *   the upload sheet would print.
 * - {@link auditCompiledProject} — the run: findings, counts per severity, the
 *   checks the engine performed, and every rule with its live count.
 * - {@link writeSsmAuditWorkbook} — the findings workbook, on SSM-Audit's own
 *   All Findings and Rules columns, byte-stable.
 */

// The rulebook's model layer reads a bare `XLSX` global that only a browser
// page sets. Imported for its side effect, first, so nothing downstream can
// touch the vendored graph before the guard is in place.
import '../vendor/xlsx-global.js';

export { AUDIT_SEVERITY_ORDER, auditCompiledProject } from './audit.js';
export type {
  AuditFinding,
  AuditProjectOptions,
  AuditRuleReport,
  AuditSeverityCounts,
  AuditableProject,
  SsmAuditReport,
} from './audit.js';

export {
  AUDIT_CLOSEST_PARENT_STATUS,
  AUDIT_SHEET_NAME,
  buildAuditRows,
} from './rows.js';
export type { AuditRowWithAsset, AuditableAsset, BuildAuditRowsOptions } from './rows.js';

export {
  AUDIT_FINDINGS_SHEET_NAME,
  AUDIT_FINDING_HEADERS,
  AUDIT_RULES_SHEET_NAME,
  AUDIT_RULE_HEADERS,
  findingsAoa,
  rulesAoa,
  writeSsmAuditWorkbook,
} from './export.js';
export type { WriteSsmAuditWorkbookOptions } from './export.js';

export { SSM_AUDIT_RULES, SSM_AUDIT_STANDARD } from '../vendor/audit/engine.js';
export type {
  SsmAuditCategory,
  SsmAuditConfidence,
  SsmAuditRule,
  SsmAuditSeverity,
  SsmAuditSource,
} from '../vendor/audit/engine.js';
