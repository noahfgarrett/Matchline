/**
 * Existing-MEL comparison (PRODUCT.md §12.3).
 *
 * The counts in these tests are worked out by hand from the fixtures rather
 * than read off the implementation — the point of the summary is that an
 * engineer can trust it without opening the code.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { MelExportError, compareWithExistingMel } from '../dist/index.js';
import {
  DRAGON_ASSETS,
  DRAGON_EXISTING_MEL_ROWS,
  DRAGON_MEL_ALIASES,
} from './dist/dragon.fixture.js';

/** The Dragon MEL's column names, bound to the §12.1 fields they hold. */
const DRAGON_MEL_MAPPING = [
  { field: 'equipmentTag', melKey: 'tag' },
  { field: 'equipmentDescription', melKey: 'description' },
  { field: 'systemKey', melKey: 'upn' },
  { field: 'systemLabel', melKey: 'system' },
];

function compare(options = { aliases: DRAGON_MEL_ALIASES }) {
  return compareWithExistingMel(
    DRAGON_ASSETS,
    DRAGON_EXISTING_MEL_ROWS,
    DRAGON_MEL_MAPPING,
    options,
  );
}

/** The comparison for one tag, or `undefined`. */
function forTag(comparison, tag) {
  return comparison.matched.find((entry) => entry.canonicalTag === tag);
}

test('tags both sides have are matched, in code-unit order', () => {
  /* Matchline has five distinct tags; the MEL supplies four matchable ones. */
  assert.deepEqual(
    compare().matched.map((entry) => entry.canonicalTag),
    ['CHW001-01-01', 'EPB002-01-01', 'MAH001-10-01', 'MAH001-10-02'],
  );
});

test('every mapped field except the tag is compared, in §12.1 column order', () => {
  const entry = forTag(compare(), 'MAH001-10-01');
  assert.deepEqual(
    entry.fields.map((field) => field.field),
    ['equipmentDescription', 'systemKey', 'systemLabel'],
  );
});

test('a tag the two sides agree on completely disagrees nowhere', () => {
  const entry = forTag(compare(), 'MAH001-10-01');
  assert.deepEqual(entry.fields, [
    {
      field: 'equipmentDescription',
      matchlineValue: 'Primary air handler',
      melValue: 'Primary air handler',
      agree: true,
    },
    { field: 'systemKey', matchlineValue: '001', melValue: '001', agree: true },
    {
      field: 'systemLabel',
      matchlineValue: 'Dragon Air Handling',
      melValue: 'Dragon Air Handling',
      agree: true,
    },
  ]);
  assert.equal(entry.agreeCount, 3);
  assert.equal(entry.disagreeCount, 0);
});

test('a differently worded description is a disagreement, not a match', () => {
  const entry = forTag(compare(), 'MAH001-10-02');
  const [description] = entry.fields;
  assert.deepEqual(description, {
    field: 'equipmentDescription',
    matchlineValue: 'Secondary air handler',
    melValue: 'Secondary air handling unit',
    agree: false,
  });
  assert.equal(entry.agreeCount, 2);
  assert.equal(entry.disagreeCount, 1);
});

test('a leading-zero mismatch on the UPN is a disagreement', () => {
  /* §20: "Leading-zero mismatch". '2' is not '002', and the comparison says so
     rather than normalizing one side into agreement. */
  const entry = forTag(compare(), 'EPB002-01-01');
  const systemKey = entry.fields.find((field) => field.field === 'systemKey');
  assert.deepEqual(systemKey, {
    field: 'systemKey',
    matchlineValue: '002',
    melValue: '2',
    agree: false,
  });
});

test('an accepted alias joins the site’s spelling to the canonical tag', () => {
  const entry = forTag(compare(), 'EPB002-01-01');
  assert.equal(entry.melTag, 'EPB002-1-1');
  /* Without the alias, the same row is MEL-only and the asset is Matchline-only. */
  const unaliased = compare({});
  assert.equal(forTag(unaliased, 'EPB002-01-01'), undefined);
  assert.ok(unaliased.melOnlyTags.includes('EPB002-1-1'));
  assert.ok(unaliased.matchlineOnlyTags.includes('EPB002-01-01'));
});

test('tags are trimmed on both sides before matching', () => {
  /* The MEL row is '  MAH001-10-02  '; the canonical tag has no padding. */
  assert.equal(forTag(compare(), 'MAH001-10-02').melTag, 'MAH001-10-02');
});

test('a mapped column the MEL row does not have reads as blank, and can agree', () => {
  /* The CHW row has no `upn` key at all, and Matchline resolved no key either.
     Absent and stated-blank are the same value here — the distinction is not
     preserved, and this is what that costs. */
  const entry = forTag(compare(), 'CHW001-01-01');
  const systemKey = entry.fields.find((field) => field.field === 'systemKey');
  assert.deepEqual(systemKey, {
    field: 'systemKey',
    matchlineValue: '',
    melValue: '',
    agree: true,
  });
  /* Its description is stated-blank in the MEL, and disagrees. */
  const description = entry.fields.find((field) => field.field === 'equipmentDescription');
  assert.deepEqual(description, {
    field: 'equipmentDescription',
    matchlineValue: 'Chilled water pump',
    melValue: '',
    agree: false,
  });
});

