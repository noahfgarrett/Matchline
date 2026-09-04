import { createHash } from 'node:crypto';
import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { writeDragonFixture } from '@matchline/model-schema/fixtures/dragon';

/**
 * A stand-in for `Matchline.Extractor.exe`, for a machine with no Navisworks.
 *
 * This is not a mock of the extraction service's own idea of the protocol — it
 * is a second implementation of the launcher's side of it, written from the C#
 * (`native/extractor/ExtractionRunner.cs`,
 * `native/navisworks-common/Protocol/ProgressReporter.cs`,
 * `native/extractor/ExitCodes.cs`) and speaking it byte for byte:
 *
 * - the same command line: `--input`, `--cache-dir`, `--navisworks-dir`,
 *   `--navisworks-version`, `--input-sha256`, `--stall-timeout-seconds`, and
 *   `INVALID_ARGS` for anything else — including a `--input-sha256` that is not
 *   64 hex digits and a `--stall-timeout-seconds` that is not a whole number of
 *   seconds in range;
 * - the same trust in a supplied hash: the hash stage is reported complete and
 *   the file is not read for it, and the value addresses the cache;
 * - the same order of events: hash → cache-hit check → detect (+ the
 *   `ADAPTER_UNVERIFIED` warning, because no year is verified yet) → open →
 *   walk → sets → convert → finalize → result;
 * - the same `total: 0` for the stages that cannot know their total, and a real
 *   total for `sets`, which counts the set tree before resolving any of it;
 * - the same atomic commit: `<sha>.sqlite.partial`, then rename;
 * - the same cancellation: one `cancel` line on stdin kills the run, deletes
 *   the partials and exits `CANCELLED` with code 9;
 * - the same exit codes, per failure class.
 *
 * The cache it writes is a real one — the Dragon fixture from
 * `@matchline/model-schema`, with the launcher's own `meta` keys stamped over
 * it — so everything downstream of extraction is exercised for real: the
 * validation, the association, the universe, and the compile.
 *
 * ## Telling it what to do
 *
 * The scenario is read out of the input file itself, whose first line is
 * `MATCHLINE-FAKE {json}`. Carrying it in the file rather than in the
 * environment means a queue of three models can be three different scenarios,
 * and that each one's bytes — and therefore its content hash, and therefore its
 * cache — differ, exactly as three real models would.
 */

const EXIT = {
  ok: 0,
  internal: 1,
  invalidArguments: 2,
  inputNotFound: 3,
  navisworksNotInstalled: 4,
  navisworksVersionTooNew: 5,
  openFailed: 6,
  extractFailed: 7,
  cacheWriteFailed: 8,
  cancelled: 9,
  navisworksStalled: 10,
  pluginNotDeployed: 11,
  pluginNotFound: 12,
};

/** `ExitCodes.ForErrorCode`, mirrored. */
const EXIT_FOR_CODE = {
  INVALID_ARGS: EXIT.invalidArguments,
  INPUT_NOT_FOUND: EXIT.inputNotFound,
  NW_NOT_INSTALLED: EXIT.navisworksNotInstalled,
  NW_VERSION_TOO_NEW: EXIT.navisworksVersionTooNew,
  OPEN_FAILED: EXIT.openFailed,
  EXTRACT_FAILED: EXIT.extractFailed,
  CACHE_WRITE_FAILED: EXIT.cacheWriteFailed,
  CANCELLED: EXIT.cancelled,
  NW_STALLED: EXIT.navisworksStalled,
  PLUGIN_NOT_DEPLOYED: EXIT.pluginNotDeployed,
  PLUGIN_NOT_FOUND: EXIT.pluginNotFound,
};

/**
 * Saved sets in the Dragon cache this fake commits, folders excluded.
 *
 * `Dragon Systems` is a folder and does not count; `Air Handling` and
 * `PLC Panels` do — the same rule `CountSelectionSets` applies in the adapter
 * (native/navisworks-adapter/DocumentWalker.cs).
 */
const DRAGON_SAVED_SET_COUNT = 2;

