/**
 * The approved VF Exto vocabulary, at compile time (SSM-Audit layer 2).
 *
 * Two things, both of them about the same standard. The completeness report
 * counts what the approved lists would refuse about this register, so the
 * refusal arrives on screen 8 rather than after somebody uploads. And the SSM
 * SOP's instrumentation rule — I&C is `FACILITIES MONITORING SYSTEM`, and an
 * instrument's system is the UPN in its own tag — is applied when the profile
 * asks for it and never when it does not.
 *
 * Dragon is a useful register to count precisely because it is not compliant:
 * `001` and `002` are not approved UPNs, `603` is, and `Chilled Water` is not an
 * approved discipline. A fixture that passed every list would prove nothing.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { compileProject } from '../dist/index.js';
import {
  fullInput,
  idOf,
  PROPERTY_MAPPINGS,
  siteProfile,
  SYSTEM_RESOLVER,
  openDragonCache,
} from './support.mjs';

let handle = null;

before(() => {
  handle = openDragonCache('approved-values');
});

after(() => {
  handle?.close();
});

/**
 * Where Dragon's instrumentation says it is instrumentation.
 *
 * The controls package publishes no discipline at all, and the mechanical model
 * writes `Dragon Data > Service` on its air handlers and leaves it blank on the
 * transmitters — so a file-name rule reaches exactly the assets nobody stated a
 * discipline for, which is the gap these rules exist to fill. MAH001 keeps
 * `Chilled Water`: the model outranks the rule.
 */
const IC_ASSIGNMENTS = [
  { scope: 'filename-pattern', match: 'Dragon-Controls*', assign: { nativeDiscipline: 'I&C' } },
  { scope: 'filename-pattern', match: 'Dragon-Mechanical*', assign: { nativeDiscipline: 'I&C' } },
];

/** The Dragon profile with the SOP's instrumentation rule turned on or off. */
function withIcRule(applyIcDisciplineRule) {
  return siteProfile({
    propertyMappings: { ...PROPERTY_MAPPINGS },
    sourceAssignments: IC_ASSIGNMENTS,
    systemResolver: { ...SYSTEM_RESOLVER, applyIcDisciplineRule },
  });
}

/* ------------------------------------------------- the approved-value counts */

test('an unapproved UPN is counted, and an approved one is not', () => {
  const { approvedValues } = compileProject(fullInput(handle.cache)).completeness;

  assert.ok(
    approvedValues.upnNotApproved.assetCount > 0,
    'Dragon systems 001 and 002 are its own numbering, not the Exto template’s',
  );
  assert.ok(
    approvedValues.upnNotApproved.exampleTags.every((tag) => !tag.startsWith('TIT603')),
    '603 IS an approved UPN, so no asset on it is counted',
  );
});

test('the counts name the SSM Audit rule that says the same thing', () => {
  const { approvedValues } = compileProject(fullInput(handle.cache)).completeness;
  assert.deepEqual(
    Object.values(approvedValues).map((entry) => entry.auditRuleId),
    [
      'exto.upn-not-approved',
      'exto.system-name-not-approved',
      'exto.discipline-not-approved',
      'exto.classification-not-approved',
      'exto.item-master-not-vf',
    ],
  );
});

test('a discipline outside the approved list is counted', () => {
  const { approvedValues } = compileProject(fullInput(handle.cache)).completeness;
  assert.ok(
    approvedValues.disciplineNotApproved.assetCount > 0,
    '"Chilled Water" is a service, not one of the twenty-one approved disciplines',
  );
});

test('a blank cell is never counted: that is a different fact with a different fix', () => {
  const project = compileProject(fullInput(handle.cache));
  const { approvedValues, assetCount } = project.completeness;
  // Nothing in this compile assigns an Item Master or a classification, so
  // every one of those cells is blank — and blank is not "outside the list".
  assert.equal(approvedValues.itemMasterNotVf.assetCount, 0);
  assert.equal(approvedValues.classificationNotInList.assetCount, 0);
  assert.ok(assetCount > 0);
});

test('examples are sorted, not first-seen, so two readings of one site agree', () => {
  const { exampleTags } = compileProject(fullInput(handle.cache)).completeness.approvedValues
    .upnNotApproved;
  assert.deepEqual(exampleTags, [...exampleTags].sort());
  assert.ok(exampleTags.length <= 10, 'ten examples, never a second queue');
});

/* ------------------------------------------------------ the I&C SOP rule */

test('with the rule on, I&C becomes FACILITIES MONITORING SYSTEM', () => {
  const project = compileProject(fullInput(handle.cache, { profile: withIcRule(true) }));
  const plc = project.compileSubjects.find((entry) => entry.assetId === idOf('PLC001-10-01'));

  assert.equal(plc.attributes.get('nativeDiscipline'), 'I&C');
  assert.equal(
    plc.attributes.get('ssmDiscipline'),
    'FACILITIES MONITORING SYSTEM',
    'there is no I&C in the approved Discipline list, and Exto refuses what is not in it',
  );
});