test('MEL-only tags are listed as evidence, and never become assets', () => {
  const comparison = compare();
  assert.deepEqual([...comparison.melOnlyTags], ['BLR001-01-01']);
  /* §9.3: MEL_ONLY records are discrepancy evidence. Nothing here promotes one:
     it is not matched, and it is not in the Matchline side of anything. */
  assert.equal(forTag(comparison, 'BLR001-01-01'), undefined);
  assert.ok(!comparison.matchlineOnlyTags.includes('BLR001-01-01'));
});

test('Matchline-only tags are listed separately', () => {
  assert.deepEqual([...compare().matchlineOnlyTags], ['FCU-SPARE-07']);
});

test('an MEL row with no tag is counted and dropped, not matched to anything', () => {
  const comparison = compare();
  assert.equal(comparison.summary.unkeyedMelRowCount, 1);
  assert.equal(comparison.matched.length + comparison.melOnlyTags.length, 5);
});

test('a duplicated tag reports both row counts and compares the first row', () => {
  const entry = forTag(compare(), 'MAH001-10-01');
  assert.equal(entry.matchlineRowCount, 2, 'DUPLICATE_MODEL_TAG: never merged (§9.3)');
  assert.equal(entry.melRowCount, 1);
  /* The first row in canonical order is the one carrying the description. */
  assert.equal(entry.fields[0].matchlineValue, 'Primary air handler');
});

test('the summary adds up, by hand', () => {
  /* Four matched tags x three compared fields = twelve comparisons.
     MAH001-10-01 agrees on all three; MAH001-10-02, EPB002-01-01 and
     CHW001-01-01 each disagree on exactly one. */
  assert.deepEqual(compare().summary, {
    matchedTagCount: 4,
    melOnlyTagCount: 1,
    matchlineOnlyTagCount: 1,
    comparedFieldCount: 12,
    agreeCount: 9,
    disagreeCount: 3,
    disagreeingTagCount: 3,
    unkeyedMelRowCount: 1,
  });
});

test('the result is the same however the MEL rows and the mapping arrive', () => {
  /* The asset order is held fixed on purpose: reversing it swaps the duplicate
     MAH001-10-01 pair, which is the one tie stable sorting leaves in input
     order (see rows.test.mjs), and that is a different row to compare -- not a
     comparison that depends on input order. */
  const forwards = compare();
  const backwards = compareWithExistingMel(
    DRAGON_ASSETS,
    [...DRAGON_EXISTING_MEL_ROWS].reverse(),
    [...DRAGON_MEL_MAPPING].reverse(),
    { aliases: DRAGON_MEL_ALIASES },
  );
  assert.deepEqual(backwards.summary, forwards.summary);
  assert.deepEqual(
    backwards.matched.map((entry) => entry.canonicalTag),
    forwards.matched.map((entry) => entry.canonicalTag),
  );
  assert.deepEqual([...backwards.melOnlyTags], [...forwards.melOnlyTags]);
  assert.deepEqual(
    backwards.matched.map((entry) => entry.fields.map((field) => field.field)),
    forwards.matched.map((entry) => entry.fields.map((field) => field.field)),
    'field order follows §12.1, not the mapping’s order',
  );
});

test('no MEL at all makes every asset Matchline-only', () => {
  const comparison = compareWithExistingMel(DRAGON_ASSETS, [], DRAGON_MEL_MAPPING);
  assert.equal(comparison.matched.length, 0);
  assert.equal(comparison.melOnlyTags.length, 0);
  assert.deepEqual(
    [...comparison.matchlineOnlyTags],
    ['CHW001-01-01', 'EPB002-01-01', 'FCU-SPARE-07', 'MAH001-10-01', 'MAH001-10-02'],
  );
  assert.equal(comparison.summary.disagreeCount, 0);
});

test('no assets at all makes every MEL row MEL-only', () => {
  const comparison = compareWithExistingMel([], DRAGON_EXISTING_MEL_ROWS, DRAGON_MEL_MAPPING);
  assert.equal(comparison.matched.length, 0);
  assert.equal(comparison.matchlineOnlyTags.length, 0);
  assert.equal(comparison.melOnlyTags.length, 5);
});

test('a mapping that does not bind the tag is refused — it is the only join key', () => {
  assert.throws(
    () =>
      compareWithExistingMel(DRAGON_ASSETS, DRAGON_EXISTING_MEL_ROWS, [
        { field: 'systemKey', melKey: 'upn' },
      ]),
    (error) =>
      error instanceof MelExportError &&
      error.reason.kind === 'comparison-mapping-missing-tag' &&
      error.reason.mappedFields.join() === 'systemKey',
  );
});

test('a mapping naming something that is not a §12.1 field is refused', () => {
  assert.throws(
    () =>
      compareWithExistingMel(DRAGON_ASSETS, DRAGON_EXISTING_MEL_ROWS, [
        { field: 'equipmentTag', melKey: 'tag' },
        { field: 'upn', melKey: 'upn' },
      ]),
    (error) =>
      error instanceof MelExportError &&
      error.reason.kind === 'unknown-canonical-field' &&
      error.reason.fields.join() === 'upn',
  );
});

test('a field bound twice keeps its first binding', () => {
  const comparison = compareWithExistingMel(DRAGON_ASSETS, DRAGON_EXISTING_MEL_ROWS, [
    { field: 'equipmentTag', melKey: 'tag' },
    { field: 'systemKey', melKey: 'upn' },
    { field: 'systemKey', melKey: 'system' },
  ]);
  const entry = forTag(comparison, 'MAH001-10-01');
  assert.equal(entry.fields.length, 1);
  assert.equal(entry.fields[0].melValue, '001');
});
