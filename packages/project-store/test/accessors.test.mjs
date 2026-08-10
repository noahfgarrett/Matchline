import assert from 'node:assert/strict';
import test, { after, beforeEach } from 'node:test';

import { createProject, deriveSourceId, ProjectStoreError } from '../dist/index.js';

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

/* ------------------------------------------------------------ sources (v4) */

function modelSource(overrides = {}) {
  return {
    sourceId: 'model:dragon-mechanical.nwd',
    role: 'model',
    logicalName: 'Dragon Mechanical',
    rawFileName: 'Dragon-Mechanical.nwd',
    rawSha256: MODEL_SHA,
    rawByteSize: 104857600,
    addedAt: '2026-01-15T09:00:00.000Z',
    ...overrides,
  };
}

test('sources are keyed by source id, and two of one basename coexist', () => {
  store.upsertSourceV4(modelSource());
  store.upsertSourceV4(
    modelSource({
      sourceId: 'model:dragon-mechanical.nwd-2',
      logicalName: 'Dragon Mechanical (rev B)',
      rawSha256: digest('dragonmechb'),
      rawByteSize: 104857601,
    }),
  );
  store.upsertSourceV4({
    sourceId: 'mel:dragon-mel.xlsx',
    role: 'mel',
    logicalName: 'Dragon MEL',
    rawFileName: 'Dragon-MEL.xlsx',
    rawSha256: MEL_SHA,
    rawByteSize: 20480,
    addedAt: '2026-01-15T09:05:00.000Z',
  });

  const sources = store.listSources();
  assert.deepEqual(
    sources.map((source) => source.sourceId),
    ['mel:dragon-mel.xlsx', 'model:dragon-mechanical.nwd', 'model:dragon-mechanical.nwd-2'],
    'ordered by source id, so two reads never disagree',
  );
  assert.deepEqual(
    sources.filter((source) => source.rawFileName === 'Dragon-Mechanical.nwd').length,
    2,
    'one basename, two sources -- the whole point of v4',
  );

  const first = store.getSource('model:dragon-mechanical.nwd');
  assert.equal(first.logicalName, 'Dragon Mechanical');
  assert.equal(first.rawSha256, MODEL_SHA);
  assert.equal(first.derivedCacheSha256, null, 'a raw file has no cache until one is associated');
  assert.equal(store.getSource('model:nothing.nwd'), undefined);
});

test('re-registering one source id replaces that row and nothing else', () => {
  store.upsertSourceV4(modelSource());
  store.upsertSourceV4(modelSource({ sourceId: 'model:dragon-controls.nwd' }));
  store.setSourceCache('model:dragon-mechanical.nwd', digest('mechcache'));

  // The raw file changed: the same id, a new hash, and the cache association
  // the old bytes had is gone rather than left pointing at the wrong file.
  store.upsertSourceV4(
    modelSource({ rawSha256: digest('dragonmechv2'), addedAt: '2026-01-16T08:00:00.000Z' }),
  );

  const replaced = store.getSource('model:dragon-mechanical.nwd');
  assert.equal(replaced.rawSha256, digest('dragonmechv2'));
  assert.equal(replaced.addedAt, '2026-01-16T08:00:00.000Z');
  assert.equal(replaced.derivedCacheSha256, null, 'a new raw file invalidates its old cache');
  assert.equal(store.listSources().length, 2, 'and the other source is untouched');
});

test('a cache is associated after the fact, and only with a source that exists', () => {
  store.upsertSourceV4(modelSource());
  assert.equal(store.getSource('model:dragon-mechanical.nwd').derivedCacheSha256, null);

  store.setSourceCache('model:dragon-mechanical.nwd', digest('mechcache'));
  assert.equal(
    store.getSource('model:dragon-mechanical.nwd').derivedCacheSha256,
    digest('mechcache'),
  );

  const failure = reason(() => store.setSourceCache('model:absent.nwd', digest('nothing')));
  assert.equal(failure.kind, 'unknown-source');
  assert.equal(failure.sourceId, 'model:absent.nwd');
  assert.equal(
    reason(() => store.setSourceCache('model:dragon-mechanical.nwd', 'ABC')).parameter,
    'cacheSha256',
  );
});

