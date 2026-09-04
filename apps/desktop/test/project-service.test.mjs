import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { after, before } from 'node:test';

import {
  DRAGON_UNRESOLVED_SET_NAME,
  EXTRACTION_CACHE_DDL_V1,
  writeDragonFixture,
  writeDragonFixtureWithUnresolvedSearch,
} from '@matchline/model-schema/fixtures/dragon';
import { PROJECT_SCHEMA_VERSION } from '@matchline/project-store';
import { writeWorkbook } from '@matchline/spreadsheet-import';

import { createProjectService } from '../dist/electron/services/project-session.js';

/**
 * The whole round-2 flow, headless: create a project, add sources, page the
 * Property Catalog, preview assets, anatomy and systems, save the profile,
 * reopen, and find the draft where it was left.
 *
 * This is the test the GUI walk cannot be: it runs the same main-process
 * service the IPC handlers call, so every number the wizard shows is asserted
 * here against the Dragon fixture rather than eyeballed in a screenshot.
 *
 * ## Where the expected counts come from
 *
 * Dragon (packages/model-schema/src/fixtures/dragon.ts) is generated, not
 * committed, so the numbers below are derived from its generator rather than
 * from a recorded run:
 *
 * - **76 objects.** Mechanical: 1 file root + 2 building layers + 24 equipment
 *   (6 MAH001 + 2 MAH002 + 4 TIT603, per building) + 24 solids = 51. Controls:
 *   1 file root + 2 building layers + 10 equipment (1 PLC001 + 4 VFD001, per
 *   building) + 8 terminals + 4 PLC modules = 25.
 * - **34 tagged objects.** Every equipment node carries `Dragon Data > Tag`;
 *   nothing else does. 24 mechanical + 10 controls.
 * - **11 distinct properties.** `Item > Name`, `Item > Type`, `Dragon Data >`
 *   Building/Tag/UPN/Manufacturer/Service/Note, `Controls Data >`
 *   Firmware/Slot/Loop.
 * - **3 systems.** The tag's system segment is 001, 002 or 603.
 */

const DRAGON_OBJECT_COUNT = 76;
const DRAGON_TAGGED_COUNT = 34;
const DRAGON_PROPERTY_COUNT = 11;
const DRAGON_SYSTEM_COUNT = 3;

/** Dragon's real anatomy: `MAH001-10-01` -> MAH / 001 / 10 / 01. */
const DRAGON_ANATOMY = {
  separators: ['-'],
  ignoredSuffixes: [],
  segments: [
    { segment: 'role', extractor: { kind: 'alphaPrefix', token: 0 } },
    { segment: 'system', extractor: { kind: 'digitSuffix', token: 0 } },
    { segment: 'unit', extractor: { kind: 'token', token: 1 } },
    { segment: 'instance', extractor: { kind: 'token', token: 2 } },
  ],
  familyKeyTemplate: '{system}-{token:1}-{token:2}',
  localFamilyTemplate: '',
};

/** Tag names the system; the MEL names what the system is (PRODUCT.md §5.4). */
const DRAGON_RESOLVER = {
  keyChain: [{ kind: 'tag-segment', segment: 'system' }],
  descriptionChain: [
    { kind: 'mel-lookup', joinBy: 'systemKey', returnField: 'systemDescription' },
  ],
  normalization: [{ kind: 'trim' }],
  conflictPolicy: 'review',
  labelTemplate: '',
};

let workDir = '';
let cachePath = '';
let melPath = '';
let projectPath = '';
let userDataDir = '';

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'matchline-desktop-'));
  cachePath = join(workDir, 'Dragon.matchline-cache');
  melPath = join(workDir, 'Dragon-MEL.xlsx');
  projectPath = join(workDir, 'Dragon.matchline');
  userDataDir = join(workDir, 'userData');

  writeDragonFixture(cachePath);

  // An invented MEL, written here rather than committed: real MELs are client
  // data (docs/EXTRACTION.md, "Confidentiality").
  writeFileSync(
    melPath,
    writeWorkbook([
      {
        name: 'MEL',
        aoa: [
          ['Equipment Tag', 'UPN', 'System Description'],
          ['MAH001-10-01', '001', 'Mechanical Dry Air Handling'],
          ['MAH002-10-01', '002', 'Mechanical Hot Water'],
          ['TIT603-10-01', '603', 'Temperature Instrumentation'],
        ],
      },
    ]),
  );
});

after(() => {
  if (workDir !== '') {
    rmSync(workDir, { recursive: true, force: true });
  }
});

function newService() {
  return createProjectService({ userDataDir, appVersion: '0.5.0' });
}

