/**
 * `reviewKey`: the flattening every review item is sorted, deduped and stored
 * by.
 *
 * Three properties are asserted here, because three different layers depend on
 * them: it is deterministic (the compiler dedupes on it), it is injective (the
 * desktop app records a decision against it), and it is storable (that record
 * goes into a `node:sqlite` TEXT column and then into an HTML attribute).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { after } from 'node:test';

import { compareReviewItems, reviewKey } from '../dist/index.js';

/** U+241F SYMBOL FOR UNIT SEPARATOR: the field boundary `order.ts` chose. */
const SEPARATOR = String.fromCodePoint(0x241f);

/** One of every review kind, with fields that are easy to tell apart. */
const EVERY_KIND = [
  {
    kind: 'system-conflict',
    assetId: 'tag:MAH001-10-01',
    claims: [{ rule: 'tag-segment' }, { rule: 'mel-lookup' }],
  },
  { kind: 'duplicate-model-tag', canonicalTag: 'MAH001-10-01', objectIds: [17, 42] },
  {
    kind: 'system-catalog-conflict',
    systemKey: '001',
    descriptions: ['Dry Air Handling', 'Air Handling'],
  },
  {
    kind: 'fuzzy-identity',
    evidenceTag: 'MAH1-10-1',
    candidates: [
      { assetId: 'tag:MAH001-10-01', distance: 2 },
      { assetId: 'tag:MAH001-10-02', distance: 3 },
    ],
  },
  {
    kind: 'ambiguous-suffix',
    evidenceTag: 'MAH001',
    candidateAssetIds: ['tag:MAH001-10-01', 'tag:MAH001-10-02'],
  },
  {
    kind: 'ambiguous-parent',
    assetId: 'tag:TIT603-10-01',
    ladderSource: 'family-role',
    candidateParentIds: ['tag:VFD001-10-01', 'tag:VFD001-10-02'],
  },
  { kind: 'structural-cycle', assetIds: ['tag:A-1', 'tag:B-1'] },
  { kind: 'missing-boundary', assetId: 'tag:MAH001-10-01', levelId: 'system' },
  {
    kind: 'nesting-proposal',
    assetId: 'tag:TIT603-10-01',
    proposedParentId: 'tag:VFD001-10-01',
    ruleDetail: 'VFD parents TIT (7/8)',
    confidence: 0.875,
  },
];

test('every review kind produces a key, and no two kinds collide', () => {
  const keys = EVERY_KIND.map(reviewKey);
  assert.equal(new Set(keys).size, keys.length, 'one key per item');
  for (const [index, key] of keys.entries()) {
    assert.ok(key.startsWith(EVERY_KIND[index].kind), 'the kind leads the key');
    assert.equal(reviewKey(EVERY_KIND[index]), key, 'the same item flattens the same way twice');
  }
});

test('a key carries no character that storage or the DOM would lose', () => {
  for (const key of EVERY_KIND.map(reviewKey)) {
    for (const character of key) {
      const code = character.codePointAt(0);
      assert.ok(
        code > 0x1f && code !== 0x7f,
        `${key} carries a control character, U+${code.toString(16).toUpperCase()}`,
      );
    }
  }
});

test('the separator inside a field is escaped rather than emitted', () => {
  const key = reviewKey({
    kind: 'missing-boundary',
    assetId: `tag:A${SEPARATOR}B`,
    levelId: 'system',
  });
  assert.equal(key.split(SEPARATOR).length, 3, 'three fields, whatever the tag contains');
  assert.ok(key.includes('%1F'), 'the tag’s own separator survives as an escape');
});

test('two items that differ only in where a field boundary falls stay distinct', () => {
  // Without escaping, `A<sep>B` + `C` and `A` + `B<sep>C` flatten identically
  // and the compiler would dedupe one of them away.
  const left = reviewKey({ kind: 'missing-boundary', assetId: `A${SEPARATOR}B`, levelId: 'C' });
  const right = reviewKey({ kind: 'missing-boundary', assetId: 'A', levelId: `B${SEPARATOR}C` });
  assert.notEqual(left, right);

  // Same argument one level down, for a list-valued field.
  const one = reviewKey({ kind: 'structural-cycle', assetIds: ['A,B', 'C'] });
  const two = reviewKey({ kind: 'structural-cycle', assetIds: ['A', 'B,C'] });
  assert.notEqual(one, two);

  // And for the escape character itself: `%1F` typed into a tag must not read
  // back as an escaped separator.
  const literal = reviewKey({ kind: 'missing-boundary', assetId: '%1F', levelId: 'system' });
  const escaped = reviewKey({ kind: 'missing-boundary', assetId: SEPARATOR, levelId: 'system' });
  assert.notEqual(literal, escaped);
});

test('a key round-trips through a node:sqlite TEXT column unchanged', () => {
  const directory = mkdtempSync(join(tmpdir(), 'matchline-review-key-'));
  after(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const db = new DatabaseSync(join(directory, 'keys.db'));
  try {
    db.exec('CREATE TABLE decisions (review_key TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO decisions (review_key) VALUES (?)');
    for (const item of EVERY_KIND) {
      insert.run(reviewKey(item));
    }

    const stored = db
      .prepare('SELECT review_key FROM decisions ORDER BY rowid')
      .all()
      .map((row) => row.review_key);
    assert.deepEqual(stored, EVERY_KIND.map(reviewKey), 'nothing was truncated on the way in');
    assert.equal(new Set(stored).size, EVERY_KIND.length, 'and nothing collapsed onto one row');
  } finally {
    db.close();
  }
});

test('sorting by key is a total order that does not depend on arrival', () => {
  const forwards = [...EVERY_KIND].sort(compareReviewItems).map(reviewKey);
  const backwards = [...EVERY_KIND].reverse().sort(compareReviewItems).map(reviewKey);
  assert.deepEqual(backwards, forwards);
});
