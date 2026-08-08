/**
 * Minimal ambient declaration for the `node:fs` calls this package makes:
 * existence checks before opening or creating a project, and the pre-migration
 * backup copy. See `node-sqlite.d.ts` for why the repo declares these itself
 * instead of depending on `@types/node`.
 */
declare module 'node:fs' {
  function existsSync(path: string): boolean;
  function copyFileSync(source: string, destination: string, mode?: number): void;
  function unlinkSync(path: string): void;

  /** `copyFileSync` mode flag: fail if the destination already exists. */
  const constants: { readonly COPYFILE_EXCL: number };

  export { constants, copyFileSync, existsSync, unlinkSync };
}
