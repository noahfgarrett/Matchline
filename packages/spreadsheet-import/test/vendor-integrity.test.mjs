/**
 * The vendored SheetJS bundle must stay a byte-identical copy of the donor's.
 *
 * The AoA scan in `src/aoa.ts` is a port that has to agree with the donor's
 * output byte for byte; that only means anything if both are running the same
 * parser. Hashing both files here makes drift impossible to land quietly —
 * a patched vendor copy, or a donor copy edited despite the freeze, fails.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { VENDOR_SHEETJS_PATH } from '../dist/index.js'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const donorPath = resolve(packageDir, '../legacy-parity/src/vendor/sheetjs.js')

/* Recorded in vendor/README.md. Both must equal it, not merely each other. */
const EXPECTED_SHA256 = 'f32ff938c11a1beae2fb3774b7a00e02d3f78c9f9f01c2e501f80bdfaaa60db7'

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

test('the vendored bundle is byte-identical to the donor original', () => {
  const vendored = readFileSync(VENDOR_SHEETJS_PATH)
  const donor = readFileSync(donorPath)
  assert.equal(vendored.length, donor.length, 'vendored bundle differs in length from the donor')
  assert.ok(vendored.equals(donor), 'vendored bundle differs in content from the donor')
})

test('both copies hash to the sha recorded in vendor/README.md', () => {
  assert.equal(sha256(VENDOR_SHEETJS_PATH), EXPECTED_SHA256, 'vendored copy drifted')
  assert.equal(sha256(donorPath), EXPECTED_SHA256, 'donor copy drifted — legacy-parity is frozen')
})
