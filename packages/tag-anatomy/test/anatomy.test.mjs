import assert from 'node:assert/strict';
import test from 'node:test';

import { applyAnatomy, tokenize } from '../dist/index.js';
import {
  DRAGON_ANATOMY,
  DRAGON_SEGMENTS_ONLY,
  MULTI_SEPARATOR,
  OVERLAPPING_SEPARATORS,
  RANGE_ANATOMY,
  TEMPLATE_OUT_OF_RANGE,
  TEMPLATE_UNEXTRACTED_SEGMENT,
  TEMPLATE_UNKNOWN_PLACEHOLDER,
  UNSEPARATED_ANATOMY,
} from './dist/anatomy.fixture.js';

test('the Dragon convention resolves role, system and family from one tag', () => {
  const result = applyAnatomy(DRAGON_ANATOMY, 'MAH001-10-01');
  assert.equal(result.matched, true);
  assert.deepEqual(result.segments, {
    role: 'MAH',
    system: '001',
    unit: '10',
    instance: '01',
  });
  assert.equal(result.familyKey, '001-10-01');
  assert.equal(result.localFamily, '10-01');
  assert.equal(result.normalizedTag, 'MAH001-10-01');
});

test('a three-letter role and a three-digit system come out of the same token', () => {
  const result = applyAnatomy(DRAGON_ANATOMY, 'TIT603-20-04');
  assert.equal(result.segments.role, 'TIT');
  assert.equal(result.segments.system, '603');
  assert.equal(result.familyKey, '603-20-04');
});

test('equipment of different roles in one system shares a family key', () => {
  const keys = ['MAH001-10-01', 'PLC001-10-01', 'VFD001-10-01'].map(
    (tag) => applyAnatomy(DRAGON_ANATOMY, tag).familyKey,
  );
  assert.deepEqual(keys, ['001-10-01', '001-10-01', '001-10-01']);
});

test('an anatomy with no templates reports no family key at all', () => {
  const result = applyAnatomy(DRAGON_SEGMENTS_ONLY, 'MAH001-10-01');
  assert.equal(result.matched, true);
  assert.equal('familyKey' in result, false);
  assert.equal('localFamily' in result, false);
  assert.deepEqual(result.segments, { role: 'MAH', system: '001' });
});

test('an ignored suffix is stripped before tokenizing', () => {
  const result = applyAnatomy(DRAGON_ANATOMY, 'MAH001-10-01-SPARE');
  assert.equal(result.matched, true);
  assert.equal(result.normalizedTag, 'MAH001-10-01');
  assert.equal(result.familyKey, '001-10-01');
});

test('the longest ignored suffix wins and only one is stripped', () => {
  const result = applyAnatomy(DRAGON_ANATOMY, 'MAH001-10-01-A-SPARE');
  assert.equal(result.normalizedTag, 'MAH001-10-01-A');
  assert.equal(result.segments.instance, '01');
});

test('ignored suffixes are matched case-sensitively, not guessed at', () => {
  const result = applyAnatomy(DRAGON_ANATOMY, 'MAH001-10-01-spare');
  assert.equal(result.matched, true);
  assert.equal(result.normalizedTag, 'MAH001-10-01-spare');
});

test('separators are matched longest-first so a shorter one cannot split first', () => {
  const result = applyAnatomy(OVERLAPPING_SEPARATORS, 'A - B-C');
  assert.equal(result.matched, true);
  assert.deepEqual(result.segments, { role: 'A', system: 'B' });
});

test('multi-character separators tokenize alongside single-character ones', () => {
  const result = applyAnatomy(MULTI_SEPARATOR, 'AHU07::001-02');
  assert.equal(result.matched, true);
  assert.deepEqual(result.segments, { role: 'AHU', system: '001', instance: '02' });
});

test('empty tokens are dropped rather than shifting every index', () => {
  assert.deepEqual(tokenize(['-'], 'MAH001--10---01'), ['MAH001', '10', '01']);
  const result = applyAnatomy(DRAGON_ANATOMY, 'MAH001--10---01');
  assert.equal(result.segments.instance, '01');
});

