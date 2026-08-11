import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
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
  LAUNCHER_ERROR_CODES,
  SERVICE_ERROR_CODES,
} from '../dist/electron/services/extraction-protocol.js';
import {
  createProcessExtractorLauncher,
  resolveExtractorLauncher,
} from '../dist/electron/services/extractor-launcher.js';
import { createProjectService } from '../dist/electron/services/project-session.js';
import { digestFile } from '../dist/electron/services/sources.js';

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
  const compiled = service.compile();
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
  assert.equal(service.compile().state, 'done');

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
  assert.equal(service.compile().state, 'done', 'and the project compiles on the new one');
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
  const opened = second.open(projectPath, false);
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