test('a service with no project open refuses work rather than inventing an answer', () => {
  const service = newService();
  assert.equal(service.current(), null);
  assert.deepEqual(service.draftState(), { draft: null, savedRevision: null });
  assert.throws(() => service.listSources(), /No project is open/);
  assert.equal(service.close(), false);
});

test('the full screens 1-5 flow, over the Dragon fixture', async (t) => {
  const service = newService();
  t.after(() => {
    service.close();
  });

  await t.test('create leaves the project open and empty', () => {
    const project = service.create(projectPath, 'Dragon');
    assert.equal(project.name, 'Dragon');
    assert.equal(project.path, projectPath);
    assert.equal(project.sourceCount, 0);
    assert.equal(project.savedRevision, null);
    assert.equal(project.hasModel, false);
  });

  await t.test('screen 1 identifies the cache and the MEL by opening them', async () => {
    const results = await service.addSources([cachePath, melPath]);
    assert.equal(results.length, 2, 'one registration per recognized role');

    const added = results.filter((entry) => entry.outcome === 'added').map((entry) => entry.source);
    const model = added.find((source) => source.role === 'model');
    assert.ok(model !== undefined, 'the cache registered as a model source');
    assert.equal(model.sourceId, 'model:dragon.matchline-cache');
    assert.equal(model.rawFileName, 'Dragon.matchline-cache');
    assert.equal(model.logicalName, 'Dragon.matchline-cache', 'the name starts as the file name');
    assert.equal(model.status, 'ready');
    assert.equal(model.rawSha256.length, 64);
    assert.equal(model.derivedCacheSha256, model.rawSha256, 'a cache IS the bytes the engine reads');
    assert.match(model.note, /76 objects/);

    const mel = added.find((source) => source.role === 'mel');
    assert.ok(mel !== undefined, 'the workbook registered as a MEL source');
    assert.equal(mel.status, 'ready');
    assert.deepEqual(
      mel.sheets.map((sheet) => sheet.sheet),
      ['MEL'],
    );
    assert.equal(mel.sheets[0].headerRow, 1, 'worksheet row 1 carries the headers');

    assert.equal(service.current().hasModel, true);
    assert.equal(service.current().sourceCount, 2);
  });

  await t.test('an unreadable file is reported, not registered', async () => {
    const junkPath = join(workDir, 'notes.txt');
    writeFileSync(junkPath, 'not a source');
    const [result] = await service.addSources([junkPath]);
    assert.equal(result.outcome, 'rejected');
    assert.match(result.reason, /does not read/);
    assert.equal(service.listSources().length, 2, 'nothing was recorded');
  });

  await t.test('screen 2 reports the model and pages the Property Catalog', () => {
    const universe = service.modelUniverse();
    assert.equal(universe.sourceCount, 1);
    assert.equal(universe.objectCount, DRAGON_OBJECT_COUNT);
    assert.equal(universe.propertyNameCount, DRAGON_PROPERTY_COUNT);

    const [scan] = universe.sources;
    assert.equal(scan.sourceId, 'model:dragon.matchline-cache');
    assert.equal(scan.objectCount, DRAGON_OBJECT_COUNT);
    assert.equal(scan.propertyNameCount, DRAGON_PROPERTY_COUNT);
    assert.equal(scan.sourceModels.length, 3);
    assert.equal(
      scan.sourceModels.reduce((total, model) => total + model.objectCount, 0),
      DRAGON_OBJECT_COUNT,
      'every object belongs to exactly one source model',
    );
    assert.equal(scan.warningCount, 2);

    const page = service.propertyPage({
      offset: 0,
      limit: 5,
      sortBy: 'coverage',
      descending: true,
      search: '',
    });
    assert.equal(page.total, DRAGON_PROPERTY_COUNT);
    assert.equal(page.rows.length, 5, 'the page is a window, not the whole catalog');
    assert.ok(
      page.rows[0].coverage >= page.rows[1].coverage,
      'descending coverage is actually descending',
    );

    const tagPage = service.propertyPage({
      offset: 0,
      limit: 50,
      sortBy: 'coverage',
      descending: true,
      search: 'Tag',
    });
    assert.equal(tagPage.total, 1, 'search narrows the catalog');
    assert.equal(tagPage.rows[0].name, 'Tag');
    assert.equal(tagPage.rows[0].objectCount, DRAGON_TAGGED_COUNT);
    assert.equal(tagPage.rows[0].distinctValueCount, DRAGON_TAGGED_COUNT);
    assert.equal(tagPage.rows[0].examples.length, 3, 'up to three examples');
    assert.deepEqual(
      tagPage.rows[0].bySource.map((source) => source.sourceId),
      ['model:dragon.matchline-cache'],
      'a one-source project still discloses which source the coverage came from',
    );
    assert.equal(tagPage.rows[0].bySource[0].label, 'dragon');
    assert.equal(tagPage.rows[0].bySource[0].objectCount, DRAGON_TAGGED_COUNT);
    assert.equal(
      tagPage.rows[0].suggestedRole,
      'equipment-tag',
      'a literal name synonym produces a suggestion',
    );

    const classes = service.classList();
    const equipment = classes.find((entry) => entry.className === 'Equipment');
    assert.equal(equipment.objectCount, DRAGON_TAGGED_COUNT);
  });

  await t.test('screen 3 is blocked until a tag property is chosen', () => {
    const blocked = service.assetPreview();
    assert.equal(blocked.state, 'blocked');
    assert.match(blocked.reason, /equipment tag/);
  });

  await t.test('screen 3 previews the inclusion impact over the real cache', () => {
    service.updateDraft({
      propertyMappings: {
        equipmentTag: { category: 'Dragon Data', name: 'Tag' },
        description: { category: 'Dragon Data', name: 'Manufacturer' },
        equipmentType: { category: 'Item', name: 'Type' },
        building: { category: 'Dragon Data', name: 'Building' },
        nativeDiscipline: null,
      },
    });

    const preview = service.assetPreview();
    assert.equal(preview.state, 'ready');
    assert.equal(preview.totalObjects, DRAGON_OBJECT_COUNT);
    assert.equal(preview.finalAssetCount, DRAGON_TAGGED_COUNT);
    assert.equal(
      preview.untaggedDroppedCount,
      DRAGON_OBJECT_COUNT - DRAGON_TAGGED_COUNT,
      '42 untagged objects leave at the tag-presence stage',
    );
    assert.equal(preview.duplicateTagCount, 0, 'Dragon has no repeated tags');
    assert.equal(preview.collapsedCount, 0, 'component collapse is off by default');

    const stages = preview.stages.map((stage) => stage.stage);
    assert.deepEqual(stages, [
      'source-model-files',
      'classes',
      'selection-sets',
      'tag-presence',
      'tag-patterns',
    ]);
    for (const stage of preview.stages) {
      assert.equal(stage.outCount, stage.inCount - stage.droppedCount);
      assert.ok(stage.label.length > 0, `${stage.stage} has a plain-language label`);
    }
    assert.equal(preview.samples.length, 8);
    assert.equal(preview.samples[0].building, 'D1');
  });

  await t.test('an exclusion narrows the catalog and the impact says so', () => {
    service.updateDraft({
      assetFilters: {
        includedClasses: [],
        excludedClasses: ['Equipment'],
        requireTagProperty: true,
        acceptedTagPatterns: [],
        selectionSetNames: [],
        includedSourceModelFiles: [],
        collapseComponents: false,
        separatelyCommissionableClasses: [],
      },
    });

    const preview = service.assetPreview();
    assert.equal(preview.state, 'ready');
    assert.equal(preview.finalAssetCount, 0, 'excluding Equipment excludes every asset');
    const classStage = preview.stages.find((stage) => stage.stage === 'classes');
    assert.equal(classStage.droppedCount, DRAGON_TAGGED_COUNT);

    // Put it back: the rest of the flow assumes the full catalog.
    service.updateDraft({
      assetFilters: {
        includedClasses: [],
        excludedClasses: [],
        requireTagProperty: true,
        acceptedTagPatterns: [],
        selectionSetNames: [],
        includedSourceModelFiles: [],
        collapseComponents: false,
        separatelyCommissionableClasses: [],
      },
    });
    assert.equal(service.assetPreview().finalAssetCount, DRAGON_TAGGED_COUNT);
  });

  await t.test('screen 4 previews the anatomy against every catalog tag', () => {
    const blocked = service.anatomyPreview();
    assert.equal(blocked.state, 'blocked');

    service.updateDraft({ tagAnatomy: DRAGON_ANATOMY });

    const preview = service.anatomyPreview();
    assert.equal(preview.state, 'ready');
    assert.equal(preview.total, DRAGON_TAGGED_COUNT);
    assert.equal(preview.matchedCount, DRAGON_TAGGED_COUNT);
    assert.equal(preview.coverage, 1);
    assert.deepEqual(
      preview.segmentStats.map((stat) => stat.segment),
      ['role', 'system', 'unit', 'instance'],
    );
    assert.equal(
      preview.segmentStats.find((stat) => stat.segment === 'system').distinctValueCount,
      DRAGON_SYSTEM_COUNT,
    );
    assert.equal(preview.misses.length, 0);

    assert.ok(preview.sample !== null, 'a sample tag drives the extractor rows');
    assert.equal(preview.sample.tag, 'MAH001-10-01');
    assert.deepEqual(preview.sample.segments, [
      { segment: 'role', value: 'MAH' },
      { segment: 'system', value: '001' },
      { segment: 'unit', value: '10' },
      { segment: 'instance', value: '01' },
    ]);
    assert.equal(preview.sample.familyKey, '001-10-01');
  });

  await t.test('a wrong token index shows up as misses with a reason', () => {
    service.updateDraft({
      tagAnatomy: {
        ...DRAGON_ANATOMY,
        segments: [{ segment: 'system', extractor: { kind: 'digitSuffix', token: 9 } }],
      },
    });

    const preview = service.anatomyPreview();
    assert.equal(preview.state, 'ready');
    assert.equal(preview.matchedCount, 0);
    assert.ok(preview.misses.length > 0);
    assert.equal(preview.misses[0].reason, 'extractor-miss');
    assert.match(preview.misses[0].explanation, /token position/);

    service.updateDraft({ tagAnatomy: DRAGON_ANATOMY });
  });

  await t.test('screen 5 resolves systems from the tag and describes them from the MEL', () => {
    const blocked = service.resolverPreview();
    assert.equal(blocked.state, 'blocked');

    service.updateDraft({ systemResolver: DRAGON_RESOLVER });

    const preview = service.resolverPreview();
    assert.equal(preview.state, 'ready');
    assert.equal(preview.subjectCount, DRAGON_TAGGED_COUNT);
    assert.equal(preview.resolvedCount, DRAGON_TAGGED_COUNT);
    assert.equal(preview.coverage, 1);
    assert.equal(preview.distinctSystemCount, DRAGON_SYSTEM_COUNT);
    assert.equal(preview.conflictCount, 0, 'one key rung cannot disagree with itself');
    assert.equal(preview.melRowCount, 3, 'the invented MEL has three rows');
    assert.equal(preview.describedCount, DRAGON_TAGGED_COUNT);
    assert.deepEqual(preview.unresolvedExamples, []);

    assert.equal(preview.rungUsage.length, 2);
    const keyRung = preview.rungUsage.find((rung) => rung.chain === 'keyChain');
    assert.equal(keyRung.kind, 'tag-segment');
    assert.equal(keyRung.wonCount, DRAGON_TAGGED_COUNT);
    assert.equal(keyRung.skippedCount, 0);
    assert.equal(keyRung.label, 'Tag segment "system"');

    const sample = preview.samples.find((entry) => entry.canonicalTag === 'MAH001-10-01');
    assert.equal(sample.systemKey, '001');
    assert.equal(sample.systemDescription, 'Mechanical Dry Air Handling');
    assert.equal(sample.systemLabel, '001 Mechanical Dry Air Handling');
    assert.equal(sample.keySource, 'Tag segment "system"');
  });

  await t.test('two key sources that disagree become visible conflicts', () => {
    service.updateDraft({
      systemResolver: {
        ...DRAGON_RESOLVER,
        keyChain: [
          { kind: 'tag-segment', segment: 'system' },
          { kind: 'model-field', property: { category: 'Item', name: 'Type' } },
        ],
      },
    });

    const preview = service.resolverPreview();
    assert.equal(preview.state, 'ready');
    assert.ok(preview.conflictCount > 0, 'the model field disagrees with the tag segment');
    assert.ok(preview.conflicts.length > 0);
    assert.equal(preview.conflicts[0].claims.length, 2, 'both claims are kept, not just the winner');
    assert.equal(
      preview.conflicts[0].claims[0].source,
      'Tag segment "system"',
      'the winning rung is named first, in chain order',
    );

    service.updateDraft({ systemResolver: DRAGON_RESOLVER });
  });

  await t.test('saving writes a revision the store validates', () => {
    const saved = service.saveProfile('Screens 1-5 complete');
    assert.equal(saved.revision, 1);
    assert.ok(saved.savedAt.length > 0);
    assert.equal(service.current().savedRevision, 1);
  });
});

