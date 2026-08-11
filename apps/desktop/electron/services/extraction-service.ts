import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';

import { openExtractionCache } from '@matchline/model-schema';

import type {
  WireExtractionJob,
  WireExtractionStatus,
  WireExtractionWarning,
  WireSourceStatus,
} from '../../shared/schemas.js';

import {
  describeExtractionFailure,
  describeExtractionProgress,
  describeExtractionSuccess,
  describeExtractionWarning,
} from './extraction-messages.js';
import {
  LAUNCHER_ERROR_CODES,
  SERVICE_ERROR_CODES,
  cacheFileName,
  errorCodeForExitCode,
  extractorArguments,
  partialFileNames,
  type ExtractionMessage,
} from './extraction-protocol.js';
import type { ExtractorChild, ExtractorLauncher } from './extractor-launcher.js';
import { digestFile } from './digest.js';

/**
 * The Navisworks extraction service (RELEASE-1.0-PLAN P0-2).
 *
 * One serial queue of extraction jobs, keyed by `sourceId`. A raw NWD, NWF or
 * NWC becomes a job; the job hashes the file if nobody has, looks for a cache
 * those bytes already produced, and otherwise runs the launcher and follows its
 * protocol until it says `ok`, `cache-hit`, or why not. What comes out is a
 * validated cache path and the hash of the cache, which is the only thing the
 * project session needs to associate it.
 *
 * ## Why the queue is serial
 *
 * Each job starts a headless Navisworks, which is a licensed application that
 * wants a lot of memory and does not enjoy company. Two at once on a real
 * machine is slower than two in sequence and can fail outright, so the queue
 * runs one and the rest say, in the row, that they are waiting for it.
 *
 * ## What this service does not do
 *
 * It never touches the project store, and it never opens a cache for reading
 * beyond the validation below. Association is the session's job: this service
 * reports, the session records (see `project-session.ts`). That split is what
 * lets the whole flow be tested against a fake launcher with no project at all.
 *
 * ## Cancellation
 *
 * A queued job is simply dropped. An active one is asked to stop the way the
 * launcher documents — a `cancel` line on its stdin, which makes it kill the
 * Navisworks it started and delete its own partials — and only if that is
 * ignored does the child get SIGTERM and then SIGKILL. Either way the source
 * stays registered with status `cancelled`, and this service then checks that
 * no `.partial` was left behind, because a killed launcher never got to.
 */

/** Every extraction status is also a source status: the row shows the job. */
const EXTRACTION_STATUSES_ARE_SOURCE_STATUSES: readonly WireSourceStatus[] = [
  'queued',
  'hashing',
  'opening',
  'extracting',
  'finalizing',
  'ready',
  'cache-hit',
  'cancelled',
  'failed',
] satisfies readonly WireExtractionStatus[];
void EXTRACTION_STATUSES_ARE_SOURCE_STATUSES;

/** Forwarded warnings kept per job. The launcher forwards at most this many too. */
const MAX_KEPT_WARNINGS = 20;

/** How long a polite cancel has before the child is signalled. */
const DEFAULT_CANCEL_GRACE_MS = 10_000;

export interface ExtractionJobRequest {
  readonly sourceId: string;
  /** What the row calls this file — the raw document, never a cache. */
  readonly fileName: string;
  readonly inputPath: string;
  /**
   * The file's sha256 when the caller already streamed it, or `null` to have
   * the job hash it. Registration needs the hash, so in practice the session
   * supplies it and the job's own hashing stage is what a re-extraction with
   * no recorded hash falls back on.
   */
  readonly rawSha256: string | null;
}

/** What a finished job produced. Everything the session needs to associate it. */
export interface ExtractionOutcome {
  readonly sourceId: string;
  readonly cachePath: string;
  /** sha256 of the cache file itself, which is what the project records. */
  readonly cacheSha256: string;
  readonly rawSha256: string;
  readonly objectCount: number;
  readonly sourceModelCount: number;
  /** True when these bytes had been extracted before and nothing was launched. */
  readonly reusedExistingCache: boolean;
}

