/**
 * The launcher's stdout protocol, read from the TypeScript side.
 *
 * `Matchline.Extractor.exe` writes one JSON object per line to stdout and
 * nothing else (native/extractor/Program.cs), so a parent process can parse
 * stdout blindly. This module is the mirror of
 * `native/navisworks-common/Protocol/ProgressReporter.cs` and
 * `ExtractionProtocol.cs`: the same four message types, the same stage names,
 * the same error codes, the same exit codes. Nothing here interprets a message
 * for a person — that is `extraction-messages.ts` — and nothing here runs a
 * process — that is `extractor-launcher.ts`.
 *
 * A line this build does not understand is dropped rather than treated as a
 * failure: a newer launcher may add a message type, and refusing to read the
 * rest of a run over one unknown line would turn an addition into an outage.
 */

/**
 * Stage names the launcher emits, in the order a full run produces them
 * (`ExtractionStages`). `detect` names the Navisworks that will open the file
 * and is the only stage that always carries a `detail` sentence.
 *
 * `sets` sits between the walk and the convert because that is where
 * `DocumentWalker` emits it: the saved sets are resolved after the tree has
 * been walked and before the stream is turned into a cache. It is its own stage
 * rather than part of the walk because resolving one saved search re-runs that
 * search over the whole model — a document with a few dozen of them sits here
 * for minutes after the last object record was written, and without a line of
 * its own the walk counter simply stops moving and the run looks hung. Unlike
 * the walk and the convert it knows its total, because the set tree is counted
 * before the first one is resolved.
 */
export const EXTRACTION_STAGES = [
  'hash',
  'detect',
  'open',
  'walk',
  'sets',
  'convert',
  'finalize',
] as const;
export type ExtractionStage = (typeof EXTRACTION_STAGES)[number];

/**
 * Error codes the launcher emits (`ExtractionErrorCodes`). SCREAMING_SNAKE by
 * convention, which is also how they are told apart from the service's own
 * codes below: anything kebab-cased was decided in this process.
 */
export const LAUNCHER_ERROR_CODES = {
  /** NWD published by a newer Navisworks than the installed adapter. */
  navisworksVersionTooNew: 'NW_VERSION_TOO_NEW',
  /** No licensed Navisworks Manage/Simulate install found — or none with an adapter. */
  navisworksNotInstalled: 'NW_NOT_INSTALLED',
  openFailed: 'OPEN_FAILED',
  cancelled: 'CANCELLED',
  invalidArguments: 'INVALID_ARGS',
  inputNotFound: 'INPUT_NOT_FOUND',
  extractFailed: 'EXTRACT_FAILED',
  /**
   * Navisworks stopped writing to the extraction stream and was killed.
   *
   * Its own code because its cause is almost never the model: a headless
   * Navisworks that goes quiet is usually behind a modal dialog on a desktop
   * nobody is looking at (a sign-in, a licence prompt, the autosave-recovery
   * box after a previous run was killed), and no amount of re-adding the file
   * will dismiss it.
   */
  navisworksStalled: 'NW_STALLED',
  /** The add-in is not in the Plugins folder — decided before Navisworks starts. */
  pluginNotDeployed: 'PLUGIN_NOT_DEPLOYED',
  /** Navisworks ran and the add-in never wrote a stream at all. */
  pluginNotFound: 'PLUGIN_NOT_FOUND',
  cacheWriteFailed: 'CACHE_WRITE_FAILED',
  internal: 'INTERNAL',
} as const;

/**
 * Failures decided in this process rather than reported by the launcher.
 *
 * Kebab-cased on purpose: a code that reaches the UI can be traced to the side
 * of the boundary that raised it without looking anything up.
 */
