/**
 * Moving a ledger forward (RELEASE-1.0-PLAN P0-9).
 *
 * "Project persists asset identity ledger {assetId, currentCanonicalTag,
 * aliases, modelIdentities} so tag corrections keep assetId, manual
 * system/relationship/review decisions survive, diffs report tag-change not
 * remove+add."
 *
 * Each scenario P0-9 names has a test here: a tag correction, a content-hash
 * change, a tree move, a duplicate-tag split, a source rename, and an asset that
 * left. The compiler package runs the same scenarios end to end against real
 * Dragon caches; these run them on the data alone, so a failure says which rule
 * broke rather than which pipeline stage noticed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { EMPTY_ASSET_LEDGER, reconcileLedger } from '../dist/index.js';
import { candidate, entryOf, eventsOf } from './support.mjs';

/** The Dragon unit every scenario below is about. */
const TAG = 'MAH001-10-01';
const TYPO = 'MAH001-10-1';

test('a first compile mints an id per asset and reports every one as new', () => {
  const result = reconcileLedger(null, [candidate(), candidate({ canonicalTag: 'PLC001-10-01' })]);

  assert.deepEqual(
    result.ledger.entries.map((entry) => entry.assetId),
    ['tag:MAH001-10-01', 'tag:PLC001-10-01'],
  );
  assert.equal(result.ledger.entries.every((entry) => entry.status === 'present'), true);
  assert.deepEqual(result.ledger.entries.map((entry) => entry.aliases), [[], []]);
  assert.deepEqual(
    eventsOf(result, 'new-asset').map((event) => event.assetId),
    ['tag:MAH001-10-01', 'tag:PLC001-10-01'],
  );
  // An empty ledger and no ledger are the same starting point.
  assert.deepEqual(reconcileLedger(EMPTY_ASSET_LEDGER, [candidate()]).ledger, {
    ...reconcileLedger(null, [candidate()]).ledger,
  });
});

test('a corrected tag keeps the id, records the old spelling, and says what happened', () => {
  const first = reconcileLedger(null, [candidate({ canonicalTag: TYPO })]);
  const second = reconcileLedger(first.ledger, [candidate({ canonicalTag: TAG })]);

  // The catalog would have minted `tag:MAH001-10-01` this time. The ledger says
  // otherwise, because it is the same object.
  assert.deepEqual([...second.mapping], [[`tag:${TAG}`, `tag:${TYPO}`]]);
  const entry = entryOf(second.ledger, `tag:${TYPO}`);
  assert.equal(entry.currentCanonicalTag, TAG);
  assert.deepEqual(entry.aliases, [TYPO]);
  assert.equal(second.ledger.entries.length, 1);

  const [changed] = eventsOf(second, 'tag-changed');
  assert.equal(changed.previousCanonicalTag, TYPO);
  assert.equal(changed.canonicalTag, TAG);
  // The strongest tier both compiles carried, which is what makes this a
  // correction rather than a coincidence of spelling.
  assert.equal(changed.tier, 'authoring-id');
});

test('an asset re-tagged back to an earlier spelling is not left as its own alias', () => {
  const first = reconcileLedger(null, [candidate({ canonicalTag: TYPO })]);
  const second = reconcileLedger(first.ledger, [candidate({ canonicalTag: TAG })]);
  const third = reconcileLedger(second.ledger, [candidate({ canonicalTag: TYPO })]);

  const entry = entryOf(third.ledger, `tag:${TYPO}`);
  assert.equal(entry.currentCanonicalTag, TYPO);
  assert.deepEqual(entry.aliases, [TAG], 'the spelling it no longer uses, and only that');
});

test('a rebuilt cache with the same objects changes nothing and reports nothing', () => {
  // A re-extraction gives every object a new content hash and can renumber the
  // extraction ordinals. Neither is identity, so neither may move an id.
  const first = reconcileLedger(null, [candidate()]);
  const second = reconcileLedger(first.ledger, [candidate()]);

  assert.deepEqual(second.ledger.entries, first.ledger.entries);
  assert.deepEqual(second.events, [], 'an unchanged compile is a quiet compile');
});

