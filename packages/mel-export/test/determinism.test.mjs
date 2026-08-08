/**
 * Byte stability (docs/ENGINE.md rule 3: "same cache + same profile → identical
 * outputs, byte-stable exports").
 *
 * Byte stability is what makes a re-export comparable: if the same assets can
 * produce two different files, a hash tells an engineer nothing about whether
 * the register changed. The usual obstacle is a writer embedding the wall clock
 * in the document metadata or in the zip entry headers. The vendored SheetJS
 * build does neither unless the workbook carries `Props` -- which this exporter
 * never sets -- so no write option needs pinning and byte equality holds
 * outright. These tests are the guard on that: if a vendor bump started
 * stamping a clock, the faked-clock case below fails instead of byte stability
 * quietly disappearing.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { writeCanonicalMelWorkbook } from '../dist/index.js';
import { DRAGON_ASSETS, syntheticDragonAssets } from './dist/dragon.fixture.js';

const PACKAGE_ROOT = new URL('..', import.meta.url).pathname;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('the same assets always write the same bytes', () => {
  const first = writeCanonicalMelWorkbook(DRAGON_ASSETS);
  const second = writeCanonicalMelWorkbook(DRAGON_ASSETS);
  assert.equal(sha256(first), sha256(second));
  assert.equal(first.length, second.length);
});

test('input order does not change the bytes -- only the assets do', () => {
  /* The duplicate-tag pair is the one tie whose order is the caller's, so it
     is held fixed here; everything else is shuffled. */
  const [power, spare, secondary, dupA, dupB, chilled] = DRAGON_ASSETS;
  const shuffled = [chilled, secondary, dupA, dupB, spare, power];
  assert.equal(
    sha256(writeCanonicalMelWorkbook(shuffled)),
    sha256(writeCanonicalMelWorkbook(DRAGON_ASSETS)),
  );
});

test('a different asset set writes different bytes', () => {
  /* The negative half of the claim: identical bytes must mean identical data,
     not a writer that ignores its input. */
  const changed = [...DRAGON_ASSETS.slice(1), { ...DRAGON_ASSETS[0], building: 'D-999' }];
  assert.notEqual(
    sha256(writeCanonicalMelWorkbook(changed)),
    sha256(writeCanonicalMelWorkbook(DRAGON_ASSETS)),
  );
});

test('the bytes do not depend on the clock, the process, or the time zone', () => {
  const inProcess = sha256(writeCanonicalMelWorkbook(DRAGON_ASSETS));
  /* A separate process, on 31 December 2099, in Asia/Kolkata. Date is replaced
     before the exporter is imported, so the vendored writer sees only the fake
     one. */
  const script = `
    const RealDate = Date;
    const FAKE = RealDate.parse('2099-12-31T23:59:59Z');
    class FakeDate extends RealDate {
      constructor(...args) { if (args.length === 0) super(FAKE); else super(...args); }
      static now() { return FAKE; }
    }
    globalThis.Date = FakeDate;
    const { createHash } = await import('node:crypto');
    const { writeCanonicalMelWorkbook } = await import('./dist/index.js');
    const { DRAGON_ASSETS } = await import('./test/dist/dragon.fixture.js');
    process.stdout.write(createHash('sha256').update(writeCanonicalMelWorkbook(DRAGON_ASSETS)).digest('hex'));
  `;
  const elsewhere = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
    cwd: PACKAGE_ROOT,
    env: { ...process.env, TZ: 'Asia/Kolkata' },
    encoding: 'utf8',
  });
  assert.equal(elsewhere, inProcess);
});

test('byte stability holds at 500 assets too', () => {
  const assets = syntheticDragonAssets(500);
  assert.equal(
    sha256(writeCanonicalMelWorkbook(assets)),
    sha256(writeCanonicalMelWorkbook(syntheticDragonAssets(500))),
  );
});
