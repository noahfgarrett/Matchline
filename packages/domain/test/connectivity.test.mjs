import assert from 'node:assert/strict';
import test from 'node:test';

import { relationshipKindOf } from '../dist/index.js';
import {
  DRAGON_CABLE_FEED,
  DRAGON_CONNECTIVITY,
  DRAGON_EASYPOWER_FEED,
  DRAGON_PMD_RELATION,
} from './dist/connectivity.fixture.js';

test('every connectivity source kind is constructible', () => {
  assert.deepEqual(
    DRAGON_CONNECTIVITY.map((observation) => observation.sourceKind),
    ['easypower', 'cable-schedule', 'pmd'],
  );
});

test('a feed names its two ends and the cable between them', () => {
  assert.equal(DRAGON_EASYPOWER_FEED.kind, 'feed');
  assert.equal(DRAGON_EASYPOWER_FEED.fromTag, 'DRG-SWB-01');
  assert.equal(DRAGON_EASYPOWER_FEED.toTag, 'DRG-P-1201A');
  assert.equal(DRAGON_EASYPOWER_FEED.via, 'C-1201A');
});

test('an unnamed conductor is an absent via, not an undefined one', () => {
  assert.equal('via' in DRAGON_CABLE_FEED, false);
});

test('a pmd relation runs panel to instrument', () => {
  assert.equal(DRAGON_PMD_RELATION.kind, 'pmd-relation');
  assert.equal(DRAGON_PMD_RELATION.fromTag, 'PLC603-20-01');
  assert.equal(DRAGON_PMD_RELATION.toTag, 'TIT603-20-04');
});

test('an observation carries the source relationship, not a projection verdict', () => {
  assert.equal(relationshipKindOf(DRAGON_EASYPOWER_FEED.relationshipType), 'structural-parent');
  assert.equal(relationshipKindOf(DRAGON_PMD_RELATION.relationshipType), 'dependency');
});

test('every observation is addressable back to the row it came from', () => {
  for (const observation of DRAGON_CONNECTIVITY) {
    assert.equal(observation.provenance.sourceRef.kind, 'sheet-row');
    assert.ok(observation.provenance.sourceFile.length > 0);
  }
});