test('reopening restores the draft from the saved revision', async () => {
  const service = newService();
  try {
    const opened = await service.open(projectPath, false);
    assert.equal(opened.outcome, 'opened');
    const { project, notice } = opened;
    assert.equal(project.name, 'Dragon');
    assert.equal(project.savedRevision, 1);
    assert.equal(project.sourceCount, 2);
    assert.equal(project.hasModel, true, 'the model was re-found through the sha256 index');

    // Written by this build, so there was nothing for opening to fix.
    assert.deepEqual(notice, {
      migration: null,
      adoptedAppStateConfig: false,
      mergedLegacyConfig: false,
    });

    const { draft, savedRevision } = service.draftState();
    assert.equal(savedRevision, 1);
    assert.deepEqual(
      draft.propertyMappings.equipmentTag,
      { chain: [{ category: 'Dragon Data', name: 'Tag' }], bySource: [] },
      'the stored revision rehydrates as a chain, whichever way it was written',
    );
    assert.deepEqual(draft.tagAnatomy.segments, DRAGON_ANATOMY.segments);
    assert.equal(draft.tagAnatomy.familyKeyTemplate, '{system}-{token:1}-{token:2}');
    assert.deepEqual(draft.systemResolver.keyChain, DRAGON_RESOLVER.keyChain);
    assert.equal(draft.systemResolver.conflictPolicy, 'review');

    // The previews work straight after reopening, with no further setup.
    assert.equal(service.assetPreview().finalAssetCount, 34);
    assert.equal(service.anatomyPreview().coverage, 1);
    assert.equal(service.resolverPreview().resolvedCount, 34);

    const sources = service.listSources();
    assert.deepEqual(
      sources.map((source) => source.status),
      ['mel', 'model'].map(() => 'ready'),
      'both sources were re-found on disk',
    );
  } finally {
    service.close();
  }
});

