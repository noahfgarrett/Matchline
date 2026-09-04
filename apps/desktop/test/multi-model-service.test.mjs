import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import {
  DRAGON_SOURCE_MODEL_IDS,
  writeDragonFixture,
  writeDragonFixtureSubset,
} from '@matchline/model-schema/fixtures/dragon';
import { deserializeSnapshot, openProject } from '@matchline/project-store';
import { writeWorkbook } from '@matchline/spreadsheet-import';

import { createProjectService } from '../dist/electron/services/project-session.js';

/**
 * One project, many model sources — through the main-process service the IPC
 * handlers call (RELEASE-1.0-PLAN P0-1, hard gates 2, 3 and 4).
 *
 * `project-service.test.mjs` walks the wizard over one cache; this walks it over
 * a universe, and asserts the four things that make a set of files a project
 * rather than a list of them:
 *
 * 1. **The universe is the union.** Two split caches scan, page, preview and
 *    compile to exactly what the federated file does.
 * 2. **Same-basename files coexist.** Two different files both called
 *    `Level 1.matchline-cache` are two sources, not one overwriting the other.
 * 3. **Replacing one source touches one source.** The cache handle of every
 *    other source survives, byte for byte the same handle.
 * 4. **A hole in the universe is a refusal.** A model source whose bytes
 *    changed stops the compile and is named in the message.
 *
 * ## The fixtures
 *
 * Dragon (packages/model-schema/src/fixtures/dragon.ts) is a federated cache:
 * one file carrying a Mechanical source model and two Controls ones.
 * `writeDragonFixtureSubset` partitions it into caches whose objects partition
 * the federated file exactly — same ids, same properties — so "federated vs
 * split" below compares two representations of one site rather than two sites.
 * Every tag, building and MEL row is invented; no client data.
 */

/** The federated fixture's own numbers, restated from `project-service.test.mjs`. */
const DRAGON_OBJECT_COUNT = 76;
const DRAGON_TAGGED_COUNT = 34;
const DRAGON_PROPERTY_COUNT = 11;

/** Mechanical alone: 1 file root + 2 building layers + 24 equipment + 24 solids. */
const MECHANICAL_OBJECT_COUNT = 51;
const MECHANICAL_ASSET_COUNT = 24;
/** Controls alone: the other 25 objects and the other 10 tags. */
const CONTROLS_OBJECT_COUNT = 25;
const CONTROLS_ASSET_COUNT = 10;

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
let userDataDir = '';
let federatedPath = '';
let mechanicalPath = '';
let controlsPath = '';
let melPath = '';
let projectCounter = 0;

/** A `.matchline-cache` holding only the named source models. */
function writeSplit(path, sourceModels, inputFileName) {
  writeDragonFixtureSubset(path, { sourceModels, inputFileName });
}

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'matchline-universe-'));
  userDataDir = join(workDir, 'userData');
  federatedPath = join(workDir, 'Dragon.matchline-cache');
  mechanicalPath = join(workDir, 'Dragon-Mechanical.matchline-cache');
  controlsPath = join(workDir, 'Dragon-Controls.matchline-cache');
  melPath = join(workDir, 'Dragon-MEL.xlsx');

  writeDragonFixture(federatedPath);
  writeSplit(mechanicalPath, [DRAGON_SOURCE_MODEL_IDS.mechanical], 'Dragon-Mechanical.nwd');
  writeSplit(
    controlsPath,
    [DRAGON_SOURCE_MODEL_IDS.controls, DRAGON_SOURCE_MODEL_IDS.controlsPlc],
    'Dragon-Controls.nwd',
  );

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

/** A fresh project path, so no two tests share a file. */
function projectFile(name) {
  projectCounter += 1;
  return join(workDir, `${name}-${String(projectCounter)}.matchline`);
}

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
  // Published, so the compiles below are recorded rather than previews: a
  // compile does not publish for itself any more.
  service.saveProfile('Dragon');
}

