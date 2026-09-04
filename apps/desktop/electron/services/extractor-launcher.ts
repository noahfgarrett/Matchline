import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  SERVICE_ERROR_CODES,
  parseExtractionLine,
  type ExtractionMessage,
} from './extraction-protocol.js';

/**
 * Running the extractor, and the seam that makes it testable.
 *
 * The extraction service never spawns anything itself. It calls an
 * {@link ExtractorLauncher} with the launcher's real argument list and gets a
 * handle back, which is the whole of its knowledge about processes. Two
 * implementations satisfy it:
 *
 * - {@link createProcessExtractorLauncher} spawns a command and speaks the
 *   protocol to it. In production that command is `Matchline.Extractor.exe`;
 *   in the tests it is `node` running a fake that emits the same JSON lines
 *   and writes a real cache. Both go through this same code, so the parsing,
 *   the stdin cancel and the SIGTERM/SIGKILL escalation are exercised for real
 *   on a machine that has no Navisworks.
 * - {@link createUnavailableExtractorLauncher} never spawns anything and
 *   reports one error. It is what a Mac gets, and it is a launcher rather than
 *   a special case in the service so that "this machine cannot extract" flows
 *   through exactly the same failure path as "Navisworks is not installed".
 */

export interface ExtractorCallbacks {
  /** One parsed protocol line. Unparseable lines never reach here. */
  readonly onMessage: (message: ExtractionMessage) => void;
  /** Called exactly once, after the last message, whatever ended the run. */
  readonly onExit: (exit: ExtractorExit) => void;
}

export interface ExtractorExit {
  readonly code: number | null;
  readonly signal: string | null;
  /**
   * Whatever the child put on stderr, capped.
   *
   * stdout is the protocol and stderr is diagnostics (Program.cs), so this is
   * the only place a crash message can appear when nothing was emitted on the
   * protocol channel at all.
   */
  readonly diagnostics: string;
}

export interface ExtractorChild {
  /**
   * The launcher's own cancellation: one `cancel` line on stdin.
   *
   * Preferred over a signal because the launcher answers it by killing the
   * Navisworks process it started, deleting its partials and exiting with
   * `CANCELLED` — a signal skips all three.
   */
  readonly requestCancel: () => void;
  /** SIGTERM now; SIGKILL after the grace period if it is still alive. */
  readonly kill: () => void;
}

export type ExtractorLauncher = (
  args: readonly string[],
  callbacks: ExtractorCallbacks,
) => ExtractorChild;

/** How long a SIGTERM has to work before SIGKILL follows. */
const DEFAULT_KILL_GRACE_MS = 5_000;

/** stderr kept for a failure report. Enough for a stack, not enough to matter. */
const MAX_DIAGNOSTIC_BYTES = 8_192;

export interface ProcessLauncherOptions {
  /** The executable to run. */
  readonly command: string;
  /**
   * Arguments that come before the launcher's own — empty in production.
   *
   * It exists because the thing being run is not always the exe: the tests run
   * `node <fake>.mjs`, and a wrapper (a profiler, a remote shell) would be the
   * same shape. The launcher's arguments are appended unchanged either way,
   * which is what keeps the fake honest about the real command line.
   */
  readonly commandArgs?: readonly string[];
  readonly killGraceMs?: number;
}

export function createProcessExtractorLauncher(
  options: ProcessLauncherOptions,
): ExtractorLauncher {
  const prefix = options.commandArgs ?? [];
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

  return (args: readonly string[], callbacks: ExtractorCallbacks): ExtractorChild => {
    let child: ChildProcess;
    try {
      child = spawn(options.command, [...prefix, ...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error: unknown) {
      return failedToStart(callbacks, error);
    }

    let finished = false;
    let stdoutRest = '';
    let diagnostics = '';
    let killTimer: NodeJS.Timeout | null = null;

    const finish = (code: number | null, signal: string | null): void => {
      if (finished) {
        return;
      }
      finished = true;
      if (killTimer !== null) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      // A last line with no newline behind it is still a message.
      readLines(stdoutRest, true).forEach(deliver);
      stdoutRest = '';
      callbacks.onExit({ code, signal, diagnostics });
    };

    const deliver = (line: string): void => {
      const message = parseExtractionLine(line);
      if (message !== null) {
        callbacks.onMessage(message);
      }
    };

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string): void => {
      stdoutRest += chunk;
      const newlineAt = stdoutRest.lastIndexOf('\n');
      if (newlineAt < 0) {
        return;
      }
      const complete = stdoutRest.slice(0, newlineAt);
      stdoutRest = stdoutRest.slice(newlineAt + 1);
      readLines(complete, false).forEach(deliver);
    });

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string): void => {
      if (diagnostics.length < MAX_DIAGNOSTIC_BYTES) {
        diagnostics = (diagnostics + chunk).slice(0, MAX_DIAGNOSTIC_BYTES);
      }
    });

    // A broken pipe is what a child that has already exited looks like from
    // here. It is never a reason to take the app down.
    child.stdin?.on('error', (): void => {});
    child.on('error', (error: Error): void => {
      diagnostics = diagnostics === '' ? error.message : `${diagnostics}\n${error.message}`;
      finish(null, null);
    });
    child.on('close', (code: number | null, signal: NodeJS.Signals | null): void => {
      finish(code, signal);
    });

    return {
      requestCancel(): void {
        if (finished) {
          return;
        }
        try {
          child.stdin?.write('cancel\n');
        } catch {
          // Already gone; `close` will arrive on its own.
        }
      },
      kill(): void {
        if (finished) {
          return;
        }
        child.kill('SIGTERM');
        if (killTimer !== null) {
          return;
        }
        killTimer = setTimeout((): void => {
          killTimer = null;
          if (!finished) {
            child.kill('SIGKILL');
          }
        }, killGraceMs);
        // A pending kill timer must never be the reason the app stays alive.
        killTimer.unref();
      },
    };
  };
}

