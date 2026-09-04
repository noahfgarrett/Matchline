import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { COMPILE_STAGES } from '@matchline/compiler';
import { writeScaleFixture } from '@matchline/model-schema/fixtures/scale';

import { createProjectService } from '../dist/electron/services/project-session.js';

/**
 * The compile runs off the main thread, and stopping it stops it
 * (RELEASE-1.0-PLAN, "Main process never blocked by ... compiling ...
 * worker_threads (compiler) ... cancellation ... responsive event loop during
 * compile").
 *
 * Everything here is about the *process*, not about what the compiler decides —
 * that is `packages/compiler`'s own suite, over Dragon, where the numbers are
 * worked out on paper. What is asserted here is only true of a compile that has
 * left the main loop:
 *
 * 1. a timer keeps firing on schedule while a compile is running;
 * 2. other service calls answer while it runs, promptly;
 * 3. it reports which stage it is on, and the stages advance;
 * 4. Stop stops it, and the project file is exactly as it was;
 * 5. a second Compile does not start a second worker;
 * 6. a cache whose bytes are not what the project recorded is refused by name.
 *
 * The universe is a modest scale fixture rather than Dragon: a compile that
 * finished in five milliseconds would prove nothing about the loop it was
 * supposed to be blocking, and a fixture whose size is stated is better than
 * one sized by accident. The aggregate-scale test lives in `tests/scale` and is
 * not in the default suite.
 */

/** Big enough that a compile is measurably long, small enough for every run. */
const SHAPE = {
  inputFileName: 'SITE-RESPONSIVE.nwd',
  unitCodes: ['10', '11'],
  familiesPerUnit: 500,
  componentsPerAsset: 4,
  propertiesPerAsset: 14,
};

/** `MAH001-10-0001` -> role MAH, system 001, unit 10, instance 0001. */
const SCALE_ANATOMY = {
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

let workDir = '';
let userDataDir = '';
let cachePath = '';
let counts = null;
let counter = 0;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'matchline-compile-worker-'));
  userDataDir = join(workDir, 'userData');
  mkdirSync(userDataDir, { recursive: true });
  cachePath = join(workDir, 'Site.matchline-cache');
  counts = writeScaleFixture(cachePath, SHAPE);
});

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function newService() {
  return createProjectService({ userDataDir, appVersion: '0.8.1' });
}

/** Ticks per millisecond a bare `setInterval` manages here, right now. */
function tickRate(intervalMs, windowMs) {
  return new Promise((resolve) => {
    let ticks = 0;
    const started = Date.now();
    const timer = setInterval(() => {
      ticks += 1;
    }, intervalMs);
    setTimeout(() => {
      clearInterval(timer);
      resolve(ticks / (Date.now() - started));
    }, windowMs);
  });
}

function projectFile(name) {
  counter += 1;
  return join(workDir, `${name}-${counter}.matchline`);
}

/** A project with the scale cache added and screens 3-6 answered. */
async function openProject(name, sourcePath = cachePath) {
  const service = newService();
  service.create(projectFile(name), name);
  await service.addSources([sourcePath]);
  service.updateDraft({
    propertyMappings: {
      equipmentTag: { category: 'Site Data', name: 'Tag' },
      description: { category: 'Site Data', name: 'Description' },
      equipmentType: { category: 'Item', name: 'Type' },
      building: { category: 'Site Data', name: 'Building' },
      nativeDiscipline: { category: 'Site Data', name: 'Service' },
    },
  });
  service.updateDraft({ tagAnatomy: SCALE_ANATOMY });
  service.updateDraft({
    systemResolver: {
      keyChain: [{ kind: 'model-field', property: { category: 'Site Data', name: 'UPN' } }],
      descriptionChain: [],
      normalization: [{ kind: 'trim' }],
      conflictPolicy: 'review',
      labelTemplate: '',
    },
  });
  service.updateConfig({
    hierarchy: {
      levels: [
        {
          levelId: 'building',
          displayName: 'Building',
          attributeKey: 'building',
          boundary: true,
          missingValuePolicy: 'unassigned-group',
          sort: 'label',
        },
      ],
    },
  });
  // Published, so a compile here is recorded rather than previewed: a compile
  // no longer publishes a revision for itself.
  service.saveProfile('scale fixture');
  return service;
}

test('the fixture is the size this suite says it is', () => {
  // 2 units x 500 families x 4 roles = 4,000 assets, each with 4 solids.
  assert.equal(counts.assetCount, 4000);
  assert.equal(counts.objectCount, 4000 * 5 + 2 + 1);
  assert.equal(counts.propertyCount, 4000 * 14 + 4000 * 4 * 2);
});

