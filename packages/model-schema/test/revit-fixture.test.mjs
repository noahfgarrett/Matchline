import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { openExtractionCache } from '../dist/index.js';
import {
  REVIT_ALL_MARKS,
  REVIT_COMMISSIONING_MARKS,
  REVIT_IC_MARKS,
  REVIT_MARK_PROPERTY,
  writeRevitShapedFixture,
} from '../dist/fixtures/revit.js';

/**
 * The Revit-shaped fixture: the second synthetic site, and the one that looks
 * like what a Revit federation actually publishes.
 *
 * Dragon proves the engine on a well-tagged plant model. This proves the
 * generator writes the OTHER shape — a sparse `Element > Mark`, no building
 * property anywhere, and the building only in the file names — because every
 * Quick Setup assertion in the desktop suite is read off these numbers.
 */

let workDir = '';
let cachePath = '';
let cache = null;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'matchline-revit-'));
  cachePath = join(workDir, 'Campus.matchline-cache');
  writeRevitShapedFixture(cachePath);
  cache = openExtractionCache(cachePath);
});

after(() => {
  cache?.close();
  if (workDir !== '') {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('five files: two buildings, a controls package and a commissioning package', () => {
  const names = cache.sourceModels().map((model) => model.fileName).sort();
  assert.deepEqual(names, [
    'B14-Commissioning.nwc',
    'B14-Controls.nwc',
    'B14-Electrical.nwc',
    'B14-Mechanical.nwc',
    'B22-Mechanical.nwc',
  ]);
});

test('the mark is on roughly a twelfth of the objects, which is the point', () => {
  const marks = [];
  for (const row of cache.allProperties()) {
    if (
      row.category === REVIT_MARK_PROPERTY.category &&
      row.name === REVIT_MARK_PROPERTY.name &&
      row.valueText
    ) {
      marks.push(row.valueText);
    }
  }

  assert.deepEqual(marks, [...REVIT_ALL_MARKS]);
  assert.equal(marks.length, 26);
  assert.equal(cache.objectCount(), 208);
  const share = marks.length / cache.objectCount();
  assert.ok(share > 0.08 && share < 0.14, `mark coverage is ${String(share)}`);
});

test('only the two B14 packages state a Discipline, and they state four of them', () => {
  const marksByObject = new Map();
  const disciplineByObject = new Map();
  for (const row of cache.allProperties()) {
    if (row.category !== 'Element' || !row.valueText) continue;
    if (row.name === 'Mark') marksByObject.set(row.objectId, row.valueText);
    if (row.name === 'Discipline') disciplineByObject.set(row.objectId, row.valueText);
  }

  const stated = [...disciplineByObject.keys()].map((id) => marksByObject.get(id));
  assert.deepEqual(
    stated.sort(),
    [...REVIT_IC_MARKS, ...REVIT_COMMISSIONING_MARKS].sort(),
    'the three MEP packages publish no Discipline parameter at all',
  );

  const byMark = new Map(
    [...disciplineByObject].map(([id, value]) => [marksByObject.get(id), value]),
  );
  // The SOP scenario is only a scenario because these differ: the machine is
  // Mechanical, its drive is Electrical, its instruments are I&C, and the SOP
  // nests all three together anyway.
  assert.equal(byMark.get('MAH101-01'), 'Mechanical');
  assert.equal(byMark.get('VFD101-01'), 'Electrical');
  assert.equal(byMark.get('TIT101-01'), 'I&C');
  assert.equal(byMark.get('MCC101'), 'Electrical');
  assert.equal(byMark.get('FACP-B14-01'), 'Life Safety');
  assert.deepEqual(
    [...new Set(disciplineByObject.values())].sort(),
    ['Electrical', 'I&C', 'Life Safety', 'Mechanical'],
  );
});

test('nothing in it is called Building', () => {
  const names = new Set();
  for (const row of cache.allProperties()) {
    names.add(`${row.category} > ${row.name}`);
  }
  assert.ok(!names.has('Element > Building'));
  assert.ok(names.has('Element > Level'), 'Level is the nearest thing, and it repeats per building');
  assert.ok(names.has('Element > Workset'));
  assert.ok(names.has('Element > System Classification'));
  assert.ok(names.has('Element > System Name'));
});

test('equipment is published inside equipment, which is what nests', () => {
  const byId = new Map();
  for (const object of cache.allObjects()) {
    byId.set(object.id, object);
  }
  const marksByObject = new Map();
  for (const row of cache.allProperties()) {
    if (row.category === 'Element' && row.name === 'Mark' && row.valueText) {
      marksByObject.set(row.objectId, row.valueText);
    }
  }

  const pairs = [];
  for (const [objectId, mark] of marksByObject) {
    let parentId = byId.get(objectId)?.parentId ?? null;
    while (parentId !== null) {
      const parentMark = marksByObject.get(parentId);
      if (parentMark !== undefined) {
        pairs.push([parentMark, mark]);
        break;
      }
      parentId = byId.get(parentId)?.parentId ?? null;
    }
  }

  assert.deepEqual(pairs.sort(), [
    ['AHU-1', 'P101'],
    ['AHU-2', 'P102'],
    ['AHU-3', 'P103'],
    ['LCP101-01', 'TIT101-01'],
    ['MCC-2A', 'VFD-2A-1'],
    ['MCC-2A', 'VFD-2A-2'],
    ['PLC101-01', 'LCP101-01'],
  ]);
});

test('the generator is deterministic', () => {
  const second = join(workDir, 'Campus-again.matchline-cache');
  writeRevitShapedFixture(second);
  const other = openExtractionCache(second);
  try {
    assert.deepEqual(
      [...other.allObjects()].map((object) => [object.id, object.displayName, object.className]),
      [...cache.allObjects()].map((object) => [object.id, object.displayName, object.className]),
    );
  } finally {
    other.close();
  }
});
