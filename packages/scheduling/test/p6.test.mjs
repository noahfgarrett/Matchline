import assert from 'node:assert/strict';
import test from 'node:test';

import { SpreadsheetReadError } from '@matchline/spreadsheet-import';

import { readP6ActivitySheet, readXerSchedule } from '../dist/index.js';
import { DRAGON_ACTIVITY_MAPPING, DRAGON_ACTIVITY_SHEET, DRAGON_XER } from './dist/dragon.fixture.js';
import { sheetFrom } from './support.mjs';

const XER_OPTIONS = { sourceFile: 'Dragon-Schedule.xer' };
const SHEET_OPTIONS = { sourceFile: 'Dragon-Activities.xlsx', sheetName: 'Activities' };

test('an XER yields TASK activities, their milestone flags, and TASKPRED links', () => {
  const schedule = readXerSchedule(DRAGON_XER, XER_OPTIONS);

  assert.deepEqual(
    schedule.activities.map((activity) => [activity.activityId, activity.activityCode, activity.isMilestone]),
    [
      ['1001', 'L2-M1-0603', true],
      ['1002', 'L2-M1-2201', true],
      ['1003', 'A1010', false],
    ],
  );
  assert.equal(schedule.activities[0].name, 'L2-M1-0603 - UPN 603 Main Intake Energization');
  assert.deepEqual(schedule.links, [
    {
      activityId: '1002',
      predecessorActivityId: '1001',
      provenance: {
        sourceFile: 'Dragon-Schedule.xer',
        sourceRef: { kind: 'sheet-row', sheet: 'TASKPRED', row: 11 },
      },
    },
  ]);
  assert.deepEqual(schedule.stats, {
    activityCount: 3,
    milestoneCount: 2,
    linkCount: 1,
    skippedRowCount: 0,
  });
});

test('an XER record is addressed by its table and its line in the file', () => {
  const schedule = readXerSchedule(DRAGON_XER, XER_OPTIONS);

  assert.deepEqual(schedule.activities[0].provenance, {
    sourceFile: 'Dragon-Schedule.xer',
    sourceRef: { kind: 'sheet-row', sheet: 'TASK', row: 6 },
  });
  assert.equal(schedule.activities[2].provenance.sourceRef.row, 8);
});

test('an XER carries no equipment tag, UPN, or dates — the format has no such fields', () => {
  const schedule = readXerSchedule(DRAGON_XER, XER_OPTIONS);

  for (const activity of schedule.activities) {
    assert.equal(activity.equipmentTag, '');
    assert.equal(activity.upn, '');
    assert.equal(activity.startDate, '');
    assert.equal(activity.finishDate, '');
  }
});

test('an XER degrades rather than failing: empty text, unknown tables, no rows', () => {
  for (const text of ['', '%T\tRSRC\n%F\trsrc_id\n%R\t9', '%R\t1\t2', 'not an XER at all']) {
    const schedule = readXerSchedule(text, XER_OPTIONS);
    assert.deepEqual(schedule.activities, []);
    assert.deepEqual(schedule.links, []);
  }
});

test('an activity sheet reads under an explicit mapping, with dates carried as text', () => {
  const schedule = readP6ActivitySheet(
    sheetFrom(DRAGON_ACTIVITY_SHEET),
    DRAGON_ACTIVITY_MAPPING,
    SHEET_OPTIONS,
  );

  assert.deepEqual(
    schedule.activities.map((activity) => [activity.activityId, activity.equipmentTag, activity.upn]),
    [
      ['A2000', 'RIO650-30-01', ''],
      ['A2010', '', '650'],
      ['A2030', '', ''],
      ['A2040', '', '777'],
      ['A2050', '', ''],
      ['A2060', '', '999'],
    ],
  );
  assert.equal(schedule.activities[0].startDate, '01-Mar-27');
  assert.equal(schedule.activities[0].finishDate, '05-Mar-27');
  assert.equal(schedule.activities[0].activityCode, 'A2000');
  assert.deepEqual(schedule.links, []);
});

test('a sheet activity is never flagged a milestone — an Activities export has no task_type', () => {
  const schedule = readP6ActivitySheet(
    sheetFrom(DRAGON_ACTIVITY_SHEET),
    DRAGON_ACTIVITY_MAPPING,
    SHEET_OPTIONS,
  );

  assert.equal(schedule.stats.milestoneCount, 0);
  assert.ok(schedule.activities.every((activity) => activity.isMilestone === false));
});

test('a row with neither an id nor a name is skipped and counted, not read as an activity', () => {
  const schedule = readP6ActivitySheet(
    sheetFrom(DRAGON_ACTIVITY_SHEET),
    DRAGON_ACTIVITY_MAPPING,
    SHEET_OPTIONS,
  );

  assert.equal(schedule.stats.activityCount, 6);
  assert.equal(schedule.stats.skippedRowCount, 1);
});

test('a sheet activity is addressed by the worksheet row an engineer sees', () => {
  const schedule = readP6ActivitySheet(
    sheetFrom(DRAGON_ACTIVITY_SHEET),
    DRAGON_ACTIVITY_MAPPING,
    SHEET_OPTIONS,
  );

  assert.deepEqual(schedule.activities[0].provenance, {
    sourceFile: 'Dragon-Activities.xlsx',
    sourceRef: { kind: 'sheet-row', sheet: 'Activities', row: 1 },
  });
  // A2050 sits below the blank row: row 6, not the 5 an index into the scan would give.
  assert.equal(schedule.activities[4].activityId, 'A2050');
  assert.equal(schedule.activities[4].provenance.sourceRef.row, 6);
});

test('unmapped optional columns simply stay empty', () => {
  const schedule = readP6ActivitySheet(sheetFrom(DRAGON_ACTIVITY_SHEET), {
    activityId: 'Activity ID',
    activityName: 'Activity Name',
  }, SHEET_OPTIONS);

  assert.equal(schedule.activities.length, 6);
  assert.ok(schedule.activities.every((activity) => activity.equipmentTag === '' && activity.upn === ''));
});

test('a mapped header the sheet does not have is an error, never a guess', () => {
  assert.throws(
    () =>
      readP6ActivitySheet(sheetFrom(DRAGON_ACTIVITY_SHEET), {
        activityId: 'Activity ID',
        activityName: 'Activity Name',
        upn: 'System Number',
      }, SHEET_OPTIONS),
    (error) => {
      assert.ok(error instanceof SpreadsheetReadError);
      assert.equal(error.reason.kind, 'missing-columns');
      assert.deepEqual(error.reason.missing, [{ field: 'upn', header: 'System Number' }]);
      return true;
    },
  );
});

test('an empty sheet yields no activities rather than throwing', () => {
  const schedule = readP6ActivitySheet(
    sheetFrom([['Activity ID', 'Activity Name']]),
    { activityId: 'Activity ID', activityName: 'Activity Name' },
    SHEET_OPTIONS,
  );

  assert.deepEqual(schedule.activities, []);
  assert.deepEqual(schedule.stats, {
    activityCount: 0,
    milestoneCount: 0,
    linkCount: 0,
    skippedRowCount: 0,
  });
});
