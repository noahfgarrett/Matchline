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
    claims: [
      { rule: 'tag-segment', proposedValue: '001' },
      { rule: 'mel-lookup', proposedValue: '002' },
    ],
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
  {
    kind: 'dead-claim-rule',
    ladderSource: 'profile-lookup',
    reason: 'unresolvable-parent-tag',
    childRef: 'TIT603-10-01',
    parentRef: 'MAH001-10-99',
  },
  {
    kind: 'missing-boundary-level',
    levelId: 'building',
    assetCount: 34,
    exampleAssetIds: ['tag:MAH001-10-01'],
  },
  {
    kind: 'boundary-demotion',
    levelId: 'building',
    ladderSource: 'flow-family',
    pairCount: 4,
    exampleAssetIds: ['tag:MAH001-10-01'],
  },
  {
    kind: 'unresolved-system',
    skipReasons: ['keyChain[0] model-field no-value'],
    assetCount: 8,
    exampleAssetIds: ['tag:MAH001-10-01'],
  },
  { kind: 'unresolvable-alias', evidenceTag: 'MAH-1', aliasTarget: 'MAH001-10-99' },
  {
    kind: 'absorbed-tagged-component',
    absorbedTag: 'VFD001-10-01',
    absorbingAssetId: 'tag:MAH001-10-01',
    objectId: 57,
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

test('two system conflicts over different values are two decisions, not one', () => {
  // The desktop app records a decision against a review key. A key that encoded
  // only the asset and how many claims there were made "MAH001 is 001 or 002?"
  // and "MAH001 is 007 or 008?" the same key, so settling the first silently
  // settled the second -- a materially different conflict inheriting a decision
  // nobody made about it.
  const asset = 'tag:MAH001-10-01';
  const first = reviewKey({
    kind: 'system-conflict',
    assetId: asset,
    claims: [{ proposedValue: '001' }, { proposedValue: '002' }],
  });
  const second = reviewKey({
    kind: 'system-conflict',
    assetId: asset,
    claims: [{ proposedValue: '007' }, { proposedValue: '008' }],
  });
  assert.notEqual(first, second);
});

test('a system conflict key does not depend on the order the claims arrived in', () => {
  const asset = 'tag:MAH001-10-01';
  const forwards = reviewKey({
    kind: 'system-conflict',
    assetId: asset,
    claims: [{ proposedValue: '001' }, { proposedValue: '002' }],
  });
  const backwards = reviewKey({
    kind: 'system-conflict',
    assetId: asset,
    claims: [{ proposedValue: '002' }, { proposedValue: '001' }],
  });
  assert.equal(forwards, backwards);
});

test('a system conflict key keeps a repeated value rather than collapsing it', () => {
  // Two rungs proposing '001' and one proposing '002' is a different conflict
  // from one rung proposing each; a set would flatten them onto one key.
  const asset = 'tag:MAH001-10-01';
  const repeated = reviewKey({
    kind: 'system-conflict',
    assetId: asset,
    claims: [{ proposedValue: '001' }, { proposedValue: '001' }, { proposedValue: '002' }],
  });
  const distinct = reviewKey({
    kind: 'system-conflict',
    assetId: asset,
    claims: [{ proposedValue: '001' }, { proposedValue: '002' }, { proposedValue: '003' }],
  });
  assert.notEqual(repeated, distinct);
});

test('a dead claim rule key carries every field that made it dead', () => {
  const base = {
    kind: 'dead-claim-rule',
    ladderSource: 'profile-lookup',
    reason: 'unresolvable-parent-tag',
    childRef: 'TIT603-10-01',
    parentRef: 'MAH001-10-99',
  };
  const keys = new Set([
    reviewKey(base),
    reviewKey({ ...base, ladderSource: 'prior-ssm' }),
    reviewKey({ ...base, reason: 'unknown-parent-asset' }),
    reviewKey({ ...base, childRef: 'TIT603-10-02' }),
    reviewKey({ ...base, parentRef: 'MAH001-10-98' }),
  ]);
  assert.equal(keys.size, 5, 'every field moves the key');
});

test('sorting by key is a total order that does not depend on arrival', () => {
  const forwards = [...EVERY_KIND].sort(compareReviewItems).map(reviewKey);
  const backwards = [...EVERY_KIND].reverse().sort(compareReviewItems).map(reviewKey);
  assert.deepEqual(backwards, forwards);
});

/* ------------------------------------------- duplicate tags across sources --- */

test('a duplicated tag on two sources is not the same decision as the same ordinals in one', () => {
  // The bug this pins: keying on `(canonicalTag, objectIds)` alone. An object
  // id is an extraction ordinal WITHIN one source (P0-1's `ModelObjectKey`), so
  // "object 3 of mechanical and object 3 of controls" and "objects 3 and 3 of
  // one file" flatten onto the same key -- and the desktop records a decision
  // against that key, so settling one would silently settle the other.
  const acrossSources = reviewKey({
    kind: 'duplicate-model-tag',
    canonicalTag: 'MAH001-10-01',
    objectIds: [3, 3],
    sources: [
      { sourceId: 'mechanical', objectIds: [3] },
      { sourceId: 'controls', objectIds: [3] },
    ],
  });
  const withinOne = reviewKey({
    kind: 'duplicate-model-tag',
    canonicalTag: 'MAH001-10-01',
    objectIds: [3, 3],
    sources: [{ sourceId: 'mechanical', objectIds: [3, 3] }],
  });
  assert.notEqual(acrossSources, withinOne);
});

test('which source carries which object moves the key', () => {
  const base = {
    kind: 'duplicate-model-tag',
    canonicalTag: 'MAH001-10-01',
    objectIds: [17, 42],
  };
  const keys = new Set([
    reviewKey({
      ...base,
      sources: [
        { sourceId: 'mech', objectIds: [17] },
        { sourceId: 'ctrl', objectIds: [42] },
      ],
    }),
    reviewKey({
      ...base,
      sources: [
        { sourceId: 'mech', objectIds: [42] },
        { sourceId: 'ctrl', objectIds: [17] },
      ],
    }),
    reviewKey({
      ...base,
      sources: [{ sourceId: 'mech', objectIds: [17, 42] }],
    }),
    // A source id is site-chosen text, so it has to be escaped like any field.
    reviewKey({
      ...base,
      sources: [
        { sourceId: `mech${SEPARATOR}ctrl`, objectIds: [17] },
        { sourceId: 'x', objectIds: [42] },
      ],
    }),
  ]);
  assert.equal(keys.size, 4, 'every arrangement of the same ordinals is its own decision');
});

test('a source id spelling the separator between a source and its ordinals stays distinct', () => {
  // `<sourceId>:<objectIds>` is the pair's own shape, so a source id containing
  // a colon must not be able to spell another pair exactly.
  const left = reviewKey({
    kind: 'duplicate-model-tag',
    canonicalTag: 'MAH001-10-01',
    objectIds: [7],
    sources: [{ sourceId: 'a:7', objectIds: [] }],
  });
  const right = reviewKey({
    kind: 'duplicate-model-tag',
    canonicalTag: 'MAH001-10-01',
    objectIds: [7],
    sources: [{ sourceId: 'a', objectIds: [7] }],
  });
  assert.notEqual(left, right);
});

test('a record written before the universe existed keeps the key it was written under', () => {
  // `sources` is optional because v3 project files do not carry it, and
  // rekeying those items would orphan every decision already taken on them.
  // Absent is not "one source": the two must not share a key either.
  const legacy = reviewKey({
    kind: 'duplicate-model-tag',
    canonicalTag: 'MAH001-10-01',
    objectIds: [17, 42],
  });
  assert.equal(legacy, `duplicate-model-tag${SEPARATOR}MAH001-10-01${SEPARATOR}17,42`);
  assert.notEqual(
    legacy,
    reviewKey({
      kind: 'duplicate-model-tag',
      canonicalTag: 'MAH001-10-01',
      objectIds: [17, 42],
      sources: [{ sourceId: 'model', objectIds: [17, 42] }],
    }),
  );
});

test('a counted item is keyed by its group, so the count can change without orphaning', () => {
  const before = reviewKey({
    kind: 'missing-boundary-level',
    levelId: 'building',
    assetCount: 34,
    exampleAssetIds: ['tag:A'],
  });
  const after = reviewKey({
    kind: 'missing-boundary-level',
    levelId: 'building',
    assetCount: 12,
    exampleAssetIds: ['tag:B', 'tag:C'],
  });
  assert.equal(before, after, 'a decision recorded on the level survives a recompile');

  // Two levels, and two rungs at one level, are still two different decisions.
  assert.notEqual(
    before,
    reviewKey({
      kind: 'missing-boundary-level',
      levelId: 'system',
      assetCount: 34,
      exampleAssetIds: [],
    }),
  );
  const demotion = (levelId, ladderSource) =>
    reviewKey({ kind: 'boundary-demotion', levelId, ladderSource, pairCount: 1, exampleAssetIds: [] });
  assert.notEqual(demotion('building', 'flow-family'), demotion('building', 'family-role'));
  assert.notEqual(demotion('building', 'flow-family'), demotion('system', 'flow-family'));
});
