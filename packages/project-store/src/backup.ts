/**
 * The automatic pre-migration backup (PRODUCT.md §15 "Recovery").
 *
 * A migration rewrites the only copy of a site's decisions, so a copy is taken
 * first and named after the version it holds -- `Dragon.matchline.backup-1` is
 * unambiguously the v1 file, whatever the migration went on to do.
 *
 * Three properties, and none of them is free:
 *
 * - **Durable.** The copy and the directory entry that names it are both
 *   `fsync`ed before this function returns. `copyFileSync` puts bytes in the
 *   page cache; power lost between the copy and the migration's own commit used
 *   to leave a current-version file beside a zero-length backup, which is the
 *   exact pair the backup exists to make impossible.
 * - **Verified.** The copy is reopened read-only and made to declare the same
 *   schema version as the original and pass `PRAGMA quick_check`. A backup
 *   nobody has read is a belief, not a backup.
 * - **Idempotent when it is genuinely the same file.** An existing backup is
 *   still never overwritten, but one whose bytes already equal the current file
 *   is REUSED rather than refused: that is what a crash between the copy and the
 *   migration leaves behind, and refusing it blocked the retry of the very
 *   migration that had not happened yet.
 */
import {
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  statSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { ProjectStoreError } from './errors.js';
import { requireText } from './rows.js';

/** Matches `store.ts`; a read-only open contends for the same locks. */
const BUSY_TIMEOUT_MS = 5000;

/** 256 KiB. Big enough that a 700 MB file is not a million syscalls. */
const COMPARE_CHUNK_BYTES = 262144;

function readSchemaVersion(path: string): number {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
  } catch (cause) {
    throw new ProjectStoreError({
      kind: 'cannot-open',
      path,
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }

  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    if (row === undefined) {
      throw new ProjectStoreError({ kind: 'missing-meta-key', key: 'schema_version' });
    }
    const raw = requireText(row, 'meta', 'value');
    if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
      throw new ProjectStoreError({
        kind: 'malformed-meta-value',
        key: 'schema_version',
        value: raw,
      });
    }
    return Number(raw);
  } catch (error) {
    if (error instanceof ProjectStoreError) {
      throw error;
    }
    throw new ProjectStoreError({
      kind: 'cannot-open',
      path,
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    db.close();
  }
}

/**
 * Flushes one path's own bytes, or -- for a directory -- the names in it.
 *
 * Both are needed and they are not the same flush: syncing the file guarantees
 * its contents survive, and syncing the directory guarantees the *entry* that
 * points at them does. A backup whose bytes are on the platter under a name the
 * directory has forgotten is not a backup.
 *
 * A directory `fsync` is not portable -- Windows refuses to open a directory as
 * a file at all -- so that half is best-effort by design. The file half is not.
 *
 * Both are opened `'r'`: POSIX `fsync` does not require a writable descriptor,
 * and asking for one would fail on a copy that inherited a read-only mode from
 * the project it was taken of.
 */
function flush(target: string, directory: boolean): void {
  let fd: number;
  try {
    fd = openSync(target, 'r');
  } catch (cause) {
    if (directory) {
      return;
    }
    throw cause;
  }
  try {
    fsyncSync(fd);
  } catch (cause) {
    if (!directory) {
      throw cause;
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * Whether two files hold exactly the same bytes.
 *
 * Chunked rather than hashed, and rather than read whole: a project file is
 * megabytes to hundreds of megabytes, this package takes no dependencies, and a
 * comparison that stops at the first differing chunk is strictly cheaper than
 * digesting both sides in full. Size first, because it settles most cases
 * without opening anything.
 */
function sameBytes(left: string, right: string): boolean {
  if (statSync(left).size !== statSync(right).size) {
    return false;
  }

  const leftFd = openSync(left, 'r');
  try {
    const rightFd = openSync(right, 'r');
    try {
      const size = fstatSync(leftFd).size;
      const leftChunk = new Uint8Array(COMPARE_CHUNK_BYTES);
      const rightChunk = new Uint8Array(COMPARE_CHUNK_BYTES);
      let offset = 0;
      while (offset < size) {
        const read = readSync(leftFd, leftChunk, 0, COMPARE_CHUNK_BYTES, offset);
        if (read === 0) {
          break;
        }
        if (readSync(rightFd, rightChunk, 0, read, offset) !== read) {
          return false;
        }
        for (let index = 0; index < read; index += 1) {
          if (leftChunk[index] !== rightChunk[index]) {
            return false;
          }
        }
        offset += read;
      }
      return true;
    } finally {
      closeSync(rightFd);
    }
  } finally {
    closeSync(leftFd);
  }
}

/**
 * Reads the copy back and refuses it unless it is a project of the same version.
 *
 * `quick_check` rather than `integrity_check`: it walks every page and every
 * index entry's presence without the full cross-index verification, which on a
 * large project is seconds rather than minutes, and it catches the failure this
 * is guarding against -- a truncated or half-written copy.
 */
function verifyBackup(backupPath: string, expectedVersion: number): void {
  const found = readSchemaVersion(backupPath);
  if (found !== expectedVersion) {
    throw new ProjectStoreError({
      kind: 'backup-unverified',
      path: backupPath,
      detail: `it declares schema_version ${String(found)}, not ${String(expectedVersion)}`,
    });
  }

  const db = new DatabaseSync(backupPath, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
  try {
    const row = db.prepare('PRAGMA quick_check').get();
    const result = row === undefined ? 'no result' : requireText(row, 'quick_check', 'quick_check');
    if (result !== 'ok') {
      throw new ProjectStoreError({
        kind: 'backup-unverified',
        path: backupPath,
        detail: `PRAGMA quick_check answered '${result}'`,
      });
    }
  } catch (error) {
    if (error instanceof ProjectStoreError) {
      throw error;
    }
    throw new ProjectStoreError({
      kind: 'backup-unverified',
      path: backupPath,
      detail: error instanceof Error ? error.message : String(error),
    });
  } finally {
    db.close();
  }
}

/**
 * Copies a project file alongside itself as `<path>.backup-<version>`, where
 * `<version>` is the schema version the file currently declares.
 *
 * Call this before running a migration, and only after the file has been
 * closed -- a copy taken while a transaction is open would copy a file whose
 * rollback journal lives elsewhere.
 *
 * @returns the path the backup was written to. An existing backup holding
 * exactly the current bytes is reused and its path returned unchanged.
 * @throws ProjectStoreError `not-found`, `cannot-open` if the file is not a
 * project, `backup-exists` if that backup path is taken by DIFFERENT bytes, or
 * `backup-unverified` if the copy did not read back as this project.
 */
export function backupBeforeMigration(path: string): string {
  if (!existsSync(path)) {
    throw new ProjectStoreError({ kind: 'not-found', path });
  }

  const version = readSchemaVersion(path);
  const backupPath = `${path}.backup-${String(version)}`;

  if (existsSync(backupPath)) {
    // The crash-retry case. A backup was taken, the migration then failed or
    // the machine went down before it committed, and the file on disk is still
    // the file that was copied. Refusing here refuses the retry of a migration
    // that has not happened, so an identical backup counts as done -- it is
    // still verified below, because "the same bytes" is worth nothing if those
    // bytes are half a database.
    if (!sameBytes(path, backupPath)) {
      throw new ProjectStoreError({ kind: 'backup-exists', path: backupPath });
    }
    verifyBackup(backupPath, version);
    return backupPath;
  }

  try {
    copyFileSync(path, backupPath, constants.COPYFILE_EXCL);
    // Both halves, in this order: the bytes, then the name that finds them.
    flush(backupPath, false);
    flush(dirname(backupPath), true);
  } catch (cause) {
    if (cause instanceof ProjectStoreError) {
      throw cause;
    }
    if (existsSync(backupPath)) {
      throw new ProjectStoreError({ kind: 'backup-exists', path: backupPath });
    }
    throw new ProjectStoreError({
      kind: 'cannot-open',
      path: backupPath,
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }

  verifyBackup(backupPath, version);
  return backupPath;
}