test('an I&C asset takes the UPN out of its own tag, over what the chain settled', () => {
  // A resolver pointed at the unit segment puts TIT603-10-01 on system `10`.
  // The SOP says an instrument belongs to what it monitors, and the only place
  // that is written down is the tag: 603.
  const project = compileProject(
    fullInput(handle.cache, {
      profile: siteProfile({
        propertyMappings: { ...PROPERTY_MAPPINGS },
        sourceAssignments: IC_ASSIGNMENTS,
        systemResolver: {
          ...SYSTEM_RESOLVER,
          keyChain: [{ kind: 'tag-segment', segment: 'unit' }],
          applyIcDisciplineRule: true,
        },
      }),
    }),
  );
  const tit = project.generatedMel.assets.find((asset) => asset.canonicalTag === 'TIT603-10-01');

  assert.equal(tit.system.systemKey, '603', 'the tag says 603 and the tag is where it is written');
  assert.equal(
    tit.system.systemEvidence[0].rule,
    'ssm-audit:ic-discipline',
    'a changed key is never a value that appeared from nowhere',
  );
  assert.ok(
    tit.system.systemEvidence.length > 1,
    'and the chain claims it overrode are still on the evidence beneath it',
  );

  const mah = project.generatedMel.assets.find((asset) => asset.canonicalTag === 'MAH001-10-01');
  assert.equal(mah.system.systemKey, '10', 'a mechanical asset is not instrumentation');
});

test('a key the chain already got right is left alone, with no invented provenance', () => {
  const project = compileProject(fullInput(handle.cache, { profile: withIcRule(true) }));
  const tit = project.generatedMel.assets.find((asset) => asset.canonicalTag === 'TIT603-10-01');

  assert.equal(tit.system.systemKey, '603');
  assert.notEqual(
    tit.system.systemEvidence[0].rule,
    'ssm-audit:ic-discipline',
    'the rule agreed with the chain, so it has nothing of its own to record',
  );
});

test('an I&C tag carrying no approved UPN is left exactly as the chain settled it', () => {
  const project = compileProject(fullInput(handle.cache, { profile: withIcRule(true) }));
  const plc = project.generatedMel.assets.find((asset) => asset.canonicalTag === 'PLC001-10-01');

  assert.equal(plc.system.systemKey, '001', 'PLC001-10-01 carries no approved UPN; nothing moves');
  assert.notEqual(plc.system.systemEvidence[0].rule, 'ssm-audit:ic-discipline');
});

test('the register agrees with itself: hierarchy, MEL and the sheet all move together', () => {
  const project = compileProject(
    fullInput(handle.cache, {
      profile: siteProfile({
        propertyMappings: { ...PROPERTY_MAPPINGS },
        sourceAssignments: IC_ASSIGNMENTS,
        systemResolver: {
          ...SYSTEM_RESOLVER,
          keyChain: [{ kind: 'tag-segment', segment: 'unit' }],
          applyIcDisciplineRule: true,
        },
      }),
    }),
  );
  const subject = project.compileSubjects.find((entry) => entry.assetId === idOf('TIT603-10-01'));
  const row = project.generatedMel.rows.find((entry) => entry.equipmentTag === 'TIT603-10-01');

  assert.equal(subject.attributes.get('systemKey'), '603', 'what the hierarchy groups on');
  assert.equal(row.systemKey, '603', 'and what the generated MEL prints');
  assert.equal(row.ssmDiscipline, 'FACILITIES MONITORING SYSTEM');
});

test('with the rule off, nothing about the compile changes', () => {
  const off = compileProject(fullInput(handle.cache, { profile: withIcRule(false) }));
  const plc = off.compileSubjects.find((entry) => entry.assetId === idOf('PLC001-10-01'));

  assert.equal(plc.attributes.get('ssmDiscipline'), 'I&C', 'the native discipline, unchanged');
  const tit = off.generatedMel.assets.find((asset) => asset.canonicalTag === 'TIT603-10-01');
  assert.equal(tit.system.systemKey, '603', 'the chain already resolved this one');
  assert.notEqual(tit.system.systemEvidence[0].rule, 'ssm-audit:ic-discipline');
});

test('a site projection a person wrote beats the SOP rule', () => {
  const project = compileProject(
    fullInput(handle.cache, {
      profile: siteProfile({
        propertyMappings: { ...PROPERTY_MAPPINGS },
        sourceAssignments: IC_ASSIGNMENTS,
        ssmDisciplineProjection: [{ from: 'I&C', to: 'TELECOM' }],
        systemResolver: { ...SYSTEM_RESOLVER, applyIcDisciplineRule: true },
      }),
    }),
  );
  const plc = project.compileSubjects.find((entry) => entry.assetId === idOf('PLC001-10-01'));
  assert.equal(
    plc.attributes.get('ssmDiscipline'),
    'TELECOM',
    'a rewrite the site wrote down is the one thing that outranks the standard rule',
  );
});