test('a source removed by id is gone, and removing it twice is a no-op', () => {
  store.upsertSourceV4(modelSource());
  store.upsertSourceV4(modelSource({ sourceId: 'model:dragon-mechanical.nwd-2' }));

  assert.equal(store.removeSource('model:dragon-mechanical.nwd'), true);
  assert.equal(store.removeSource('model:dragon-mechanical.nwd'), false);
  assert.deepEqual(
    store.listSources().map((source) => source.sourceId),
    ['model:dragon-mechanical.nwd-2'],
    'the same-basename twin is not collateral damage',
  );
});

test('a v4 source with a malformed field is refused', () => {
  assert.equal(reason(() => store.upsertSourceV4(modelSource({ rawSha256: 'ABC' }))).parameter, 'rawSha256');
  assert.equal(
    reason(() => store.upsertSourceV4(modelSource({ derivedCacheSha256: 'ABC' }))).parameter,
    'derivedCacheSha256',
  );
  assert.equal(
    reason(() => store.upsertSourceV4(modelSource({ addedAt: '15 January 2026' }))).parameter,
    'addedAt',
  );
  assert.equal(
    reason(() => store.upsertSourceV4(modelSource({ rawByteSize: -1 }))).parameter,
    'rawByteSize',
  );
  assert.equal(reason(() => store.upsertSourceV4(modelSource({ role: 'invoice' }))).parameter, 'role');
  assert.equal(reason(() => store.upsertSourceV4(modelSource({ sourceId: '  ' }))).parameter, 'sourceId');
  assert.equal(
    reason(() => store.upsertSourceV4(modelSource({ logicalName: '' }))).parameter,
    'logicalName',
  );
  assert.equal(
    reason(() => store.upsertSourceV4(modelSource({ rawFileName: '' }))).parameter,
    'rawFileName',
  );
  assert.deepEqual(store.listSources(), [], 'nothing was written');
});

test('deriveSourceId is readable, stable and collision-free', () => {
  assert.equal(deriveSourceId('model', 'Mechanical A.nwd', []), 'model:mechanical-a.nwd');
  assert.equal(
    deriveSourceId('model', 'Mechanical A.nwd', ['model:mechanical-a.nwd']),
    'model:mechanical-a.nwd-2',
  );
  assert.equal(
    deriveSourceId('model', 'Mechanical A.nwd', ['model:mechanical-a.nwd', 'model:mechanical-a.nwd-2']),
    'model:mechanical-a.nwd-3',
  );
  // Same inputs, same answer: no clock, no counter, no randomness.
  assert.equal(deriveSourceId('mel', 'Dragon MEL.xlsx', []), deriveSourceId('mel', 'Dragon MEL.xlsx', []));
  // The role is part of the id, so one file registered twice for two roles is
  // two sources rather than a collision.
  assert.equal(deriveSourceId('pmd', 'Both.xlsx', ['mel:both.xlsx']), 'pmd:both.xlsx');
  assert.equal(deriveSourceId('model', 'Zone 1 // Level_2.nwc', []), 'model:zone-1-level_2.nwc');
  assert.equal(deriveSourceId('model', '模型.nwd', []), 'model:nwd', 'an unreadable name still ids');
  assert.equal(reason(() => deriveSourceId('invoice', 'x.nwd', [])).parameter, 'role');
  assert.equal(reason(() => deriveSourceId('model', '   ', [])).parameter, 'rawFileName');
});

/* ----------------------------------------- sources: re-registering one file */