const USAGE =
  'Matchline.Extractor --input <file.nwd> [--cache-dir <dir>] [--navisworks-dir <dir>]\n' +
  '                    [--navisworks-version <year>] [--input-sha256 <hex>]\n' +
  '                    [--stall-timeout-seconds <n>]';

/** `ExtractorArguments.MaxStallTimeoutSeconds`. */
const MAX_STALL_TIMEOUT_SECONDS = 86400;

/** `ExtractorArguments.TryNormaliseSha256`: 64 hex digits, folded to lower case. */
function normaliseSha256(value) {
  return /^[0-9a-fA-F]{64}$/.test(value) ? value.toLowerCase() : null;
}

/**
 * One protocol line, written synchronously.
 *
 * `process.stdout.write` to a pipe is asynchronous, and every terminal path
 * here calls `process.exit` immediately afterwards — which would truncate it.
 * The real launcher has the same requirement and meets it with
 * `AutoFlush = true` on a `StreamWriter` (Program.cs).
 */
function emit(record) {
  const buffer = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    try {
      offset += writeSync(1, buffer, offset, buffer.length - offset);
    } catch (error) {
      if (error.code === 'EAGAIN') {
        continue;
      }
      // The parent went away mid-run; there is nobody left to tell.
      return;
    }
  }
}

function progress(stage, done, total, detail) {
  emit(
    detail === undefined
      ? { type: 'progress', stage, done, total }
      : { type: 'progress', stage, done, total, detail },
  );
}

function fail(code, message) {
  emit({ type: 'error', code, message });
  process.exit(EXIT_FOR_CODE[code] ?? EXIT.internal);
}

function parseArguments(argv) {
  let input = null;
  let cacheDir = null;
  let inputSha256 = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const takeValue = (name) => {
      if (index + 1 >= argv.length) {
        fail('INVALID_ARGS', `${name} requires a value.\n${USAGE}`);
      }
      index += 1;
      return argv[index];
    };
    switch (argument) {
      case '--input':
        input = takeValue('--input');
        break;
      case '--cache-dir':
        cacheDir = takeValue('--cache-dir');
        break;
      case '--navisworks-dir':
        takeValue('--navisworks-dir');
        break;
      case '--navisworks-version':
        takeValue('--navisworks-version');
        break;
      case '--stall-timeout-seconds': {
        const raw = takeValue('--stall-timeout-seconds');
        if (!/^[0-9]+$/.test(raw) || Number(raw) > MAX_STALL_TIMEOUT_SECONDS) {
          fail(
            'INVALID_ARGS',
            `--stall-timeout-seconds takes a whole number of seconds from 0 to ` +
              `${MAX_STALL_TIMEOUT_SECONDS}, not '${raw}'.\n${USAGE}`,
          );
        }
        break;
      }
      case '--input-sha256': {
        const raw = takeValue('--input-sha256');
        inputSha256 = normaliseSha256(raw);
        if (inputSha256 === null) {
          fail('INVALID_ARGS', `--input-sha256 takes 64 hex digits, not '${raw}'.\n${USAGE}`);
        }
        break;
      }
      default:
        fail('INVALID_ARGS', `Unrecognised argument '${argument}'.\n${USAGE}`);
    }
  }
  if (input === null) {
    fail('INVALID_ARGS', `--input is required.\n${USAGE}`);
  }
  return { input: path.resolve(input), cacheDir: path.resolve(cacheDir ?? '.'), inputSha256 };
}

/**
 * The launcher hashes its own input, streaming, reporting bytes (FileHasher) —
 * unless the caller passed `--input-sha256`, in which case it trusts that and
 * only reports the stage as complete (ExtractionRunner.Run).
 */
function hashInput(inputPath, supplied) {
  if (supplied !== null) {
    const total = statSync(inputPath).size;
    progress('hash', total, total);
    return Promise.resolve(supplied);
  }
  const total = statSync(inputPath).size;
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(inputPath, { highWaterMark: 1 << 20 });
    let done = 0;
    progress('hash', 0, total);
    stream.on('data', (chunk) => {
      hash.update(chunk);
      done += chunk.length;
    });
    stream.on('error', reject);
    stream.on('end', () => {
      progress('hash', done, total);
      resolve(hash.digest('hex'));
    });
  });
}