/** Splits a chunk into lines, dropping the empty tail a trailing newline leaves. */
function readLines(text: string, isTail: boolean): readonly string[] {
  if (text === '') {
    return [];
  }
  const lines = text.split('\n');
  return isTail ? lines.filter((line: string): boolean => line.trim() !== '') : lines;
}

/**
 * A launcher that answers one error and never starts anything.
 *
 * The message is the caller's, because the two reasons to use it are different
 * facts about the machine: not Windows at all, or Windows with the extractor
 * missing.
 */
export function createUnavailableExtractorLauncher(
  code: string,
  message: string,
): ExtractorLauncher {
  return (_args: readonly string[], callbacks: ExtractorCallbacks): ExtractorChild => {
    // Asynchronous so that a caller which wires up state after calling the
    // launcher sees the failure in the same order it would from a real child.
    setImmediate((): void => {
      callbacks.onMessage({ type: 'error', code, message });
      callbacks.onExit({ code: 1, signal: null, diagnostics: '' });
    });
    return { requestCancel: (): void => {}, kill: (): void => {} };
  };
}

function failedToStart(callbacks: ExtractorCallbacks, error: unknown): ExtractorChild {
  const message = error instanceof Error ? error.message : String(error);
  setImmediate((): void => {
    callbacks.onMessage({
      type: 'error',
      code: SERVICE_ERROR_CODES.extractorNotInstalled,
      message,
    });
    callbacks.onExit({ code: null, signal: null, diagnostics: message });
  });
  return { requestCancel: (): void => {}, kill: (): void => {} };
}

/* --------------------------------------------------------- production choice */

/** The launcher executable, as it ships beside a packaged app. */
const EXTRACTOR_EXECUTABLE = 'Matchline.Extractor.exe';

/**
 * Where the packaged app keeps the extractor.
 *
 * `MATCHLINE_EXTRACTOR_PATH` overrides it, which is how a Windows developer
 * points the app at `native\extractor\bin\Release` without packaging first —
 * the same folder docs/WINDOWS-RUNBOOK.md runs the launcher from by hand.
 */
export function defaultExtractorPath(): string {
  const override = process.env['MATCHLINE_EXTRACTOR_PATH'];
  if (override !== undefined && override !== '') {
    return override;
  }
  // Electron sets `resourcesPath`; a plain node process running the service in
  // a test does not, and falls back to a path relative to the built output.
  const resourcesPath: unknown = (process as unknown as Record<string, unknown>)['resourcesPath'];
  const root =
    typeof resourcesPath === 'string' && resourcesPath !== ''
      ? resourcesPath
      : path.join(import.meta.dirname, '..', '..');
  return path.join(root, 'extractor', EXTRACTOR_EXECUTABLE);
}

export interface ResolveLauncherOptions {
  readonly platform: NodeJS.Platform;
  readonly executablePath: string;
}

/**
 * The launcher this machine can honestly offer.
 *
 * Both refusals are decided here rather than at spawn time so that the reason
 * reaches the user as a sentence about their machine instead of as a failure to
 * start a process.
 */
export function resolveExtractorLauncher(options: ResolveLauncherOptions): ExtractorLauncher {
  const capability = extractionCapability(options);
  if (!capability.available) {
    return createUnavailableExtractorLauncher(capability.code, capability.reason);
  }
  return createProcessExtractorLauncher({ command: options.executablePath });
}

/**
 * Whether this machine can extract at all, and why not when it cannot.
 *
 * The same question {@link resolveExtractorLauncher} answers, asked without
 * starting anything — because the honest place to say "not here" is before a
 * file is dropped, not in a row that says `failed` afterwards. A Mac is a
 * perfectly good machine for everything else Matchline does; it simply has no
 * Navisworks to drive, and telling the user that up front is the difference
 * between a limitation and a fault.
 */
export interface ExtractionCapability {
  readonly available: boolean;
  /** The failure code a job would settle with, or `''` when extraction works. */
  readonly code: string;
  /** One sentence naming what is missing, or `''` when nothing is. */
  readonly reason: string;
}

export function extractionCapability(options: ResolveLauncherOptions): ExtractionCapability {
  if (options.platform !== 'win32') {
    return {
      available: false,
      code: SERVICE_ERROR_CODES.unavailableOnThisPlatform,
      reason:
        `Navisworks runs on Windows only, and this copy of Matchline is running on ${options.platform}.`,
    };
  }
  if (!existsSync(options.executablePath)) {
    return {
      available: false,
      code: SERVICE_ERROR_CODES.extractorNotInstalled,
      reason: `${EXTRACTOR_EXECUTABLE} was not found at ${options.executablePath}.`,
    };
  }
  return { available: true, code: '', reason: '' };
}
