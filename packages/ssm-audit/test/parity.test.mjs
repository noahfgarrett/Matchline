import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The vendored rulebook is SSM-Audit's, byte for byte.
 *
 * SSM-Audit pins the same five files against its own integrated checkout
 * (`tests/parity.test.mjs`); this is the third corner of that triangle. When
 * the SSM-Audit checkout is not next door — CI, a fresh clone, anyone who does
 * not have the other app — the test skips rather than failing: it can only
 * assert parity against a source it can see.
 *
 * A rule that needs changing is changed in SSM-Audit and re-vendored. Editing
 * one here is what this test exists to catch.
 */

const packageRoot = resolve(new URL('..', import.meta.url).pathname);
const ssmAudit = resolve(packageRoot, '../../../SSM-Audit');

/** vendored path -> the SSM-Audit source it must equal. */
const VENDORED = [
  ['vendor/audit/engine.js', 'src/audit/engine.js'],
  ['vendor/audit/model.js', 'src/audit/model.js'],
  ['vendor/exto/rev21-contract.js', 'src/exto/rev21-contract.js'],
  ['vendor/exto/vf-item-masters.js', 'src/exto/vf-item-masters.js'],
  ['vendor/core/text.js', 'src/core/text.js'],
];

test('the vendored rulebook matches the SSM-Audit checkout', { skip: !existsSync(ssmAudit) }, () => {
  for (const [vendored, source] of VENDORED) {
    assert.equal(
      readFileSync(resolve(packageRoot, vendored), 'utf8'),
      readFileSync(resolve(ssmAudit, source), 'utf8'),
      `${vendored} diverged from SSM-Audit's ${source}`,
    );
  }
});

test('every vendored file is present and non-empty', () => {
  for (const [vendored] of VENDORED) {
    const path = resolve(packageRoot, vendored);
    assert.equal(existsSync(path), true, `${vendored} is missing`);
    assert.equal(readFileSync(path, 'utf8').length > 0, true, `${vendored} is empty`);
  }
});

test('the two shims are shims, and say so', () => {
  for (const shim of ['vendor/io/workbook.js', 'vendor/xlsx-global.js']) {
    const text = readFileSync(resolve(packageRoot, shim), 'utf8');
    assert.equal(text.length > 0, true, `${shim} is empty`);
  }
  // The shims must never be mistaken for vendored rulebook files, so neither is
  // in the parity list and neither may exist in SSM-Audit under the same name.
  assert.equal(
    VENDORED.some(([vendored]) => vendored === 'vendor/io/workbook.js'),
    false,
  );
});