test('removing the model source takes screens 2-5 back to blocked', async () => {
  const service = newService();
  try {
    await service.open(projectPath, false);
    assert.equal(service.removeSource('model:dragon.matchline-cache'), true);
    assert.equal(service.modelUniverse(), null);
    assert.deepEqual(service.classList(), []);
    assert.equal(service.assetPreview().state, 'blocked');
    assert.equal(service.anatomyPreview().state, 'blocked');
    assert.equal(service.resolverPreview().state, 'blocked');
    assert.deepEqual(service.propertyPage({
      offset: 0,
      limit: 10,
      sortBy: 'coverage',
      descending: true,
      search: '',
    }), { total: 0, rows: [] });
  } finally {
    service.close();
  }
});

test('the recent-projects list survives a new service on the same userData', () => {
  const service = newService();
  try {
    const recents = service.recentProjects();
    assert.ok(recents.length >= 1);
    assert.equal(recents[0].path, projectPath);
    assert.equal(recents[0].name, 'Dragon');
    assert.equal(recents[0].missing, false);
  } finally {
    service.close();
  }
});

/* ------------------------------------------- the sha256 index is not authority */

/** Every screen 3-5 answer, so a project set up this way can compile. */
function teachDragon(service) {
  service.updateDraft({
    propertyMappings: {
      equipmentTag: { category: 'Dragon Data', name: 'Tag' },
      description: { category: 'Dragon Data', name: 'Manufacturer' },
      equipmentType: { category: 'Item', name: 'Type' },
      building: { category: 'Dragon Data', name: 'Building' },
      nativeDiscipline: null,
    },
  });
  service.updateDraft({ tagAnatomy: DRAGON_ANATOMY });
  service.updateDraft({ systemResolver: DRAGON_RESOLVER });
}

