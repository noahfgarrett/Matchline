/**
 * The SSM Audit gate, and its findings as review items (docs/ENGINE.md).
 *
 * The audit is the last thing a compile does. It is not a stage of the fold and
 * it changes nothing: it reads the register the compile just built — the EXTO
 * rows, through `@matchline/exto-export`'s own flattening — and reports whether
 * Exto and the SSM SOP would accept it. Running it here rather than in the
 * desktop is what makes it a gate: a compile that produced a register Exto
 * would refuse says so on screen 8, not after somebody exports and uploads.
 *
 * ## Notes are counted, everything else is per asset
 *
 * A `blocker`, an `error` and a `warning` name one row a person has to look at,
 * and each becomes its own review item. An `info` is a note about a practice —
 * a site-prefixed Item Master, a row on UPN MISC — and a real register carries
 * thousands. One item per rule, with the count and ten examples, is the same
 * rule the B-series aggregates follow: a queue nobody can work is the same as
 * no queue at all.
 *
 * Nothing is discarded to produce the aggregate. Every finding is still in
 * `CompiledProject.ssmAudit`, which is what the exports and the rules screen
 * read; what aggregates is only the queue row.
 */

import type { ReviewItem, SsmAuditReviewItem } from '@matchline/domain';
import type { AuditFinding, SsmAuditReport } from '@matchline/ssm-audit';

/** How many tags an aggregate names. The B-series items use ten too. */
const AGGREGATE_EXAMPLE_LIMIT = 10;

/**
 * Every finding as a review item, per asset above `info` and counted at it.
 *
 * Deterministic: the report's own order decides, and the aggregates follow the
 * per-asset items in rule-id order.
 */
export function ssmAuditReviewItems(report: SsmAuditReport): ReadonlyArray<ReviewItem> {
  const items: SsmAuditReviewItem[] = [];
  const notes = new Map<string, { readonly first: AuditFinding; count: number; tags: string[] }>();

  for (const finding of report.findings) {
    if (finding.severity === 'info') {
      const entry = notes.get(finding.ruleId) ?? { first: finding, count: 0, tags: [] };
      entry.count += 1;
      if (finding.equipmentId !== '' && entry.tags.length < AGGREGATE_EXAMPLE_LIMIT) {
        entry.tags.push(finding.equipmentId);
      }
      notes.set(finding.ruleId, entry);
      continue;
    }
    items.push({
      kind: 'ssm-audit',
      ruleId: finding.ruleId,
      severity: finding.severity,
      title: finding.title,
      statement: finding.statement,
      why: finding.why,
      expected: finding.expected,
      recommendation: finding.recommendation,
      field: finding.field,
      actual: finding.actual,
      assetId: finding.assetId ?? '',
      equipmentTag: finding.equipmentId,
      relatedAssetId: finding.relatedAssetId ?? '',
      findingCount: 0,
      exampleTags: [],
    });
  }

  for (const ruleId of [...notes.keys()].sort()) {
    const entry = notes.get(ruleId);
    if (entry === undefined) {
      continue;
    }
    items.push({
      kind: 'ssm-audit',
      ruleId,
      severity: 'info',
      title: entry.first.title,
      statement: entry.first.statement,
      // Deliberately empty: every row behind the count saw something of its
      // own, and printing the first one's sentence would make it look like the
      // sentence for all of them.
      why: '',
      expected: entry.first.expected,
      recommendation: entry.first.recommendation,
      field: '',
      actual: '',
      assetId: '',
      equipmentTag: '',
      relatedAssetId: '',
      findingCount: entry.count,
      exampleTags: entry.tags,
    });
  }

  return items;
}