/** Creates a project, registers `paths`, and teaches it Dragon. */
async function projectOver(name, paths) {
  const path = projectFile(name);
  const service = newService();
  service.create(path, name);
  const added = await service.addSources(paths);
  teachDragon(service);
  return { path, service, added };
}

function modelSources(service) {
  return service.listSources().filter((source) => source.role === 'model');
}

/**
 * The stored snapshot reduced to what two representations of one site must
 * agree on: who parents whom, what depends on what, and where the roots are.
 *
 * Provenance is left out on purpose (P0-1: "provenance differences excepted") —
 * a federated compile really did read one file where a split compile read two,
 * and a canonical form that hid that would be lying rather than comparing.
 *
 * Asset ids are the comparison key without translation: every Dragon tag is
 * unique across the whole universe, so every asset id is `tag:<tag>` and names
 * no source in either representation.
 */
function canonicalSnapshot(projectPath) {
  const store = openProject(projectPath);
  try {
    const stored = store.getLatestSnapshot(deserializeSnapshot);
    assert.ok(stored !== undefined, 'the compile stored a snapshot');

    const parents = [];
    const dependencies = [];
    for (const [assetId, node] of stored.snapshot.nodes) {
      parents.push(`${assetId} -> ${node.parent.parentAssetId ?? `(${node.parent.status})`}`);
      for (const dependency of node.dependencies) {
        dependencies.push(
          `${assetId} <- ${dependency.parentAssetId} (${dependency.relationshipType})`,
        );
      }
    }
    return { parents: parents.sort(), dependencies: dependencies.sort() };
  } finally {
    store.close();
  }
}

/* ------------------------------------------- the universe is the union ---- */

test('two split caches scan as one universe whose totals are the federated file', async () => {
  const split = await projectOver('Split', [mechanicalPath, controlsPath, melPath]);
  const federated = await projectOver('Federated', [federatedPath, melPath]);

  try {
    const universe = split.service.modelUniverse();
    assert.equal(universe.sourceCount, 2);
    assert.equal(universe.objectCount, DRAGON_OBJECT_COUNT, 'the union is the federated file');
    assert.equal(universe.propertyNameCount, DRAGON_PROPERTY_COUNT);
    assert.deepEqual(
      universe.sources.map((source) => source.sourceId),
      ['model:dragon-controls.matchline-cache', 'model:dragon-mechanical.matchline-cache'],
      'the universe is read in source-id order, not the order files were added',
    );
    assert.deepEqual(
      universe.sources.map((source) => source.objectCount),
      [CONTROLS_OBJECT_COUNT, MECHANICAL_OBJECT_COUNT],
    );
    assert.deepEqual(
      universe.sources.map((source) => source.rawFileName),
      ['Dragon-Controls.matchline-cache', 'Dragon-Mechanical.matchline-cache'],
    );

    // A shared property name is ONE row of the catalog, not two: this is the
    // number the list under it is a list of.
    const federatedUniverse = federated.service.modelUniverse();
    assert.equal(universe.propertyNameCount, federatedUniverse.propertyNameCount);
    assert.equal(universe.objectCount, federatedUniverse.objectCount);

    // And the class list a screen-3 filter is built from is summed, not taken
    // from whichever cache opened first.
    const equipment = split.service.classList().find((entry) => entry.className === 'Equipment');
    assert.equal(equipment.objectCount, DRAGON_TAGGED_COUNT);
  } finally {
    split.service.close();
    federated.service.close();
  }
});