test('a source whose bytes changed is reported as changed, not read anyway', async () => {
  // Its own copies of everything: this test edits a source file, and the
  // fixtures above are shared with every test in this file.
  const ownMelPath = join(workDir, 'Changed-MEL.xlsx');
  const ownProjectPath = join(workDir, 'Changed.matchline');
  copyFileSync(melPath, ownMelPath);

  const setup = newService();
  try {
    setup.create(ownProjectPath, 'Changed');
    await setup.addSources([cachePath, ownMelPath]);
    teachDragon(setup);
    assert.equal((await setup.compile()).state, 'done', 'it compiles before anything is touched');
  } finally {
    setup.close();
  }

  // Same name, same folder, different bytes — a new revision of the MEL saved
  // over the old one, which is exactly what happens on a real job.
  writeFileSync(
    ownMelPath,
    writeWorkbook([
      {
        name: 'MEL',
        aoa: [
          ['Equipment Tag', 'UPN', 'System Description'],
          ['MAH001-10-01', '001', 'Mechanical Dry Air Handling'],
          ['MAH002-10-01', '002', 'Mechanical Hot Water'],
          ['TIT603-10-01', '603', 'Temperature Instrumentation'],
          ['PLC001-10-01', '001', 'Controls'],
        ],
      },
    ]),
  );

  const service = newService();
  try {
    const opened = await service.open(ownProjectPath, false);
    assert.equal(opened.outcome, 'opened');

    const mel = service.listSources().find((source) => source.role === 'mel');
    assert.equal(mel.status, 'file-changed', 'distinct from file-missing: the file is right there');
    assert.match(mel.note, /has changed since it was added/);
    assert.match(mel.note, /Add it again/);

    const model = service.listSources().find((source) => source.role === 'model');
    assert.equal(model.status, 'ready', 'the file that did not change is untouched by this');

    const refused = await service.compile();
    assert.equal(refused.state, 'failed');
    assert.match(refused.reason, /Changed-MEL\.xlsx/, 'the refusal names the file');
    assert.match(refused.reason, /changed on disk/);

    // Re-adding is the fix, because adding is what records the hash.
    const [readded] = await service.addSources([ownMelPath]);
    assert.equal(readded.outcome, 'added');
    assert.equal(readded.source.status, 'ready');
    assert.equal(service.listSources().find((source) => source.role === 'mel').status, 'ready');

    assert.equal((await service.compile()).state, 'done', 'and the compile runs again');
  } finally {
    service.close();
  }
});

