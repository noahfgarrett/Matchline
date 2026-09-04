/**
 * Shared machinery for the seven Navisworks proof scripts.
 *
 * ============================== CONFIDENTIALITY ==============================
 * These scripts run against a REAL client model on the owner's own machine, and
 * everything they emit is published as a CI artifact. Nothing model-derived may
 * appear in it: no file paths, no file names, no project names, no equipment
 * tags, no selection-set names, no property values. Counts, codes, timings and
 * booleans only (docs/RELEASE-1.0-PLAN.md P0-3, .github/workflows/
 * navisworks-proof.yml).
 *
 * That is not left to good intentions. `writeReport` walks everything it is
 * given and refuses to write a string that looks like a path or a model file
 * name, so a summary that would leak fails the proof instead of shipping.
 * =============================================================================
 *
 * The protocol parser here is a second implementation, written from the C#
 * (`native/navisworks-common/Protocol/ProgressReporter.cs`,
 * `native/extractor/ExitCodes.cs`) rather than imported from the app. That is
 * deliberate: a proof that the launcher speaks the protocol is worth nothing if
 * it is checked by the same code that would be wrong in the same way. It is the
 * same argument as apps/desktop/test/fake-extractor.mjs being a second
 * implementation of the other side.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Exit codes, from `native/extractor/ExitCodes.cs`. */
export const EXIT_CODES = {
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
};

/** Stage names, from `native/navisworks-common/Protocol/ExtractionProtocol.cs`. */
export const STAGES = ['hash', 'detect', 'open', 'walk', 'sets', 'convert', 'finalize'];

/** The launcher's own executable name, as it is built and as it ships. */
const EXTRACTOR_EXECUTABLE = 'Matchline.Extractor.exe';

function envOrNull(name) {
  const value = process.env[name];
  return value === undefined || value === '' ? null : value;
}

/**
 * One flag off the command line, or null.
 *
 * argv overrides the environment so a script can be driven by hand and by the
 * workflow with the same code. The workflow passes no arguments at all.
 */
function argOrNull(name) {
  const argv = process.argv.slice(2);
  const index = argv.indexOf(`--${name}`);
  if (index < 0 || index + 1 >= argv.length) {
    return null;
  }
  return argv[index + 1] ?? null;
}

function setting(argName, envName, fallback = null) {
  return argOrNull(argName) ?? envOrNull(envName) ?? fallback;
}

/**
 * Everything a proof script reads from its environment.
 *
 * The cache directory is deliberately NOT under the artifact directory: the
 * workflow uploads that whole tree, and a cache is derived from a client model.
 * It defaults to a runner-local temp path that every script in one job agrees
 * on, so extract.mjs writes a cache the later scripts can find without any of
 * them naming a model.
 */
export function proofSettings() {
  const outDir = path.resolve(setting('out', 'MATCHLINE_PROOF_OUT', 'artifacts/windows-proof'));
  const cacheDir = path.resolve(
    setting('cache-dir', 'MATCHLINE_PROOF_CACHE', path.join(os.tmpdir(), 'matchline-proof-cache')),
  );
  const configuration = setting('configuration', 'MATCHLINE_CONFIGURATION', 'Release');
  return {
    modelPath: setting('model', 'MATCHLINE_PROOF_MODEL'),
    outDir,
    cacheDir,
    /** Where a cancellation run works, so a killed run cannot disturb the real cache. */
    cancelCacheDir: path.join(cacheDir, 'cancel'),
    navisworksInstallDir: setting('navisworks-dir', 'MATCHLINE_NAVISWORKS_INSTALL_DIR'),
    configuration,
    extractorPath: resolveExtractorPath(configuration),
    /** An NWD published by a newer Navisworks, when the runner has one. */
    tooNewModelPath: setting('too-new-model', 'MATCHLINE_PROOF_TOO_NEW_MODEL'),
  };
}