test('the main loop keeps ticking, and other calls answer, while a compile runs', async (t) => {
  const service = await openProject('Responsive');
  t.after(() => {
    service.close();
  });

  const INTERVAL_MS = 10;

  /**
   * How fast a bare timer fires on this machine with nothing else going on.
   *
   * Measured rather than assumed: `setInterval(10)` does not fire a hundred
   * times a second anywhere, and a hard-coded expectation would be a test about
   * the runner's timer resolution and the CI box's load. What the compile is
   * held to is a *fraction of this machine's own idle rate*, which is the
   * comparison the claim is actually about.
   */
  const idleRate = await tickRate(INTERVAL_MS, 300);

  const ticks = [];
  /** How long each service call took while the compile was running. */
  const answerMs = [];
  const stagesSeen = new Set();

  let lastTick = Date.now();
  // A bare timer, doing nothing but noticing that it fired. This is the
  // measurement; anything else on the same interval would be measuring itself.
  const timer = setInterval(() => {
    const now = Date.now();
    ticks.push(now - lastTick);
    lastTick = now;
  }, INTERVAL_MS);

  // The dev:ping equivalent, on its own slower interval: real service calls,
  // answered from the same loop the compile used to own.
  const caller = setInterval(() => {
    const before = Date.now();
    const status = service.compileStatus();
    service.listSources();
    service.modelUniverse();
    answerMs.push(Date.now() - before);
    if (status.state === 'running' && status.stageIndex > 0) {
      stagesSeen.add(status.stageIndex);
    }
  }, INTERVAL_MS * 5);

  const started = Date.now();
  const result = await service.compile();
  clearInterval(timer);
  clearInterval(caller);
  const elapsed = Date.now() - started;

  assert.equal(result.state, 'done', `the compile finished: ${JSON.stringify(result)}`);
  assert.equal(result.summary.assetCount, counts.assetCount);
  t.diagnostic(`compile ${String(elapsed)} ms, ${String(ticks.length)} ticks`);

  // The interval cannot fire more often than it was asked to, so the only
  // question is whether it kept up. A main thread running the compile would
  // fire once at the end, however long the compile took.
  const busyRate = ticks.length / elapsed;
  t.diagnostic(
    `idle ${idleRate.toFixed(3)} ticks/ms, during the compile ${busyRate.toFixed(3)} ticks/ms`,
  );
  assert.ok(
    busyRate >= idleRate * 0.4,
    `the loop fired ${busyRate.toFixed(3)} times per ms during the compile against ` +
      `${idleRate.toFixed(3)} idle; a compile on the main thread fires once, at the end`,
  );
  assert.ok(ticks.length > 10, 'and the compile ran long enough for this to mean something');
  assert.ok(answerMs.length > 2, 'and several service calls were answered while it ran');

  // The sharpest evidence, and the one that does not depend on a rate: a
  // compile on the main thread shows one gap as long as the compile. The gap
  // that does remain is the compiled project crossing the thread boundary,
  // which main deserializes in one go when the worker answers.
  const worstGap = Math.max(...ticks);
  assert.ok(
    worstGap < elapsed / 3,
    `the longest gap between ticks was ${String(worstGap)} ms of a ${String(elapsed)} ms compile`,
  );

  const worstAnswer = Math.max(...answerMs);
  assert.ok(
    worstAnswer < 250,
    `the slowest service call during the compile took ${String(worstAnswer)} ms`,
  );

  assert.ok(stagesSeen.size > 1, `the compile reported several stages, not one: ${[...stagesSeen]}`);
  assert.ok(
    Math.max(...stagesSeen) <= COMPILE_STAGES.length,
    'and never a stage number the pipeline does not have',
  );
});

test('Stop ends the compile and leaves the project exactly as it was', async (t) => {
  const service = await openProject('Cancelled');
  t.after(() => {
    service.close();
  });

  // One finished compile first, so there is something for cancellation to be
  // careful with: a Stop that threw away a workspace the user still had open
  // would be more destructive than waiting.
  const first = await service.compile();
  assert.equal(first.state, 'done');
  const historyBefore = service.compileHistory();
  const treeBefore = service.treeChildren('', 0, 5);

  const running = service.compile();
  assert.equal(service.cancelCompile(), true, 'there was a compile to stop');
  const stopped = await running;

  assert.equal(stopped.state, 'cancelled');
  assert.equal(service.compileStatus().state, 'cancelled');
  assert.deepEqual(
    service.compileHistory(),
    historyBefore,
    'no compile row, no snapshot and no ledger were written',
  );
  assert.deepEqual(
    service.treeChildren('', 0, 5),
    treeBefore,
    'and the workspace still shows the compile that did finish',
  );

  assert.equal(service.cancelCompile(), false, 'there is nothing left to stop');

  const after = await service.compile();
  assert.equal(after.state, 'done', 'and compiling again works');
  assert.equal(service.compileHistory().length, historyBefore.length + 1);
});

test('a second Compile joins the first rather than starting a second worker', async (t) => {
  const service = await openProject('Reentrant');
  t.after(() => {
    service.close();
  });

  const first = service.compile();
  const second = await service.compile();
  assert.equal(second.state, 'running', 'the second call reports the first, and starts nothing');
  assert.equal(second.stageCount, COMPILE_STAGES.length);

  assert.equal((await first).state, 'done');
  assert.equal(service.compileHistory().length, 1, 'exactly one compile was recorded');
});

test('a cache whose bytes are not what the project recorded is refused by name', async (t) => {
  // The session holds an open handle; the worker opens the path itself, which
  // is the only reason this can be checked at all. A compile over content the
  // project never approved is what the recorded hashes exist to prevent (P0-1).
  const swappedPath = join(workDir, 'Swapped.matchline-cache');
  copyFileSync(cachePath, swappedPath);
  const service = await openProject('Swapped', swappedPath);
  t.after(() => {
    service.close();
    rmSync(swappedPath, { force: true });
  });

  // Different content under the same path, after the project recorded the
  // original: the session's own handle is still on the file it opened.
  writeScaleFixture(swappedPath, { ...SHAPE, inputFileName: 'SITE-OTHER.nwd' });

  const status = await service.compile();
  assert.equal(status.state, 'failed');
  assert.match(status.reason, /not what this project recorded/);
  assert.match(status.reason, /Swapped\.matchline-cache/, 'and the refusal names the source');
  assert.equal(service.compileHistory().length, 0, 'nothing was recorded');
});
