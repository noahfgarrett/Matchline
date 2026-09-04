/**
 * Minimal ambient declaration for the `node:fs` calls this package makes:
 * existence checks before opening or creating a project, and the pre-migration
 * backup copy -- which is why the descriptor-level calls are here too. A backup
 * that is only in the page cache is not a backup, so it is `fsync`ed, and one
 * that has never been read back is a belief, so it is compared and reopened.
 * See `node-sqlite.d.ts` for why the repo declares these itself instead of
 * depending on `@types/node`.
 */
declare module 'node:fs' {
  function existsSync(path: string): boolean;
  function copyFileSync(source: string, destination: string, mode?: number): void;
  function unlinkSync(path: string): void;

  /** Only the field this package reads. */
  interface Stats {
    readonly size: number;
  }

  function statSync(path: string): Stats;
  function fstatSync(fd: number): Stats;
  /** `'r'` is the only flag this package opens with; see `flush`. */
  function openSync(path: string, flags: string): number;
  function closeSync(fd: number): void;
  function fsyncSync(fd: number): void;
  function readSync(
    fd: number,
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): number;

  /** `copyFileSync` mode flag: fail if the destination already exists. */
  const constants: { readonly COPYFILE_EXCL: number };

  export {
    closeSync,
    constants,
    copyFileSync,
    existsSync,
    fstatSync,
    fsyncSync,
    openSync,
    readSync,
    statSync,
    unlinkSync,
  };
  export type { Stats };
}