/** `MATCHLINE-FAKE {json}` on the first line of the input, or the defaults. */
function readScenario(inputPath) {
  const defaults = {
    mode: 'ok',
    code: 'EXTRACT_FAILED',
    message: 'The fake extractor was told to fail.',
    walkTicks: 2,
    tickMs: 0,
    ignoreCancel: false,
    ignoreSigterm: false,
    /**
     * Milliseconds spent in `finalize` before the result line.
     *
     * What a real launcher spends there is the integrity check on a committed
     * cache, and it is the window in which a cancel can arrive AFTER the cache
     * exists — the case the service has to settle as `cancelled` rather than
     * `ready` however the race goes.
     */
    lingerMs: 0,
  };
  // Only the head of the file: a fixture's scenario is its first line, and a
  // real NWD would be gigabytes.
  const head = readFileSync(inputPath, 'latin1').slice(0, 4096);
  const [firstLine] = head.split('\n');
  if (firstLine === undefined || !firstLine.startsWith('MATCHLINE-FAKE ')) {
    return defaults;
  }
  return { ...defaults, ...JSON.parse(firstLine.slice('MATCHLINE-FAKE '.length)) };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Writes the cache the way the launcher does: into `<sha>.sqlite.partial`,
 * stamped with the launcher's authoritative `meta` (it knows the real file, its
 * hash and its size — ExtractionRunner.BuildLauncherMeta), then renamed.
 */
