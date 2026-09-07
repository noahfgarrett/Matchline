/**
 * The gate, over a hand-built registry that breaks six rules on purpose.
 *
 * Every expectation here is a rule id from the vendored rulebook. The ids are
 * the stable contract — SSM-Audit's own note says never to rename one casually
 * — so a rulebook that stopped catching one of these would fail here, which is
 * the point of running the audit inside the compile at all.
 *
 * The registry is deliberately small and deliberately wrong in specific ways;
 * nothing in it is a real site.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUDIT_FINDING_HEADERS,
  AUDIT_RULE_HEADERS,
  AUDIT_SEVERITY_ORDER,
  auditCompiledProject,
  buildAuditRows,
  findingsAoa,
  rulesAoa,
  writeSsmAuditWorkbook,
} from '../dist/index.js';

/** An approved System Name for each UPN the fixture uses. */
const SYSTEM_602 = '602  Medium Voltage';
const SYSTEM_118 = '118  Secondary Heat Recovery Water (S/R)';

/** One compiled asset, with the members the audit reads. */
function asset(canonicalTag, extra = {}) {
  return {
    canonicalTag,
    stableAssetId: `asset-${canonicalTag}`,
    inclusionStatus: 'MODEL_CONFIRMED',
    building: 'FAB1',
    ssmDiscipline: 'ELECTRICAL',
    ...extra,
  };
}

/** A resolved system, as `GeneratedMelAsset` carries it. */
function system(systemKey, systemLabel) {
  return { systemKey, systemDescription: systemLabel, systemLabel };
}

/**
 * The registry under test.
 *
 * - `MV-SWGR-01` is the root of UPN 602 and is fine.
 * - `MV-XFMR-01` nests under it and is fine.
 * - `DUPE-01` appears twice — one Equipment ID, two rows.
 * - `ORPHAN-01` names a parent no row carries and no System Name matches.
 * - `HW-PUMP-01` is on UPN 118 and nests under the UPN 602 switchgear.
 * - `LOOP-A` and `LOOP-B` parent each other.
 * - `BAD-UPN-01` sits on a UPN the template does not carry.
 * - `VESDA-01` is a smoke detection system with no fire alarm panel anywhere.
 */
const REGISTRY = [
  asset('MV-SWGR-01', {
    description: 'MEDIUM VOLTAGE SWITCHGEAR',
    system: system('602', SYSTEM_602),
  }),
  asset('MV-XFMR-01', {
    description: 'MEDIUM VOLTAGE TRANSFORMER',
    system: system('602', SYSTEM_602),
    systemParentTag: 'MV-SWGR-01',
  }),
  asset('DUPE-01', {
    description: 'PANEL',
    system: system('602', SYSTEM_602),
    systemParentTag: 'MV-SWGR-01',
  }),
  asset('DUPE-01', {
    description: 'PANEL',
    system: system('602', SYSTEM_602),
    systemParentTag: 'MV-SWGR-01',
  }),
  asset('ORPHAN-01', {
    description: 'PANEL',
    system: system('602', SYSTEM_602),
    systemParentTag: 'NOT-IN-THIS-REGISTER',
  }),
  asset('HW-PUMP-01', {
    description: 'HOT WATER PUMP',
    ssmDiscipline: 'MECHANICAL WET',
    system: system('118', SYSTEM_118),
    systemParentTag: 'MV-SWGR-01',
  }),
  asset('LOOP-A', {
    description: 'PANEL',
    system: system('602', SYSTEM_602),
    systemParentTag: 'LOOP-B',
  }),
  asset('LOOP-B', {
    description: 'PANEL',
    system: system('602', SYSTEM_602),
    systemParentTag: 'LOOP-A',
  }),
  asset('BAD-UPN-01', {
    description: 'PANEL',
    system: system('888', '888  Not A Real System'),
    systemParentTag: 'MV-SWGR-01',
  }),
  asset('VESDA-01', {
    description: 'VESDA SMOKE DETECTION SYSTEM',
    ssmDiscipline: 'LIFE SAFETY SYSTEM',
    system: system('602', SYSTEM_602),
    systemParentTag: 'MV-SWGR-01',
  }),
];

/** The identity index's one used member: exact tag -> the assets carrying it. */
function identityIndexOf(assets) {
  const byExactTag = new Map();
  for (const entry of assets) {
    const list = byExactTag.get(entry.canonicalTag) ?? [];
    list.push({ assetId: entry.stableAssetId, canonicalTag: entry.canonicalTag });
    byExactTag.set(entry.canonicalTag, list);
  }
  return { byExactTag };
}

