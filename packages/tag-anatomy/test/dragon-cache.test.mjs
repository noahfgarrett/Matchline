import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { applyAnatomy, previewAnatomy } from '../dist/index.js';
import { DRAGON_ANATOMY } from './dist/anatomy.fixture.js';

// model-schema is a sibling workspace, imported by built path rather than by
// package name: it is only needed by this test, and depending on it for that
// would put a test-only link in the package manifest. `tsc -b test` builds it
// via the project reference in test/tsconfig.json.
import { openExtractionCache } from '../../model-schema/dist/index.js';
import { writeDragonFixture } from '../../model-schema/dist/fixtures/dragon.js';

/**
 * Tag counts worked out by hand from the Dragon fixture layout:
 *
 *   Mechanical, per building: 6 MAH001 + 2 MAH002 + 4 TIT603 = 12
 *   Controls,   per building: 1 PLC001 + 4 VFD001            =  5
 *   Two buildings (level segments 10 and 20)      -> 34 tagged objects
 *
 * Distinct segment values across those 34 tags:
 *   role      MAH, TIT, PLC, VFD                              -> 4
 *   system    001, 002, 603                                   -> 3
 *   unit      10, 20                                          -> 2
 *   instance  01..06                                          -> 6
 *
 * Distinct family keys: per building 6 (001-nn-01..06) + 2 (002) + 4 (603)
 * = 12, and two buildings                                     -> 24
 */
const TAG_PROPERTY = { category: 'Dragon Data', name: 'Tag' };

let directory = '';
let cache = null;
let tags = [];

before(() => {
  directory = mkdtempSync(join(tmpdir(), 'matchline-tag-anatomy-dragon-'));
  const path = join(directory, 'dragon.sqlite');
  writeDragonFixture(path);
  cache = openExtractionCache(path);

  // Extraction ordinal order, so the tag list is the same every run.
  tags = [];
  for (const object of cache.allObjects()) {
    for (const property of cache.propertiesOf(object.id)) {
      if (
        property.category === TAG_PROPERTY.category &&
        property.name === TAG_PROPERTY.name &&
        property.valueText !== null
      ) {
        tags.push(property.valueText);
      }
    }
  }
});

after(() => {
  cache?.close();
  if (directory !== '') {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the Dragon cache yields the tags the fixture layout implies', () => {
  assert.equal(tags.length, 34);
  assert.equal(tags[0], 'MAH001-10-01');
});

test('the taught anatomy covers every tagged object in the model', () => {
  const preview = previewAnatomy(DRAGON_ANATOMY, tags);
  assert.equal(preview.total, 34);
  assert.equal(preview.matchedCount, 34);
  assert.equal(preview.coverage, 1);
  assert.deepEqual(preview.misses, []);
});

test('segment cardinality over the real cache matches the fixture layout', () => {
  const preview = previewAnatomy(DRAGON_ANATOMY, tags);
  assert.deepEqual(preview.segmentStats, [
    { segment: 'role', distinctValueCount: 4 },
    { segment: 'system', distinctValueCount: 3 },
    { segment: 'unit', distinctValueCount: 2 },
    { segment: 'instance', distinctValueCount: 6 },
  ]);
});

test('tag-derived system agrees with the UPN property the model carries', () => {
  let compared = 0;
  for (const object of cache.allObjects()) {
    const properties = cache.propertiesOf(object.id);
    const tag = properties.find(
      (property) => property.category === 'Dragon Data' && property.name === 'Tag',
    );
    const upn = properties.find(
      (property) => property.category === 'Dragon Data' && property.name === 'UPN',
    );
    if (tag?.valueText == null || upn?.valueText == null) {
      continue;
    }
    const result = applyAnatomy(DRAGON_ANATOMY, tag.valueText);
    assert.equal(result.matched, true, `${tag.valueText} did not match`);
    assert.equal(result.segments.system, upn.valueText, `${tag.valueText} disagreed with its UPN`);
    compared += 1;
  }
  assert.equal(compared, 34);
});

test('family keys group equipment across roles and disciplines', () => {
  const families = new Set();
  for (const tag of tags) {
    families.add(applyAnatomy(DRAGON_ANATOMY, tag).familyKey);
  }
  assert.equal(families.size, 24);
  // MAH001-10-01 is mechanical, PLC001-10-01 and VFD001-10-01 are controls.
  assert.equal(families.has('001-10-01'), true);
});
