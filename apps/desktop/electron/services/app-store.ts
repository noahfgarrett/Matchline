import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The app's own small state file, kept in `app.getPath('userData')`.
 *
 * Two things live here, and neither belongs in a `.matchline` project:
 *
 * - **Recent projects.** A list of files this installation has opened. It is
 *   about the machine, not about any one site.
 * - **A sha256 → absolute path index.** A project file records source *names*
 *   and hashes and deliberately no directories (PRODUCT.md §13.3), so reopening
 *   a project cannot on its own find the workbook or extraction cache a source
 *   row refers to. This index is how the app remembers where it last saw a file
 *   with that hash. It is a convenience, never authority: a hash that resolves
 *   to a file whose bytes no longer match is treated as missing, and a project
 *   that opens on another machine simply asks for the files again.
 *
 * Writes are atomic (temp file + rename) so a crash mid-write cannot leave the
 * installation with an unparseable state file.
 */

export interface RecentProjectEntry {
  readonly path: string;
  readonly name: string;
  readonly openedAt: string;
}

interface AppState {
  readonly version: 1;
  readonly recentProjects: readonly RecentProjectEntry[];
  /** Lowercase hex sha256 → the absolute path the file was last seen at. */
  readonly sourcePaths: Readonly<Record<string, string>>;
}

const STATE_FILE_NAME = 'app-state.json';
const MAX_RECENT_PROJECTS = 12;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const EMPTY_STATE: AppState = { version: 1, recentProjects: [], sourcePaths: {} };

export interface AppStateStore {
  readonly filePath: string;
  recentProjects(): readonly RecentProjectEntry[];
  rememberProject(entry: RecentProjectEntry): void;
  /** Where a file with this hash was last seen, or `undefined`. */
  sourcePath(sha256: string): string | undefined;
  rememberSourcePath(sha256: string, absolutePath: string): void;
}

/** Reads one entry, returning `null` rather than throwing on anything odd. */
function readEntry(value: unknown): RecentProjectEntry | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const entryPath = record['path'];
  const name = record['name'];
  const openedAt = record['openedAt'];
  if (typeof entryPath !== 'string' || entryPath.length === 0) {
    return null;
  }
  if (typeof name !== 'string' || name.length === 0) {
    return null;
  }
  if (typeof openedAt !== 'string' || openedAt.length === 0) {
    return null;
  }
  return { path: entryPath, name, openedAt };
}

/**
 * A hand-edited or truncated state file must not stop the app starting, so
 * anything unreadable degrades to the empty state rather than throwing.
 */
function parseState(text: string): AppState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return EMPTY_STATE;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return EMPTY_STATE;
  }

  const record = parsed as Record<string, unknown>;

  const rawRecents = record['recentProjects'];
  const recentProjects: RecentProjectEntry[] = [];
  if (Array.isArray(rawRecents)) {
    for (const candidate of rawRecents) {
      const entry = readEntry(candidate);
      if (entry !== null) {
        recentProjects.push(entry);
      }
    }
  }

  const rawPaths = record['sourcePaths'];
  const sourcePaths: Record<string, string> = {};
  if (typeof rawPaths === 'object' && rawPaths !== null) {
    for (const [hash, value] of Object.entries(rawPaths as Record<string, unknown>)) {
      if (SHA256_PATTERN.test(hash) && typeof value === 'string' && value.length > 0) {
        sourcePaths[hash] = value;
      }
    }
  }

  return { version: 1, recentProjects, sourcePaths };
}

/**
 * Opens (or creates) the state file under `userDataDir`.
 *
 * Takes the directory rather than calling `app.getPath` so the tests can point
 * it at a temp dir without loading Electron.
 */
export function createAppStateStore(userDataDir: string): AppStateStore {
  const filePath = path.join(userDataDir, STATE_FILE_NAME);

  let state: AppState = existsSync(filePath)
    ? parseState(readFileSync(filePath, 'utf8'))
    : EMPTY_STATE;

  const persist = (): void => {
    mkdirSync(userDataDir, { recursive: true });
    const temporaryPath = `${filePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    renameSync(temporaryPath, filePath);
  };

  return {
    filePath,

    recentProjects(): readonly RecentProjectEntry[] {
      return state.recentProjects;
    },

    rememberProject(entry: RecentProjectEntry): void {
      const withoutDuplicate = state.recentProjects.filter(
        (candidate: RecentProjectEntry): boolean => candidate.path !== entry.path,
      );
      state = {
        ...state,
        recentProjects: [entry, ...withoutDuplicate].slice(0, MAX_RECENT_PROJECTS),
      };
      persist();
    },

    sourcePath(sha256: string): string | undefined {
      return state.sourcePaths[sha256];
    },

    rememberSourcePath(sha256: string, absolutePath: string): void {
      if (!SHA256_PATTERN.test(sha256)) {
        throw new Error(`"${sha256}" is not a lowercase hex sha256 digest.`);
      }
      state = {
        ...state,
        sourcePaths: { ...state.sourcePaths, [sha256]: absolutePath },
      };
      persist();
    },
  };
}