/* ------------------------------------------ the recorded revision is the real one */

test('a compile records the revision it compiled, not the last one saved', async () => {
  const ownProjectPath = join(workDir, 'Revisions.matchline');
  const service = newService();
  try {
    service.create(ownProjectPath, 'Revisions');
    await service.addSources([cachePath, melPath]);
    teachDragon(service);

    const saved = service.saveProfile('Screens 1-5');
    assert.equal(saved.revision, 1);
    assert.equal(service.draftState().savedRevision, 1);

    const first = await service.compile();
    assert.equal(first.state, 'done');
    assert.equal(first.summary.profileRevision, 1, 'a saved draft compiles as itself');

    // One real change to the profile, and no save.
    service.updateDraft({
      tagAnatomy: { ...DRAGON_ANATOMY, ignoredSuffixes: ['-SPARE'] },
    });
    assert.equal(
      service.draftState().savedRevision,
      null,
      'the stored revision is no longer what is in memory',
    );

    const second = await service.compile();
    assert.equal(second.state, 'done');
    assert.equal(second.summary.profileRevision, 2, 'the edit was saved as its own revision');
    assert.equal(service.draftState().savedRevision, 2);

    const history = service.compileHistory();
    assert.deepEqual(
      history.map((entry) => entry.profileRevision).sort(),
      [1, 2],
      'each compile points at the profile that produced it',
    );
  } finally {
    service.close();
  }

  // And revision 2 really holds the edit: reopening restores from it.
  const reopened = newService();
  try {
    await reopened.open(ownProjectPath, false);
    assert.deepEqual(reopened.draftState().draft.tagAnatomy.ignoredSuffixes, ['-SPARE']);
  } finally {
    reopened.close();
  }
});

/* ------------------------------------------------------ migration is opt-in */

/**
 * A project file that declares itself version 1.
 *
 * Built by walking a current file back rather than from a frozen v1 DDL:
 * whether the migration preserves a real v1 file's rows is
 * `@matchline/project-store`'s own test, and what this file is about is who
 * gets asked before it runs.
 */
function writeOlderProject(name) {
  const olderPath = join(workDir, name);
  const service = newService();
  service.create(olderPath, 'Older');
  service.close();

  const db = new DatabaseSync(olderPath);
  try {
    db.exec('DROP TABLE config');
    db.exec('DELETE FROM migrations WHERE version > 1');
    db.exec("UPDATE meta SET value = '1' WHERE key = 'schema_version'");
  } finally {
    db.close();
  }
  return olderPath;
}

test('an older project file is not upgraded until the user says so', async () => {
  const olderPath = writeOlderProject('Older.matchline');

  const service = newService();
  try {
    const asked = await service.open(olderPath, false);
    assert.equal(asked.outcome, 'migration-needed');
    assert.equal(asked.migrationNeeded.fromVersion, 1);
    assert.equal(asked.migrationNeeded.toVersion, PROJECT_SCHEMA_VERSION);
    assert.equal(service.current(), null, 'nothing was opened');
    assert.equal(existsSync(`${olderPath}.backup-1`), false, 'and nothing was written');

    const accepted = await service.open(olderPath, true);
    assert.equal(accepted.outcome, 'opened');
    assert.equal(accepted.project.schemaVersion, PROJECT_SCHEMA_VERSION);
    assert.deepEqual(accepted.notice.migration, {
      fromVersion: 1,
      toVersion: PROJECT_SCHEMA_VERSION,
      backupPath: `${olderPath}.backup-1`,
    });
    assert.equal(existsSync(`${olderPath}.backup-1`), true, 'the original is kept');
  } finally {
    service.close();
  }
});

test('a backup from an earlier upgrade attempt blocks the next one, by path', async () => {
  const olderPath = writeOlderProject('Blocked.matchline');
  writeFileSync(`${olderPath}.backup-1`, 'left over from last time');

  const service = newService();
  try {
    const blocked = await service.open(olderPath, true);
    assert.equal(blocked.outcome, 'backup-blocked');
    assert.equal(blocked.backupPath, `${olderPath}.backup-1`);
    assert.equal(
      // Unchanged: the refusal happens before anything is written.
      String(new DatabaseSync(olderPath, { readOnly: true })
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get().value),
      '1',
    );
  } finally {
    service.close();
  }
});

