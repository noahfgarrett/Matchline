/**
 * Minimal ambient declaration for the one `node:crypto` call the fixture
 * generators make. See `node-sqlite.d.ts` for why the repo declares these
 * itself instead of depending on `@types/node`.
 *
 * Only the SHA-256-to-hex path is declared, because that is the only one used:
 * the fixtures restate the extractor's `structural_key` algorithm so the
 * writing and reading halves of schema v3 cannot drift apart.
 */
declare module 'node:crypto' {
  interface Hash {
    update(data: string, inputEncoding: 'utf8'): Hash;
    digest(encoding: 'hex'): string;
  }

  function createHash(algorithm: 'sha256'): Hash;

  export { createHash };
  export type { Hash };
}