test('the Property Catalog aggregates the universe and discloses each source', async () => {
  const split = await projectOver('Coverage', [mechanicalPath, controlsPath]);
  try {
    const page = split.service.propertyPage({
      offset: 0,
      limit: 50,
      sortBy: 'coverage',
      descending: true,
      search: 'Tag',
    });
    assert.equal(page.total, 1);

    const [tag] = page.rows;
    assert.equal(tag.objectCount, DRAGON_TAGGED_COUNT, 'the overall count is the universe');
    assert.deepEqual(
      tag.bySource.map((source) => source.sourceId),
      ['model:dragon-controls.matchline-cache', 'model:dragon-mechanical.matchline-cache'],
    );
    assert.deepEqual(
      tag.bySource.map((source) => source.label),
      ['dragon-controls', 'dragon-mechanical'],
      'the disclosure prints short names, not whole ids',
    );
    assert.equal(
      tag.bySource.reduce((total, source) => total + source.objectCount, 0),
      tag.objectCount,
      'the per-source counts add up to the overall one',
    );

    // `Controls Data > Firmware` is written in the controls model and nowhere
    // else, which is exactly the shape the per-source split exists to show.
    const firmware = split.service.propertyPage({
      offset: 0,
      limit: 50,
      sortBy: 'coverage',
      descending: true,
      search: 'Firmware',
    }).rows[0];
    assert.deepEqual(
      firmware.bySource.map((source) => source.sourceId),
      ['model:dragon-controls.matchline-cache'],
      'a source that never carries the property is absent, which reads as zero',
    );
    assert.ok(
      firmware.coverage < firmware.bySource[0].coverage,
      'coverage across the site is lower than coverage within the one file that has it',
    );
  } finally {
    split.service.close();
  }
});

test('screen 3 breaks the inclusion impact down per model source', async () => {
  const split = await projectOver('Impact', [mechanicalPath, controlsPath]);
  try {
    const preview = split.service.assetPreview();
    assert.equal(preview.state, 'ready');
    assert.equal(preview.totalObjects, DRAGON_OBJECT_COUNT);
    assert.equal(preview.finalAssetCount, DRAGON_TAGGED_COUNT);
    assert.equal(preview.duplicateTagCount, 0, 'the two halves share no tag');

    assert.deepEqual(preview.bySource, [
      {
        sourceId: 'model:dragon-controls.matchline-cache',
        label: 'dragon-controls',
        totalObjects: CONTROLS_OBJECT_COUNT,
        collapsedCount: 0,
        finalAssetCount: CONTROLS_ASSET_COUNT,
        untaggedDroppedCount: CONTROLS_OBJECT_COUNT - CONTROLS_ASSET_COUNT,
      },
      {
        sourceId: 'model:dragon-mechanical.matchline-cache',
        label: 'dragon-mechanical',
        totalObjects: MECHANICAL_OBJECT_COUNT,
        collapsedCount: 0,
        finalAssetCount: MECHANICAL_ASSET_COUNT,
        untaggedDroppedCount: MECHANICAL_OBJECT_COUNT - MECHANICAL_ASSET_COUNT,
      },
    ]);
    assert.equal(
      preview.bySource.reduce((total, source) => total + source.finalAssetCount, 0),
      preview.finalAssetCount,
    );

    // Every sample says which file it came out of, so a person can tell the two
    // halves apart in a list that mixes them.
    for (const sample of preview.samples) {
      assert.ok(
        sample.sourceId.startsWith('model:dragon-'),
        `sample ${sample.assetId} names its source`,
      );
    }
  } finally {
    split.service.close();
  }
});