/**
 * The launcher to drive.
 *
 * `MATCHLINE_EXTRACTOR_PATH` overrides it — the same variable the app uses
 * (docs/WINDOWS-RUNBOOK.md §6), and the way these scripts are tested against
 * the fake extractor on a machine with no Navisworks. Otherwise it is whatever
 * the workflow just built.
 */
function resolveExtractorPath(configuration) {
  const override = envOrNull('MATCHLINE_EXTRACTOR_PATH');
  if (override !== null) {
    return path.resolve(override);
  }
  return path.resolve('native', 'extractor', 'bin', configuration, EXTRACTOR_EXECUTABLE);
}

/** One protocol line, or null for anything this build does not read. */
export function parseLine(line) {
  const trimmed = line.trim();
  if (trimmed === '') {
    return null;
  }
  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  switch (parsed.type) {
    case 'progress':
      return typeof parsed.stage === 'string'
        ? {
            type: 'progress',
            stage: parsed.stage,
            done: Number(parsed.done ?? 0),
            total: Number(parsed.total ?? 0),
            detail: typeof parsed.detail === 'string' ? parsed.detail : null,
          }
        : null;
    case 'warning':
      return typeof parsed.code === 'string'
        ? { type: 'warning', code: parsed.code, message: String(parsed.message ?? '') }
        : null;
    case 'result':
      return typeof parsed.cachePath === 'string' &&
        (parsed.status === 'ok' || parsed.status === 'cache-hit')
        ? {
            type: 'result',
            status: parsed.status,
            cachePath: parsed.cachePath,
            objects: Number(parsed.objects ?? 0),
            warnings: Number(parsed.warnings ?? 0),
          }
        : null;
    case 'error':
      return typeof parsed.code === 'string'
        ? { type: 'error', code: parsed.code, message: String(parsed.message ?? '') }
        : null;
    default:
      return null;
  }
}

/**
 * Runs the launcher once and collects everything it said.
 *
 * `cancelWhen` is called for every parsed message; the first time it answers
 * true, a `cancel` line goes to stdin — which is the launcher's own
 * cancellation, the one that kills Navisworks and deletes the partials. A
 * signal would skip all of that and prove nothing.
 */
export function runExtractor(args, options = {}) {
  const { extractorPath } = proofSettings();
  const isScript = extractorPath.endsWith('.mjs');
  const command = isScript ? process.execPath : extractorPath;
  const commandArgs = isScript ? [extractorPath, ...args] : [...args];

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const messages = [];
    /** First arrival of each stage, milliseconds from spawn. */
    const stageFirstSeenMs = new Map();
    let cancelSentAtMs = null;
    let stdoutRest = '';
    let stderrBytes = 0;

    let child;
    try {
      child = spawn(command, commandArgs, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (error) {
      resolve({
        spawned: false,
        exitCode: null,
        messages: [],
        stageFirstSeenMs: new Map(),
        cancelSentAtMs: null,
        elapsedMs: 0,
        // The error code (e.g. "ENOENT"), never `.message`: Node's spawn
        // error message embeds the full command path, which is exactly what
        // a published proof artifact must never carry (writeReport's `LEAKY`
        // check would refuse to write it at all).
        spawnError:
          error !== null && typeof error === 'object' && 'code' in error
            ? String(error.code)
            : 'SPAWN_FAILED',
      });
      return;
    }

    const handle = (message) => {
      messages.push(message);
      if (message.type === 'progress' && !stageFirstSeenMs.has(message.stage)) {
        stageFirstSeenMs.set(message.stage, Date.now() - startedAt);
      }
      if (options.onMessage !== undefined) {
        options.onMessage(message);
      }
      if (cancelSentAtMs === null && options.cancelWhen !== undefined && options.cancelWhen(message)) {
        cancelSentAtMs = Date.now() - startedAt;
        try {
          child.stdin.write('cancel\n');
        } catch {
          // The child is already gone; its exit is the answer either way.
        }
      }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      const text = stdoutRest + chunk;
      const lines = text.split('\n');
      stdoutRest = lines.pop() ?? '';
      for (const line of lines) {
        const message = parseLine(line);
        if (message !== null) {
          handle(message);
        }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      // Never kept: stderr can carry a stack trace naming real paths, and this
      // process writes a published artifact. Its size is evidence enough.
      stderrBytes += Buffer.byteLength(chunk, 'utf8');
    });

    child.on('error', () => {
      // Reported through the exit below; a failed spawn has no exit code.
    });

    child.on('close', (exitCode) => {
      const last = parseLine(stdoutRest);
      if (last !== null) {
        handle(last);
      }
      resolve({
        spawned: true,
        exitCode,
        messages,
        stageFirstSeenMs,
        cancelSentAtMs,
        stderrBytes,
        elapsedMs: Date.now() - startedAt,
        spawnError: null,
      });
    });
  });
}