function commitCache(cacheDir, sha256, inputPath, scenario) {
  const cachePath = path.join(cacheDir, `${sha256}.sqlite`);
  const partialPath = `${cachePath}.partial`;
  rmSync(partialPath, { force: true });
  writeDragonFixture(partialPath);

  const database = new DatabaseSync(partialPath);
  try {
    if (scenario.mode === 'empty') {
      // Foreign keys are enforced by node:sqlite, so everything that points at
      // an object lets go of it before the objects themselves go.
      database.exec('DELETE FROM selection_set_members');
      database.exec('DELETE FROM properties');
      database.exec('UPDATE warnings SET object_id = NULL');
      database.exec('DELETE FROM objects');
    }
    const update = database.prepare('UPDATE meta SET value = ? WHERE key = ?');
    update.run(path.basename(inputPath), 'input_file_name');
    // A cache that claims a different input is what a mixed-up run looks like.
    update.run(scenario.mode === 'mismatch' ? 'f'.repeat(64) : sha256, 'input_sha256');
    update.run(String(statSync(inputPath).size), 'input_bytes');
    update.run(new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'), 'extracted_at_utc');
    const count = database.prepare('SELECT COUNT(*) AS n FROM objects').get();
    update.run(String(count.n), 'object_count');
    return { cachePath, partialPath, objects: Number(count.n) };
  } finally {
    database.close();
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const { input, cacheDir, inputSha256 } = parseArguments(argv);

  if (!existsSync(input)) {
    fail('INPUT_NOT_FOUND', `Input file not found: ${path.basename(input)}`);
  }
  mkdirSync(cacheDir, { recursive: true });

  const scenario = readScenario(input);
  const log = (line) => {
    appendFileSync(path.join(cacheDir, 'fake-extractor.log'), `${line}\n`);
  };

  let cancelled = false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    if (!chunk.split('\n').some((line) => line.trim() === 'cancel')) {
      return;
    }
    // Logged whether or not it is obeyed: the order of "cancel line" against
    // "signal" is exactly what the shutdown sequence promises, and the only
    // place it can be observed from outside is here.
    log(`cancel ${path.basename(input)}`);
    if (!scenario.ignoreCancel) {
      cancelled = true;
    }
  });
  process.on('SIGTERM', () => {
    log(`sigterm ${path.basename(input)}`);
    if (!scenario.ignoreSigterm) {
      process.exit(EXIT.cancelled);
    }
    // Only SIGKILL will stop this one, which is what the escalation is for.
  });

  const sha256 = await hashInput(input, inputSha256);
  log(`start ${path.basename(input)}`);

  const stopIfCancelled = (partialPath) => {
    if (!cancelled) {
      return false;
    }
    if (partialPath !== null) {
      rmSync(partialPath, { force: true });
    }
    rmSync(path.join(cacheDir, `${sha256}.ndjson.tmp`), { force: true });
    log(`end ${path.basename(input)}`);
    emit({ type: 'error', code: 'CANCELLED', message: 'Extraction cancelled.' });
    process.exit(EXIT.cancelled);
    return true;
  };

  // Cache reuse by content hash: an unchanged model never touches Navisworks.
  const existingPath = path.join(cacheDir, `${sha256}.sqlite`);
  if (existsSync(existingPath)) {
    const database = new DatabaseSync(existingPath);
    const { n } = database.prepare('SELECT COUNT(*) AS n FROM objects').get();
    database.close();
    log(`end ${path.basename(input)}`);
    emit({
      type: 'result',
      status: 'cache-hit',
      cachePath: existingPath,
      objects: Number(n),
      warnings: 2,
    });
    process.exit(EXIT.ok);
  }

  if (scenario.mode === 'silent') {
    // A launcher that dies without a word: the exit code is all there is.
    log(`end ${path.basename(input)}`);
    process.exit(EXIT.internal);
  }

  if (scenario.mode === 'error') {
    log(`end ${path.basename(input)}`);
    fail(scenario.code, scenario.message);
  }

  progress(
    'detect',
    1,
    1,
    'Navisworks Manage 2025 (C:\\Program Files\\Autodesk\\Navisworks Manage 2025) will open ' +
      'this file; expecting adapter navisworks-2025.',
  );
  emit({
    type: 'warning',
    code: 'ADAPTER_UNVERIFIED',
    message:
      'The navisworks-2025 adapter is pending-real-proof: it has not been proven against a ' +
      'real Navisworks 2025 install yet.',
    objectId: null,
  });

  progress('open', 0, 1);
  if (stopIfCancelled(null)) {
    return;
  }

  if (scenario.mode === 'hang') {
    // Navisworks behind an invisible dialog: the process is alive, the stream
    // never grows, and nothing is ever said again. The launcher's own
    // --stall-timeout-seconds is what ends this in production; here it runs
    // until the service's watchdog has had its say and the test cancels.
    for (;;) {
      await sleep(25);
      if (stopIfCancelled(null)) {
        return;
      }
    }
  }

  for (let tick = 1; tick <= scenario.walkTicks; tick += 1) {
    await sleep(scenario.tickMs);
    if (stopIfCancelled(null)) {
      return;
    }
    // total 0 = unknown: the record count is not knowable until the walk ends.
    progress('walk', tick * 25000, 0);
  }

  // The saved sets, after the walk and before the convert, exactly where
  // DocumentWalker puts them. The denominator is real: it is the number of
  // saved sets — folders excluded — in the Dragon cache this run is about to
  // commit, counted before the first is resolved, which is what lets this stage
  // report a fraction where the walk and the convert cannot.
  progress('sets', 0, DRAGON_SAVED_SET_COUNT);
  for (let resolved = 1; resolved <= DRAGON_SAVED_SET_COUNT; resolved += 1) {
    await sleep(scenario.tickMs);
    if (stopIfCancelled(null)) {
      return;
    }
    progress('sets', resolved, DRAGON_SAVED_SET_COUNT);
  }

  progress('convert', 0, 0);
  const committed = commitCache(cacheDir, sha256, input, scenario);
  if (stopIfCancelled(committed.partialPath)) {
    return;
  }
  progress('convert', 25000, 0);

  progress('finalize', 1, 1);
  renameSync(committed.partialPath, committed.cachePath);
  // The cache is committed and the run is not over: a cancel that lands here
  // has to settle `cancelled` even though a perfectly good cache now exists.
  if (scenario.lingerMs > 0) {
    await sleep(scenario.lingerMs);
  }
  log(`end ${path.basename(input)}`);
  emit({
    type: 'result',
    status: 'ok',
    cachePath: committed.cachePath,
    objects: committed.objects,
    warnings: 2,
  });
  process.exit(EXIT.ok);
}

main().catch((error) => {
  emit({ type: 'error', code: 'INTERNAL', message: `${error.name}: ${error.message}` });
  process.exit(EXIT.internal);
});
