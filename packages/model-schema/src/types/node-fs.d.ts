/**
 * Minimal ambient declaration for the one `node:fs` call the Dragon fixture
 * generator makes. See `node-sqlite.d.ts` for why the repo declares these
 * itself instead of depending on `@types/node`.
 */
declare module 'node:fs' {
  interface RmSyncOptions {
    readonly force?: boolean;
    readonly recursive?: boolean;
  }

  function rmSync(path: string, options?: RmSyncOptions): void;

  export { rmSync };
  export type { RmSyncOptions };
}
