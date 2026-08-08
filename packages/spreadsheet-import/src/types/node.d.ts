/**
 * Minimal ambient declarations for the handful of platform members this
 * package touches: reading the vendored SheetJS bundle off disk once, and
 * resolving its path relative to this module's own location.
 *
 * The repo installs no `@types/node` on purpose (zero dependencies, npm supply
 * chain surface) — see `packages/model-schema/src/types/node-sqlite.d.ts`.
 * Only the members actually called here are declared, and nothing from this
 * file may appear in the package's public API: ambient `.d.ts` inputs are not
 * emitted to `dist/`, so consumers could not resolve them.
 */

/** `lib: ["ES2023"]` carries no host types, so `import.meta.url` needs one. */
interface ImportMeta {
  readonly url: string;
}

declare module 'node:fs' {
  function readFileSync(path: string, encoding: 'utf8'): string;

  export { readFileSync };
}

declare module 'node:url' {
  function fileURLToPath(url: string): string;

  export { fileURLToPath };
}

declare module 'node:path' {
  function dirname(path: string): string;
  function join(...segments: string[]): string;

  export { dirname, join };
}
