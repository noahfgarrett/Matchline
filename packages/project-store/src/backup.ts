/**
 * The automatic pre-migration backup (PRODUCT.md §15 "Recovery").
 *
 * A migration rewrites the only copy of a site's decisions, so a copy is taken
 * first and named after the version it holds -- `Dragon.matchline.backup-1` is
 * unambiguously the v1 file, whatever the migration went on to do.
 *
 * The copy is refused rather than overwritten when one already exists: a
 * previous failed migration's backup is evidence, and silently replacing it
 * with a half-migrated file would destroy the thing it was taken for.
 */
import { constants, copyFileSync, existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import { ProjectStoreError } from './errors.js';
import { requireText } from './rows.js';

function readSchemaVersion(path: string): number {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
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
 * Copies a project file alongside itself as `<path>.backup-<version>`, where
 * `<version>` is the schema version the file currently declares.
 *
 * Call this before running a migration, and only after the file has been
 * closed -- a copy taken while a transaction is open would copy a file whose
 * rollback journal lives elsewhere.
 *
 * @returns the path the backup was written to.
 * @throws ProjectStoreError `not-found`, `cannot-open` if the file is not a
 * project, or `backup-exists` if that backup path is already taken.
 */
export function backupBeforeMigration(path: string): string {
  if (!existsSync(path)) {
    throw new ProjectStoreError({ kind: 'not-found', path });
  }

  const version = readSchemaVersion(path);
  const backupPath = `${path}.backup-${String(version)}`;
  try {
    copyFileSync(path, backupPath, constants.COPYFILE_EXCL);
  } catch (cause) {
    if (existsSync(backupPath)) {
      throw new ProjectStoreError({ kind: 'backup-exists', path: backupPath });
    }
    throw new ProjectStoreError({
      kind: 'cannot-open',
      path: backupPath,
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }
  return backupPath;
}