/**
 * The launcher's own argument list, as the app builds it — plus
 * `--navisworks-dir`, which the app never passes (it lets the launcher
 * auto-locate) but every proof script needs on a runner where
 * MATCHLINE_NAVISWORKS_INSTALL_DIR names a non-default install (e.g.
 * Simulate, or a drive other than C:). Without it every proof script fails
 * `NW_NOT_INSTALLED` on such a runner, silently proving nothing.
 */
export function extractorArguments(inputPath, cacheDirectory) {
  const args = ['--input', inputPath, '--cache-dir', cacheDirectory];
  const { navisworksInstallDir } = proofSettings();
  if (navisworksInstallDir !== null) {
    args.push('--navisworks-dir', navisworksInstallDir);
  }
  return args;
}

/** Every `<64 hex>.sqlite` in a cache directory. Never returns a path. */
export function cacheFileNames(cacheDirectory) {
  let entries;
  try {
    entries = readdirSync(cacheDirectory);
  } catch {
    return [];
  }
  return entries.filter((name) => /^[0-9a-f]{64}\.sqlite$/.test(name)).sort();
}

/** Files a run must not leave behind: partial caches and hand-off streams. */
export function leftoverFileNames(cacheDirectory) {
  let entries;
  try {
    entries = readdirSync(cacheDirectory);
  } catch {
    return [];
  }
  return entries.filter((name) => name.endsWith('.partial') || name.endsWith('.ndjson.tmp')).sort();
}

/**
 * The one cache in a proof cache directory, as an absolute path.
 *
 * Absolute because a reader needs it; it is never reported. Throws when there
 * is not exactly one, which is itself a finding: two caches means the directory
 * was not cleared and the later scripts would be reading the wrong run.
 */
export function soleCachePath(cacheDirectory) {
  const names = cacheFileNames(cacheDirectory);
  if (names.length !== 1) {
    throw new Error(
      `expected exactly one cache in the proof cache directory, found ${String(names.length)}`,
    );
  }
  return path.join(cacheDirectory, names[0]);
}