export interface ExtractionServiceOptions {
  /** Where caches live: `<cacheDirectory>/<raw sha256>.sqlite`. */
  readonly cacheDirectory: string;
  readonly launcher: ExtractorLauncher;
  /** Every status or progress change, terminal ones included. */
  readonly onChanged: (job: WireExtractionJob) => void;
  /** A job that has stopped. `outcome` is null unless a cache was associated. */
  readonly onSettled: (job: WireExtractionJob, outcome: ExtractionOutcome | null) => void;
  readonly cancelGraceMs?: number;
}

export interface ExtractionService {
  /**
   * Queues one file. A job already queued for this source is replaced and an
   * active one is cancelled first, so re-adding a changed model re-extracts it
   * under the same source id rather than racing the run it supersedes.
   */
  enqueue(request: ExtractionJobRequest): void;
  /** True when there was something to cancel. */
  cancel(sourceId: string): boolean;
  /** Every job this session has seen, oldest first. */
  jobs(): readonly WireExtractionJob[];
  job(sourceId: string): WireExtractionJob | null;
  /** Forgets a settled job — used when its source is removed. */
  forget(sourceId: string): void;
  /** Cancels everything, in-flight children included. */
  shutdown(): void;
  /**
   * Resolves when nothing is queued or running.
   *
   * A test seam, and the honest one: extraction is asynchronous by nature and
   * asserting against it with a sleep would be asserting against a guess.
   */
  whenIdle(): Promise<void>;
}

interface Job {
  readonly sourceId: string;
  readonly fileName: string;
  readonly inputPath: string;
  rawSha256: string | null;
  status: WireExtractionStatus;
  progress: number | null;
  detail: string;
  note: string;
  errorCode: string | null;
  warnings: WireExtractionWarning[];
  objectCount: number | null;
  cachePath: string | null;
  readonly startedAt: string;
  finishedAt: string | null;
  cancelRequested: boolean;
}

interface ActiveRun {
  readonly job: Job;
  readonly child: ExtractorChild;
  killTimer: NodeJS.Timeout | null;
}

/** A cache that opened, read back, and agrees about which file it came from. */
interface CacheValidation {
  readonly ok: boolean;
  readonly code: string;
  readonly detail: string;
  readonly objectCount: number;
  readonly sourceModelCount: number;
}

const RUNNING_STATUSES: ReadonlySet<WireExtractionStatus> = new Set<WireExtractionStatus>([
  'queued',
  'hashing',
  'opening',
  'extracting',
  'finalizing',
]);

/** The status a launcher stage puts the row in, or `null` for one we do not know. */
function statusForStage(stage: string): WireExtractionStatus | null {
  switch (stage) {
    case 'hash':
      return 'hashing';
    // Detection is part of opening as far as the row is concerned: both are
    // "Matchline is getting Navisworks ready to read this".
    case 'detect':
    case 'open':
      return 'opening';
    case 'walk':
    case 'convert':
      return 'extracting';
    case 'finalize':
      return 'finalizing';
    default:
      return null;
  }
}

/**
 * The fraction a stage can honestly claim, or `null` for "no denominator".
 *
 * Only the hash has one. `detect` and `finalize` report `1 of 1` because they
 * are single steps, not because they are measurements — drawing a full bar
 * from that would tell the user an extraction was finished at the moment
 * Navisworks was about to open the file. The walk and the convert report a
 * total of `0`, which the protocol defines as "not known yet".
 */