test('re-registering the same source replaces its row rather than adding one', () => {
  store.upsertSourceV4(modelSource());
  store.upsertSourceV4({
    sourceId: 'mel:dragon-mel.xlsx',
    role: 'mel',
    logicalName: 'Dragon MEL',
    rawFileName: 'Dragon-MEL.xlsx',
    rawSha256: MEL_SHA,
    rawByteSize: 20480,
    derivedCacheSha256: MEL_SHA,
    addedAt: '2026-01-15T09:05:00.000Z',
  });
  // The same file, edited: one row, new hash. A second row would leave a stale
  // hash behind and make the next compile look up to date.
  store.upsertSourceV4({
    sourceId: 'mel:dragon-mel.xlsx',
    role: 'mel',
    logicalName: 'Dragon MEL',
    rawFileName: 'Dragon-MEL.xlsx',
    rawSha256: digest('dragonmelv2'),
    rawByteSize: 20600,
    derivedCacheSha256: digest('dragonmelv2'),
    addedAt: '2026-01-15T09:05:00.000Z',
  });

  const sources = store.listSources();
  assert.equal(sources.length, 2);
  assert.deepEqual(
    sources.map((source) => source.sourceId),
    ['mel:dragon-mel.xlsx', 'model:dragon-mechanical.nwd'],
  );
  assert.equal(sources[0].rawSha256, digest('dragonmelv2'));
  assert.equal(sources[0].rawByteSize, 20600);
  assert.equal(sources[0].derivedCacheSha256, digest('dragonmelv2'));

  assert.equal(store.removeSource('mel:dragon-mel.xlsx'), true);
  assert.equal(store.removeSource('mel:dragon-mel.xlsx'), false, 'second remove is a no-op');
  assert.equal(store.listSources().length, 1);
});

test('replacing one same-basename source leaves its twin exactly as it was', () => {
  store.upsertSourceV4(modelSource({ sourceId: 'model:level-1.nwc', rawFileName: 'Level 1.nwc' }));
  store.upsertSourceV4(modelSource({ sourceId: 'model:level-1.nwc-2', rawFileName: 'Level 1.nwc' }));

  store.upsertSourceV4(
    modelSource({
      sourceId: 'model:level-1.nwc',
      rawFileName: 'Level 1.nwc',
      rawSha256: digest('level1v2'),
      rawByteSize: 99,
    }),
  );

  assert.equal(store.listSources().length, 2, 'no third row');
  assert.equal(store.getSource('model:level-1.nwc').rawSha256, digest('level1v2'));
  assert.equal(store.getSource('model:level-1.nwc-2').rawSha256, MODEL_SHA, 'the twin is untouched');
  assert.equal(store.removeSource('model:level-1.nwc'), true);
  assert.deepEqual(
    store.listSources().map((source) => source.sourceId),
    ['model:level-1.nwc-2'],
    'and removing by id takes exactly the row that id names',
  );
});

test('removing a source id nothing holds is a no-op, not a throw', () => {
  store.upsertSourceV4(modelSource());
  assert.equal(store.removeSource('model:not-registered.nwd'), false);
  assert.equal(store.listSources().length, 1);
  assert.equal(reason(() => store.removeSource('  ')).parameter, 'sourceId');
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

  store.upsertSourceV4({
    sourceId: 'model:dragon-coordination.nwd',
    role: 'model',
    logicalName: 'Dragon-Coordination.nwd',
    rawFileName: 'Dragon-Coordination.nwd',
    rawSha256: MODEL_SHA,
    rawByteSize: 1,
    addedAt: '2026-01-15T09:00:00.000Z',
  });
  const afterInsert = store.meta().modifiedAt;
  assert.notEqual(afterInsert, created.modifiedAt);

  assert.equal(store.removeSource('model:dragon-nothing.nwd'), false);
  assert.equal(store.meta().modifiedAt, afterInsert, 'a no-op delete changed nothing');

  store.removeSource('model:dragon-coordination.nwd');
  assert.notEqual(store.meta().modifiedAt, afterInsert);
});
