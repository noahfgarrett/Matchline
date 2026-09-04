/**
 * Minimal ambient declaration for the one `node:path` call this package makes.
 *
 * The pre-migration backup `fsync`s the directory its new entry was written
 * into, not just the file. See `node-sqlite.d.ts` for why the repo declares
 * these itself instead of depending on `@types/node`.
 */
declare module 'node:path' {
  function dirname(path: string): string;

  export { dirname };
}
