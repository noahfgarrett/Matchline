/**
 * Every way a project file can be refused, as data rather than as a message
 * string.
 *
 * Mirrors `@matchline/model-schema`'s `CacheValidationError`: callers switch on
 * `reason.kind`, and the human-readable message is derived from the reason so
 * the two can never drift apart. A project file that fails any of these checks
 * is refused outright rather than opened partially -- a half-understood project
 * would put wrong numbers in front of an engineer, and this file is the only
 * copy of a site's decisions.
 */

/** Why a project file, or a call against one, was refused. */
export type ProjectStoreReason =
  | { readonly kind: 'cannot-open'; readonly path: string; readonly detail: string }
  | { readonly kind: 'not-found'; readonly path: string }
  | { readonly kind: 'already-exists'; readonly path: string }
  | { readonly kind: 'missing-table'; readonly table: string }
  | { readonly kind: 'missing-meta-key'; readonly key: string }
  | { readonly kind: 'malformed-meta-value'; readonly key: string; readonly value: string }
  | {
      readonly kind: 'unsupported-schema-version';
      readonly found: number;
      readonly supported: number;
    }
  | {
      readonly kind: 'migration-required';
      readonly found: number;
      readonly supported: number;
    }
  /**
   * The file changed version between planning the migration and taking the
   * write lock -- another process upgraded it first.
   */
  | {
      readonly kind: 'migration-raced';
      readonly path: string;
      /** The version the step list was chosen for. */
      readonly expected: number;
      /** What the file declared once this process held the write lock. */
      readonly found: number;
    }
  | {
      readonly kind: 'no-migration-path';
      readonly found: number;
      readonly supported: number;
    }
  | {
      readonly kind: 'malformed-row';
      readonly table: string;
      readonly column: string;
      readonly detail: string;
    }
  | { readonly kind: 'invalid-argument'; readonly parameter: string; readonly detail: string }
  | { readonly kind: 'not-json-serializable'; readonly path: string; readonly detail: string }
  | { readonly kind: 'malformed-json'; readonly table: string; readonly detail: string }
  | { readonly kind: 'invalid-profile'; readonly field: string; readonly detail: string }
  | { readonly kind: 'invalid-snapshot'; readonly field: string; readonly detail: string }
  | { readonly kind: 'invalid-ledger'; readonly field: string; readonly detail: string }
  | { readonly kind: 'invalid-override'; readonly field: string; readonly detail: string }
  | { readonly kind: 'unknown-compile'; readonly compileId: number }
  | { readonly kind: 'unknown-profile-revision'; readonly revision: number }
  | { readonly kind: 'unknown-source'; readonly sourceId: string }
  | { readonly kind: 'closed'; readonly path: string }
  | { readonly kind: 'backup-exists'; readonly path: string }
  /**
   * Another program holds a write lock on the file (SQLITE_BUSY / SQLITE_LOCKED).
   *
   * Its own reason rather than a `cannot-open`, because the fix is different and
   * the user can act on it: close the other copy of Matchline, or wait for the
   * sync client to finish, and try again. Raised after the busy timeout has
   * already been waited out, so it means "still locked", not "momentarily busy".
   */
  | { readonly kind: 'locked'; readonly path: string; readonly detail: string }
  /**
   * The file opened, but it cannot be written (SQLITE_READONLY).
   *
   * A project file on read-only media, in a locked-down folder, or marked
   * read-only. Detected when the file is opened rather than at the first save,
   * so a user does not configure a project for an hour and lose it.
   */
  | { readonly kind: 'read-only'; readonly path: string; readonly detail: string }
  /**
   * A write reached the disk and failed for any other reason -- a full volume,
   * an I/O error, a disconnected network share.
   */
  | { readonly kind: 'write-failed'; readonly path: string; readonly detail: string }
  /** The pre-migration backup was written but did not read back as the original. */
  | { readonly kind: 'backup-unverified'; readonly path: string; readonly detail: string };

/** Thrown by everything in this package. Never a raw driver error. */
export class ProjectStoreError extends Error {
  readonly reason: ProjectStoreReason;

  constructor(reason: ProjectStoreReason) {
    super(describeProjectStoreReason(reason));
    this.name = 'ProjectStoreError';
    this.reason = reason;
  }
}

/** The message shown for a reason. Exhaustive: a new reason will not compile. */
export function describeProjectStoreReason(reason: ProjectStoreReason): string {
  switch (reason.kind) {
    case 'cannot-open':
      return `cannot open project file at ${reason.path}: ${reason.detail}`;
    case 'not-found':
      return `no project file at ${reason.path}`;
    case 'already-exists':
      return `refusing to overwrite an existing file at ${reason.path}`;
    case 'missing-table':
      return `project file is missing required table '${reason.table}'`;
    case 'missing-meta-key':
      return `project file is missing required meta key '${reason.key}'`;
    case 'malformed-meta-value':
      return `project file meta key '${reason.key}' has malformed value '${reason.value}'`;
    case 'unsupported-schema-version':
      return `project file schema_version ${reason.found} is newer than this build understands (${reason.supported}); upgrade Matchline to open it`;
    case 'migration-required':
      return `project file schema_version ${reason.found} predates this build (${reason.supported}); reopen it with migrate: true to upgrade it`;
    case 'migration-raced':
      return `project file at ${reason.path} was schema_version ${reason.expected} when its migration was planned but ${reason.found} when the write lock was taken; another program upgraded it first. Nothing was changed; open it again.`;
    case 'no-migration-path':
      return `project file schema_version ${reason.found} predates this build (${reason.supported}) and no migration from ${reason.found} exists; the file was left as it was found`;
    case 'malformed-row':
      return `project file table '${reason.table}' column '${reason.column}' is malformed: ${reason.detail}`;
    case 'invalid-argument':
      return `invalid ${reason.parameter}: ${reason.detail}`;
    case 'not-json-serializable':
      return `value at ${reason.path} cannot be stored as JSON: ${reason.detail}`;
    case 'malformed-json':
      return `project file table '${reason.table}' holds JSON this reader cannot use: ${reason.detail}`;
    case 'invalid-profile':
      return `site profile field '${reason.field}' is invalid: ${reason.detail}`;
    case 'invalid-snapshot':
      return `snapshot field '${reason.field}' is invalid: ${reason.detail}`;
    case 'invalid-ledger':
      return `asset identity ledger field '${reason.field}' is invalid: ${reason.detail}`;
    case 'invalid-override':
      return `override field '${reason.field}' is invalid: ${reason.detail}`;
    case 'unknown-compile':
      return `no compile with id ${reason.compileId} in this project`;
    case 'unknown-profile-revision':
      return `no profile revision ${reason.revision} in this project`;
    case 'unknown-source':
      return `no source '${reason.sourceId}' in this project`;
    case 'closed':
      return `project file is closed: ${reason.path}`;
    case 'backup-exists':
      return `a backup already exists at ${reason.path}; move it aside before migrating`;
    case 'locked':
      return `another program is holding a lock on the project file at ${reason.path}: ${reason.detail}`;
    case 'read-only':
      return `the project file at ${reason.path} cannot be written: ${reason.detail}`;
    case 'write-failed':
      return `writing the project file at ${reason.path} failed: ${reason.detail}`;
    case 'backup-unverified':
      return `the backup written to ${reason.path} did not read back as a copy of the project: ${reason.detail}`;
    default: {
      const exhaustive: never = reason;
      throw new Error(`unhandled ProjectStoreReason: ${JSON.stringify(exhaustive)}`);
    }
  }
}
