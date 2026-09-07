/**
 * The SSM Audit gate, over the Dragon compile.
 *
 * The fixture is synthetic and the audit is right to say so: its system keys
 * are `001`, `002` and `603`, and only `603` is a UPN the VF Exto Upload
 * Template carries. Those findings are asserted here rather than silenced —
 * a gate that reported nothing on a register Exto would refuse would be worth
 * nothing on a real one either.
 *
 * Every number below is the audit's own, read off a compile.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { compileProject } from '../dist/index.js';
import { fullInput, idOf, openDragonCache, siteProfile } from './support.mjs';

let handle = null;
let project = null;

before(() => {
  handle = openDragonCache('ssm-audit');
  project = compileProject(fullInput(handle.cache));
});

after(() => {
  handle?.close();
});

/** Findings of one rule, in report order. */
const of = (ruleId) => project.ssmAudit.findings.filter((finding) => finding.ruleId === ruleId);

test('the compile publishes an audit of every EXTO row it would write', () => {
  const audit = project.ssmAudit;
  assert.equal(audit.rowCount, project.generatedMel.assets.length);
  assert.equal(audit.rowCount, 34);
  assert.equal(audit.checksRun > 0, true);
  // Every rule is listed whether it fired or not, so the rules screen shows the
  // rulebook rather than only what this project happened to break.
  assert.equal(audit.rulesEnabled.length > 40, true);
  assert.equal(audit.rulesEnabled.every((rule) => rule.enabled), true);
});

test('the severity counts add up to the findings', () => {
  const { bySeverity, findings } = project.ssmAudit;
  assert.equal(
    bySeverity.blocker + bySeverity.error + bySeverity.warning + bySeverity.info,
    findings.length,
  );
});

test('the fixture’s system keys are not VF UPNs, and the gate says so', () => {
  // 26 of the 34 assets carry 001 or 002; the other 8 carry 603, which is on
  // the approved list. Exto would refuse the 26, so they are blockers.
  const notApproved = of('metadata.upn-not-approved');
  assert.equal(notApproved.length, 26);
  assert.equal(notApproved.every((finding) => finding.severity === 'blocker'), true);
  assert.equal(project.ssmAudit.bySeverity.blocker, 34);

  // 603 is approved; "Temperature Instrumentation" is not its approved System
  // Name, which is the other half of the same column being wrong.
  const systemMismatch = of('metadata.system-upn-mismatch');
  assert.equal(systemMismatch.length, 8);
  assert.equal(systemMismatch.every((finding) => finding.severity === 'blocker'), true);
});

test('a finding carries the compiled asset id behind its tag', () => {
  const finding = of('metadata.upn-not-approved').find(
    (entry) => entry.equipmentId === 'MAH001-10-01',
  );
  assert.notEqual(finding, undefined);
  assert.equal(finding.assetId, idOf('MAH001-10-01'));
  assert.equal(finding.field, 'UPN');
  assert.equal(finding.why.length > 0, true);
  assert.equal(finding.expected.length > 0, true);
  assert.equal(finding.recommendation.length > 0, true);
  assert.equal(finding.statement.length > 0, true);
});

test('blockers reach the queue per asset; notes reach it once per rule', () => {
  const items = project.reviewItems.filter((item) => item.kind === 'ssm-audit');
  const perAsset = items.filter((item) => item.findingCount === 0);
  const aggregates = items.filter((item) => item.findingCount > 0);

  assert.equal(perAsset.length, project.ssmAudit.bySeverity.blocker);
  assert.equal(perAsset.every((item) => item.assetId !== '' || item.equipmentTag !== ''), true);

  // The three `info` rules the fixture trips, counted rather than repeated.
  assert.deepEqual(
    aggregates.map((item) => item.ruleId).sort(),
    [
      'dependency.parent-also-listed',
      'dependency.same-upn-bottom-up',
      'metadata.classification-not-in-list',
    ],
  );
  assert.equal(
    aggregates.reduce((total, item) => total + item.findingCount, 0),
    project.ssmAudit.bySeverity.info,
  );

  const classification = aggregates.find(
    (item) => item.ruleId === 'metadata.classification-not-in-list',
  );
  // One per asset, and ten of them named: the fix is one decision about a code,
  // not thirty-four decisions about equipment.
  assert.equal(classification.findingCount, 34);
  assert.equal(classification.exampleTags.length, 10);
  assert.equal(classification.assetId, '');
  assert.equal(classification.severity, 'info');
});

test('a disabled rule leaves the register alone and empties its queue rows', () => {
  const off = compileProject(
    fullInput(handle.cache, {
      profile: siteProfile({ ssmAudit: { disabledRuleIds: ['metadata.upn-not-approved'] } }),
    }),
  );
  assert.equal(off.ssmAudit.findings.some((f) => f.ruleId === 'metadata.upn-not-approved'), false);
  assert.equal(off.ssmAudit.bySeverity.blocker, project.ssmAudit.bySeverity.blocker - 26);
  assert.equal(
    off.ssmAudit.rulesEnabled.find((rule) => rule.ruleId === 'metadata.upn-not-approved').enabled,
    false,
  );
  // The gate reads the register; it never writes to it.
  assert.equal(off.generatedMel.assets.length, project.generatedMel.assets.length);
  assert.deepEqual(off.generatedMel.workbookBytes, project.generatedMel.workbookBytes);
});