test('a project file that cannot be written comes back as read-only, not as an error', async () => {
  const readOnlyPath = join(workDir, 'ReadOnly.matchline');
  const setup = newService();
  setup.create(readOnlyPath, 'Read Only');
  setup.close();
  chmodSync(readOnlyPath, 0o444);

  const service = newService();
  try {
    const refused = await service.open(readOnlyPath, false);
    // A result the landing screen can explain, rather than a driver message
    // thrown an hour later when the user finally pressed Save.
    assert.equal(refused.outcome, 'read-only');
    assert.match(refused.detail, /readonly/i);
    assert.equal(service.current(), null, 'and nothing was opened');
  } finally {
    service.close();
    chmodSync(readOnlyPath, 0o644);
  }

  // The mode was the only thing wrong with it.
  const reopened = newService();
  try {
    assert.equal((await reopened.open(readOnlyPath, false)).outcome, 'opened');
  } finally {
    reopened.close();
  }
});

test('creating a project over an existing file is refused in plain language', () => {
  const takenPath = join(workDir, 'Taken.matchline');
  writeFileSync(takenPath, 'something else lives here');

  const service = newService();
  try {
    assert.throws(
      () => service.create(takenPath, 'Taken'),
      /already a file called Taken\.matchline/,
    );
    assert.equal(service.current(), null);
  } finally {
    service.close();
  }
});

/* ---------------------------------------- the search-set publication gate */

/**
 * A profile whose filters name a set nobody resolved is refused at publish
 * (RELEASE-1.0-PLAN P0-3).
 *
 * > Search Sets: preferred = resolve real membership [...]; fallback = mark
 * > unusable for filtering + block profile publication + explain; never return
 * > empty-as-answer.
 *
 * The engine half of that already holds: `buildAssetCatalog` throws
 * `unresolved-selection-set` rather than filtering a project down to nothing.
 * These tests are the other half — the refusal has to reach the person while
 * they can still act on it, because a stored revision naming such a set is a
 * revision that can never produce a register. The gate lives in `saveProfile`
 * rather than on screen 9 so that Quick Setup, an imported profile package and
 * a headless caller all meet it; screen 9 additionally reads
 * `publishBlockers()` so the button is off before it is pressed.
 */

/** Enough of screens 3-5 that the draft is publishable but for its filters. */
function teachEnoughToPublish(service) {
  service.updateDraft({
    propertyMappings: {
      equipmentTag: { category: 'Dragon Data', name: 'Tag' },
      description: null,
      equipmentType: null,
      building: null,
      nativeDiscipline: null,
    },
  });
  service.updateDraft({ tagAnatomy: DRAGON_ANATOMY });
}

function filterOnSets(service, names) {
  const { draft } = service.draftState();
  service.updateDraft({ assetFilters: { ...draft.assetFilters, selectionSetNames: names } });
}

test('a profile filtering on an unresolved search set cannot be published', async () => {
  const searchCachePath = join(workDir, 'Dragon-Search.matchline-cache');
  writeDragonFixtureWithUnresolvedSearch(searchCachePath);

  const service = newService();
  try {
    service.create(join(workDir, 'UnresolvedSet.matchline'), 'Unresolved Set');
    await service.addSources([searchCachePath]);
    teachEnoughToPublish(service);
    filterOnSets(service, [DRAGON_UNRESOLVED_SET_NAME]);

    const blockers = service.publishBlockers();
    assert.equal(blockers.length, 1, 'one filter, one refusal');
    const [blocker] = blockers;
    assert.equal(blocker.kind, 'unresolved-selection-set');
    assert.equal(blocker.setName, DRAGON_UNRESOLVED_SET_NAME, 'the blocker names the set');
    assert.equal(blocker.sourceNames.length, 1, 'and the source whose copy is unresolved');

    // The explanation, in the words of the job: what is wrong, why Matchline
    // will not just carry on, and the two things that fix it.
    assert.match(blocker.message, new RegExp(DRAGON_UNRESOLVED_SET_NAME));
    assert.match(blocker.message, /saved search/);
    assert.match(blocker.message, /extract it again/);
    assert.match(blocker.message, /screen 3/);
    assert.doesNotMatch(
      blocker.message,
      /[A-Z]{3,}_[A-Z]|membership_resolved|unresolved-selection-set/,
      'and never a machine code',
    );

    // Publishing anyway is refused with that same sentence, not a different one.
    assert.throws(
      () => service.saveProfile('published over an unresolved set'),
      new RegExp(DRAGON_UNRESOLVED_SET_NAME),
    );
    assert.equal(service.current().savedRevision, null, 'and nothing was written');
  } finally {
    service.close();
  }
});