function progressForStage(stage: string, done: number, total: number): number | null {
  if (stage !== 'hash' || total <= 0) {
    return null;
  }
  return Math.min(1, done / total);
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

function thousands(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * The line under the progress bar for one stage.
 *
 * The launcher's own `detail` wins whenever it sent one, because the only
 * stage that sends one is `detect` and what it says — which Navisworks will
 * open this file, and which adapter it expects — is the single most useful
 * sentence in the whole run.
 */
function detailForStage(stage: string, done: number, total: number, sent: string | null): string {
  if (sent !== null && sent !== '') {
    return sent;
  }
  switch (stage) {
    case 'hash':
      return total > 0 ? `Read ${megabytes(done)} of ${megabytes(total)}.` : '';
    case 'walk':
      return done > 0 ? `${thousands(done)} records read from the model so far.` : '';
    case 'convert':
      return done > 0 ? `${thousands(done)} records written to the cache.` : '';
    case 'finalize':
      return 'Checking the cache is complete.';
    default:
      return '';
  }
}

export function createExtractionService(options: ExtractionServiceOptions): ExtractionService {
  const cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
  /** Insertion-ordered, and the order the status list is reported in. */
  const jobs = new Map<string, Job>();
  const queue: string[] = [];
  const idleWaiters: (() => void)[] = [];
  let active: ActiveRun | null = null;
  let pumping = false;
  let stopped = false;

  function summarize(job: Job): WireExtractionJob {
    return {
      sourceId: job.sourceId,
      fileName: job.fileName,
      status: job.status,
      progress: job.progress,
      detail: job.detail,
      note: job.note,
      errorCode: job.errorCode,
      warnings: [...job.warnings],
      objectCount: job.objectCount,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      cancellable: RUNNING_STATUSES.has(job.status),
    };
  }

  /** Reports a change, but only for a job that is still the one for its source. */
  function announce(job: Job, settledWith: ExtractionOutcome | null, isFinal: boolean): void {
    if (jobs.get(job.sourceId) !== job) {
      return;
    }
    const summary = summarize(job);
    options.onChanged(summary);
    if (isFinal) {
      options.onSettled(summary, settledWith);
    }
  }

  function moveTo(
    job: Job,
    status: WireExtractionStatus,
    progress: number | null,
    detail: string,
  ): void {
    job.status = status;
    job.progress = progress;
    job.detail = detail;
    if (
      status === 'queued' ||
      status === 'hashing' ||
      status === 'opening' ||
      status === 'extracting' ||
      status === 'finalizing'
    ) {
      job.note = describeExtractionProgress(status, job.fileName);
    }
    announce(job, null, false);
  }

  function settleFailure(job: Job, code: string, detail: string): void {
    job.status = code === LAUNCHER_ERROR_CODES.cancelled ? 'cancelled' : 'failed';
    job.progress = null;
    job.detail = detail;
    job.errorCode = code;
    job.note = describeExtractionFailure(code, detail);
    job.finishedAt = new Date().toISOString();
    cleanPartials(job, job.status === 'cancelled');
    announce(job, null, true);
  }

  function settleSuccess(job: Job, outcome: ExtractionOutcome): void {
    job.status = outcome.reusedExistingCache ? 'cache-hit' : 'ready';
    job.progress = 1;
    job.detail = '';
    job.errorCode = null;
    job.objectCount = outcome.objectCount;
    job.cachePath = outcome.cachePath;
    job.note = describeExtractionSuccess(
      job.fileName,
      outcome.objectCount,
      outcome.sourceModelCount,
      outcome.reusedExistingCache,
    );
    job.finishedAt = new Date().toISOString();
    // Belt and braces: a successful run leaves nothing behind either, but the
    // check costs nothing and a stray `.partial` would be read as a cache by
    // nobody and confuse everybody.
    cleanPartials(job, false);
    announce(job, outcome, true);
  }

  /**
   * Removes what a run that did not finish can leave in the cache directory.
   *
   * The launcher deletes its own partial cache in a `finally` and its stream
   * too unless the stream is the evidence for a failure (ExtractionRunner.Run).
   * A launcher that was killed never ran that `finally`, and this is the only
   * other process that knows the file names, so it checks. The stream is kept
   * for a failure, exactly as the launcher would have kept it, and removed
   * after a cancel, which is not a failure to diagnose.
   */
  function cleanPartials(job: Job, includeStream: boolean): void {
    if (job.rawSha256 === null) {
      return;
    }
    const [partialCache, stream] = partialFileNames(job.rawSha256);
    const remove = (name: string | undefined): void => {
      if (name === undefined) {
        return;
      }
      try {
        rmSync(path.join(options.cacheDirectory, name), { force: true });
      } catch {
        // A locked temp file is not worth failing a finished job over; the
        // next run for these bytes overwrites it.
      }
    };
    remove(partialCache);
    if (includeStream) {
      remove(stream);
    }
  }

  /**
   * Opens a produced cache and checks it is what it claims to be.
   *
   * Three checks, and each one has a different lie behind it: unreadable is a
   * cache this build cannot use, empty is a run that walked nothing, and a
   * `meta.input_sha256` that disagrees with the file we hashed is a cache
   * belonging to a different model. Associating any of the three would put
   * numbers nobody produced behind a compile.
   */
  function validateCache(cachePath: string, rawSha256: string): CacheValidation {
    let objectCount = 0;
    let sourceModelCount = 0;
    let inputSha256 = '';

    try {
      const cache = openExtractionCache(cachePath);
      try {
        objectCount = cache.objectCount();
        sourceModelCount = cache.sourceModels().length;
        inputSha256 = cache.meta().inputSha256;
      } finally {
        cache.close();
      }
    } catch (error: unknown) {
      return {
        ok: false,
        code: SERVICE_ERROR_CODES.cacheUnreadable,
        detail: error instanceof Error ? error.message : String(error),
        objectCount: 0,
        sourceModelCount: 0,
      };
    }

    if (inputSha256 !== rawSha256) {
      return {
        ok: false,
        code: SERVICE_ERROR_CODES.cacheMismatch,
        detail: `The cache records input_sha256 ${inputSha256}; this file hashes to ${rawSha256}.`,
        objectCount,
        sourceModelCount,
      };
    }
    if (objectCount === 0) {
      return {
        ok: false,
        code: SERVICE_ERROR_CODES.cacheEmpty,
        detail: 'The extraction produced a cache with no objects in it.',
        objectCount,
        sourceModelCount,
      };
    }
    return { ok: true, code: '', detail: '', objectCount, sourceModelCount };
  }

  /** Turns a validated cache into the outcome the session records. */
  async function associate(
    job: Job,
    cachePath: string,
    rawSha256: string,
    validation: CacheValidation,
    reusedExistingCache: boolean,
  ): Promise<void> {
    let cacheSha256: string;
    try {
      cacheSha256 = (await digestFile(cachePath)).sha256;
    } catch (error: unknown) {
      settleFailure(
        job,
        SERVICE_ERROR_CODES.cacheUnreadable,
        error instanceof Error ? error.message : String(error),
      );
      return;
    }
    settleSuccess(job, {
      sourceId: job.sourceId,
      cachePath,
      cacheSha256,
      rawSha256,
      objectCount: validation.objectCount,
      sourceModelCount: validation.sourceModelCount,
      reusedExistingCache,
    });
  }

  function recordWarning(job: Job, code: string, message: string): void {
    if (job.warnings.length >= MAX_KEPT_WARNINGS) {
      return;
    }
    job.warnings = [...job.warnings, { code, message: describeExtractionWarning(code, message) }];
  }

  /** Runs the launcher and resolves when the child has exited and been judged. */
  function runLauncher(job: Job, rawSha256: string): Promise<void> {
    return new Promise<void>((resolve): void => {
      let result: { readonly status: 'ok' | 'cache-hit'; readonly cachePath: string } | null = null;
      let failure: { readonly code: string; readonly message: string } | null = null;
      let settled = false;

      const child = options.launcher(
        extractorArguments(job.inputPath, options.cacheDirectory, rawSha256),
        {
          onMessage(message: ExtractionMessage): void {
            switch (message.type) {
              case 'progress': {
                const status = statusForStage(message.stage);
                if (status === null) {
                  return;
                }
                moveTo(
                  job,
                  status,
                  progressForStage(message.stage, message.done, message.total),
                  detailForStage(message.stage, message.done, message.total, message.detail),
                );
                return;
              }
              case 'warning':
                recordWarning(job, message.code, message.message);
                announce(job, null, false);
                return;
              case 'result':
                result = { status: message.status, cachePath: message.cachePath };
                return;
              case 'error':
                failure = { code: message.code, message: message.message };
                return;
              default:
                return;
            }
          },

          onExit(exit): void {
            if (settled) {
              return;
            }
            settled = true;
            if (active?.job === job) {
              if (active.killTimer !== null) {
                clearTimeout(active.killTimer);
              }
              active = null;
            }

            void (async (): Promise<void> => {
              // A cancel that arrived after the child had already produced a
              // cache still counts as cancelled: the user asked, and reporting
              // a source as ready because the race went the other way would be
              // the app disagreeing with the button that was pressed.
              if (job.cancelRequested) {
                settleFailure(job, LAUNCHER_ERROR_CODES.cancelled, 'Extraction cancelled.');
                resolve();
                return;
              }
              if (failure !== null) {
                const reported: { readonly code: string; readonly message: string } = failure;
                settleFailure(job, reported.code, reported.message);
                resolve();
                return;
              }
              if (result !== null) {
                const produced: { readonly status: 'ok' | 'cache-hit'; readonly cachePath: string } =
                  result;
                const validation = validateCache(produced.cachePath, rawSha256);
                if (!validation.ok) {
                  settleFailure(job, validation.code, validation.detail);
                  resolve();
                  return;
                }
                await associate(
                  job,
                  produced.cachePath,
                  rawSha256,
                  validation,
                  produced.status === 'cache-hit',
                );
                resolve();
                return;
              }
              // Nothing on the protocol channel at all. The exit code is the
              // launcher's other way of saying what went wrong.
              settleFailure(
                job,
                exit.code === 0 ? SERVICE_ERROR_CODES.extractorStopped : errorCodeForExitCode(exit.code),
                exit.diagnostics === ''
                  ? `The extractor exited with code ${String(exit.code ?? -1)}.`
                  : exit.diagnostics,
              );
              resolve();
            })();
          },
        },
      );

      active = { job, child, killTimer: null };
      // Cancelled between being queued and being launched: the child exists
      // now, so the request that could not be delivered then is delivered here.
      if (job.cancelRequested) {
        escalateCancel();
      }
    });
  }

  /** Asks the launcher to stop, and schedules the signal that follows. */
  function escalateCancel(): void {
    const run = active;
    if (run === null || run.killTimer !== null) {
      return;
    }
    run.child.requestCancel();
    const timer = setTimeout((): void => {
      run.killTimer = null;
      // Still the same run, still not exited: it ignored the protocol.
      if (active === run) {
        run.child.kill();
      }
    }, cancelGraceMs);
    timer.unref();
    run.killTimer = timer;
  }

  async function runJob(job: Job): Promise<void> {
    if (job.rawSha256 === null) {
      moveTo(job, 'hashing', null, '');
      try {
        const digest = await digestFile(job.inputPath, (done: number, total: number): void => {
          moveTo(
            job,
            'hashing',
            progressForStage('hash', done, total),
            detailForStage('hash', done, total, null),
          );
        });
        job.rawSha256 = digest.sha256;
      } catch (error: unknown) {
        settleFailure(
          job,
          existsSync(job.inputPath)
            ? LAUNCHER_ERROR_CODES.openFailed
            : LAUNCHER_ERROR_CODES.inputNotFound,
          error instanceof Error ? error.message : String(error),
        );
        return;
      }
    }
    const rawSha256 = job.rawSha256;

    if (job.cancelRequested) {
      settleFailure(job, LAUNCHER_ERROR_CODES.cancelled, 'Extraction cancelled before it started.');
      return;
    }

    try {
      mkdirSync(options.cacheDirectory, { recursive: true });
    } catch (error: unknown) {
      settleFailure(
        job,
        LAUNCHER_ERROR_CODES.cacheWriteFailed,
        error instanceof Error ? error.message : String(error),
      );
      return;
    }

    // The cache-hit check happens here as well as inside the launcher, and
    // that is the point: a model that has not changed must never start
    // Navisworks at all (docs/EXTRACTION.md, "Cache reuse by content hash").
    const cachePath = path.join(options.cacheDirectory, cacheFileName(rawSha256));
    if (existsSync(cachePath)) {
      const validation = validateCache(cachePath, rawSha256);
      if (validation.ok) {
        await associate(job, cachePath, rawSha256, validation, true);
        return;
      }
      // Present but not trustworthy. Left where it is: the launcher discards a
      // stale cache itself and says so with STALE_CACHE_DISCARDED, and two
      // processes deleting the same file is one race nobody needs.
    }

    // The hash goes on the command line (`--input-sha256`), so the launcher
    // does not read the whole model again to work out what it already knows —
    // it reports the hash stage as done and goes straight to detection. The row
    // therefore steps forward from here rather than back through `hashing`.
    moveTo(job, 'opening', null, 'Starting the extractor.');
    await runLauncher(job, rawSha256);
  }

  function resolveIdle(): void {
    if (queue.length > 0 || active !== null || pumping) {
      return;
    }
    const waiters = idleWaiters.splice(0, idleWaiters.length);
    for (const waiter of waiters) {
      waiter();
    }
  }

  async function pump(): Promise<void> {
    if (pumping) {
      return;
    }
    pumping = true;
    try {
      for (;;) {
        const next = queue.shift();
        if (next === undefined) {
          break;
        }
        const job = jobs.get(next);
        // Dropped, superseded, or cancelled while it waited.
        if (job === undefined || job.status !== 'queued') {
          continue;
        }
        await runJob(job);
      }
    } finally {
      pumping = false;
      resolveIdle();
    }
  }

  return {
    enqueue(request: ExtractionJobRequest): void {
      if (stopped) {
        return;
      }
      const previous = jobs.get(request.sourceId);
      if (previous !== undefined && RUNNING_STATUSES.has(previous.status)) {
        // Same source, new bytes (or a retry). The run in flight is stopped
        // rather than left to finish and associate a cache for a file this
        // project no longer describes.
        previous.cancelRequested = true;
        if (active?.job === previous) {
          escalateCancel();
        }
      }

      const job: Job = {
        sourceId: request.sourceId,
        fileName: request.fileName,
        inputPath: request.inputPath,
        rawSha256: request.rawSha256,
        status: 'queued',
        progress: null,
        detail: '',
        note: describeExtractionProgress('queued', request.fileName),
        errorCode: null,
        warnings: [],
        objectCount: null,
        cachePath: null,
        startedAt: new Date().toISOString(),
        finishedAt: null,
        cancelRequested: false,
      };
      // Re-inserted rather than updated, so a job that is being superseded can
      // still tell it is no longer the one for its source (see `announce`).
      jobs.delete(request.sourceId);
      jobs.set(request.sourceId, job);
      queue.push(request.sourceId);
      announce(job, null, false);
      // On the next turn of the loop, not this one. Enqueuing is bookkeeping,
      // and a caller that has just registered a source is entitled to see it
      // queued rather than to have the first stage of its extraction run inside
      // its own call.
      setImmediate((): void => {
        void pump();
      });
    },

    cancel(sourceId: string): boolean {
      const job = jobs.get(sourceId);
      if (job === undefined || !RUNNING_STATUSES.has(job.status)) {
        return false;
      }
      job.cancelRequested = true;
      if (active?.job === job) {
        escalateCancel();
        return true;
      }
      // Queued, or hashing before any child exists. Hashing finishes its
      // current chunk and then sees the flag; a queued job is settled here so
      // the row stops saying it is waiting for something that will not happen.
      if (job.status === 'queued') {
        settleFailure(job, LAUNCHER_ERROR_CODES.cancelled, 'Extraction cancelled before it started.');
      }
      return true;
    },

    jobs(): readonly WireExtractionJob[] {
      return [...jobs.values()].map(summarize);
    },

    job(sourceId: string): WireExtractionJob | null {
      const job = jobs.get(sourceId);
      return job === undefined ? null : summarize(job);
    },

    forget(sourceId: string): void {
      const job = jobs.get(sourceId);
      if (job === undefined) {
        return;
      }
      if (RUNNING_STATUSES.has(job.status)) {
        job.cancelRequested = true;
        if (active?.job === job) {
          escalateCancel();
        }
      }
      jobs.delete(sourceId);
    },

    shutdown(): void {
      stopped = true;
      queue.length = 0;
      for (const job of jobs.values()) {
        job.cancelRequested = true;
      }
      const run = active;
      if (run !== null) {
        // Closing a project is not the moment for a ten-second grace period:
        // ask and signal together, so no Navisworks outlives the window.
        run.child.requestCancel();
        run.child.kill();
      }
    },

    whenIdle(): Promise<void> {
      if (queue.length === 0 && active === null && !pumping) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve): void => {
        idleWaiters.push(resolve);
      });
    },
  };
}
