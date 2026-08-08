import assert from 'node:assert/strict';
import test, { after } from 'node:test';

import { createProject, serializeSnapshot } from '../dist/index.js';

import {
  digest,
  dragonProfile,
  dragonSnapshot,
  dumpTables,
  steppingClock,
  tempDirectory,
} from './support.mjs';

/**
 * Two runs of the same history with the same clock must produce the same
 * project contents.
 *
 * Contents, not bytes: SQLite files differ in page layout, freelist state and
 * internal counters even when every row matches, so the assertion is on the
 * table dumps. What must not differ is anything this package chose -- a
 * timestamp, a JSON key order, a generated revision number.
 */

const temp = tempDirectory('determinism');
after(() => {
  temp.cleanup();
});

function writeProject(name) {
  const path = temp.file(name);
  const store = createProject(path, {
    name: 'Dragon',
    appVersion: '0.5.0-test',
    now: steppingClock(),
  });
  try {
    store.upsertSource({
      role: 'model',
      fileName: 'Dragon-Coordination.nwd',
      sha256: digest('dragoncoordination'),
      byteSize: 104857600,
      addedAt: '2026-01-15T09:00:00.000Z',
    });
    store.upsertSource({
      role: 'mel',
      fileName: 'Dragon-MEL.xlsx',
      sha256: digest('dragonmel'),
      byteSize: 20480,
    });

    const revision = store.saveProfile(dragonProfile(), 'initial import');
    store.saveLearnedRules('nesting', { rules: [{ parentRole: 'VFD', childRole: 'TIT' }] });
    store.setSystemOverride('MAH001-10-01', {
      systemDescription: 'Dragon AHU',
      systemKey: '001',
    });
    store.setRelationshipOverride({ childAssetId: 'TIT001-10-01', parentAssetId: 'VFD001-10-01' });

    const compileId = store.recordCompile({
      inputHashes: {
        'Dragon-MEL.xlsx': digest('dragonmel'),
        'Dragon-Coordination.nwd': digest('dragoncoordination'),
      },
      profileRevision: revision,
      statsJson: dragonSnapshot().stats,
      startedAt: '2026-01-15T10:00:00.000Z',
      finishedAt: '2026-01-15T10:00:42.000Z',
    });
    store.saveSnapshot(compileId, serializeSnapshot(dragonSnapshot()));
    store.recordDecision({
      reviewKey: 'ambiguous-parent:TIT001-10-01',
      decision: 'accepted',
      note: 'walked it down on site',
      decidedAt: '2026-01-15T11:00:00.000Z',
    });
  } finally {
    store.close();
  }
  return path;
}

test('the same history with the same clock writes the same rows', () => {
  const first = dumpTables(writeProject('run-a.matchline'));
  const second = dumpTables(writeProject('run-b.matchline'));
  assert.deepEqual(second, first);
});

test('a profile stored twice produces byte-identical JSON', () => {
  // The two literals differ only in key order, which canonical JSON removes.
  const reordered = {
    version: 1,
    name: 'Dragon',
    profileId: 'dragon',
    systemResolver: dragonProfile().systemResolver,
    tagAnatomy: dragonProfile().tagAnatomy,
    assetFilters: dragonProfile().assetFilters,
    propertyMappings: dragonProfile().propertyMappings,
  };

  const one = createProject(temp.file('profile-a.matchline'), {
    name: 'Dragon',
    now: steppingClock(),
  });
  const two = createProject(temp.file('profile-b.matchline'), {
    name: 'Dragon',
    now: steppingClock(),
  });
  try {
    one.saveProfile(dragonProfile());
    two.saveProfile(reordered);
    assert.deepEqual(
      dumpTables(temp.file('profile-b.matchline')).profile,
      dumpTables(temp.file('profile-a.matchline')).profile,
    );
  } finally {
    one.close();
    two.close();
  }
});
