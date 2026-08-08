import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assignMilestones,
  buildPredecessorMatrix,
  computeSequence,
  naturalCompare,
  readP6ActivitySheet,
  readXerSchedule,
  systemKeyOf,
  tagKey,
  writePredecessorWorkbook,
} from '../dist/index.js';
import {
  DRAGON_ACTIVITY_MAPPING,
  DRAGON_ACTIVITY_SHEET,
  DRAGON_ASSETS,
  DRAGON_SNAPSHOT,
  DRAGON_XER,
} from './dist/dragon.fixture.js';
import { reorder, sheetFrom } from './support.mjs';

/** Every commissioning output for one project, as a comparable value. */
function outputs(assets) {
  const activities = [
    ...readP6ActivitySheet(sheetFrom(DRAGON_ACTIVITY_SHEET), DRAGON_ACTIVITY_MAPPING, {
      sourceFile: 'Dragon-Activities.xlsx',
      sheetName: 'Activities',
    }).activities,
    ...readXerSchedule(DRAGON_XER, { sourceFile: 'Dragon-Schedule.xer' }).activities,
  ];
  const matrix = buildPredecessorMatrix(DRAGON_SNAPSHOT, assets);
  return JSON.stringify({
    milestones: assignMilestones(activities, assets),
    sequence: computeSequence(DRAGON_SNAPSHOT, assets),
    matrix,
    workbook: [...writePredecessorWorkbook(matrix)],
  });
}

test('the same project compiles to the same commissioning outputs, twice', () => {
  assert.equal(outputs(DRAGON_ASSETS), outputs(DRAGON_ASSETS));
});

test('a reordered asset list changes nothing but the milestone row order', () => {
  const straight = JSON.parse(outputs(DRAGON_ASSETS));
  const shuffled = JSON.parse(outputs(reorder([...DRAGON_ASSETS])));

  assert.deepEqual(shuffled.sequence, straight.sequence);
  assert.deepEqual(shuffled.matrix, straight.matrix);
  assert.deepEqual(shuffled.workbook, straight.workbook);
  // Milestone assignments follow the asset order given, so compare as a set.
  const byAsset = (result) =>
    Object.fromEntries(result.assignments.map((entry) => [entry.assetId, entry.rung]));
  assert.deepEqual(byAsset(shuffled.milestones), byAsset(straight.milestones));
});

test('natural ordering is numeric, case-insensitive, and a total order', () => {
  const sorted = ['VFD603-10-2', 'vfd603-10-10', 'GIS603-00-01', 'PNL603-10-01'].sort(naturalCompare);

  assert.deepEqual(sorted, ['GIS603-00-01', 'PNL603-10-01', 'VFD603-10-2', 'vfd603-10-10']);
  assert.equal(naturalCompare('001', '001'), 0);
  assert.ok(naturalCompare('001', '1') < 0, 'equal numbers order by padding, never as equal');
  assert.ok(naturalCompare('2201', '603') > 0);
  assert.equal(naturalCompare('', ''), 0);
});

test('tag keys fold the spellings that mean one tag, and nothing else', () => {
  assert.equal(tagKey('  MAH001 - 10 - 01 '), 'mah001-10-01');
  // U+2011 non-breaking hyphens, as Word and some MELs write them.
  assert.equal(tagKey('MAH001‑10‑01'), 'mah001-10-01');
  // A zero-width space pasted into the middle of a tag.
  assert.equal(tagKey('MAH001​-10-01'), 'mah001-10-01');
  assert.notEqual(tagKey('MAH001-10-01A'), tagKey('MAH001-10-01B'));
  assert.equal(tagKey(''), '');
});

test('system keys drop whitespace and case, and never drop a leading zero', () => {
  assert.equal(systemKeyOf(' 26 01 '), '2601');
  assert.equal(systemKeyOf('Upn-603'), 'upn-603');
  assert.notEqual(systemKeyOf('001'), systemKeyOf('1'));
  assert.equal(systemKeyOf(undefined), '');
});