test('a profile filtering on a set that did resolve publishes normally', async () => {
  const searchCachePath = join(workDir, 'Dragon-Search-Ok.matchline-cache');
  writeDragonFixtureWithUnresolvedSearch(searchCachePath);

  const service = newService();
  try {
    service.create(join(workDir, 'ResolvedSet.matchline'), 'Resolved Set');
    await service.addSources([searchCachePath]);
    teachEnoughToPublish(service);
    // The same cache: `Air Handling` is a fixed selection with members, and
    // `PLC Panels` is a saved search that DID resolve. Neither is the gate's
    // business, and a gate that fired on them would refuse every real project.
    filterOnSets(service, ['Air Handling', 'PLC Panels']);

    assert.deepEqual(service.publishBlockers(), []);
    assert.equal(service.saveProfile('filtered on a resolved set').revision, 1);
  } finally {
    service.close();
  }
});

test('a set no source in this project has is not a publication blocker', async () => {
  const service = newService();
  try {
    service.create(join(workDir, 'UnknownSet.matchline'), 'Unknown Set');
    await service.addSources([cachePath]);
    teachEnoughToPublish(service);
    // A filter naming a set that will exist once the model holding it is added.
    // That is `unknown-selection-set` in the engine and it is a different
    // situation from an unresolved one: refusing to publish over it would make
    // the wizard unusable in the order people actually work.
    filterOnSets(service, ['A Set From The Model Nobody Has Added Yet']);

    assert.deepEqual(service.publishBlockers(), []);
    assert.ok(service.saveProfile('filters ahead of the sources').revision > 0);
  } finally {
    service.close();
  }
});

/**
 * A schema-v1 cache: no `membership_resolved` column at all.
 *
 * A v1 writer never resolved a saved search — it recorded searches without
 * members, so "members absent" meant "unknown" rather than "empty". The reader
 * carries that meaning forward (`readV1MembershipResolved`), and the gate has
 * to honour it: a project still holding a v1 cache must be refused for exactly
 * the same reason a v2 cache with the flag set to 0 is.
 */
function writeV1Cache(name) {
  const path = join(workDir, name);
  rmSync(path, { force: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(EXTRACTION_CACHE_DDL_V1);
    const meta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    for (const [key, value] of [
      ['schema_version', '1'],
      ['input_file_name', 'Legacy.nwd'],
      ['input_sha256', '1'.repeat(64)],
      ['input_bytes', '2048'],
      ['extracted_at_utc', '2026-01-15T09:30:00Z'],
      ['extractor_version', '0.1.0'],
      ['adapter_version', 'navisworks-2025'],
      ['navisworks_version', '25.0.1234.56'],
      ['object_count', '1'],
    ]) {
      meta.run(key, value);
    }
    db.exec(
      'INSERT INTO objects (id, source_model_id, parent_id, path_index, depth, display_name, class_name) ' +
        "VALUES (1, NULL, NULL, 0, 0, 'Legacy root', 'File')",
    );
    db.exec(
      "INSERT INTO selection_sets (id, parent_id, name, kind) VALUES (1, NULL, 'Legacy Fixed', 'selection')",
    );
    db.exec(
      "INSERT INTO selection_sets (id, parent_id, name, kind) VALUES (2, NULL, 'Legacy Search', 'search')",
    );
    db.exec('INSERT INTO selection_set_members (set_id, object_id) VALUES (1, 1)');
  } finally {
    db.close();
  }
  return path;
}

test('a v1 cache’s saved search blocks publication, and its fixed selection does not', async () => {
  const legacyCachePath = writeV1Cache('Legacy.matchline-cache');

  const service = newService();
  try {
    service.create(join(workDir, 'LegacyCache.matchline'), 'Legacy Cache');
    await service.addSources([legacyCachePath]);
    teachEnoughToPublish(service);

    filterOnSets(service, ['Legacy Search']);
    const blockers = service.publishBlockers();
    assert.equal(blockers.length, 1, 'a v1 search set is unknown membership, not an empty set');
    assert.equal(blockers[0].setName, 'Legacy Search');
    assert.throws(() => service.saveProfile('over a v1 search'), /Legacy Search/);

    filterOnSets(service, ['Legacy Fixed']);
    assert.deepEqual(service.publishBlockers(), [], 'a v1 fixed selection is a real answer');
    assert.ok(service.saveProfile('over a v1 fixed selection').revision > 0);
  } finally {
    service.close();
  }
});
