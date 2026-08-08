import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';

import { createProject, ProjectStoreError } from '../dist/index.js';

import { digest, dragonProfile, dragonSnapshot, steppingClock, tempDirectory } from './support.mjs';

/**
 * Every accessor and mutator: the happy path, and the edge each one is most
 * likely to get wrong -- a missing key, a second write to the same key, and
 * whether the history behind it survived.
 */

const temp = tempDirectory('accessors');
after(() => {
  temp.cleanup();
});

let counter = 0;
let store = null;

beforeEach(() => {
  store?.close();
  counter += 1;
  store = createProject(temp.file(`accessors-${counter}.matchline`), {
    name: 'Dragon',
    now: steppingClock(),
  });
});

after(() => {
  store?.close();
});

function reason(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof ProjectStoreError, `expected ProjectStoreError, got ${error}`);
    return error.reason;
  }
  throw new assert.AssertionError({ message: 'expected a throw, got none' });
}

const MODEL_SHA = digest('dragoncoordination');
const MEL_SHA = digest('dragonmel');

test('sources are keyed by role and file name, so re-importing replaces', () => {
  store.upsertSource({
    role: 'model',
    fileName: 'Dragon-Coordination.nwd',
    sha256: MODEL_SHA,
    byteSize: 104857600,
    addedAt: '2026-01-15T09:00:00.000Z',
  });
  store.upsertSource({
    role: 'mel',
    fileName: 'Dragon-MEL.xlsx',
    sha256: MEL_SHA,
    byteSize: 20480,
    addedAt: '2026-01-15T09:05:00.000Z',
  });
  // The same file, edited: one row, new hash. A second row would leave a stale
  // hash behind and make the next compile look up to date.
  store.upsertSource({
    role: 'mel',
    fileName: 'Dragon-MEL.xlsx',
    sha256: digest('dragonmelv2'),
    byteSize: 20600,
    addedAt: '2026-01-16T08:00:00.000Z',
  });

  const sources = store.listSources();
  assert.equal(sources.length, 2);
  assert.deepEqual(
    sources.map((source) => source.role),
    ['mel', 'model'],
  );
  assert.equal(sources[0].sha256, digest('dragonmelv2'));
  assert.equal(sources[0].byteSize, 20600);

  assert.equal(store.removeSource('mel', 'Dragon-MEL.xlsx'), true);
  assert.equal(store.removeSource('mel', 'Dragon-MEL.xlsx'), false, 'second remove is a no-op');
  assert.equal(store.listSources().length, 1);
});

test('a source added without a timestamp takes one from the injected clock', () => {
  store.upsertSource({
    role: 'pmd',
    fileName: 'Dragon-PMD.xlsx',
    sha256: digest('dragonpmd'),
    byteSize: 4096,
  });
  assert.equal(store.listSources()[0].addedAt, '2026-01-15T09:30:01.000Z');
});

test('a source with a malformed hash or timestamp is refused', () => {
  const base = { role: 'pmd', fileName: 'Dragon-PMD.xlsx', sha256: MODEL_SHA, byteSize: 1 };
  assert.equal(reason(() => store.upsertSource({ ...base, sha256: 'ABC' })).parameter, 'sha256');
  assert.equal(
    reason(() => store.upsertSource({ ...base, addedAt: '15 January 2026' })).parameter,
    'addedAt',
  );
  assert.equal(reason(() => store.upsertSource({ ...base, byteSize: -1 })).parameter, 'byteSize');
  assert.equal(reason(() => store.upsertSource({ ...base, role: 'invoice' })).parameter, 'role');
  assert.deepEqual(store.listSources(), [], 'nothing was written');
});