test('an object moved in the tree keeps its id on the GUID tier', () => {
  const first = reconcileLedger(null, [candidate({ authoringId: null })]);
  const second = reconcileLedger(first.ledger, [
    candidate({ authoringId: null, structuralPath: [0, 5, 9] }),
  ]);

  assert.deepEqual([...second.mapping.values()], [`tag:${TAG}`]);
  assert.deepEqual(second.events, []);
  // The structural key really did change; the GUID tier is what carried it.
  assert.notDeepEqual(
    entryOf(second.ledger, `tag:${TAG}`).modelIdentities,
    entryOf(first.ledger, `tag:${TAG}`).modelIdentities,
  );
});

test('an object with no ids at all survives a rebuild structurally, and a move renames it', () => {
  // The documented consequence of a model that states neither an authoring id
  // nor an InstanceGuid: identity is only as good as the shape of the tree.
  const bare = { authoringId: null, instanceGuid: null };
  const first = reconcileLedger(null, [candidate(bare)]);

  const rebuilt = reconcileLedger(first.ledger, [candidate(bare)]);
  assert.deepEqual([...rebuilt.mapping.values()], [`tag:${TAG}`]);
  assert.deepEqual(rebuilt.events, []);

  // Moved AND re-tagged: nothing is left to tie the two compiles together, and
  // the ledger says so rather than guessing.
  const moved = reconcileLedger(first.ledger, [
    candidate({ ...bare, structuralPath: [0, 5, 9], canonicalTag: TYPO }),
  ]);
  assert.deepEqual(
    eventsOf(moved, 'new-asset').map((event) => event.canonicalTag),
    [TYPO],
  );
  assert.deepEqual(
    eventsOf(moved, 'disappeared').map((event) => event.assetId),
    [`tag:${TAG}`],
  );
});

test('a move with the tag intact is re-matched by tag, and the weak evidence is reported', () => {
  const bare = { authoringId: null, instanceGuid: null };
  const first = reconcileLedger(null, [candidate(bare)]);
  const moved = reconcileLedger(first.ledger, [
    candidate({ ...bare, structuralPath: [0, 5, 9] }),
  ]);

  assert.deepEqual([...moved.mapping.values()], [`tag:${TAG}`]);
  const [rematched] = eventsOf(moved, 'rematched-by-tag');
  assert.equal(rematched.assetId, `tag:${TAG}`);
  assert.equal(rematched.tier, 'tag');
  assert.match(rematched.detail, /tag alone/);
});

test('two assets that now share one identity are split, never merged', () => {
  const first = reconcileLedger(null, [candidate()]);
  // The same InstanceGuid and authoring id on two objects: one asset became two,
  // or one file was registered twice. Either way, both are kept.
  const second = reconcileLedger(first.ledger, [
    candidate(),
    candidate({ canonicalTag: 'MAH001-10-02', assetId: 'tag:MAH001-10-02' }),
  ]);

  assert.equal(second.ledger.entries.length, 2, 'nothing was absorbed into anything');
  assert.deepEqual([...second.mapping], [
    [`tag:${TAG}`, `tag:${TAG}`],
    ['tag:MAH001-10-02', 'tag:MAH001-10-02'],
  ]);
  const [split] = eventsOf(second, 'split');
  assert.equal(split.assetId, `tag:${TAG}`);
  assert.deepEqual(split.siblingAssetIds, ['tag:MAH001-10-02']);
  assert.match(split.detail, /merging them would silently discard one asset/);
});

test('a tier that names two previous entries identifies nothing, and a weaker tier may still speak', () => {
  // A model whose authoring application numbers two objects alike. That tier
  // cannot tell them apart, so it must not be allowed to pick one -- and the
  // InstanceGuid, which can, is still entitled to answer.
  const shared = { authoringId: 'id-shared' };
  const first = reconcileLedger(null, [
    candidate({ ...shared, canonicalTag: TAG }),
    candidate({
      ...shared,
      canonicalTag: 'MAH001-10-02',
      assetId: 'tag:MAH001-10-02',
      instanceGuid: '00000000-0000-4000-8000-000000000005',
      structuralPath: [0, 1, 3],
    }),
  ]);

  const second = reconcileLedger(first.ledger, [
    candidate({ ...shared, canonicalTag: TYPO, assetId: `tag:${TYPO}` }),
  ]);

  const [changed] = eventsOf(second, 'tag-changed');
  assert.equal(changed.tier, 'instance-guid', 'the ambiguous tier was skipped, not guessed at');
  assert.equal(changed.assetId, `tag:${TAG}`);
});