export const SERVICE_ERROR_CODES = {
  /** This machine cannot run the extractor at all (not Windows). */
  unavailableOnThisPlatform: 'extraction-unavailable-on-this-platform',
  /** Windows, but the launcher executable is not where it should be. */
  extractorNotInstalled: 'extractor-not-installed',
  /** The child ended without a result and without an error line. */
  extractorStopped: 'extractor-stopped-unexpectedly',
  /** A cache was produced, and this build cannot read it. */
  cacheUnreadable: 'cache-unreadable',
  /** A readable cache holding no objects at all. */
  cacheEmpty: 'cache-empty',
  /** A readable cache that says it came from different bytes. */
  cacheMismatch: 'cache-mismatch',
  /**
   * The file on disk stopped being the file this job was queued for.
   *
   * The queue is serial and a model can wait behind another for a long time, so
   * "hashed at registration" and "read by Navisworks" are two different moments
   * — and a model re-issued in place between them would be extracted and then
   * stamped with the old hash. Checked immediately before the launcher starts,
   * which is the last moment the answer is still true.
   */
  fileChangedBeforeLaunch: 'file-changed-before-extraction',
} as const;

/** Process exit codes (`native/extractor/ExitCodes.cs`), by launcher code. */
const EXIT_CODE_TO_ERROR: ReadonlyMap<number, string> = new Map([
  [1, LAUNCHER_ERROR_CODES.internal],
  [2, LAUNCHER_ERROR_CODES.invalidArguments],
  [3, LAUNCHER_ERROR_CODES.inputNotFound],
  [4, LAUNCHER_ERROR_CODES.navisworksNotInstalled],
  [5, LAUNCHER_ERROR_CODES.navisworksVersionTooNew],
  [6, LAUNCHER_ERROR_CODES.openFailed],
  [7, LAUNCHER_ERROR_CODES.extractFailed],
  [8, LAUNCHER_ERROR_CODES.cacheWriteFailed],
  [9, LAUNCHER_ERROR_CODES.cancelled],
  [10, LAUNCHER_ERROR_CODES.navisworksStalled],
  [11, LAUNCHER_ERROR_CODES.pluginNotDeployed],
  [12, LAUNCHER_ERROR_CODES.pluginNotFound],
]);

/**
 * The launcher code a bare exit status implies.
 *
 * Only consulted when the child died without saying anything, which is exactly
 * the case the distinct exit codes exist for (`ExitCodes.cs`: "a caller that
 * cannot parse stdout still learns what went wrong").
 */
export function errorCodeForExitCode(exitCode: number | null): string {
  if (exitCode === null) {
    return SERVICE_ERROR_CODES.extractorStopped;
  }
  return EXIT_CODE_TO_ERROR.get(exitCode) ?? SERVICE_ERROR_CODES.extractorStopped;
}

/**
 * How long the launcher waits for a silent Navisworks before killing it.
 *
 * Fifteen minutes, matching `ExtractorArguments.DefaultStallTimeoutSeconds`.
 * Deliberately longer than the service's own `stallWarningMs`: the row says
 * "this looks stuck, you can cancel" well before anything is killed, so the
 * user gets the chance to decide before the launcher does.
 */
export const DEFAULT_STALL_TIMEOUT_SECONDS = 900;

export interface ExtractionProgressMessage {
  readonly type: 'progress';
  readonly stage: string;
  readonly done: number;
  /** `0` means "not known yet" — the walk and convert stages cannot know it. */
  readonly total: number;
  /** Optional in the protocol; `null` when the line carried none. */
  readonly detail: string | null;
}

export interface ExtractionWarningMessage {
  readonly type: 'warning';
  readonly code: string;
  readonly message: string;
  readonly objectId: number | null;
}

export interface ExtractionResultMessage {
  readonly type: 'result';
  readonly status: 'ok' | 'cache-hit';
  readonly cachePath: string;
  readonly objects: number;
  readonly warnings: number;
}

export interface ExtractionErrorMessage {
  readonly type: 'error';
  readonly code: string;
  readonly message: string;
}

export type ExtractionMessage =
  | ExtractionProgressMessage
  | ExtractionWarningMessage
  | ExtractionResultMessage
  | ExtractionErrorMessage;