function projectOf(assets) {
  return { generatedMel: { assets }, identityIndex: identityIndexOf(assets) };
}

const REPORT = auditCompiledProject(projectOf(REGISTRY));

/** Every finding of one rule. */
const of = (ruleId, report = REPORT) => report.findings.filter((f) => f.ruleId === ruleId);

test('the six rules the fixture breaks all fire', () => {
  for (const ruleId of [
    'identity.duplicate-equipment-id',
    'parent.unresolved',
    'parent.cross-upn',
    'parent.cycle',
    'metadata.upn-not-approved',
    'logic.vesda-fire-alarm-missing',
  ]) {
    assert.equal(of(ruleId).length > 0, true, `${ruleId} produced no finding`);
  }
});

test('a duplicated Equipment ID is a blocker on both rows', () => {
  const findings = of('identity.duplicate-equipment-id');
  assert.equal(findings.length, 2);
  for (const finding of findings) {
    assert.equal(finding.severity, 'blocker');
    assert.equal(finding.equipmentId, 'DUPE-01');
    assert.equal(finding.field, 'Equipment ID');
    // The tag names two assets, so no single asset id can carry the finding.
    assert.equal(finding.assetId, null);
  }
});

test('a Closest Parent naming nothing in the upload is a blocker', () => {
  const [finding] = of('parent.unresolved');
  assert.equal(finding.equipmentId, 'ORPHAN-01');
  assert.equal(finding.severity, 'blocker');
  assert.equal(finding.actual, 'NOT-IN-THIS-REGISTER');
  assert.equal(finding.assetId, 'asset-ORPHAN-01');
});

test('a parent in another UPN is an error naming both ends', () => {
  // Two rows cross a UPN here: the hot-water pump, and the row on the UPN the
  // template does not carry. The pump is the one this asserts about.
  const finding = of('parent.cross-upn').find((entry) => entry.equipmentId === 'HW-PUMP-01');
  assert.notEqual(finding, undefined);
  assert.equal(finding.severity, 'error');
  assert.equal(finding.relatedEquipmentId, 'MV-SWGR-01');
  assert.equal(finding.relatedAssetId, 'asset-MV-SWGR-01');
});

test('a parent loop is one blocker naming the loop', () => {
  const [finding] = of('parent.cycle');
  assert.equal(finding.severity, 'blocker');
  assert.equal(finding.actual.includes('LOOP-A'), true);
  assert.equal(finding.actual.includes('LOOP-B'), true);
});

test('a UPN the template does not carry is a blocker', () => {
  const [finding] = of('metadata.upn-not-approved');
  assert.equal(finding.equipmentId, 'BAD-UPN-01');
  assert.equal(finding.severity, 'blocker');
  assert.equal(finding.actual, '888');
});

test('a VESDA with no fire alarm panel is an error', () => {
  const [finding] = of('logic.vesda-fire-alarm-missing');
  assert.equal(finding.equipmentId, 'VESDA-01');
  assert.equal(finding.severity, 'error');
});

test('a root attaching to its own System Name raises no parent finding', () => {
  const rootFindings = REPORT.findings.filter(
    (finding) => finding.equipmentId === 'MV-SWGR-01' && finding.field === 'Closest Parent',
  );
  assert.deepEqual(rootFindings, []);
});

test('the report counts every severity and every rule', () => {
  const counted = AUDIT_SEVERITY_ORDER.reduce(
    (total, severity) => total + REPORT.bySeverity[severity],
    0,
  );
  assert.equal(counted, REPORT.findings.length);
  assert.equal(REPORT.checksRun > 0, true);
  assert.equal(REPORT.rowCount, REGISTRY.length);
  // Every rule is listed whether or not it fired, so a screen can show the
  // whole rulebook rather than only the rules this project happened to break.
  assert.equal(REPORT.rulesEnabled.length > 40, true);
  assert.equal(
    REPORT.rulesEnabled.every((rule) => rule.enabled),
    true,
  );
  const duplicate = REPORT.rulesEnabled.find(
    (rule) => rule.ruleId === 'identity.duplicate-equipment-id',
  );
  assert.equal(duplicate.findingCount, 2);
  assert.equal(duplicate.statement.length > 0, true);
});

test('findings are ordered blocker, error, warning, info', () => {
  const rank = (severity) => AUDIT_SEVERITY_ORDER.indexOf(severity);
  for (let index = 1; index < REPORT.findings.length; index++) {
    assert.equal(
      rank(REPORT.findings[index - 1].severity) <= rank(REPORT.findings[index].severity),
      true,
    );
  }
});