test('a token range includes both ends and rejoins with the first separator', () => {
  const result = applyAnatomy(RANGE_ANATOMY, 'MAH001-10-01');
  assert.equal(result.segments.unit, '10-01');
});

test('a character range is a 0-based slice with the end excluded', () => {
  const result = applyAnatomy(RANGE_ANATOMY, 'MAH001-10-01');
  assert.equal(result.segments.instance, '001');
});

test('a site with no separators still slices its single token', () => {
  assert.deepEqual(tokenize([], 'MAH001-10-01'), ['MAH001-10-01']);
  const result = applyAnatomy(UNSEPARATED_ANATOMY, 'MAH001-10-01');
  assert.deepEqual(result.segments, { role: 'MAH', system: '001' });
});

test('an empty tag misses with a reason of its own', () => {
  const result = applyAnatomy(DRAGON_ANATOMY, '');
  assert.deepEqual(result, {
    matched: false,
    reason: 'empty-tag',
    detail: 'the tag is empty',
  });
});

test('a tag that is nothing but an ignored suffix misses as empty', () => {
  const result = applyAnatomy(DRAGON_ANATOMY, '-SPARE');
  assert.equal(result.reason, 'empty-tag');
  assert.match(result.detail, /nothing but an ignored suffix/);
});

test('a tag made only of separators misses with no-tokens', () => {
  const result = applyAnatomy(DRAGON_ANATOMY, '---');
  assert.deepEqual(result, {
    matched: false,
    reason: 'no-tokens',
    detail: '"---" is nothing but separators',
  });
});

test('a tag with no digits names the segment that could not be extracted', () => {
  const result = applyAnatomy(DRAGON_ANATOMY, 'PUMP-10-01');
  assert.equal(result.reason, 'extractor-miss');
  assert.equal(result.detail, 'segment "system": token 0 "PUMP" has no trailing digits');
});

test('a tag with no letters names the role segment', () => {
  const result = applyAnatomy(DRAGON_ANATOMY, '001-10-01');
  assert.equal(result.detail, 'segment "role": token 0 "001" has no leading letters');
});

test('a tag too short for a configured segment misses on that segment', () => {
  const result = applyAnatomy(DRAGON_ANATOMY, 'MAH001-10');
  assert.equal(
    result.detail,
    'segment "instance": token 2 does not exist (the tag has 2 token(s))',
  );
});

test('a character range past the end of its token misses', () => {
  const result = applyAnatomy(RANGE_ANATOMY, 'MAH-10-01');
  assert.equal(result.reason, 'extractor-miss');
  assert.match(result.detail, /segment "instance": character range \[3, 6\) runs past token 0/);
});

test('a template placeholder that cannot be filled fails the whole tag', () => {
  const result = applyAnatomy(TEMPLATE_OUT_OF_RANGE, 'MAH001-10-01');
  assert.equal(result.matched, false);
  assert.equal(result.reason, 'extractor-miss');
  assert.match(result.detail, /^familyKeyTemplate: \{token:5\} needs token 5/);
});

test('a template naming a segment the anatomy never extracts fails', () => {
  const result = applyAnatomy(TEMPLATE_UNEXTRACTED_SEGMENT, 'MAH001-10-01');
  assert.equal(
    result.detail,
    'familyKeyTemplate: {role} needs the role segment, which this anatomy does not extract',
  );
});

test('an unknown placeholder is refused rather than left literal', () => {
  const result = applyAnatomy(TEMPLATE_UNKNOWN_PLACEHOLDER, 'MAH001-10-01');
  assert.equal(
    result.detail,
    'localFamilyTemplate: {building} is not a placeholder this engine knows',
  );
});

test('anatomy does not normalize: stray whitespace is a visible miss', () => {
  const result = applyAnatomy(DRAGON_ANATOMY, ' MAH001-10-01');
  assert.equal(result.matched, false);
  assert.equal(result.detail, 'segment "role": token 0 " MAH001" has no leading letters');
});

test('the same tag produces an identical result every call', () => {
  const first = applyAnatomy(DRAGON_ANATOMY, 'MAH001-10-01');
  const second = applyAnatomy(DRAGON_ANATOMY, 'MAH001-10-01');
  assert.deepEqual(first, second);
  assert.notEqual(first, second);
});
