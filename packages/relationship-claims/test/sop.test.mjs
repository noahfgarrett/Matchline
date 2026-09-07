/**
 * The SSM SOP rules, on their own.
 *
 * `tests/integration/e5-ssm-sop.test.mjs` proves these over a real compile and
 * against the vendored gate. This proves the rules themselves — the three
 * things they refuse to do, which a green end-to-end test would not catch
 * because it only sees the cases that work.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { assembleRelationshipClaims, sopClaims } from '../dist/index.js';

/** One subject, with the four facts the SOP rules read. */
function subject(tag, equipmentClass, extra = {}) {
  return { assetId: tag, canonicalTag: tag, equipmentClass, ...extra };
}

const MAH = subject('MAH101-01', 'driven', { upn: '101', instance: '01', building: 'B14' });
const VFD = subject('VFD101-01', 'vfd', { upn: '101', instance: '01', building: 'B14' });
const MCC = subject('MCC101', 'panel', { upn: '101', building: 'B14' });
const PLC = subject('PLC101-01', 'plc', { upn: '101', instance: '01', building: 'B14' });
const TIT = subject('TIT101-01', 'instrument', { upn: '101', instance: '01', building: 'B14' });

function run(subjects, options = {}) {
  return sopClaims({
    subjects,
    flowEdges: options.flowEdges ?? [],
    disabledRuleIds: options.disabledRuleIds ?? [],
  });
}

test('a drive pairs to the machine it runs, never to the panel that feeds it', () => {
  const claims = run([MAH, VFD, MCC, PLC]);
  const drive = claims.structural.filter((claim) => claim.subjectAssetId === 'VFD101-01');
  assert.deepEqual(
    drive.map((claim) => [claim.targetAssetId, claim.rule]),
    [['MAH101-01', 'sop.tag-pair']],
    'the MCC is on the same UPN and is still not the answer',
  );
});

test('two candidates on one UPN and instance both get a claim, so the ladder can tie', () => {
  const second = subject('MAH101-01-B', 'driven', { upn: '101', instance: '01', building: 'B14' });
  const claims = run([MAH, second, VFD]);
  assert.deepEqual(
    claims.structural
      .filter((claim) => claim.subjectAssetId === 'VFD101-01')
      .map((claim) => claim.targetAssetId)
      .sort(),
    ['MAH101-01', 'MAH101-01-B'],
    'picking here would hide the ambiguity the ladder exists to surface',
  );
});

test('nothing crosses a UPN', () => {
  const other = subject('MAH202-01', 'driven', { upn: '202', instance: '01', building: 'B14' });
  const claims = run([other, VFD]);
  assert.deepEqual(claims.structural, [], 'a drive is not adopted by another system');
});

test('an instrument with nothing on its own instance falls back inside its own UPN', () => {
  const loose = subject('TIT101-07', 'instrument', { upn: '101', instance: '07', building: 'B14' });
  const claims = run([MAH, loose]);
  assert.deepEqual(
    claims.structural.map((claim) => [claim.subjectAssetId, claim.targetAssetId, claim.rule]),
    [['TIT101-07', 'MAH101-01', 'sop.instrument-parent-upn']],
  );
});

test('an instrument with no equipment on its UPN at all is left to root', () => {
  const alone = subject('TIT909-01', 'instrument', { upn: '909', instance: '01', building: 'B14' });
  assert.deepEqual(run([MAH, alone]).structural, []);
});

test('a subject with no class, no UPN or no instance takes part in nothing', () => {
  const unclassified = { assetId: 'X', canonicalTag: 'X', upn: '101', instance: '01' };
  const untagged = subject('VFD', 'vfd');
  assert.deepEqual(run([MAH, unclassified, untagged]).structural, []);
});

test('the power-path rules make no claim without connectivity, and one with it', () => {
  const dry = run([MAH, MCC]);
  assert.deepEqual(
    dry.dependencies.filter((claim) => claim.rule.startsWith('logic.')),
    [],
    'never guess power',
  );

  const wet = run([MAH, MCC], {
    flowEdges: [
      {
        fromAssetId: 'MCC101',
        toAssetId: 'MAH101-01',
        relationshipType: 'POWERS',
        provenance: { sourceFile: 'cables.xlsx', sourceRef: { kind: 'sheet-row', sheet: 'S', row: 2 } },
      },
    ],
  });
  const path = wet.dependencies.find((claim) => claim.rule === 'logic.driven-electrical-path');
  assert.ok(path);
  assert.equal(path.targetAssetId, 'MCC101');
  assert.equal(
    path.relationshipType,
    'POWERS',
    'the edge’s own type, so this and the flow rung collapse to one dependency',
  );
});

test('a disabled rule produces nothing, and its neighbours are untouched', () => {
  const claims = run([MAH, VFD, MCC, PLC, TIT], { disabledRuleIds: ['sop.tag-pair'] });
  assert.deepEqual(
    claims.structural.filter((claim) => claim.subjectAssetId === 'VFD101-01'),
    [],
  );
  assert.ok(
    claims.dependencies.some((claim) => claim.rule === 'sop.vfd-dependencies'),
    'the VFD still lists its panel and its PLC',
  );
});

test('assembly runs the SOP source only when it is handed one', () => {
  const subjects = [MAH, VFD, MCC, PLC];
  const resolveTag = () => null;

  const off = assembleRelationshipClaims(subjects, { resolveTag });
  assert.deepEqual(off.structural, [], 'no rung, no claims');
  assert.deepEqual(off.dependencies, [], 'and no dependencies either, which no ladder filters');

  const on = assembleRelationshipClaims(subjects, {
    resolveTag,
    sopRules: { disabledRuleIds: [] },
  });
  assert.ok(on.structural.some((claim) => claim.ladderSource === 'sop-rule'));
  assert.ok(on.dependencies.some((claim) => claim.ladderSource === 'sop-rule'));
});

test('every claim says which SOP sentence made it, and against which evidence', () => {
  const [claim] = run([MAH, VFD]).structural;
  assert.equal(claim.ladderSource, 'sop-rule');
  assert.equal(claim.kind, 'structural-parent');
  assert.equal(claim.provenance.sourceFile, 'ssm-sop');
  assert.equal(claim.provenance.rule, 'sop.tag-pair');
  assert.match(claim.provenance.propertyOrColumn, /UPN 101, instance 01: MAH101-01/);
});

test('the same subjects in another order produce the same claims', () => {
  const forwards = run([MAH, VFD, MCC, PLC, TIT]);
  const backwards = run([TIT, PLC, MCC, VFD, MAH]);
  assert.deepEqual(backwards, forwards);
});