test('a disabled rule drops its findings and keeps the checks it ran', () => {
  const off = auditCompiledProject(projectOf(REGISTRY), {
    disabledRuleIds: ['identity.duplicate-equipment-id'],
  });
  assert.equal(of('identity.duplicate-equipment-id', off).length, 0);
  assert.equal(off.findings.length, REPORT.findings.length - 2);
  assert.equal(off.bySeverity.blocker, REPORT.bySeverity.blocker - 2);
  // The engine still ran the check; what the site switched off is the finding.
  assert.equal(off.checksRun, REPORT.checksRun);
  const rule = off.rulesEnabled.find(
    (entry) => entry.ruleId === 'identity.duplicate-equipment-id',
  );
  assert.equal(rule.enabled, false);
  assert.equal(rule.findingCount, 0);
});

test('an unknown disabled rule id changes nothing', () => {
  const off = auditCompiledProject(projectOf(REGISTRY), {
    disabledRuleIds: ['nothing.like.this'],
  });
  assert.equal(off.findings.length, REPORT.findings.length);
});

test('an empty project audits to an empty report with the rules still listed', () => {
  const empty = auditCompiledProject(projectOf([]));
  assert.deepEqual(empty.findings, []);
  assert.equal(empty.rowCount, 0);
  assert.deepEqual(empty.bySeverity, { blocker: 0, error: 0, warning: 0, info: 0 });
  assert.equal(empty.rulesEnabled.length, REPORT.rulesEnabled.length);
});

test('the audit rows carry what the upload sheet would print', () => {
  const rows = buildAuditRows(REGISTRY);
  assert.equal(rows.length, REGISTRY.length);
  const swgr = rows.find((entry) => entry.canonicalTag === 'MV-SWGR-01').row;
  assert.equal(swgr.upn, '602');
  assert.equal(swgr.systemName, SYSTEM_602);
  // A root's Closest Parent is its own System Name, and Matchline can see that
  // parent, so the status cell says NEW.
  assert.equal(swgr.closestParent, SYSTEM_602);
  assert.equal(swgr.closestParentStatus, 'NEW');
  // The description is not an EXTO column Matchline prints; the audit reads it.
  assert.equal(swgr.equipmentDescription, 'MEDIUM VOLTAGE SWITCHGEAR');
  // No P6 schedule reaches a compile, so both milestone levels stay blank.
  assert.equal(swgr.milestone, '');
  assert.equal(swgr.milestoneParent, '');

  const orphan = rows.find((entry) => entry.canonicalTag === 'ORPHAN-01').row;
  assert.equal(orphan.closestParentStatus, '');
});

test('the findings workbook carries SSM-Audit’s own two sheets', () => {
  const findings = findingsAoa(REPORT, REGISTRY);
  assert.deepEqual(findings[0], AUDIT_FINDING_HEADERS);
  assert.equal(findings.length, REPORT.findings.length + 1);
  const duplicateRow = findings.find((row) => row[2] === 'DUPE-01');
  assert.equal(duplicateRow[0], 'INVALID');
  assert.equal(duplicateRow[1], 'No milestone');
  assert.equal(duplicateRow[3], 'PANEL');
  assert.equal(duplicateRow[10], 'Exto SSM');

  const rules = rulesAoa(REPORT);
  assert.deepEqual(rules[0], AUDIT_RULE_HEADERS);
  // Sorted by count descending, so the rule that fired most is the first row.
  assert.equal(Number(rules[1][4]) >= Number(rules[2][4]), true);

  const bytes = writeSsmAuditWorkbook(REPORT, { assets: REGISTRY });
  assert.equal(bytes instanceof Uint8Array, true);
  assert.equal(bytes.byteLength > 0, true);
  // Byte-stable: the same report always writes the same file.
  assert.deepEqual(writeSsmAuditWorkbook(REPORT, { assets: REGISTRY }), bytes);
});

test('a disabled rule is absent from the Rules sheet', () => {
  const off = auditCompiledProject(projectOf(REGISTRY), {
    disabledRuleIds: ['identity.duplicate-equipment-id'],
  });
  const titles = rulesAoa(off).map((row) => row[0]);
  assert.equal(titles.includes('Duplicate Equipment ID'), false);
  assert.equal(rulesAoa(REPORT).map((row) => row[0]).includes('Duplicate Equipment ID'), true);
});