test('a split project compiles to the same hierarchy the federated file does', async () => {
  const split = await projectOver('SplitCompile', [mechanicalPath, controlsPath, melPath]);
  const federated = await projectOver('FederatedCompile', [federatedPath, melPath]);

  let splitSummary = null;
  let federatedSummary = null;
  try {
    const splitStatus = await split.service.compile();
    assert.equal(splitStatus.state, 'done', splitStatus.reason ?? '');
    splitSummary = splitStatus.summary;

    const federatedStatus = await federated.service.compile();
    assert.equal(federatedStatus.state, 'done', federatedStatus.reason ?? '');
    federatedSummary = federatedStatus.summary;

    // Screen 5 resolves over the universe too: 34 subjects, not 24.
    const resolver = split.service.resolverPreview();
    assert.equal(resolver.state, 'ready');
    assert.equal(resolver.subjectCount, DRAGON_TAGGED_COUNT);
    assert.equal(resolver.resolvedCount, DRAGON_TAGGED_COUNT);
    assert.ok(
      resolver.samples.every((sample) => sample.sourceId !== ''),
      'a resolved sample names the source it was read from',
    );
  } finally {
    split.service.close();
    federated.service.close();
  }

  // Every number a reviewer checks on screen 8, except the two that are about
  // this run rather than about the site.
  const comparable = (summary) => {
    const { compileId, finishedAt, durationMs, ...rest } = summary;
    void compileId;
    void finishedAt;
    void durationMs;
    return rest;
  };
  assert.equal(splitSummary.assetCount, DRAGON_TAGGED_COUNT);
  assert.deepEqual(comparable(splitSummary), comparable(federatedSummary));

  // And the stored snapshot itself: same parents, same dependencies.
  assert.deepEqual(canonicalSnapshot(split.path), canonicalSnapshot(federated.path));
});

/* --------------------------------------- duplicate basenames coexist ------ */

test('two different files called `Level 1.matchline-cache` are two sources', async () => {
  const first = join(workDir, 'consultant-a');
  const second = join(workDir, 'consultant-b');
  mkdirSync(first, { recursive: true });
  mkdirSync(second, { recursive: true });
  const firstPath = join(first, 'Level 1.matchline-cache');
  const secondPath = join(second, 'Level 1.matchline-cache');
  copyFileSync(mechanicalPath, firstPath);
  copyFileSync(controlsPath, secondPath);

  const project = await projectOver('Duplicates', [firstPath, secondPath]);
  try {
    assert.deepEqual(
      modelSources(project.service).map((source) => source.sourceId),
      ['model:level-1.matchline-cache', 'model:level-1.matchline-cache-2'],
      'the second registration is suffixed rather than overwriting the first',
    );
    assert.deepEqual(
      modelSources(project.service).map((source) => source.rawFileName),
      ['Level 1.matchline-cache', 'Level 1.matchline-cache'],
      'and both keep the name their file actually has',
    );

    const universe = project.service.modelUniverse();
    assert.equal(universe.sourceCount, 2);
    assert.equal(universe.objectCount, DRAGON_OBJECT_COUNT, 'both files were read');
    assert.equal(project.service.assetPreview().finalAssetCount, DRAGON_TAGGED_COUNT);

    // Re-adding the FIRST file replaces the first source only. Same bytes, so
    // the row is rewritten and no third source appears.
    await project.service.addSources([firstPath]);
    assert.equal(modelSources(project.service).length, 2, 'still two, not three');
  } finally {
    project.service.close();
  }
});

/* ----------------------------- replacing one source invalidates one source */

test('replacing one model source re-opens that cache and no other', async () => {
  const own = join(workDir, 'replace-one');
  mkdirSync(own, { recursive: true });
  const ownMechanical = join(own, 'Dragon-Mechanical.matchline-cache');
  const ownControls = join(own, 'Dragon-Controls.matchline-cache');
  copyFileSync(mechanicalPath, ownMechanical);
  copyFileSync(controlsPath, ownControls);

  const project = await projectOver('ReplaceOne', [ownMechanical, ownControls]);
  const mechanicalId = 'model:dragon-mechanical.matchline-cache';
  const controlsId = 'model:dragon-controls.matchline-cache';

  try {
    const before = project.service.cacheHandleIds();
    assert.deepEqual([...before.keys()].sort(), [controlsId, mechanicalId]);
    assert.equal(project.service.assetPreview().finalAssetCount, DRAGON_TAGGED_COUNT);

    // The same file on disk, re-extracted: identical objects, different bytes.
    // (`inputFileName` is recorded in the cache's own meta.)
    writeSplit(
      ownMechanical,
      [DRAGON_SOURCE_MODEL_IDS.mechanical],
      'Dragon-Mechanical-RevB.nwd',
    );
    const [readded] = await project.service.addSources([ownMechanical]);
    assert.equal(readded.outcome, 'added');
    assert.equal(readded.source.sourceId, mechanicalId, 'the same file keeps its source id');
    assert.equal(readded.source.status, 'ready');

    const after = project.service.cacheHandleIds();
    assert.deepEqual([...after.keys()].sort(), [controlsId, mechanicalId], 'still two sources');
    assert.equal(
      after.get(controlsId),
      before.get(controlsId),
      'the source nobody touched is the same open handle, not an equal one',
    );
    assert.notEqual(
      after.get(mechanicalId),
      before.get(mechanicalId),
      'and the replaced source was re-opened, because its bytes are different',
    );

    // The universe still answers with both halves.
    assert.equal(project.service.assetPreview().finalAssetCount, DRAGON_TAGGED_COUNT);
    assert.equal(modelSources(project.service).length, 2);
  } finally {
    project.service.close();
  }
});

