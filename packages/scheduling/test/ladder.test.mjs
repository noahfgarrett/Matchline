import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assignMilestones,
  extractMilestoneUpns,
  readP6ActivitySheet,
  readXerSchedule,
} from '../dist/index.js';
import {
  DRAGON_ACTIVITY_MAPPING,
  DRAGON_ACTIVITY_SHEET,
  DRAGON_ASSETS,
  DRAGON_XER,
} from './dist/dragon.fixture.js';
import { reorder, sheetFrom } from './support.mjs';

/** The Dragon schedule: the activity sheet first, then the XER. */
function dragonActivities() {
  const sheet = readP6ActivitySheet(sheetFrom(DRAGON_ACTIVITY_SHEET), DRAGON_ACTIVITY_MAPPING, {
    sourceFile: 'Dragon-Activities.xlsx',
    sheetName: 'Activities',
  });
  const xer = readXerSchedule(DRAGON_XER, { sourceFile: 'Dragon-Schedule.xer' });
  return [...sheet.activities, ...xer.activities];
}

/** `{ assetId: [rung, label] }`, the shape the rung assertions read best in. */
function rungs(result) {
  return Object.fromEntries(
    result.assignments.map((assignment) => [assignment.assetId, [assignment.rung, assignment.label]]),
  );
}

test('rung 1: an activity naming the equipment tag claims that asset outright', () => {
  const result = assignMilestones(dragonActivities(), DRAGON_ASSETS);

  assert.deepEqual(rungs(result)['asset-0020'], [1, 'Commission RIO 650 remote IO']);
});

test('rung 2: an explicit UPN column claims every asset of that system', () => {
  const result = assignMilestones(dragonActivities(), DRAGON_ASSETS);

  assert.deepEqual(rungs(result)['asset-0021'], [2, 'Terminate FMS network trunk']);
});

test('rung 3: a UPN read out of a milestone name claims every asset of that system', () => {
  const result = assignMilestones(dragonActivities(), DRAGON_ASSETS);
  const byAsset = rungs(result);

  for (const assetId of ['asset-0001', 'asset-0002', 'asset-0003', 'asset-0004']) {
    assert.deepEqual(byAsset[assetId], [3, 'L2-M1-0603 - UPN 603 Main Intake Energization']);
  }
  for (const assetId of ['asset-0010', 'asset-0011', 'asset-0012']) {
    assert.deepEqual(byAsset[assetId], [3, 'L2-M1-2201 - UPN 2201 Screening Systems Enabling']);
  }
});

test('rung 4: an asset no activity reaches lands in its building-ready bucket', () => {
  const result = assignMilestones(dragonActivities(), DRAGON_ASSETS);
  const fallback = result.assignments.find((assignment) => assignment.assetId === 'asset-0040');

  assert.equal(fallback.rung, 4);
  assert.equal(fallback.label, 'OP / Building Ready');
  assert.equal(fallback.building, 'Dragon Screening');
  assert.deepEqual(result.byRung, { 1: 1, 2: 2, 3: 7, 4: 1 });
});

test('without a schedule at all, every asset sits on the building-ready rung', () => {
  const result = assignMilestones([], DRAGON_ASSETS);

  assert.equal(result.assignments.length, DRAGON_ASSETS.length);
  assert.ok(result.assignments.every((assignment) => assignment.rung === 4));
  assert.deepEqual(result.byRung, { 1: 0, 2: 0, 3: 0, 4: 11 });
  assert.deepEqual(result.unmatchedActivities, []);
});

test('an asset whose building nothing stated still gets the default, with an empty bucket', () => {
  const result = assignMilestones([], [{ assetId: 'asset-9000', canonicalTag: 'TBD-0001' }]);

  assert.deepEqual(result.assignments, [
    { assetId: 'asset-9000', rung: 4, label: 'OP / Building Ready', building: '' },
  ]);
});

test('precedence: a direct equipment match outranks the system claim on the same asset', () => {
  // A2010 claims system 650; A2000 names RIO650-30-01. The RIO takes rung 1.
  const result = assignMilestones(dragonActivities(), DRAGON_ASSETS);
  const byAsset = rungs(result);

  assert.equal(byAsset['asset-0020'][0], 1);
  assert.equal(byAsset['asset-0021'][0], 2);
});