/** Last-modified time of a file, in milliseconds, or null if it is not there. */
export function modifiedAtMs(filePath) {
  try {
    return statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

export function emptyDirectory(directory) {
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
}

/** Counts by key, as a plain object, sorted so two runs compare cleanly. */
export function countBy(values) {
  const counts = new Map();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * A proof script's verdict.
 *
 * Three outcomes, not two. A skip is for a fixture the runner does not have —
 * it is printed as loudly as a failure and recorded in the artifact, because a
 * check that did not run must never read as a check that passed.
 */
export class ProofReport {
  #name;
  #checks = [];
  #facts = {};
  #skips = [];

  constructor(name) {
    this.#name = name;
  }

  /** Records a check. `detail` is authored here, never taken from a model. */
  check(name, ok, detail = null) {
    this.#checks.push({ name, status: ok ? 'pass' : 'fail', detail });
    return ok;
  }

  /** A check that could not run, and why. Visible, never silent. */
  skip(name, reason) {
    this.#skips.push({ name, reason });
    this.#checks.push({ name, status: 'skip', detail: reason });
  }

  /** Anonymized numbers and codes for the artifact. */
  fact(key, value) {
    this.#facts[key] = value;
  }

  get failed() {
    return this.#checks.some((check) => check.status === 'fail');
  }

  get skipped() {
    return this.#skips.length > 0;
  }

  /**
   * Prints the summary, writes it, and exits with 0 or 1.
   *
   * A skip does not fail the run — the runner cannot conjure a fixture it does
   * not have — but it is printed under its own heading and carried into the
   * artifact, so a green job with skips is still legible as incomplete.
   */
  finish(outDir) {
    const status = this.failed ? 'FAIL' : this.skipped ? 'PASS (with skips)' : 'PASS';
    const lines = [`--- ${this.#name}: ${status}`];
    for (const check of this.#checks) {
      const mark = check.status === 'pass' ? 'ok  ' : check.status === 'skip' ? 'SKIP' : 'FAIL';
      lines.push(`  ${mark} ${check.name}${check.detail === null ? '' : ` — ${check.detail}`}`);
    }
    for (const [key, value] of Object.entries(this.#facts)) {
      lines.push(`  fact ${key} = ${JSON.stringify(value)}`);
    }
    if (this.skipped) {
      lines.push(`  ${String(this.#skips.length)} check(s) did NOT run; this proof is incomplete.`);
    }
    process.stdout.write(`${lines.join('\n')}\n`);

    writeReport(outDir, this.#name, {
      script: this.#name,
      status: this.failed ? 'fail' : 'pass',
      skipped: this.skipped,
      checks: this.#checks,
      facts: this.#facts,
    });

    process.exitCode = this.failed ? 1 : 0;
  }
}

/**
 * Anything that must never reach a published artifact.
 *
 * Path separators catch file paths; the model extensions catch a bare file
 * name. The check is deliberately blunt: a false positive is a script that has
 * to name something differently, and a false negative is client data in a
 * public artifact.
 */
const LEAKY = /[/\\]|\.nwd\b|\.nwc\b|\.nwf\b/i;

function assertAnonymous(value, at) {
  if (typeof value === 'string' && LEAKY.test(value)) {
    throw new Error(
      `refusing to write a proof summary: ${at} looks model-derived (${JSON.stringify(value)}). ` +
        'Proof artifacts carry counts, codes and timings only.',
    );
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertAnonymous(entry, `${at}[${String(index)}]`));
    return;
  }
  if (typeof value === 'object' && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      assertAnonymous(key, `${at}.${key} (key)`);
      assertAnonymous(entry, `${at}.${key}`);
    }
  }
}

/** Writes one anonymized summary file, or throws rather than leak. */
export function writeReport(outDir, name, payload) {
  assertAnonymous(payload, name);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, `${name}.json`), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

/**
 * Fails a script before it starts when the environment cannot support it.
 *
 * Written as its own step so that "the operator forgot an input" never reads
 * like "the proof found a problem with the code".
 */
export function requireSettings(report, settings, needs) {
  let ok = true;
  if (needs.includes('model')) {
    // `existsSync`, not just "the variable is set": a stale or typo'd
    // MATCHLINE_PROOF_MODEL must fail here, in a check with an anonymous
    // detail, rather than reach runExtractor and fail somewhere that reports
    // the real path.
    const present = settings.modelPath !== null && existsSync(settings.modelPath);
    ok =
      report.check(
        'MATCHLINE_PROOF_MODEL names a file on this runner',
        present,
        present ? null : settings.modelPath === null ? 'the variable is unset' : 'no file at that path',
      ) && ok;
  }
  if (needs.includes('extractor')) {
    // Detail carries no path separator on purpose: it is written into the
    // published proof summary by ProofReport.finish -> writeReport, whose
    // `LEAKY` check refuses to write a string containing "/" or "\" and
    // throws instead — which used to mean a missing launcher crashed the
    // script before it could report anything at all.
    const present = existsSync(settings.extractorPath);
    ok =
      report.check(
        'the launcher executable is where the build left it',
        present,
        present ? null : 'not found; build the launcher, or set MATCHLINE_EXTRACTOR_PATH',
      ) && ok;
  }
  return ok;
}