test('profiles are revisions: latest wins, history is kept', () => {
  assert.equal(store.getProfile(), undefined);
  assert.deepEqual(store.listProfileRevisions(), []);

  const first = store.saveProfile(dragonProfile(), 'initial import');
  const second = store.saveProfile(dragonProfile({ name: 'Dragon Phase 2', version: 2 }));
  assert.equal(first, 1);
  assert.equal(second, 2);

  const latest = store.getProfile();
  assert.equal(latest.revision, 2);
  assert.equal(latest.profile.name, 'Dragon Phase 2');
  assert.equal(latest.profile.version, 2);

  const original = store.getProfileRevision(1);
  assert.equal(original.profile.name, 'Dragon');
  assert.deepEqual(original.profile, dragonProfile());

  const history = store.listProfileRevisions();
  assert.deepEqual(
    history.map((entry) => entry.revision),
    [2, 1],
  );
  assert.equal(history[1].note, 'initial import');
  assert.equal(history[0].note, undefined, 'a revision saved without a note has none');
  assert.equal(store.getProfileRevision(3), undefined);
});

test('a profile that would not read back is never written', () => {
  const broken = dragonProfile();
  delete broken.propertyMappings.equipmentTag;

  const failure = reason(() => store.saveProfile(broken));
  assert.equal(failure.kind, 'invalid-profile');
  assert.equal(failure.field, 'profile.propertyMappings.equipmentTag');
  assert.equal(store.getProfile(), undefined, 'nothing was published');
});

test('a profile round-trips through canonical JSON unchanged', () => {
  store.saveProfile(dragonProfile());
  assert.deepEqual(store.getProfile().profile, dragonProfile());
});

test('learned rules keep the latest per kind and retain the prior sets', () => {
  assert.equal(store.getLearnedRules('nesting'), undefined);

  store.saveLearnedRules('nesting', { rules: [{ parentRole: 'VFD', childRole: 'TIT' }] });
  store.saveLearnedRules('item-master', { entries: [{ tag: 'MAH001-10-01', class: 'AHU' }] });
  store.saveLearnedRules('nesting', {
    rules: [
      { parentRole: 'VFD', childRole: 'TIT' },
      { parentRole: 'PLC', childRole: 'VFD' },
    ],
  });

  const nesting = store.getLearnedRules('nesting');
  assert.equal(nesting.kind, 'nesting');
  assert.equal(nesting.rules.rules.length, 2);
  // One clock read per mutation: the third save is the fourth tick after create.
  assert.equal(nesting.savedAt, '2026-01-15T09:30:03.000Z');
  assert.equal(store.getLearnedRules('item-master').rules.entries[0].class, 'AHU');
  assert.equal(reason(() => store.saveLearnedRules('guesswork', {})).parameter, 'kind');
});

test('learned rules refuse a value JSON cannot hold', () => {
  const failure = reason(() =>
    store.saveLearnedRules('nesting', { pairs: new Map([['VFD', 'TIT']]) }),
  );
  assert.equal(failure.kind, 'not-json-serializable');
  assert.equal(failure.path, 'learned.nesting.pairs');
  assert.equal(store.getLearnedRules('nesting'), undefined);
});

test('overrides are keyed by canonical tag and both kinds list together', () => {
  store.setSystemOverride('MAH001-10-01', { systemKey: '001', systemDescription: 'Dragon AHU' });
  store.setRelationshipOverride({
    childAssetId: 'TIT001-10-01',
    parentAssetId: 'VFD001-10-01',
    note: 'walked it down on site',
  });
  // Same tag again: the row is replaced, not duplicated.
  store.setSystemOverride('MAH001-10-01', { systemKey: '002' });

  const overrides = store.listOverrides();
  assert.equal(overrides.length, 2);
  assert.deepEqual(
    overrides.map((entry) => entry.kind),
    ['relationship', 'system'],
  );
  assert.deepEqual(overrides[0].override, {
    childAssetId: 'TIT001-10-01',
    parentAssetId: 'VFD001-10-01',
    note: 'walked it down on site',
  });
  assert.equal(overrides[0].assetKey, 'TIT001-10-01');
  assert.deepEqual(overrides[1].override, { systemKey: '002' });

  assert.equal(store.removeOverride('system', 'MAH001-10-01'), true);
  assert.equal(store.removeOverride('system', 'MAH001-10-01'), false);
  assert.equal(store.listOverrides().length, 1);
});