test('removing one model source leaves the rest of the universe open', async () => {
  const project = await projectOver('RemoveOne', [mechanicalPath, controlsPath]);
  const mechanicalId = 'model:dragon-mechanical.matchline-cache';
  const controlsId = 'model:dragon-controls.matchline-cache';

  try {
    const before = project.service.cacheHandleIds();
    assert.equal(project.service.removeSource(controlsId), true);

    const after = project.service.cacheHandleIds();
    assert.deepEqual([...after.keys()], [mechanicalId]);
    assert.equal(
      after.get(mechanicalId),
      before.get(mechanicalId),
      'the survivor was never re-opened',
    );

    const universe = project.service.modelUniverse();
    assert.equal(universe.sourceCount, 1);
    assert.equal(universe.objectCount, MECHANICAL_OBJECT_COUNT);
    assert.equal(project.service.assetPreview().finalAssetCount, MECHANICAL_ASSET_COUNT);

    assert.equal(project.service.removeSource(mechanicalId), true);
    assert.equal(project.service.modelUniverse(), null);
    assert.equal(project.service.assetPreview().state, 'blocked');
    assert.equal(project.service.removeSource(controlsId), false, 'a second remove is a no-op');
  } finally {
    project.service.close();
  }
});

/* ------------------------------------- a hole in the universe is a refusal */

test('a model source whose bytes changed refuses the compile and is named in it', async () => {
  const own = join(workDir, 'changed-source');
  mkdirSync(own, { recursive: true });
  const ownMechanical = join(own, 'Dragon-Mechanical.matchline-cache');
  const ownControls = join(own, 'Dragon-Controls.matchline-cache');
  copyFileSync(mechanicalPath, ownMechanical);
  copyFileSync(controlsPath, ownControls);

  const setup = await projectOver('Changed', [ownMechanical, ownControls, melPath]);
  try {
    assert.equal((await setup.service.compile()).state, 'done', 'it compiles before anything is touched');
  } finally {
    setup.service.close();
  }

  // A re-extraction saved over the old cache — exactly what happens on a real
  // job when a consultant reissues one model.
  writeSplit(ownControls, [DRAGON_SOURCE_MODEL_IDS.controls], 'Dragon-Controls-RevB.nwd');

  const service = newService();
  try {
    assert.equal((await service.open(setup.path, false)).outcome, 'opened');

    const controls = service
      .listSources()
      .find((source) => source.sourceId === 'model:dragon-controls.matchline-cache');
    assert.equal(controls.status, 'file-changed');
    assert.equal(
      service.listSources().find(
        (source) => source.sourceId === 'model:dragon-mechanical.matchline-cache',
      ).status,
      'ready',
      'the file that did not change is untouched by this',
    );

    const refused = await service.compile();
    assert.equal(refused.state, 'failed');
    assert.match(refused.reason, /Dragon-Controls\.matchline-cache/, 'the refusal names the source');
    assert.match(refused.reason, /changed on disk/);

    // Re-adding is the fix, because adding is what records the hash — and the
    // re-added file is the SAME source, not a second one.
    const [readded] = await service.addSources([ownControls]);
    assert.equal(readded.outcome, 'added');
    assert.equal(readded.source.sourceId, 'model:dragon-controls.matchline-cache');
    assert.equal(readded.source.status, 'ready');
    assert.equal(modelSources(service).length, 2, 'still two model sources');
    assert.equal((await service.compile()).state, 'done', 'and the compile runs again');
  } finally {
    service.close();
  }
});