function textOf(record: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' ? value : null;
}

function numberOf(record: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * One protocol line, or `null` when the line is not one this build reads.
 *
 * Blank lines, non-JSON lines and unknown message types all answer `null`. The
 * launcher promises stdout carries the protocol and nothing else, but a
 * promise is not a parser: anything that arrives malformed is dropped and the
 * run is judged by what it did emit.
 */
export function parseExtractionLine(line: string): ExtractionMessage | null {
  const trimmed = line.trim();
  if (trimmed === '') {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const record = parsed as Record<string, unknown>;
  switch (record['type']) {
    case 'progress': {
      const stage = textOf(record, 'stage');
      if (stage === null) {
        return null;
      }
      return {
        type: 'progress',
        stage,
        done: numberOf(record, 'done') ?? 0,
        total: numberOf(record, 'total') ?? 0,
        detail: textOf(record, 'detail'),
      };
    }
    case 'warning': {
      const code = textOf(record, 'code');
      if (code === null) {
        return null;
      }
      return {
        type: 'warning',
        code,
        message: textOf(record, 'message') ?? '',
        objectId: numberOf(record, 'objectId'),
      };
    }
    case 'result': {
      const status = textOf(record, 'status');
      const cachePath = textOf(record, 'cachePath');
      if ((status !== 'ok' && status !== 'cache-hit') || cachePath === null) {
        return null;
      }
      return {
        type: 'result',
        status,
        cachePath,
        objects: numberOf(record, 'objects') ?? 0,
        warnings: numberOf(record, 'warnings') ?? 0,
      };
    }
    case 'error': {
      const code = textOf(record, 'code');
      if (code === null) {
        return null;
      }
      return { type: 'error', code, message: textOf(record, 'message') ?? '' };
    }
    default:
      return null;
  }
}

/**
 * The launcher's own command line (`ExtractorArguments.TryParse`).
 *
 * Built here, in one place, so the arguments the production launcher spawns
 * and the arguments the test fake parses are literally the same array. The
 * install is deliberately not pinned: the launcher picks the newest installed
 * year it has an adapter for and says which one on its `detect` line, and
 * second-guessing that from here would put the choice in two places.
 *
 * `--stall-timeout-seconds` is passed explicitly rather than left to the
 * launcher's default so that the two halves of the same promise are set in one
 * place: this service warns in the row after `stallWarningMs`, and the launcher
 * gives up and reports `NW_STALLED` after this. The launcher's own default is
 * the same number (`ExtractorArguments.DefaultStallTimeoutSeconds`), so a hand
 * run from a shell behaves the way the app does.
 *
 * `inputSha256` is the hash the service has already streamed for this file, and
 * passing it is what stops the launcher reading a multi-gigabyte model a second
 * time to learn something main worked out minutes ago. The launcher trusts it —
 * see `--input-sha256` in `ExtractorArguments` — which is honest here precisely
 * because the two hashes are of the same bytes: the service refuses to touch a
 * source whose file has changed since it was registered, and a re-added file is
 * re-digested before anything is launched for it.
 */
export function extractorArguments(
  inputPath: string,
  cacheDirectory: string,
  inputSha256: string,
  stallTimeoutSeconds: number = DEFAULT_STALL_TIMEOUT_SECONDS,
): readonly string[] {
  return [
    '--input',
    inputPath,
    '--cache-dir',
    cacheDirectory,
    '--input-sha256',
    inputSha256,
    '--stall-timeout-seconds',
    String(Math.max(0, Math.round(stallTimeoutSeconds))),
  ];
}

/** The file name the launcher gives a cache built from these bytes. */
export function cacheFileName(rawSha256: string): string {
  return `${rawSha256}.sqlite`;
}

/** The two files a run leaves behind if it is killed before it can tidy up. */
export function partialFileNames(rawSha256: string): readonly string[] {
  return [`${rawSha256}.sqlite.partial`, `${rawSha256}.ndjson.tmp`];
}