test('rooting an asset by hand is a decision, not a missing value', () => {
  store.setRelationshipOverride({ childAssetId: 'MCC-D1-01', parentAssetId: null });
  assert.equal(store.listOverrides()[0].override.parentAssetId, null);
});

test('an override that says nothing, or names itself, is refused', () => {
  assert.equal(reason(() => store.setSystemOverride('MAH001-10-01', {})).kind, 'invalid-override');
  assert.equal(
    reason(() =>
      store.setRelationshipOverride({ childAssetId: 'MAH001-10-01', parentAssetId: 'MAH001-10-01' }),
    ).field,
    'relationshipOverride.parentAssetId',
  );
  assert.equal(
    reason(() => store.setRelationshipOverride({ childAssetId: 'MAH001-10-01' })).field,
    'relationshipOverride.parentAssetId',
  );
  assert.deepEqual(store.listOverrides(), []);
});

test('compiles are a history, newest first, and reference a real profile revision', () => {
  const revision = store.saveProfile(dragonProfile());
  const first = store.recordCompile({
    inputHashes: { 'Dragon-Coordination.nwd': MODEL_SHA },
    profileRevision: revision,
    statsJson: { nodeCount: 2, unresolvedCount: 0 },
    startedAt: '2026-01-15T10:00:00.000Z',
    finishedAt: '2026-01-15T10:00:42.000Z',
  });
  const second = store.recordCompile({
    inputHashes: { 'Dragon-Coordination.nwd': MODEL_SHA, 'Dragon-MEL.xlsx': MEL_SHA },
    profileRevision: revision,
    statsJson: { nodeCount: 3, unresolvedCount: 1 },
    startedAt: '2026-01-16T10:00:00.000Z',
    finishedAt: '2026-01-16T10:00:31.000Z',
  });
  assert.equal(first, 1);
  assert.equal(second, 2);

  const history = store.listCompiles();
  assert.deepEqual(
    history.map((entry) => entry.compileId),
    [2, 1],
  );
  assert.deepEqual(history[0].inputHashes, {
    'Dragon-Coordination.nwd': MODEL_SHA,
    'Dragon-MEL.xlsx': MEL_SHA,
  });
  assert.deepEqual(history[0].stats, { nodeCount: 3, unresolvedCount: 1 });
  assert.equal(history[0].recordedAt, '2026-01-15T09:30:03.000Z');
  assert.deepEqual(
    store.listCompiles(1).map((entry) => entry.compileId),
    [2],
  );
  assert.deepEqual(store.listCompiles(0), []);
});

test('a compile against an unsaved profile revision is refused', () => {
  const failure = reason(() =>
    store.recordCompile({
      inputHashes: {},
      profileRevision: 7,
      statsJson: {},
      startedAt: '2026-01-15T10:00:00.000Z',
      finishedAt: '2026-01-15T10:00:01.000Z',
    }),
  );
  assert.equal(failure.kind, 'unknown-profile-revision');
  assert.equal(failure.revision, 7);
  assert.deepEqual(store.listCompiles(), []);
});

test('a compile that finished before it started is refused', () => {
  store.saveProfile(dragonProfile());
  const failure = reason(() =>
    store.recordCompile({
      inputHashes: {},
      profileRevision: 1,
      statsJson: {},
      startedAt: '2026-01-15T10:00:42.000Z',
      finishedAt: '2026-01-15T10:00:00.000Z',
    }),
  );
  assert.equal(failure.kind, 'invalid-argument');
  assert.equal(failure.parameter, 'finishedAt');
});