/**
 * A raw model whose extraction cannot run — this machine is not Windows and the
 * default launcher says so — is still a registered source, and still not part
 * of the universe.
 *
 * The extraction service itself is proven in `extraction-service.test.mjs`
 * against a fake launcher. What matters here is the multi-model promise: a
 * model source with no cache is a row, not a hole, and it does not stop the
 * sources that do have one from compiling.
 */
test('a raw Navisworks file is a registered source that no compile waits for', async () => {
  const rawPath = join(workDir, 'Dragon-Architectural.nwd');
  writeFileSync(rawPath, 'not a real NWD, and nothing here opens one');

  const project = await projectOver('RawDrop', [mechanicalPath, rawPath, melPath]);
  try {
    await project.service.extractionIdle();
    const raw = project.service
      .listSources()
      .find((source) => source.sourceId === 'model:dragon-architectural.nwd');
    assert.equal(raw.status, 'failed', 'extraction cannot run on this machine, and says so');
    assert.match(raw.note, /Windows/);
    assert.equal(
      raw.derivedCacheSha256,
      null,
      'a raw file has no cache until the extractor produces one',
    );

    // It is not part of the universe, and it does not hold the compile up: its
    // status on screen 1 is what says the extraction has not run.
    assert.equal(project.service.modelUniverse().sourceCount, 1);
    assert.equal((await project.service.compile()).state, 'done');
  } finally {
    project.service.close();
  }
});

/* ----------------------------------------------- single-source parity ----- */

test('a one-source project reports exactly what it did before the universe existed', async () => {
  const project = await projectOver('Parity', [federatedPath, melPath]);
  try {
    const universe = project.service.modelUniverse();
    assert.equal(universe.sourceCount, 1);
    assert.equal(universe.objectCount, DRAGON_OBJECT_COUNT);
    assert.equal(universe.propertyNameCount, DRAGON_PROPERTY_COUNT);
    assert.equal(universe.sources[0].sourceModels.length, 3);

    const preview = project.service.assetPreview();
    assert.equal(preview.totalObjects, DRAGON_OBJECT_COUNT);
    assert.equal(preview.finalAssetCount, DRAGON_TAGGED_COUNT);
    assert.equal(preview.untaggedDroppedCount, DRAGON_OBJECT_COUNT - DRAGON_TAGGED_COUNT);
    assert.equal(preview.bySource.length, 1);
    assert.equal(preview.bySource[0].finalAssetCount, preview.finalAssetCount);
    assert.equal(preview.bySource[0].totalObjects, preview.totalObjects);

    assert.equal(project.service.anatomyPreview().coverage, 1);
    assert.equal(project.service.resolverPreview().resolvedCount, DRAGON_TAGGED_COUNT);

    const status = await project.service.compile();
    assert.equal(status.state, 'done', status.reason ?? '');
    assert.equal(status.summary.assetCount, DRAGON_TAGGED_COUNT);
    assert.equal(status.summary.duplicateTagCount, 0);

    // The asset ids a single-source project produces name no source, so every
    // decision stored against a unique tag survives the move to a universe.
    for (const sample of preview.samples) {
      assert.equal(sample.assetId, `tag:${sample.canonicalTag}`);
    }
  } finally {
    project.service.close();
  }
});