test('precedence: a milestone-flagged task claims a system before a plain activity can', () => {
  // A2030 mentions UPN 2201 and is read first; the XER milestone still wins,
  // because flagged milestones are sorted ahead of ordinary activities.
  const result = assignMilestones(dragonActivities(), DRAGON_ASSETS);

  assert.deepEqual(rungs(result)['asset-0010'], [3, 'L2-M1-2201 - UPN 2201 Screening Systems Enabling']);
  assert.ok(
    result.unmatchedActivities.some(
      (activity) => activity.activityId === 'A2030' && activity.reason === 'superseded',
    ),
  );
});

test('precedence: within one activity the UPN column is claimed before its name', () => {
  // A2040 states UPN 777 in both the column and the name; the column's rung wins.
  const result = assignMilestones(dragonActivities(), DRAGON_ASSETS);

  assert.deepEqual(rungs(result)['asset-0030'], [2, 'Loop check UPN 777 instruments']);
});

test('an activity that reached no asset is listed with why, never attached to a guess', () => {
  const result = assignMilestones(dragonActivities(), DRAGON_ASSETS);

  assert.deepEqual(result.unmatchedActivities, [
    { activityId: 'A2030', name: 'Preassemble UPN 2201 ductwork', reason: 'superseded' },
    { activityId: 'A2050', name: 'Mobilize commissioning team', reason: 'no-identifier' },
    { activityId: 'A2060', name: 'Energize spare feeder', reason: 'no-matching-asset' },
    { activityId: '1003', name: 'Install screening supply fan', reason: 'no-identifier' },
  ]);
});

test('an assignment carries the activity provenance, stamped with the rung that used it', () => {
  const result = assignMilestones(dragonActivities(), DRAGON_ASSETS);
  const rio = result.assignments.find((assignment) => assignment.assetId === 'asset-0020');

  assert.deepEqual(rio.provenance, {
    sourceFile: 'Dragon-Activities.xlsx',
    sourceRef: { kind: 'sheet-row', sheet: 'Activities', row: 1 },
    rule: 'milestone-ladder',
    fallbackRung: 1,
  });
  assert.equal(rio.activityId, 'A2000');
});

test('the ladder is deterministic under a reordered asset list', () => {
  const activities = dragonActivities();
  const straight = rungs(assignMilestones(activities, DRAGON_ASSETS));
  const shuffled = rungs(assignMilestones(activities, reorder([...DRAGON_ASSETS])));

  assert.deepEqual(shuffled, straight);
});

test('empty inputs produce empty output', () => {
  const result = assignMilestones([], []);

  assert.deepEqual(result.assignments, []);
  assert.deepEqual(result.unmatchedActivities, []);
  assert.deepEqual(result.byRung, { 1: 0, 2: 0, 3: 0, 4: 0 });
});

test('a milestone covering several systems at once is claimed by each of them', () => {
  assert.deepEqual(extractMilestoneUpns('L2 Energization UPN 115/116/117 complete'), [
    '115',
    '116',
    '117',
  ]);
  assert.deepEqual(extractMilestoneUpns('UPN-2201 enabling'), ['2201']);
  assert.deepEqual(extractMilestoneUpns('UPN#603 intake'), ['603']);
  assert.deepEqual(extractMilestoneUpns('Install screening supply fan'), []);
  assert.deepEqual(extractMilestoneUpns(''), []);
});

test('a global extraction pattern does not carry state between calls', () => {
  const pattern = /\bSYS\s*([0-9]+)/gi;

  assert.deepEqual(extractMilestoneUpns('Energize SYS 603', pattern), ['603']);
  assert.deepEqual(extractMilestoneUpns('Energize SYS 603', pattern), ['603']);
});

test('the bucket label and the extraction pattern are both configurable', () => {
  const activities = dragonActivities();
  const result = assignMilestones(activities, DRAGON_ASSETS, {
    buildingReadyLabel: 'RFSU / Building Ready',
    upnPattern: /\bSYSTEM\s*([A-Za-z0-9./-]+)/i,
  });
  const byAsset = rungs(result);

  // Nothing says "SYSTEM nnn", so the name-pattern rung is now unreachable.
  assert.equal(byAsset['asset-0001'][0], 4);
  assert.equal(byAsset['asset-0001'][1], 'RFSU / Building Ready');
  assert.equal(byAsset['asset-0020'][0], 1);
  assert.equal(byAsset['asset-0021'][0], 2);
});
