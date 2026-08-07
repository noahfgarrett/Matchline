/**
 * Minimal ambient declaration for the part of `node:sqlite` this package uses.
 *
 * The repo installs no `@types/node` on purpose (zero dependencies, npm supply
 * chain surface). `node:sqlite` is still experimental on Node 24 — using it
 * emits an ExperimentalWarning at runtime, which is accepted. Only the members
 * actually called here are declared; nothing from this file may appear in the
 * package's public API, because ambient `.d.ts` inputs are not emitted to
 * `dist/` and consumers would not be able to resolve them.
 */
declare module 'node:sqlite' {
  /** Every value SQLite can hand back for a column. */
  type SQLOutputValue = string | number | bigint | Uint8Array | null;

  /** Every value that may be bound to a statement parameter. */
  type SQLInputValue = string | number | bigint | Uint8Array | null;

  /** One result row, keyed by column name. */
  type SQLRow = Record<string, SQLOutputValue>;

  interface StatementResultingChanges {
    changes: number | bigint;
    lastInsertRowid: number | bigint;
  }

  class StatementSync {
    all(...params: SQLInputValue[]): SQLRow[];
    get(...params: SQLInputValue[]): SQLRow | undefined;
    iterate(...params: SQLInputValue[]): IterableIterator<SQLRow>;
    run(...params: SQLInputValue[]): StatementResultingChanges;
  }

  interface DatabaseSyncOptions {
    readonly readOnly?: boolean;
  }

  class DatabaseSync {
    constructor(path: string, options?: DatabaseSyncOptions);
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
  }

  export { DatabaseSync, StatementSync };
  export type { DatabaseSyncOptions, SQLInputValue, SQLOutputValue, SQLRow };
}
