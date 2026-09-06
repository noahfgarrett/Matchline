import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

import { writeWorkbook } from '@matchline/spreadsheet-import';

import { createExtractionService } from '../dist/electron/services/extraction-service.js';
import {
  describeExtractionFailure,
  failureCodesWithCopy,
} from '../dist/electron/services/extraction-messages.js';
import {
  DEFAULT_STALL_TIMEOUT_SECONDS,
  EXTRACTION_STAGES,
  LAUNCHER_ERROR_CODES,
  SERVICE_ERROR_CODES,
  extractorArguments,
} from '../dist/electron/services/extraction-protocol.js';
import {
  createProcessExtractorLauncher,
  resolveExtractorLauncher,
} from '../dist/electron/services/extractor-launcher.js';
import { createProjectService } from '../dist/electron/services/project-session.js';
import { digestFile } from '../dist/electron/services/digest.js';

/**
 * The integrated extraction service (RELEASE-1.0-PLAN P0-2), end to end, on a
 * machine that has never seen Navisworks.
 *
 * What makes that honest rather than convenient is `test/fake-extractor.mjs`:
 * a second implementation of the launcher's side of the protocol, written from
 * the C# and run as a real child process. Every assertion below therefore goes
 * through the real spawn, the real line parsing, the real stdin cancel, the
 * real SIGTERM/SIGKILL escalation and a real SQLite cache — the only thing
 * missing is Autodesk, which is the one part this machine could never provide.
 *
 * The nine things a milestone-5 build has to be able to say:
 *
 * 1. Dropping an NWD extracts it, associates the cache and compiles.
 * 2. The same bytes twice never start the extractor again.
 * 3. Cancelling mid-extract leaves the source registered, cancelled, and no
 *    partial file behind.
 * 4. Every failure has a plain-language sentence naming what to do.
 * 5. Three models run one at a time, in the order they were added.
 * 6. Hashing a large file streams it.
 * 7. A changed model re-extracts under the same source id.
 * 8. A machine that cannot extract says so, in the row.
 * 9. Cancellation escalates when the launcher ignores the polite request.
 */

const FAKE_EXTRACTOR = join(dirname(fileURLToPath(import.meta.url)), 'fake-extractor.mjs');

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

/** What the Dragon fixture the fake writes holds. */
const DRAGON_OBJECT_COUNT = 76;