test('an asset that is not in this compile is kept and flagged, never deleted', () => {
  const first = reconcileLedger(null, [candidate(), candidate({ canonicalTag: 'PLC001-10-01' })]);
  const second = reconcileLedger(first.ledger, [candidate()]);

  const gone = entryOf(second.ledger, 'tag:PLC001-10-01');
  assert.equal(gone.status, 'disappeared');
  assert.equal(gone.currentCanonicalTag, 'PLC001-10-01', 'the entry keeps what it knew');
  assert.deepEqual(
    eventsOf(second, 'disappeared').map((event) => event.assetId),
    ['tag:PLC001-10-01'],
  );

  // And it comes back with the id it always had.
  const third = reconcileLedger(second.ledger, [
    candidate(),
    candidate({ canonicalTag: 'PLC001-10-01' }),
  ]);
  assert.equal(entryOf(third.ledger, 'tag:PLC001-10-01').status, 'present');
  assert.deepEqual(eventsOf(third, 'new-asset'), []);
});

test('a genuinely new asset tagged the way a renamed one used to be gets an ordinal id', () => {
  const first = reconcileLedger(null, [candidate({ canonicalTag: TYPO })]);
  const second = reconcileLedger(first.ledger, [candidate({ canonicalTag: TAG })]);
  // Somebody installs a real MAH001-10-1. The ledger already holds that string
  // as an id, so the new asset cannot have it.
  const third = reconcileLedger(second.ledger, [
    candidate({ canonicalTag: TAG }),
    candidate({
      canonicalTag: TYPO,
      assetId: `tag:${TYPO}`,
      authoringId: 'id-MAH001-10-1',
      instanceGuid: '00000000-0000-4000-8000-000000000099',
      structuralPath: [0, 1, 3],
    }),
  ]);

  assert.deepEqual([...third.mapping], [
    [`tag:${TAG}`, `tag:${TYPO}`],
    [`tag:${TYPO}`, 'asset:000001'],
  ]);
  assert.equal(third.ledger.nextOrdinal, 2, 'an ordinal is never reused');
  assert.equal(entryOf(third.ledger, 'asset:000001').currentCanonicalTag, TYPO);
});

test('the ledger is plain JSON, because the project store persists it', () => {
  const first = reconcileLedger(null, [candidate({ canonicalTag: TYPO }), candidate({ canonicalTag: 'PLC001-10-01' })]);
  const second = reconcileLedger(first.ledger, [candidate({ canonicalTag: TAG })]);

  const roundTripped = JSON.parse(JSON.stringify(second.ledger));
  assert.deepEqual(roundTripped, second.ledger);
  // And a round-tripped ledger reconciles exactly as the original does.
  assert.deepEqual(
    reconcileLedger(roundTripped, [candidate({ canonicalTag: TAG })]),
    reconcileLedger(second.ledger, [candidate({ canonicalTag: TAG })]),
  );
});

test('a ledger with a nonsense ordinal still mints, rather than spinning', () => {
  // A hand-edited or half-written project file. Every candidate id is checked
  // against what is taken, so restarting the counter can never reuse an id.
  const first = reconcileLedger(null, [candidate({ canonicalTag: TYPO })]);
  const second = reconcileLedger(first.ledger, [candidate({ canonicalTag: TAG })]);

  for (const nextOrdinal of [Number.NaN, 0, -4, 1.5, Number.POSITIVE_INFINITY, null]) {
    const third = reconcileLedger({ ...second.ledger, nextOrdinal }, [
      candidate({ canonicalTag: TAG }),
      candidate({
        canonicalTag: TYPO,
        assetId: `tag:${TYPO}`,
        authoringId: 'id-new',
        instanceGuid: '00000000-0000-4000-8000-000000000099',
        structuralPath: [0, 1, 3],
      }),
    ]);
    assert.equal(third.mapping.get(`tag:${TYPO}`), 'asset:000001', String(nextOrdinal));
    assert.equal(third.ledger.nextOrdinal, 2);
  }
});

test('reconciliation does not depend on how the previous ledger was reached', () => {
  const shuffled = reconcileLedger(null, [
    candidate({ canonicalTag: 'PLC001-10-01' }),
    candidate(),
  ]);
  const straight = reconcileLedger(null, [candidate(), candidate({ canonicalTag: 'PLC001-10-01' })]);

  const next = (ledger) => reconcileLedger(ledger, [candidate({ canonicalTag: TYPO })]);
  assert.deepEqual([...next(shuffled.ledger).mapping], [...next(straight.ledger).mapping]);
});
