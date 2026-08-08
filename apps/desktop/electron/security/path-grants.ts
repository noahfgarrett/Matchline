import path from 'node:path';

/**
 * Which absolute paths the renderer is allowed to name (PRODUCT.md §16).
 *
 * Every channel that reads or writes a file takes a path *string*, and a string
 * from the renderer is a request, not an authority. The only place a path
 * legitimately enters the renderer is a native dialog the user drove, or the
 * recents list main itself keeps — so those are the only two places that grant,
 * and a path that was never granted is refused before any handler opens it.
 *
 * This is not a sandbox and does not pretend to be one: a compromised renderer
 * still gets whatever the user picks in a dialog. What it removes is the class
 * where the renderer picks on its own — reading `~/.ssh/id_rsa` through
 * `export:template-analyze`, or writing an export over a file nobody chose.
 *
 * Grants are for the life of one open project. Closing a project clears them,
 * because the paths that made sense for it are not the ones that make sense for
 * the next.
 */

/** How many paths one session may accumulate before the oldest fall off. */
const DEFAULT_LIMIT = 512;

export interface PathGrants {
  /** Records paths a dialog returned, or that main itself produced. */
  grant(...paths: readonly string[]): void;
  /** Whether this exact file has been granted in this session. */
  isGranted(candidate: string): boolean;
  /** Forgets everything. Called when a project closes. */
  clear(): void;
  /** How many paths are currently granted. For tests and the cap. */
  readonly size: number;
}

/**
 * Paths are compared after `path.resolve`, so `./Dragon.matchline` and an
 * absolute spelling of the same file are one entry rather than two.
 *
 * The comparison is deliberately exact rather than by directory: granting a
 * folder because one file in it was chosen is how "the user picked a file"
 * quietly becomes "the user picked everything next to it".
 */
export function createPathGrants(limit: number = DEFAULT_LIMIT): PathGrants {
  // Insertion-ordered, which is what makes "drop the oldest" a first key.
  const granted = new Set<string>();

  const normalize = (candidate: string): string | null => {
    if (candidate === '') {
      return null;
    }
    try {
      return path.resolve(candidate);
    } catch {
      return null;
    }
  };

  return {
    grant(...paths: readonly string[]): void {
      for (const candidate of paths) {
        const resolved = normalize(candidate);
        if (resolved === null) {
          continue;
        }
        // Re-granting moves an entry to the back of the eviction queue, so the
        // file the user keeps choosing is not the one that falls off.
        granted.delete(resolved);
        granted.add(resolved);
        while (granted.size > limit) {
          const oldest = granted.values().next();
          if (oldest.done === true) {
            break;
          }
          granted.delete(oldest.value);
        }
      }
    },

    isGranted(candidate: string): boolean {
      const resolved = normalize(candidate);
      return resolved !== null && granted.has(resolved);
    },

    clear(): void {
      granted.clear();
    },

    get size(): number {
      return granted.size;
    },
  };
}