let workDir = '';
let userDataDir = '';
let melPath = '';
let counter = 0;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'matchline-extraction-'));
  userDataDir = join(workDir, 'userData');
  mkdirSync(userDataDir, { recursive: true });

  melPath = join(workDir, 'Dragon-MEL.xlsx');
  writeFileSync(
    melPath,
    writeWorkbook([
      {
        name: 'MEL',
        aoa: [
          ['Equipment Tag', 'UPN', 'System Description'],
          ['MAH001-10-01', '001', 'Mechanical Dry Air Handling'],
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

/**
 * A stand-in Navisworks document.
 *
 * The bytes are not an NWD and never need to be: what makes this a model is
 * that its name ends in `.nwd`, which is exactly how Matchline decides. The
 * first line tells the fake launcher what kind of run to have, and the tail
 * makes every fixture's content hash unique, so two models are two caches.
 */
function writeModel(name, scenario = {}) {
  counter += 1;
  const modelPath = join(workDir, name);
  writeFileSync(
    modelPath,
    `MATCHLINE-FAKE ${JSON.stringify(scenario)}\nsynthetic model ${name} #${counter}\n`,
  );
  return modelPath;
}

/** A fresh cache directory, so one test's launch log is not another's. */
function newCacheDir(name) {
  counter += 1;
  const dir = join(workDir, `cache-${name}-${counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function fakeLauncher(options = {}) {
  return createProcessExtractorLauncher({
    command: process.execPath,
    // `--no-warnings` only silences node:sqlite's experimental notice, which
    // would otherwise land in the diagnostics of every run.
    commandArgs: ['--no-warnings', FAKE_EXTRACTOR],
    killGraceMs: options.killGraceMs ?? 400,
  });
}

function newService(cacheDir, launcher = fakeLauncher()) {
  return createProjectService({
    userDataDir,
    appVersion: '0.8.1',
    extractionCacheDir: cacheDir,
    extractionLauncher: launcher,
  });
}

function projectFile(name) {
  counter += 1;
  return join(workDir, `${name}-${counter}.matchline`);
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
}

function sourceById(service, sourceId) {
  return service.listSources().find((source) => source.sourceId === sourceId);
}

/** The fake's own record of what it was asked to do, in order. */
function launchLog(cacheDir) {
  const logPath = join(cacheDir, 'fake-extractor.log');
  try {
    return readFileSync(logPath, 'utf8').trim().split('\n').filter((line) => line !== '');
  } catch {
    return [];
  }
}

/** Waits for `predicate`, polling rather than sleeping a fixed amount. */
async function waitFor(predicate, description) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (predicate()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${description}`);
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
}

/* ------------------------------------------------------------- 1. happy path */

test('dropping a Navisworks model extracts it, associates it, and compiles', async (t) => {
  const cacheDir = newCacheDir('happy');
  const modelPath = writeModel('Dragon-Coordination.nwd', { walkTicks: 3, tickMs: 15 });
  const service = newService(cacheDir);
  t.after(() => {
    service.close();
  });

  service.create(projectFile('Happy'), 'Happy');
  const results = await service.addSources([modelPath, melPath]);

  const model = results
    .filter((entry) => entry.outcome === 'added')
    .map((entry) => entry.source)
    .find((source) => source.role === 'model');
  assert.ok(model !== undefined, 'the raw model registered as a model source');
  assert.equal(model.sourceId, 'model:dragon-coordination.nwd');
  assert.equal(model.status, 'queued', 'a raw model starts queued, not ready');
  assert.equal(
    model.derivedCacheSha256,
    null,
    'and carries no cache until one has been produced and validated',
  );
  assert.equal(service.modelUniverse(), null, 'so it is not in the universe yet');

  // The stages the row travels through, watched the way the screen does.
  const seen = new Set();
  await waitFor(() => {
    const [job] = service.extractionStatus(0, 10).rows;
    if (job !== undefined) {
      seen.add(job.status);
    }
    return job !== undefined && !job.cancellable;
  }, 'the extraction to finish');
  await service.extractionIdle();

  assert.ok(seen.has('extracting'), `the row reported extracting (saw ${[...seen].join(', ')})`);
  assert.ok(seen.has('ready'), 'and ended ready');

  const [job] = service.extractionStatus(0, 10).rows;
  assert.equal(job.status, 'ready');
  assert.equal(job.objectCount, DRAGON_OBJECT_COUNT);
  assert.equal(job.errorCode, null);
  assert.equal(job.progress, 1);
  assert.deepEqual(
    job.warnings.map((warning) => warning.code),
    ['ADAPTER_UNVERIFIED'],
    'the unverified-adapter notice is forwarded to the row',
  );
  assert.match(job.warnings[0].message, /not been proven against a real install/);

  const stored = sourceById(service, 'model:dragon-coordination.nwd');
  assert.equal(stored.status, 'ready');
  assert.equal(stored.derivedCacheSha256.length, 64, 'the project recorded the cache it produced');
  assert.notEqual(
    stored.derivedCacheSha256,
    stored.rawSha256,
    'and the cache hash is the cache, not the model',
  );
  assert.match(stored.note, /76 objects/, 'the row says what came out, in plain language');
  assert.doesNotMatch(stored.note, /matchline-cache/, 'and never names a cache file');

  const universe = service.modelUniverse();
  assert.equal(universe.sourceCount, 1, 'the extracted model joined the universe automatically');
  assert.equal(universe.objectCount, DRAGON_OBJECT_COUNT);

  teachDragon(service);
  const compiled = await service.compile();
  assert.equal(compiled.state, 'done', 'and the compile consumes it like any other source');
  assert.ok(compiled.summary.assetCount > 0);

  const written = readdirSync(cacheDir).filter((name) => name.endsWith('.sqlite'));
  assert.equal(written.length, 1, 'exactly one cache was written');
  assert.equal(
    readdirSync(cacheDir).filter((name) => name.includes('.partial')).length,
    0,
    'and nothing partial was left behind',
  );
});

/* --------------------------------------------------------------- 2. cache hit */

test('the same model added twice never starts the extractor again', async (t) => {
  const cacheDir = newCacheDir('reuse');
  const modelPath = writeModel('Dragon-Reused.nwd');
  const service = newService(cacheDir);
  t.after(() => {
    service.close();
  });

  service.create(projectFile('Reuse'), 'Reuse');
  await service.addSources([modelPath]);
  await service.extractionIdle();
  assert.equal(sourceById(service, 'model:dragon-reused.nwd').status, 'ready');
  assert.deepEqual(launchLog(cacheDir), ['start Dragon-Reused.nwd', 'end Dragon-Reused.nwd']);

  await service.addSources([modelPath]);
  await service.extractionIdle();

  const [job] = service.extractionStatus(0, 10).rows;
  assert.equal(job.status, 'cache-hit', 'the second add is a cache hit');
  assert.equal(job.objectCount, DRAGON_OBJECT_COUNT);
  assert.deepEqual(
    launchLog(cacheDir),
    ['start Dragon-Reused.nwd', 'end Dragon-Reused.nwd'],
    'and the launcher was never run a second time',
  );

  const stored = sourceById(service, 'model:dragon-reused.nwd');
  assert.equal(stored.status, 'cache-hit');
  assert.match(stored.note, /reused that extraction/);
  assert.equal(service.modelUniverse().sourceCount, 1, 'and the source is readable either way');
});

/* ------------------------------------------------------------ 3. cancellation */

test('cancelling mid-extract leaves the source registered, cancelled and clean', async (t) => {
  const cacheDir = newCacheDir('cancel');
  // Long enough to be cancelled while it is still walking the model.
  const modelPath = writeModel('Dragon-Cancelled.nwd', { walkTicks: 200, tickMs: 25 });
  const service = newService(cacheDir);
  t.after(() => {
    service.close();
  });

  service.create(projectFile('Cancel'), 'Cancel');
  await service.addSources([modelPath]);

  await waitFor(
    () => service.extractionStatus(0, 10).rows[0]?.status === 'extracting',
    'the extraction to start reading the model',
  );
  assert.equal(service.cancelExtraction('model:dragon-cancelled.nwd'), true);
  await service.extractionIdle();

  const [job] = service.extractionStatus(0, 10).rows;
  assert.equal(job.status, 'cancelled');
  assert.equal(job.errorCode, LAUNCHER_ERROR_CODES.cancelled);
  assert.equal(job.cancellable, false);

  const stored = sourceById(service, 'model:dragon-cancelled.nwd');
  assert.ok(stored !== undefined, 'the source stays registered');
  assert.equal(stored.status, 'cancelled');
  assert.equal(stored.derivedCacheSha256, null, 'with no cache associated');
  assert.match(stored.note, /Add the file again/, 'and a line saying how to run it again');

  assert.deepEqual(
    readdirSync(cacheDir).filter((name) => name.endsWith('.sqlite')),
    [],
    'no cache was committed',
  );
  assert.deepEqual(
    readdirSync(cacheDir).filter((name) => name.includes('.partial') || name.endsWith('.tmp')),
    [],
    'and nothing partial or temporary was left behind',
  );

  // Re-adding is how a cancelled extraction is run again.
  const readdedPath = writeModel('Dragon-Cancelled.nwd', { walkTicks: 1 });
  await service.addSources([readdedPath]);
  await service.extractionIdle();
  assert.equal(sourceById(service, 'model:dragon-cancelled.nwd').status, 'ready');
  assert.equal(service.modelUniverse().sourceCount, 1);
});

test('a launcher that ignores the cancel line is signalled, then killed', async (t) => {
  const cacheDir = newCacheDir('stubborn');
  const modelPath = writeModel('Dragon-Stubborn.nwd', {
    walkTicks: 400,
    tickMs: 25,
    ignoreCancel: true,
    ignoreSigterm: true,
  });

  const settled = [];
  const extraction = createExtractionService({
    cacheDirectory: cacheDir,
    launcher: fakeLauncher({ killGraceMs: 200 }),
    onChanged: () => {},
    onSettled: (job) => settled.push(job),
    cancelGraceMs: 150,
  });
  t.after(() => {
    extraction.shutdown();
  });

  extraction.enqueue({
    sourceId: 'model:stubborn',
    fileName: 'Dragon-Stubborn.nwd',
    inputPath: modelPath,
    rawSha256: null,
  });

  await waitFor(
    () => extraction.job('model:stubborn')?.status === 'extracting',
    'the stubborn launcher to start walking',
  );
  assert.equal(extraction.cancel('model:stubborn'), true);
  await extraction.whenIdle();

  assert.equal(settled.length, 1);
  assert.equal(settled[0].status, 'cancelled');
  assert.deepEqual(
    readdirSync(cacheDir).filter((name) => name.includes('.partial')),
    [],
    'the service cleaned up what the killed launcher never got to',
  );
});

test('the job hashes the file itself when nobody supplied a hash', async (t) => {
  const cacheDir = newCacheDir('selfhash');
  const modelPath = writeModel('Dragon-Selfhash.nwd');
  const seen = [];
  const extraction = createExtractionService({
    cacheDirectory: cacheDir,
    launcher: fakeLauncher(),
    onChanged: (job) => seen.push(job.status),
    onSettled: () => {},
  });
  t.after(() => {
    extraction.shutdown();
  });

  extraction.enqueue({
    sourceId: 'model:selfhash',
    fileName: 'Dragon-Selfhash.nwd',
    inputPath: modelPath,
    rawSha256: null,
  });
  await extraction.whenIdle();

  assert.ok(seen.includes('hashing'), `the row reported hashing (saw ${seen.join(', ')})`);
  assert.equal(extraction.job('model:selfhash').status, 'ready');

  const expected = createHash('sha256').update(readFileSync(modelPath)).digest('hex');
  assert.deepEqual(
    readdirSync(cacheDir).filter((name) => name.endsWith('.sqlite')),
    [`${expected}.sqlite`],
    'and the cache is named by the content hash it computed',
  );
});

/* ------------------------------------------------------- 4. the error vocabulary */

test('every failure code has a plain-language sentence that names an action', () => {
  const codes = failureCodesWithCopy();
  const expected = [
    ...Object.values(LAUNCHER_ERROR_CODES),
    ...Object.values(SERVICE_ERROR_CODES),
  ];
  assert.deepEqual(
    [...codes].sort(),
    [...expected].sort(),
    'the copy table covers every code either side of the boundary can raise, and no others',
  );

  const sentences = new Set();
  for (const code of codes) {
    const line = describeExtractionFailure(code, '');
    assert.ok(line.length > 40, `${code} has no real sentence`);
    assert.doesNotMatch(line, /[A-Z]{3,}_[A-Z]/, `${code} leaks a machine code into the UI`);
    assert.match(
      line,
      /\b(Add|add|Check|check|Close|Extract|Open|open|Reinstall|Report|report|Republish)\b/,
      `${code} does not tell the user what they can do`,
    );
    assert.equal(sentences.has(line), false, `${code} shares its sentence with another code`);
    sentences.add(line);
  }
});

test('a launcher failure reaches the row as its own sentence, with the detail after it', async (t) => {
  const cases = [
    [LAUNCHER_ERROR_CODES.navisworksNotInstalled, /licensed Navisworks Manage or Simulate/],
    [LAUNCHER_ERROR_CODES.navisworksVersionTooNew, /newer Navisworks than the one installed/],
    [LAUNCHER_ERROR_CODES.openFailed, /Close it everywhere else/],
    [LAUNCHER_ERROR_CODES.extractFailed, /model walk did not finish/],
    [LAUNCHER_ERROR_CODES.cacheWriteFailed, /failed its integrity check/],
    // The three the launcher gained when it learned to notice a Navisworks that
    // had stopped moving and an add-in that was never deployed.
    [LAUNCHER_ERROR_CODES.navisworksStalled, /window nobody can see/],
    [LAUNCHER_ERROR_CODES.pluginNotDeployed, /add-in is not installed/],
    [LAUNCHER_ERROR_CODES.pluginNotFound, /without ever handing Matchline the model/],
  ];

  for (const [code, expected] of cases) {
    const cacheDir = newCacheDir(`fail-${code}`);
    const modelPath = writeModel(`Dragon-${code}.nwd`, {
      mode: 'error',
      code,
      message: 'the launcher said so',
    });
    const service = newService(cacheDir);
    try {
      service.create(projectFile(`Fail-${code}`), 'Fail');
      await service.addSources([modelPath]);
      await service.extractionIdle();

      const [job] = service.extractionStatus(0, 10).rows;
      assert.equal(job.status, 'failed', `${code} settles as failed`);
      assert.equal(job.errorCode, code);
      assert.match(job.note, expected, `${code} produced its own sentence`);
      assert.match(job.note, /the launcher said so/, `${code} keeps the launcher's own detail`);

      const stored = service.listSources()[0];
      assert.equal(stored.status, 'failed', 'and the source row says so too');
      assert.equal(stored.derivedCacheSha256, null, 'with nothing associated');
      assert.equal(service.modelUniverse(), null, 'and nothing in the universe');
    } finally {
      service.close();
    }
  }
  t.diagnostic(`${cases.length} launcher error codes checked end to end`);
});

test('a cache that does not match the model it came from is refused', async (t) => {
  const cacheDir = newCacheDir('mismatch');
  const modelPath = writeModel('Dragon-Mismatch.nwd', { mode: 'mismatch' });
  const service = newService(cacheDir);
  t.after(() => {
    service.close();
  });

  service.create(projectFile('Mismatch'), 'Mismatch');
  await service.addSources([modelPath]);
  await service.extractionIdle();

  const [job] = service.extractionStatus(0, 10).rows;
  assert.equal(job.status, 'failed');
  assert.equal(job.errorCode, SERVICE_ERROR_CODES.cacheMismatch);
  assert.match(job.note, /came from different bytes/);
  assert.equal(sourceById(service, 'model:dragon-mismatch.nwd').derivedCacheSha256, null);
});

test('an extraction that finds no objects is a failure with its own explanation', async (t) => {
  const cacheDir = newCacheDir('empty');
  const modelPath = writeModel('Dragon-Empty.nwd', { mode: 'empty' });
  const service = newService(cacheDir);
  t.after(() => {
    service.close();
  });

  service.create(projectFile('Empty'), 'Empty');
  await service.addSources([modelPath]);
  await service.extractionIdle();

  const [job] = service.extractionStatus(0, 10).rows;
  assert.equal(job.status, 'failed');
  assert.equal(job.errorCode, SERVICE_ERROR_CODES.cacheEmpty);
  assert.match(job.note, /without finding a single object/);
});

test('a launcher that dies without a word is judged by its exit code', async (t) => {
  const cacheDir = newCacheDir('silent');
  const modelPath = writeModel('Dragon-Silent.nwd', { mode: 'silent' });
  const service = newService(cacheDir);
  t.after(() => {
    service.close();
  });

  service.create(projectFile('Silent'), 'Silent');
  await service.addSources([modelPath]);
  await service.extractionIdle();

  const [job] = service.extractionStatus(0, 10).rows;
  assert.equal(job.status, 'failed');
  assert.equal(job.errorCode, LAUNCHER_ERROR_CODES.internal, 'exit code 1 is INTERNAL');
  assert.match(job.note, /did not expect/);
});

/* -------------------------------------------------------------- 5. the queue */

test('three models extract one at a time, in the order they were added', async (t) => {
  const cacheDir = newCacheDir('queue');
  const models = ['Queue-A.nwd', 'Queue-B.nwd', 'Queue-C.nwd'].map((name) =>
    writeModel(name, { walkTicks: 4, tickMs: 20 }),
  );
  const service = newService(cacheDir);
  t.after(() => {
    service.close();
  });

  service.create(projectFile('Queue'), 'Queue');
  await service.addSources(models);

  // While the first runs, the others must say they are waiting — not "opening".
  await waitFor(() => {
    const rows = service.extractionStatus(0, 10).rows;
    return rows.length === 3 && rows[0].status !== 'queued';
  }, 'the first job to start');
  const midRun = service.extractionStatus(0, 10).rows;
  assert.equal(
    midRun.filter((job) => job.status !== 'queued' && job.cancellable).length,
    1,
    'exactly one job is past the queue at a time',
  );
  assert.match(midRun[2].note, /waiting its turn/);

  await service.extractionIdle();

  assert.deepEqual(
    launchLog(cacheDir),
    [
      'start Queue-A.nwd',
      'end Queue-A.nwd',
      'start Queue-B.nwd',
      'end Queue-B.nwd',
      'start Queue-C.nwd',
      'end Queue-C.nwd',
    ],
    'the runs never overlap, and they keep the order they were added in',
  );

  assert.equal(service.extractionStatus(0, 10).active, false);
  assert.deepEqual(
    service.extractionStatus(0, 10).rows.map((job) => job.status),
    ['ready', 'ready', 'ready'],
  );
  assert.equal(service.modelUniverse().sourceCount, 3, 'all three joined the universe');

  const page = service.extractionStatus(1, 1);
  assert.equal(page.total, 3, 'the status channel pages');
  assert.equal(page.rows.length, 1);
  assert.equal(page.rows[0].fileName, 'Queue-B.nwd');
});

/* ------------------------------------------------------- 6. the streaming hash */

test('hashing a large model streams it instead of reading it into memory', async () => {
  const bigPath = join(workDir, 'Big.nwd');
  const chunk = Buffer.alloc(1024 * 1024, 7);
  writeFileSync(bigPath, '');
  for (let written = 0; written < 120; written += 1) {
    appendFileSync(bigPath, chunk);
  }
  const totalBytes = 120 * 1024 * 1024;

  const events = [];
  /**
   * The peak, not the difference between the ends.
   *
   * A whole-file read frees its buffer as soon as the digest is taken, so
   * before-and-after would look identical whichever way the file was read. What
   * separates the two is how much was held AT ONCE, and the progress callback
   * is the hook that can see it: it fires several times during the hash, with
   * `arrayBuffers` — the counter Node keeps for exactly this memory — live.
   */
  const baseline = process.memoryUsage().arrayBuffers;
  let peakHeldBytes = 0;
  const sample = () => {
    peakHeldBytes = Math.max(peakHeldBytes, process.memoryUsage().arrayBuffers - baseline);
  };

  // The event loop, watched from a timer: a synchronous read would starve it
  // completely, and "the main process is never blocked by hashing" is the
  // promise this is here to keep (RELEASE-1.0-PLAN, performance).
  let loopTurns = 0;
  const heartbeat = setInterval(() => {
    loopTurns += 1;
  }, 1);

  const digest = await digestFile(bigPath, (done, total) => {
    events.push({ done, total });
    sample();
  });
  sample();
  clearInterval(heartbeat);

  assert.equal(digest.byteSize, totalBytes);
  assert.equal(digest.sha256.length, 64);
  assert.equal(
    digest.sha256,
    createHash('sha256').update(readFileSync(bigPath)).digest('hex'),
    'and it is the same digest a whole-file read would have produced',
  );

  assert.ok(loopTurns >= 5, `the event loop kept turning while hashing (${loopTurns} turns)`);

  // Intermediate progress is only expressible by an implementation that
  // consumes the file in pieces: a whole-file read has nothing to report until
  // it is already finished.
  assert.ok(events.length >= 4, `progress was reported while hashing (${events.length} events)`);
  assert.equal(events[0].done, 0);
  assert.equal(events.at(-1).done, totalBytes);
  assert.ok(
    events.slice(1, -1).every((event) => event.done > 0 && event.done < totalBytes),
    'and it reported part-way through, not only at the ends',
  );
  assert.ok(
    events.every((event) => event.total === totalBytes),
    'every event knows the whole size',
  );

  // Generously bounded — the claim is "nowhere near the whole file at once",
  // not that the allocator is predictable. What is actually held is one chunk;
  // the headroom is for chunks V8 has not got round to collecting yet.
  assert.ok(
    peakHeldBytes < 80 * 1024 * 1024,
    `hashing 120 MB held ${(peakHeldBytes / (1024 * 1024)).toFixed(1)} MB of buffers at once`,
  );

  rmSync(bigPath, { force: true });
});

/* --------------------------------------------------------- 7. a changed model */

test('a model whose bytes changed re-extracts under the same source id', async (t) => {
  const cacheDir = newCacheDir('changed');
  const modelPath = join(workDir, 'Dragon-Revised.nwd');
  writeFileSync(modelPath, 'MATCHLINE-FAKE {}\nrevision A\n');

  const service = newService(cacheDir);
  t.after(() => {
    service.close();
  });
  service.create(projectFile('Changed'), 'Changed');
  await service.addSources([modelPath, melPath]);
  await service.extractionIdle();
  teachDragon(service);

  const first = sourceById(service, 'model:dragon-revised.nwd');
  assert.equal(first.status, 'ready');
  assert.equal((await service.compile()).state, 'done');

  // The model is reissued: same path, same name, different bytes.
  writeFileSync(modelPath, 'MATCHLINE-FAKE {}\nrevision B, with more equipment\n');
  const [readded] = await service.addSources([modelPath]);
  assert.equal(readded.outcome, 'added');
  assert.equal(readded.source.sourceId, first.sourceId, 'the same source, not a second one');
  assert.equal(readded.source.status, 'queued', 'and it is queued for extraction again');
  assert.equal(readded.source.derivedCacheSha256, null, 'the old cache is no longer associated');

  await service.extractionIdle();
  const second = sourceById(service, 'model:dragon-revised.nwd');
  assert.equal(second.status, 'ready');
  assert.notEqual(second.rawSha256, first.rawSha256, 'it is the new bytes that were extracted');
  assert.notEqual(second.derivedCacheSha256, first.derivedCacheSha256, 'and a new cache');
  assert.equal(
    launchLog(cacheDir).filter((line) => line.startsWith('start')).length,
    2,
    'the launcher ran once per revision',
  );
  assert.equal((await service.compile()).state, 'done', 'and the project compiles on the new one');
});

test('a reopened project picks its extraction back up where it left off', async (t) => {
  const cacheDir = newCacheDir('reopen');
  const modelPath = writeModel('Dragon-Reopened.nwd');
  const projectPath = projectFile('Reopen');

  const first = newService(cacheDir);
  first.create(projectPath, 'Reopen');
  await first.addSources([modelPath]);
  await first.extractionIdle();
  assert.equal(first.modelUniverse().sourceCount, 1);
  first.close();

  const second = newService(cacheDir);
  t.after(() => {
    second.close();
  });
  const opened = await second.open(projectPath, false);
  assert.equal(opened.outcome, 'opened');
  await second.extractionIdle();

  assert.equal(
    sourceById(second, 'model:dragon-reopened.nwd').status,
    'ready',
    'the cache it produced is still its cache',
  );
  assert.equal(second.modelUniverse().objectCount, DRAGON_OBJECT_COUNT);
  assert.equal(
    launchLog(cacheDir).filter((line) => line.startsWith('start')).length,
    1,
    'and reopening did not run the extractor again',
  );
});

/* --------------------------------------------------- 8. a machine that cannot */

test('a machine that cannot run Navisworks says so, in the row', async (t) => {
  const cacheDir = newCacheDir('platform');
  const modelPath = writeModel('Dragon-Mac.nwd');
  const service = newService(
    cacheDir,
    resolveExtractorLauncher({ platform: 'darwin', executablePath: '/nowhere/Matchline.Extractor.exe' }),
  );
  t.after(() => {
    service.close();
  });

  service.create(projectFile('Platform'), 'Platform');
  await service.addSources([modelPath]);
  await service.extractionIdle();

  const [job] = service.extractionStatus(0, 10).rows;
  assert.equal(job.status, 'failed');
  assert.equal(job.errorCode, SERVICE_ERROR_CODES.unavailableOnThisPlatform);
  assert.match(job.note, /extracts Navisworks models on Windows/);
  assert.match(job.note, /add the .matchline-cache it produces here/);
  assert.match(job.note, /darwin/, "and names the platform it is actually on");

  const stored = sourceById(service, 'model:dragon-mac.nwd');
  assert.equal(stored.status, 'failed', 'the source stays registered and honest about its state');
  assert.equal(service.modelUniverse(), null);
  assert.deepEqual(readdirSync(cacheDir), [], 'nothing was written anywhere');
});

test('a Windows install missing the extractor is a different sentence', () => {
  const launcher = resolveExtractorLauncher({
    platform: 'win32',
    executablePath: join(workDir, 'no-such-extractor.exe'),
  });
  const messages = [];
  launcher(['--input', 'x'], {
    onMessage: (message) => messages.push(message),
    onExit: () => {},
  });
  return new Promise((resolve) => {
    setImmediate(() => {
      assert.equal(messages.length, 1);
      assert.equal(messages[0].code, SERVICE_ERROR_CODES.extractorNotInstalled);
      resolve();
    });
  });
});

/* ------------------------------------------------- the supplied input hash */

/**
 * `--input-sha256`, both ways (docs/EXTRACTION.md, "The command line").
 *
 * The service streams a model's sha256 when the file is registered, and until
 * this flag existed the launcher then read the whole model again to work the
 * same number out for itself — a second full pass over a multi-gigabyte file
 * for an answer main already had (RELEASE-1.0-PLAN, "Performance / isolation").
 *
 * Both paths are exercised against the same fake launcher, which mirrors
 * `ExtractionRunner.Run` and `ExtractorArguments.TryParse` line for line: with
 * the flag it reports the hash stage complete and trusts the value, without it
 * it hashes the file itself, and a malformed value is a wrong command line
 * rather than a cache filed under something unusable.
 */
function runLauncherOnce(args) {
  const messages = [];
  return new Promise((resolve) => {
    fakeLauncher()(args, {
      onMessage: (message) => messages.push(message),
      onExit: (exit) => resolve({ messages, exit }),
    });
  });
}

test('the service hands the launcher the hash it already streamed', async () => {
  assert.deepEqual(extractorArguments('/models/A.nwd', '/caches', 'a'.repeat(64)), [
    '--input',
    '/models/A.nwd',
    '--cache-dir',
    '/caches',
    '--input-sha256',
    'a'.repeat(64),
    '--stall-timeout-seconds',
    String(DEFAULT_STALL_TIMEOUT_SECONDS),
  ]);
  assert.equal(
    DEFAULT_STALL_TIMEOUT_SECONDS,
    900,
    'and it is the same fifteen minutes ExtractorArguments.DefaultStallTimeoutSeconds uses, so ' +
      'a hand run from a shell behaves the way the app does',
  );
});

test('a supplied hash skips the hash stage and addresses the cache', async () => {
  const cacheDir = newCacheDir('supplied-hash');
  const modelPath = writeModel('Dragon-Supplied.nwd');
  // Deliberately not this file's real hash: only a launcher that TRUSTS the
  // value rather than checking it can produce a cache named after it, which is
  // exactly the promise the flag makes and the reason it is documented as an
  // assertion.
  const claimed = 'b'.repeat(64);

  const { messages, exit } = await runLauncherOnce(
    extractorArguments(modelPath, cacheDir, claimed),
  );
  assert.equal(exit.code, 0, exit.diagnostics);

  const hashLines = messages.filter(
    (message) => message.type === 'progress' && message.stage === 'hash',
  );
  assert.equal(hashLines.length, 1, 'the stage is announced once, already complete');
  assert.equal(hashLines[0].done, hashLines[0].total);
  assert.ok(hashLines[0].total > 0, 'and it still reports the real file size');

  const result = messages.find((message) => message.type === 'result');
  assert.equal(result.status, 'ok');
  assert.equal(
    result.cachePath,
    join(cacheDir, `${claimed}.sqlite`),
    'the supplied hash is what the cache is filed under',
  );
});

test('no supplied hash means the launcher hashes the file itself', async () => {
  const cacheDir = newCacheDir('own-hash');
  const modelPath = writeModel('Dragon-Own.nwd');
  const real = (await digestFile(modelPath)).sha256;

  const { messages, exit } = await runLauncherOnce([
    '--input',
    modelPath,
    '--cache-dir',
    cacheDir,
  ]);
  assert.equal(exit.code, 0, exit.diagnostics);

  const hashLines = messages.filter(
    (message) => message.type === 'progress' && message.stage === 'hash',
  );
  assert.equal(hashLines.length, 2, 'the stage opens at zero and closes at the end');
  assert.equal(hashLines[0].done, 0);

  const result = messages.find((message) => message.type === 'result');
  assert.equal(result.cachePath, join(cacheDir, `${real}.sqlite`));
});

test('a malformed --input-sha256 is refused rather than reinterpreted', async () => {
  const cacheDir = newCacheDir('bad-hash');
  const modelPath = writeModel('Dragon-BadHash.nwd');

  for (const bad of ['', 'abc', 'z'.repeat(64), `0x${'a'.repeat(62)}`, 'a'.repeat(65)]) {
    const { messages, exit } = await runLauncherOnce([
      '--input',
      modelPath,
      '--cache-dir',
      cacheDir,
      '--input-sha256',
      bad,
    ]);
    const error = messages.find((message) => message.type === 'error');
    assert.equal(error?.code, LAUNCHER_ERROR_CODES.invalidArguments, `"${bad}" is refused`);
    assert.equal(exit.code, 2, 'with the INVALID_ARGS exit code');
  }
  assert.deepEqual(
    readdirSync(cacheDir).filter((name) => name.endsWith('.sqlite')),
    [],
    'and no cache was written under a name nobody could find again',
  );
});

test('an upper-case hash is folded rather than rejected', async () => {
  const cacheDir = newCacheDir('upper-hash');
  const modelPath = writeModel('Dragon-Upper.nwd');
  const claimed = 'C'.repeat(64);

  const { messages, exit } = await runLauncherOnce(
    extractorArguments(modelPath, cacheDir, claimed),
  );
  assert.equal(exit.code, 0, exit.diagnostics);
  const result = messages.find((message) => message.type === 'result');
  assert.equal(result.cachePath, join(cacheDir, `${'c'.repeat(64)}.sqlite`));
});

/* ------------------------------------------------------------ the sets stage */

/**
 * Saved-set resolution is a stage of its own, and the row says so.
 *
 * `ExtractionStages.Sets` (native/navisworks-common/Protocol/
 * ExtractionProtocol.cs) exists because resolving one saved search runs that
 * search over the whole model: a set-heavy document sits there for minutes, and
 * a build that dropped the stage — which this one did, by not listing it —
 * showed the user a counter that had stopped moving. It is asserted here in
 * three places at once, because a stage that only one side knows about is the
 * bug: the launcher emits it, the protocol lists it in the launcher's own
 * order, and the service turns it into a row a person can read.
 *
 * It sits BEFORE the walk, and that is load-bearing rather than cosmetic: the
 * adapter resolves every set first so the walk can write each item's membership
 * as it reaches it, instead of pinning a handle to every object in the model
 * until the last set is done.
 */
test('the saved-set stage is emitted, listed, and turned into a line in the row', async (t) => {
  assert.deepEqual(
    [...EXTRACTION_STAGES],
    ['hash', 'detect', 'open', 'sets', 'walk', 'convert', 'finalize'],
    'the stage list is the launcher order, sets between the open and the walk',
  );

  const cacheDir = newCacheDir('sets');
  const modelPath = writeModel('Dragon-Sets.nwd', { walkTicks: 1 });

  const changes = [];
  const extraction = createExtractionService({
    cacheDirectory: cacheDir,
    launcher: fakeLauncher(),
    onChanged: (job) => changes.push({ status: job.status, detail: job.detail, progress: job.progress }),
    onSettled: () => {},
  });
  t.after(() => {
    extraction.shutdown();
  });

  extraction.enqueue({
    sourceId: 'model:sets',
    fileName: 'Dragon-Sets.nwd',
    inputPath: modelPath,
    rawSha256: null,
  });
  await extraction.whenIdle();
  assert.equal(extraction.job('model:sets').status, 'ready');

  // Every announcement, in order, so "between the open and the walk" is
  // checked against what actually reached the row rather than against the fake.
  const walkAt = changes.findIndex((change) => change.detail.includes('records read from the model'));
  const setsAt = changes.findIndex((change) => change.detail.includes('saved selection and search sets'));
  const convertAt = changes.findIndex((change) => change.detail.includes('records written to the cache'));
  assert.ok(setsAt >= 0, 'the sets stage reported');
  assert.ok(walkAt > setsAt, `the walk reached the row after the sets (saw ${walkAt})`);
  assert.ok(convertAt > walkAt, 'and the convert after the walk');

  const setLines = changes.filter((change) => change.detail.includes('saved selection and search sets'));
  for (const line of setLines) {
    assert.equal(line.status, 'extracting', 'resolving sets is still reading the model');
    assert.doesNotMatch(line.detail, /[A-Z]{3,}_[A-Z]/, 'and never leaks the stage name');
  }
  // The one stage besides the hash that knows its denominator: it counts the
  // set tree before resolving any of it, so it can honestly draw a bar.
  assert.deepEqual(
    setLines.map((line) => line.progress),
    [0, 0.5, 1],
    'reported as a real fraction of a real total, not as "unknown"',
  );
  assert.match(setLines.at(-1).detail, /2 of 2/);
});

/* ---------------------------------------------------------------- NWF inputs */

/**
 * An NWF holds a list of references, not a model.
 *
 * Two consequences, and this is where both are checked from the outside: its
 * bytes are not evidence about the models behind them, so a cache filed under
 * its hash is never served without opening it again; and a document that opened
 * without one of those models produces an extraction that is missing whole
 * packages of equipment while looking, from every other angle, like a success.
 */
test('an unchanged NWF is opened again rather than served from its cache', async (t) => {
  const cacheDir = newCacheDir('nwf-reopen');
  const modelPath = writeModel('Dragon-Coordination.nwf', { walkTicks: 1 });

  const extraction = createExtractionService({
    cacheDirectory: cacheDir,
    launcher: fakeLauncher(),
    onChanged: () => {},
    onSettled: () => {},
  });
  t.after(() => {
    extraction.shutdown();
  });

  const runOnce = async (sourceId) => {
    extraction.enqueue({
      sourceId,
      fileName: 'Dragon-Coordination.nwf',
      inputPath: modelPath,
      rawSha256: null,
    });
    await extraction.whenIdle();
    return extraction.job(sourceId);
  };

  const first = await runOnce('model:nwf-a');
  assert.equal(first.status, 'ready');

  // The same bytes a second time. An NWD would come back as a cache hit here —
  // that is the promise "the same model twice never starts Navisworks again" —
  // and an NWF must not, because identical bytes say nothing about whether the
  // files they point at have moved since.
  const second = await runOnce('model:nwf-b');
  assert.equal(
    second.status,
    'ready',
    'an NWF was served from cache (`cache-hit`) without anyone checking its references',
  );

  // The launch log is the proof it really ran twice rather than being answered
  // from this process.
  const log = readFileSync(join(cacheDir, 'fake-extractor.log'), 'utf8');
  assert.equal(
    log.split('\n').filter((line) => line.startsWith('start ')).length,
    2,
  );
});

test('an NWF that opened without one of its models is refused, not half-kept', async (t) => {
  const cacheDir = newCacheDir('nwf-missing');
  const modelPath = writeModel('Dragon-Broken.nwf', {
    mode: 'missing-reference',
    missingFileName: 'Dragon-Electrical.nwc',
  });

  const extraction = createExtractionService({
    cacheDirectory: cacheDir,
    launcher: fakeLauncher(),
    onChanged: () => {},
    onSettled: () => {},
  });
  t.after(() => {
    extraction.shutdown();
  });

  extraction.enqueue({
    sourceId: 'model:nwf-missing',
    fileName: 'Dragon-Broken.nwf',
    inputPath: modelPath,
    rawSha256: null,
  });
  await extraction.whenIdle();

  const job = extraction.job('model:nwf-missing');
  assert.equal(job.status, 'failed');
  assert.equal(job.errorCode, LAUNCHER_ERROR_CODES.sourceModelMissing);

  // Nothing is left behind that a later run could mistake for an answer: not a
  // cache, not a partial. A cache describing part of a site as if it were all
  // of it is worse than no cache.
  assert.deepEqual(
    readdirSync(cacheDir).filter((name) => name.endsWith('.sqlite') || name.endsWith('.partial')),
    [],
  );

  // And the row says which file was missing and what to do about it, in words:
  // the plain sentence leads, the launcher's own detail names the file.
  assert.match(job.note, /could not find every model it points at/);
  assert.match(job.note, /Dragon-Electrical\.nwc/);
  assert.doesNotMatch(job.note.split('The extractor reported:')[0], /[A-Z]{3,}_[A-Z]/);
});

/* ------------------------------------------------------------- removal, close */

test('removing a source stops the extraction it started', async (t) => {
  const cacheDir = newCacheDir('removed');
  const modelPath = writeModel('Dragon-Removed.nwd', { walkTicks: 200, tickMs: 25 });
  const service = newService(cacheDir);
  t.after(() => {
    service.close();
  });

  service.create(projectFile('Removed'), 'Removed');
  await service.addSources([modelPath]);
  await waitFor(
    () => service.extractionStatus(0, 10).rows[0]?.status === 'extracting',
    'the extraction to start',
  );

  assert.equal(service.removeSource('model:dragon-removed.nwd'), true);
  await service.extractionIdle();

  assert.equal(service.listSources().length, 0);
  assert.equal(service.extractionStatus(0, 10).total, 0, 'the job went with the source');
  assert.deepEqual(
    readdirSync(cacheDir).filter((name) => name.endsWith('.sqlite')),
    [],
    'and the half-finished extraction committed nothing',
  );
});

/* ------------------------------------------------- hardening: the launcher watch */

/**
 * What a run that has stopped moving looks like from the outside.
 *
 * The launcher reports a stage the moment it reaches one, so silence is
 * information: a model walk emits a line a second, and a run that says nothing
 * for ten minutes is not slow, it is stuck — nearly always behind a modal
 * dialog on a desktop nobody can see (the audit's B6). The service cannot
 * dismiss that dialog and does not pretend to; what it owes the user is to say
 * what it looks like, keep the run cancellable, and leave the decision to them.
 */
test('a run that goes quiet says so in the row, and is still the user\'s to cancel', async (t) => {
  const cacheDir = newCacheDir('watchdog');
  const modelPath = writeModel('Dragon-Quiet.nwd', { mode: 'hang' });
  const extraction = createExtractionService({
    cacheDirectory: cacheDir,
    launcher: fakeLauncher(),
    onChanged: () => {},
    onSettled: () => {},
    // A tenth of the real ten minutes and then some: the promise under test is
    // "silence is noticed and named", not the size of the number.
    stallWarningMs: 1_200,
    watchdogIntervalMs: 40,
    cancelGraceMs: 200,
  });
  t.after(() => {
    extraction.shutdown();
  });

  extraction.enqueue({
    sourceId: 'model:quiet',
    fileName: 'Dragon-Quiet.nwd',
    inputPath: modelPath,
    rawSha256: null,
  });

  await waitFor(
    () => extraction.job('model:quiet')?.detail.includes('No progress for') === true,
    'the watchdog to notice the silence',
  );

  const stalled = extraction.job('model:quiet');
  assert.match(stalled.detail, /Navisworks may be waiting on a dialog/);
  assert.match(stalled.detail, /Cancel to stop/, 'and it names the one thing the user can do');
  assert.equal(stalled.status, 'opening', 'the run is still running, not failed');
  assert.equal(stalled.cancellable, true, 'and the Cancel button it points at is still there');
  assert.equal(stalled.errorCode, null, 'nothing has gone wrong yet — it only looks stuck');

  // And cancelling is what actually ends it: the watchdog never does.
  assert.equal(extraction.cancel('model:quiet'), true);
  await extraction.whenIdle();
  assert.equal(extraction.job('model:quiet').status, 'cancelled');
});

/**
 * Quitting asks before it signals.
 *
 * `shutdown()` used to write `cancel` and kill in the same tick, which on
 * Windows is `TerminateProcess` — the launcher died before its stdin listener
 * had read the line, so the headless Navisworks it started kept its licence,
 * its memory and its handle on a stream file Matchline had already deleted.
 * The order is the whole fix, so the order is what is asserted.
 */
test('closing the app asks the launcher to stop before it signals it', async (t) => {
  const cacheDir = newCacheDir('shutdown');
  const modelPath = writeModel('Dragon-Quit.nwd', {
    walkTicks: 400,
    tickMs: 25,
    // Ignores the polite request, so the signal is guaranteed to be needed and
    // the two log lines are guaranteed to both exist.
    ignoreCancel: true,
  });
  const extraction = createExtractionService({
    cacheDirectory: cacheDir,
    launcher: fakeLauncher({ killGraceMs: 400 }),
    onChanged: () => {},
    onSettled: () => {},
    shutdownGraceMs: 150,
  });
  t.after(() => {
    extraction.shutdown();
  });

  extraction.enqueue({
    sourceId: 'model:quit',
    fileName: 'Dragon-Quit.nwd',
    inputPath: modelPath,
    rawSha256: null,
  });
  await waitFor(
    () => extraction.job('model:quit')?.status === 'extracting',
    'the run to be well underway',
  );

  extraction.shutdown();
  await waitFor(
    () => launchLog(cacheDir).some((line) => line.startsWith('sigterm ')),
    'the signal that follows the polite request',
  );

  const log = launchLog(cacheDir);
  const askedAt = log.findIndex((line) => line.startsWith('cancel '));
  const signalledAt = log.findIndex((line) => line.startsWith('sigterm '));
  assert.ok(askedAt >= 0, `the cancel line was delivered (saw ${log.join(' / ')})`);
  assert.ok(signalledAt > askedAt, 'and the signal came after it, not in the same breath');

  await extraction.whenIdle();
  assert.equal(extraction.job('model:quit').status, 'cancelled');
});

/* --------------------------------------------- hardening: proving the file again */

/**
 * The queue is serial, so "hashed" and "read" are two different moments.
 *
 * A model can wait an hour behind another. If it is re-issued in place while it
 * waits, extracting it anyway would stamp the new bytes with the old hash: the
 * cache would validate, the project would record it, and every number behind
 * the compile would belong to a file nobody approved.
 */
test('a model that changed while it waited its turn is refused rather than extracted', async (t) => {
  const cacheDir = newCacheDir('changed-in-queue');
  const slowPath = writeModel('Queue-Slow.nwd', { walkTicks: 60, tickMs: 25 });
  const reissuedPath = join(workDir, 'Queue-Reissued.nwd');
  writeFileSync(reissuedPath, 'MATCHLINE-FAKE {}\nrevision A\n');

  const extraction = createExtractionService({
    cacheDirectory: cacheDir,
    launcher: fakeLauncher(),
    onChanged: () => {},
    onSettled: () => {},
  });
  t.after(() => {
    extraction.shutdown();
  });

  extraction.enqueue({
    sourceId: 'model:slow',
    fileName: 'Queue-Slow.nwd',
    inputPath: slowPath,
    rawSha256: null,
  });
  extraction.enqueue({
    sourceId: 'model:reissued',
    fileName: 'Queue-Reissued.nwd',
    inputPath: reissuedPath,
    rawSha256: null,
  });

  await waitFor(
    () => extraction.job('model:slow')?.status === 'extracting',
    'the first model to occupy the queue',
  );
  // Re-issued in place, exactly as a consultant re-exporting over the same
  // path would do it.
  writeFileSync(reissuedPath, 'MATCHLINE-FAKE {}\nrevision B, and rather longer than A\n');

  await extraction.whenIdle();

  const job = extraction.job('model:reissued');
  assert.equal(job.status, 'failed');
  assert.equal(job.errorCode, SERVICE_ERROR_CODES.fileChangedBeforeLaunch);
  assert.match(job.note, /changed on disk while it was waiting/);
  assert.match(job.note, /Add it again/, 'and says what to do about it');
  assert.deepEqual(
    launchLog(cacheDir).filter((line) => line.includes('Queue-Reissued')),
    [],
    'Navisworks was never started for the file that moved',
  );
  assert.equal(extraction.job('model:slow').status, 'ready', 'and the run in front finished');
});

/* ----------------------------------------- hardening: a cache that failed its checks */

/**
 * "Add the file again to extract it fresh" has to be true.
 *
 * A cache that fails validation used to be left exactly where the next run
 * would look for it, and the launcher's own inspector — which checks a cache's
 * integrity but has no way to know which model this project thinks it belongs
 * to — handed it straight back. The row's advice could therefore never work.
 */
test('a cache that fails validation is moved aside so adding the file again re-extracts', async (t) => {
  const cacheDir = newCacheDir('rejected');
  const modelPath = writeModel('Dragon-Rejected.nwd', { mode: 'mismatch' });
  const extraction = createExtractionService({
    cacheDirectory: cacheDir,
    launcher: fakeLauncher(),
    onChanged: () => {},
    onSettled: () => {},
  });
  t.after(() => {
    extraction.shutdown();
  });

  const request = {
    sourceId: 'model:rejected',
    fileName: 'Dragon-Rejected.nwd',
    inputPath: modelPath,
    rawSha256: null,
  };
  extraction.enqueue(request);
  await extraction.whenIdle();

  const first = extraction.job('model:rejected');
  assert.equal(first.errorCode, SERVICE_ERROR_CODES.cacheMismatch);
  assert.match(first.note, /rejected cache was kept at/, 'the row says where it went');

  const afterFirst = readdirSync(cacheDir);
  assert.deepEqual(
    afterFirst.filter((name) => name.endsWith('.sqlite')),
    [],
    'nothing is left at the name the next run would find',
  );
  assert.ok(
    afterFirst.some((name) => name.includes('.rejected-')),
    `the bad cache was kept for diagnosis (saw ${afterFirst.join(', ')})`,
  );

  // Which is the point: the second add really does run the extractor again
  // rather than being served the cache that was just refused.
  extraction.enqueue(request);
  await extraction.whenIdle();
  assert.equal(
    launchLog(cacheDir).filter((line) => line.startsWith('start')).length,
    2,
    'adding the file again extracted it again',
  );
});

/* ------------------------------------------------ hardening: re-adding the same file */

/**
 * Re-adding a model nobody has changed is a question, not an instruction.
 *
 * "Did that work?" is the commonest reason to drop the same file twice, and
 * killing a run that is twenty minutes into a large model in order to start the
 * identical run again is the one answer that is never what was meant.
 */
test('re-adding the same bytes while they are being read leaves the run alone', async (t) => {
  const cacheDir = newCacheDir('same-bytes');
  const modelPath = writeModel('Dragon-Same.nwd', { walkTicks: 40, tickMs: 25 });
  const sha256 = (await digestFile(modelPath)).sha256;
  const extraction = createExtractionService({
    cacheDirectory: cacheDir,
    launcher: fakeLauncher(),
    onChanged: () => {},
    onSettled: () => {},
  });
  t.after(() => {
    extraction.shutdown();
  });

  const request = {
    sourceId: 'model:same',
    fileName: 'Dragon-Same.nwd',
    inputPath: modelPath,
    rawSha256: sha256,
  };
  extraction.enqueue(request);
  await waitFor(
    () => extraction.job('model:same')?.status === 'extracting',
    'the run to be underway',
  );
  const startedAt = extraction.job('model:same').startedAt;

  extraction.enqueue(request);
  await extraction.whenIdle();

  const job = extraction.job('model:same');
  assert.equal(job.status, 'ready', 'the run that was already going is the one that finished');
  assert.equal(job.startedAt, startedAt, 'and it was never replaced by a second job');
  assert.equal(
    launchLog(cacheDir).filter((line) => line.startsWith('start')).length,
    1,
    'the extractor ran once, not once killed and once again',
  );
});

/* --------------------------------------------------- hardening: the hash stage line */

/**
 * A row must not walk backwards.
 *
 * The launcher announces the hash stage even when it was handed the hash and
 * did not compute one — a single line, already complete, so a parent drawing
 * progress from these lines does not see a stage go missing. Relaying it
 * unchanged made the row read `opening` → `hashing 100%` → `opening` for work
 * that never happened.
 */
test('the launcher\'s hash line is ignored for a job whose hash was supplied', async (t) => {
  const cacheDir = newCacheDir('hash-line');
  const modelPath = writeModel('Dragon-Prehashed.nwd', { walkTicks: 1 });
  const sha256 = (await digestFile(modelPath)).sha256;

  const statuses = [];
  const extraction = createExtractionService({
    cacheDirectory: cacheDir,
    launcher: fakeLauncher(),
    onChanged: (job) => statuses.push(job.status),
    onSettled: () => {},
  });
  t.after(() => {
    extraction.shutdown();
  });

  extraction.enqueue({
    sourceId: 'model:prehashed',
    fileName: 'Dragon-Prehashed.nwd',
    inputPath: modelPath,
    rawSha256: sha256,
  });
  await extraction.whenIdle();

  assert.equal(extraction.job('model:prehashed').status, 'ready');
  assert.equal(
    statuses.includes('hashing'),
    false,
    `the row never claimed to be hashing a file nobody hashed (saw ${statuses.join(', ')})`,
  );
  assert.deepEqual(
    [...new Set(statuses)],
    ['queued', 'opening', 'extracting', 'finalizing', 'ready'],
    'it steps forward through the stages and never back',
  );
});

/* ------------------------------------------- hardening: a cancel at the last moment */

/**
 * A cancel that lands after the cache is written is still a cancel.
 *
 * The race is real: the row spends its last seconds in `finalizing` with a
 * committed cache already on disk, and a Cancel pressed there used to settle
 * `ready` — the app disagreeing with the button that was pressed. What it must
 * do instead is agree, associate nothing, and say honestly that the finished
 * work was kept.
 */
test('a cancel during the integrity check settles cancelled, and keeps what was written', async (t) => {
  const cacheDir = newCacheDir('late-cancel');
  const modelPath = writeModel('Dragon-Late.nwd', {
    walkTicks: 1,
    // The launcher is past the point of no return: the cache is committed and
    // the result line is about to be written, and it is not listening any more.
    lingerMs: 700,
    ignoreCancel: true,
  });

  const settled = [];
  const extraction = createExtractionService({
    cacheDirectory: cacheDir,
    launcher: fakeLauncher(),
    onChanged: () => {},
    onSettled: (job) => settled.push(job),
    cancelGraceMs: 5_000,
  });
  t.after(() => {
    extraction.shutdown();
  });

  extraction.enqueue({
    sourceId: 'model:late',
    fileName: 'Dragon-Late.nwd',
    inputPath: modelPath,
    rawSha256: null,
  });
  await waitFor(
    () => extraction.job('model:late')?.status === 'finalizing',
    'the run to reach the integrity check',
  );
  assert.equal(extraction.cancel('model:late'), true);
  await extraction.whenIdle();

  assert.equal(settled.length, 1);
  assert.equal(settled[0].status, 'cancelled', 'the button that was pressed is what the row says');
  assert.equal(extraction.job('model:late').objectCount, null, 'and nothing was associated');
  assert.match(
    settled[0].note,
    /that work is kept/,
    'the copy no longer claims nothing was written, because something was',
  );
  assert.equal(
    readdirSync(cacheDir).filter((name) => name.endsWith('.sqlite')).length,
    1,
    'the committed cache is kept, so adding the file again costs nothing',
  );
});

/* ------------------------------------------- hardening: partials have an owner */

/**
 * The partial files are named after the CONTENT hash, not after the job, so
 * "clean up after yourself" and "clean up after these bytes" are two different
 * sentences. Sweeping on the second meaning deleted files belonging to a run
 * that was still writing them: a job that failed before it launched anything
 * removed a live partial, and two sources holding the same model removed each
 * other's.
 */

/** A launcher that is a stub, so the test decides exactly what a run does. */
function scriptedLauncher(script) {
  let launched = 0;
  return (args, callbacks) => {
    const index = launched;
    launched += 1;
    setTimeout(() => {
      script(index, callbacks, args);
    }, 5);
    return { requestCancel() {}, kill() {} };
  };
}

test('a job that never launched an extractor leaves the partials where they are', async (t) => {
  const cacheDir = newCacheDir('unowned');
  const modelPath = writeModel('Dragon-Unowned.nwd');
  const sha = createHash('sha256').update(readFileSync(modelPath)).digest('hex');
  const partialPath = join(cacheDir, `${sha}.sqlite.partial`);
  const streamPath = join(cacheDir, `${sha}.ndjson.tmp`);
  writeFileSync(partialPath, 'written by a run this job knows nothing about');
  writeFileSync(streamPath, 'and so is this');

  const extraction = createExtractionService({
    cacheDirectory: cacheDir,
    launcher: () => {
      throw new Error('a cancelled queued job must never launch anything');
    },
    onChanged: () => {},
    onSettled: () => {},
  });
  t.after(() => {
    extraction.shutdown();
  });

  extraction.enqueue({
    sourceId: 'model:unowned',
    fileName: 'Dragon-Unowned.nwd',
    inputPath: modelPath,
    rawSha256: sha,
  });
  // In the same tick, so the job is still queued: `enqueue` defers the pump.
  assert.equal(extraction.cancel('model:unowned'), true);
  await extraction.whenIdle();

  assert.equal(extraction.job('model:unowned').status, 'cancelled');
  assert.ok(existsSync(partialPath), 'the partial cache survived a job that wrote nothing');
  assert.ok(existsSync(streamPath), 'and so did the stream');
});

test('the sweep waits while another job is still working on the same bytes', async (t) => {
  const cacheDir = newCacheDir('shared-bytes');
  const modelPath = writeModel('Dragon-Shared.nwd');
  const sha = createHash('sha256').update(readFileSync(modelPath)).digest('hex');
  const partialPath = join(cacheDir, `${sha}.sqlite.partial`);
  const streamPath = join(cacheDir, `${sha}.ndjson.tmp`);

  const settled = [];
  const extraction = createExtractionService({
    cacheDirectory: cacheDir,
    launcher: scriptedLauncher((index, callbacks) => {
      if (index === 0) {
        // What a run holds while it is working, written by the run itself.
        writeFileSync(partialPath, 'the first run is writing this');
        writeFileSync(streamPath, 'and this');
      }
      callbacks.onMessage({ type: 'error', code: LAUNCHER_ERROR_CODES.openFailed, message: 'no' });
      callbacks.onExit({ code: 3, signal: null, diagnostics: '' });
    }),
    onChanged: () => {},
    onSettled: (job) => {
      settled.push({
        sourceId: job.sourceId,
        partial: existsSync(partialPath),
        stream: existsSync(streamPath),
      });
    },
  });
  t.after(() => {
    extraction.shutdown();
  });

  // Two sources, one model. Enqueued in the same tick so the second is queued
  // while the first runs.
  for (const sourceId of ['model:shared-a', 'model:shared-b']) {
    extraction.enqueue({
      sourceId,
      fileName: 'Dragon-Shared.nwd',
      inputPath: modelPath,
      rawSha256: sha,
    });
  }
  await extraction.whenIdle();

  assert.deepEqual(
    settled.map((entry) => entry.sourceId),
    ['model:shared-a', 'model:shared-b'],
  );
  assert.deepEqual(
    settled[0],
    { sourceId: 'model:shared-a', partial: true, stream: true },
    'the first job left the second job\'s files alone',
  );
  // The last job for these bytes owns them, and a failure keeps the stream as
  // the evidence the launcher would have kept.
  assert.equal(settled[1].partial, false, 'the last job swept the partial cache');
  assert.equal(settled[1].stream, true, 'and kept the stream a failure is diagnosed from');
});

/* --------------------------------------- hardening: cancelling during the hash */

test('aborting a digest stops the read instead of finishing it', async () => {
  const bigPath = join(workDir, 'Abortable.nwd');
  const chunk = Buffer.alloc(1024 * 1024, 3);
  writeFileSync(bigPath, '');
  for (let written = 0; written < 200; written += 1) {
    appendFileSync(bigPath, chunk);
  }
  const totalBytes = 200 * 1024 * 1024;

  const abort = new AbortController();
  let lastDone = 0;
  const failure = await digestFile(
    bigPath,
    (done) => {
      lastDone = done;
      // The first progress event is 0 bytes; the second proves the read began.
      if (done > 0) {
        abort.abort();
      }
    },
    abort.signal,
  ).then(
    () => null,
    (error) => error,
  );

  assert.ok(failure !== null, 'the digest rejected rather than returning a hash');
  assert.equal(failure.name, 'DigestAbortedError');
  assert.ok(
    lastDone < totalBytes,
    `the read stopped part-way (${String(lastDone)} of ${String(totalBytes)} bytes)`,
  );

  // Already aborted before the first byte: no stream is opened at all.
  const immediate = await digestFile(bigPath, undefined, abort.signal).then(
    () => null,
    (error) => error,
  );
  assert.equal(immediate.name, 'DigestAbortedError');

  rmSync(bigPath, { force: true });
});

test('cancelling a job that is hashing settles it without reading the rest', async (t) => {
  const cacheDir = newCacheDir('hash-cancel');
  const bigPath = join(workDir, 'Dragon-Hashing.nwd');
  const chunk = Buffer.alloc(1024 * 1024, 5);
  writeFileSync(bigPath, 'MATCHLINE-FAKE {}\n');
  for (let written = 0; written < 200; written += 1) {
    appendFileSync(bigPath, chunk);
  }

  const extraction = createExtractionService({
    cacheDirectory: cacheDir,
    launcher: () => {
      throw new Error('a job cancelled while hashing must never launch anything');
    },
    onChanged: (job) => {
      // The moment the hash is genuinely under way, not merely announced.
      if (job.status === 'hashing' && job.progress !== null && job.progress > 0) {
        extraction.cancel('model:hashing');
      }
    },
    onSettled: () => {},
  });
  t.after(() => {
    extraction.shutdown();
  });

  extraction.enqueue({
    sourceId: 'model:hashing',
    fileName: 'Dragon-Hashing.nwd',
    inputPath: bigPath,
    rawSha256: null,
  });
  await extraction.whenIdle();

  const job = extraction.job('model:hashing');
  assert.equal(job.status, 'cancelled');
  assert.equal(job.errorCode, LAUNCHER_ERROR_CODES.cancelled);
  assert.match(job.detail, /while the file was being read/);

  rmSync(bigPath, { force: true });
});

/* ------------------------------------ hardening: a moved model, an intact cache */

/**
 * Losing the raw model is not losing the extraction.
 *
 * The NWD is what an extraction is made FROM; the cache is what every compile
 * actually reads. A detached drive or a moved share used to take the model out
 * of the universe entirely — the row said `file-missing` and the compile
 * refused, which turned a misplaced file into a register that had quietly lost
 * a building. The row still says the file is missing, because it is and because
 * re-extracting needs it back; the compile reads the cache in the meantime.
 */
test('a model whose file has gone still compiles from the cache it produced', async (t) => {
  const cacheDir = newCacheDir('moved-model');
  const modelPath = writeModel('Dragon-Moved.nwd');
  const projectPath = projectFile('Moved');

  const first = newService(cacheDir);
  first.create(projectPath, 'Moved');
  await first.addSources([modelPath]);
  await first.extractionIdle();
  teachDragon(first);
  assert.equal((await first.compile()).state, 'done', 'it compiles while the file is there');
  first.close();

  // The file goes; its extraction stays where the app put it.
  rmSync(modelPath, { force: true });

  const second = newService(cacheDir);
  t.after(() => {
    second.close();
  });
  assert.equal((await second.open(projectPath, false)).outcome, 'opened');
  await second.extractionIdle();

  const source = sourceById(second, 'model:dragon-moved.nwd');
  assert.equal(source.status, 'file-missing', 'the row still says the file cannot be found');
  assert.match(source.note, /cannot find it on this machine/);
  assert.match(source.note, /Cache available; locate the file to re-extract\./);

  assert.equal(second.modelUniverse().sourceCount, 1, 'the model is still in the universe');
  assert.equal(second.modelUniverse().objectCount, DRAGON_OBJECT_COUNT);
  teachDragon(second);
  assert.equal((await second.compile()).state, 'done', 'and the compile still runs');
  assert.equal(
    launchLog(cacheDir).filter((line) => line.startsWith('start')).length,
    1,
    'without the extractor being asked to run over a file that is not there',
  );
});

test('a model whose file AND cache have gone is refused rather than compiled', async (t) => {
  const cacheDir = newCacheDir('lost-both');
  const modelPath = writeModel('Dragon-Lost.nwd');
  const projectPath = projectFile('Lost');

  const first = newService(cacheDir);
  first.create(projectPath, 'Lost');
  await first.addSources([modelPath]);
  await first.extractionIdle();
  teachDragon(first);
  first.close();

  rmSync(modelPath, { force: true });
  for (const name of readdirSync(cacheDir).filter((entry) => entry.endsWith('.sqlite'))) {
    rmSync(join(cacheDir, name), { force: true });
  }

  const second = newService(cacheDir);
  t.after(() => {
    second.close();
  });
  await second.open(projectPath, false);
  await second.extractionIdle();

  const source = sourceById(second, 'model:dragon-lost.nwd');
  assert.equal(source.status, 'file-missing');
  assert.match(source.note, /Add the file again to work with it\./);
  assert.equal(second.modelUniverse(), null, 'nothing is open for it to read');

  const refused = await second.compile();
  assert.equal(refused.state, 'failed');
  assert.match(refused.reason, /cannot be found on this machine/);
});
