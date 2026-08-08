import assert from 'node:assert/strict';
import test from 'node:test';

import { PREVIEW_EXAMPLE_LIMIT, previewAnatomy } from '../dist/index.js';
import { DRAGON_ANATOMY, DRAGON_SEGMENTS_ONLY } from './dist/anatomy.fixture.js';

/**
 * The numbers below are worked out by hand from this list, not captured from a
 * run:
 *
 *   MAH001-10-01  matches  role MAH  system 001  unit 10  instance 01
 *   MAH001-10-02  matches  role MAH  system 001  unit 10  instance 02
 *   MAH002-10-01  matches  role MAH  system 002  unit 10  instance 01
 *   PUMP-10-01    misses   no trailing digits in token 0
 *   ""            misses   empty tag
 *   MAH001-10-01  matches  a repeat of the first tag
 *
 *   6 tags, 4 matches, coverage 4/6.
 *   distinct role 1 (MAH), system 2 (001, 002), unit 1 (10), instance 2 (01, 02).
 *   3 distinct matching tags, 2 distinct missing tags.
 */
const SAMPLE_TAGS = [
  'MAH001-10-01',
  'MAH001-10-02',
  'MAH002-10-01',
  'PUMP-10-01',
  '',
  'MAH001-10-01',
];

test('coverage counts every tag handed in, repeats included', () => {
  const preview = previewAnatomy(DRAGON_ANATOMY, SAMPLE_TAGS);
  assert.equal(preview.total, 6);
  assert.equal(preview.matchedCount, 4);
  assert.equal(preview.coverage, 4 / 6);
});

test('per-segment statistics count distinct values, not occurrences', () => {
  const preview = previewAnatomy(DRAGON_ANATOMY, SAMPLE_TAGS);
  assert.deepEqual(preview.segmentStats, [
    { segment: 'role', distinctValueCount: 1 },
    { segment: 'system', distinctValueCount: 2 },
    { segment: 'unit', distinctValueCount: 1 },
    { segment: 'instance', distinctValueCount: 2 },
  ]);
});

test('statistics cover only the segments the anatomy configured', () => {
  const preview = previewAnatomy(DRAGON_SEGMENTS_ONLY, SAMPLE_TAGS);
  assert.deepEqual(
    preview.segmentStats.map((stat) => stat.segment),
    ['role', 'system'],
  );
});

test('examples are the first distinct matching tags, in input order', () => {
  const preview = previewAnatomy(DRAGON_ANATOMY, SAMPLE_TAGS);
  assert.deepEqual(
    preview.examples.map((example) => example.tag),
    ['MAH001-10-01', 'MAH001-10-02', 'MAH002-10-01'],
  );
  assert.equal(preview.examples[0].result.familyKey, '001-10-01');
});

test('every miss example carries the reason and the detail', () => {
  const preview = previewAnatomy(DRAGON_ANATOMY, SAMPLE_TAGS);
  assert.deepEqual(preview.misses, [
    {
      tag: 'PUMP-10-01',
      reason: 'extractor-miss',
      detail: 'segment "system": token 0 "PUMP" has no trailing digits',
    },
    { tag: '', reason: 'empty-tag', detail: 'the tag is empty' },
  ]);
});

test('an empty tag set previews as zero coverage rather than NaN', () => {
  const preview = previewAnatomy(DRAGON_ANATOMY, []);
  assert.equal(preview.total, 0);
  assert.equal(preview.matchedCount, 0);
  assert.equal(preview.coverage, 0);
  assert.deepEqual(preview.examples, []);
  assert.deepEqual(preview.misses, []);
});

test('examples and misses are capped without affecting the counts', () => {
  const matching = Array.from({ length: 12 }, (_, index) => `MAH001-10-${String(index).padStart(2, '0')}`);
  const failing = Array.from({ length: 11 }, (_, index) => `PUMP-10-${String(index).padStart(2, '0')}`);
  const preview = previewAnatomy(DRAGON_ANATOMY, [...matching, ...failing]);

  assert.equal(preview.total, 23);
  assert.equal(preview.matchedCount, 12);
  assert.equal(preview.examples.length, PREVIEW_EXAMPLE_LIMIT);
  assert.equal(preview.misses.length, PREVIEW_EXAMPLE_LIMIT);
  assert.equal(preview.examples[0].tag, 'MAH001-10-00');
  assert.equal(preview.examples[PREVIEW_EXAMPLE_LIMIT - 1].tag, 'MAH001-10-07');
});

test('the same tag set previews identically every run', () => {
  const first = previewAnatomy(DRAGON_ANATOMY, SAMPLE_TAGS);
  const second = previewAnatomy(DRAGON_ANATOMY, [...SAMPLE_TAGS]);
  assert.deepEqual(first, second);
});

test('reordering the tags changes the examples but not the statistics', () => {
  const reversed = previewAnatomy(DRAGON_ANATOMY, [...SAMPLE_TAGS].reverse());
  const forward = previewAnatomy(DRAGON_ANATOMY, SAMPLE_TAGS);

  assert.equal(reversed.matchedCount, forward.matchedCount);
  assert.deepEqual(reversed.segmentStats, forward.segmentStats);
  assert.notDeepEqual(
    reversed.examples.map((example) => example.tag),
    forward.examples.map((example) => example.tag),
  );
  assert.equal(reversed.misses[0].tag, '');
});