test('only the latest snapshot is kept, and it belongs to a real compile', () => {
  const revision = store.saveProfile(dragonProfile());
  const compileId = store.recordCompile({
    inputHashes: { 'Dragon-Coordination.nwd': MODEL_SHA },
    profileRevision: revision,
    statsJson: {},
    startedAt: '2026-01-15T10:00:00.000Z',
    finishedAt: '2026-01-15T10:00:42.000Z',
  });
  assert.equal(store.getLatestSnapshot(), undefined);

  store.saveSnapshot(compileId, { nodes: [], reviewItems: [], stats: { nodeCount: 0 } });
  const second = store.recordCompile({
    inputHashes: { 'Dragon-Coordination.nwd': MODEL_SHA },
    profileRevision: revision,
    statsJson: {},
    startedAt: '2026-01-16T10:00:00.000Z',
    finishedAt: '2026-01-16T10:00:12.000Z',
  });
  store.saveSnapshot(second, { nodes: [{ assetId: 'MAH001-10-01' }], reviewItems: [], stats: {} });

  const latest = store.getLatestSnapshot();
  assert.equal(latest.compileId, second);
  assert.equal(latest.snapshot.nodes.length, 1);

  // The validate hook is the caller's, and its return type is what comes back.
  const tagged = store.getLatestSnapshot((value) => ({ seen: value.nodes.length }));
  assert.deepEqual(tagged.snapshot, { seen: 1 });

  assert.equal(reason(() => store.saveSnapshot(99, {})).kind, 'unknown-compile');
});

test('a snapshot holding a Map is refused rather than stored as {}', () => {
  const revision = store.saveProfile(dragonProfile());
  const compileId = store.recordCompile({
    inputHashes: {},
    profileRevision: revision,
    statsJson: {},
    startedAt: '2026-01-15T10:00:00.000Z',
    finishedAt: '2026-01-15T10:00:01.000Z',
  });
  const failure = reason(() => store.saveSnapshot(compileId, dragonSnapshot()));
  assert.equal(failure.kind, 'not-json-serializable');
  assert.equal(failure.path, 'snapshot.nodes');
  assert.equal(store.getLatestSnapshot(), undefined);
});

test('decisions keep every answer and the latest one wins', () => {
  assert.equal(store.decisionFor('system-conflict:MAH001-10-01'), undefined);

  store.recordDecision({
    reviewKey: 'system-conflict:MAH001-10-01',
    decision: 'deferred',
    note: 'ask the controls lead',
    decidedAt: '2026-01-15T11:00:00.000Z',
  });
  store.recordDecision({
    reviewKey: 'ambiguous-parent:TIT001-10-01',
    decision: 'rejected',
    decidedAt: '2026-01-15T11:05:00.000Z',
  });
  store.recordDecision({
    reviewKey: 'system-conflict:MAH001-10-01',
    decision: 'accepted',
    decidedAt: '2026-01-16T08:00:00.000Z',
  });

  const latest = store.decisionFor('system-conflict:MAH001-10-01');
  assert.equal(latest.decision, 'accepted');
  assert.equal(latest.note, undefined);

  const history = store.listDecisions();
  assert.equal(history.length, 3, 'the deferred answer is still on file');
  assert.deepEqual(
    history.map((entry) => entry.decision),
    ['deferred', 'rejected', 'accepted'],
  );
  assert.equal(history[0].note, 'ask the controls lead');
  assert.equal(reason(() => store.decisionFor('  ')).parameter, 'reviewKey');
  assert.equal(
    reason(() =>
      store.recordDecision({
        reviewKey: 'k',
        decision: 'maybe',
        decidedAt: '2026-01-16T08:00:00.000Z',
      }),
    ).parameter,
    'decision',
  );
});

test('every successful mutation stamps the modified timestamp', () => {
  const created = store.meta();
  assert.equal(created.modifiedAt, created.createdAt);

  store.upsertSource({
    role: 'model',
    fileName: 'Dragon-Coordination.nwd',
    sha256: MODEL_SHA,
    byteSize: 1,
    addedAt: '2026-01-15T09:00:00.000Z',
  });
  const afterInsert = store.meta().modifiedAt;
  assert.notEqual(afterInsert, created.modifiedAt);

  assert.equal(store.removeSource('model', 'Dragon-Nothing.nwd'), false);
  assert.equal(store.meta().modifiedAt, afterInsert, 'a no-op delete changed nothing');

  store.removeSource('model', 'Dragon-Coordination.nwd');
  assert.notEqual(store.meta().modifiedAt, afterInsert);
});
