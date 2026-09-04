import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { after, before } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  DRAGON_UNRESOLVED_SET_NAME,
  writeDragonFixtureWithUnresolvedSearch,
} from '@matchline/model-schema/fixtures/dragon';

/**
 * The seven Windows-proof scripts, exercised on a machine with no Navisworks.
 *
 * What can be tested here is the scripts' own logic — the protocol they parse,
 * the assertions they make, the anonymity of what they write, and above all
 * that they FAIL when the thing they are proving is not true. That last part is
 * the point: a proof script that cannot fail proves nothing, and the only place
 * to establish it is here, because on the real runner every run is expected to
 * pass.
 *
 * The launcher under test is apps/desktop/test/fake-extractor.mjs, pointed at
 * by MATCHLINE_EXTRACTOR_PATH exactly as docs/WINDOWS-RUNBOOK.md points the app
 * at a locally built one. It is a second implementation of the launcher's side
 * of the protocol, written from the C#, so these scripts are being checked
 * against something that was not written to satisfy them.
 *
 * What cannot be tested here: anything Autodesk. No real Navisworks starts, no
 * real model is read, and the cache is the Dragon fixture. Gates 14-16 are not
 * proven by this file and nothing in it should be read as proving them.
 */

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const FAKE_EXTRACTOR = path.join(REPO_ROOT, 'apps', 'desktop', 'test', 'fake-extractor.mjs');
const SCRIPTS = path.join(REPO_ROOT, 'scripts', 'windows-proof');

/** A 64-hex cache name, so `soleCachePath` recognises it. */
const FIXTURE_SHA = 'a'.repeat(64);

let workspace = '';

before(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'matchline-windows-proof-'));
});

after(() => {
  rmSync(workspace, { recursive: true, force: true });
});

/** A fresh directory under the test workspace. */
function directory(...parts) {
  const created = path.join(workspace, ...parts);
  mkdirSync(created, { recursive: true });
  return created;
}

/**
 * A stand-in model file. Its first line is the fake extractor's scenario, and
 * the rest is padding so two scenarios hash differently.
 */
function fakeModel(name, scenario = {}) {
  const file = path.join(directory('models'), `${name}.nwd`);
  writeFileSync(file, `MATCHLINE-FAKE ${JSON.stringify(scenario)}\n${name}\n`, 'utf8');
  return file;
}

function runScript(script, env = {}) {
  const result = spawnSync(process.execPath, [path.join(SCRIPTS, script)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      MATCHLINE_EXTRACTOR_PATH: FAKE_EXTRACTOR,
      ...env,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function reportOf(outDir, name) {
  return JSON.parse(readFileSync(path.join(outDir, `${name}.json`), 'utf8'));
}

/** The check names a report failed on, for a readable assertion message. */
function failedChecks(report) {
  return report.checks.filter((check) => check.status === 'fail').map((check) => check.name);
}

/** A cache directory holding one cache file written by `write`. */
function cacheDirectoryWith(name, write) {
  const cacheDir = directory('caches', name);
  const cachePath = path.join(cacheDir, `${FIXTURE_SHA}.sqlite`);
  write(cachePath);
  return { cacheDir, cachePath };
}

test('extract drives the launcher and reports a fresh extraction', () => {
  const outDir = directory('out', 'extract');
  const cacheDir = directory('caches', 'extract');
  const run = runScript('extract.mjs', {
    MATCHLINE_PROOF_MODEL: fakeModel('extract'),
    MATCHLINE_PROOF_OUT: outDir,
    MATCHLINE_PROOF_CACHE: cacheDir,
  });

  const report = reportOf(outDir, 'extract');
  assert.deepEqual(failedChecks(report), []);
  assert.equal(run.status, 0);
  assert.equal(report.status, 'pass');
  assert.equal(report.facts.objects, 76);
  assert.ok(report.facts.stagesSeen.includes('walk'));
});

test('extract fails when the launcher answers with an error', () => {
  const outDir = directory('out', 'extract-error');
  const run = runScript('extract.mjs', {
    MATCHLINE_PROOF_MODEL: fakeModel('extract-error', { mode: 'error', code: 'OPEN_FAILED' }),
    MATCHLINE_PROOF_OUT: outDir,
    MATCHLINE_PROOF_CACHE: directory('caches', 'extract-error'),
  });

  assert.equal(run.status, 1);
  const report = reportOf(outDir, 'extract');
  assert.equal(report.status, 'fail');
  assert.ok(failedChecks(report).includes('no error line was emitted'));
});

/**
 * A regression test for the crash the audit found (proof-lib.mjs's `LEAKY`
 * check refusing to write a detail containing a path separator): a missing
 * launcher used to make `requireSettings` report a detail naming
 * `native/Matchline.Extraction.sln`, which `writeReport` then refused to
 * write at all — the script died with an uncaught exception and published no
 * JSON, not even a failing one. `scripts.test.mjs` always overrode
 * MATCHLINE_EXTRACTOR_PATH before this, so the case was never exercised.
 */
test('extract fails cleanly, with no path in the report, when the launcher is missing', () => {
  const outDir = directory('out', 'extract-missing-launcher');
  const run = runScript('extract.mjs', {
    MATCHLINE_PROOF_MODEL: fakeModel('extract-missing-launcher'),
    MATCHLINE_PROOF_OUT: outDir,
    MATCHLINE_PROOF_CACHE: directory('caches', 'extract-missing-launcher'),
    MATCHLINE_EXTRACTOR_PATH: path.join(workspace, 'no-such-extractor.exe'),
  });

  assert.notEqual(run.status, 0);

  // The whole point: a report was written at all.
  const report = reportOf(outDir, 'extract');
  assert.equal(report.status, 'fail');

  const failure = report.checks.find(
    (check) => check.name === 'the launcher executable is where the build left it',
  );
  assert.ok(failure, 'expected the requireSettings extractor check to have run');
  assert.equal(failure.status, 'fail');
  assert.ok(typeof failure.detail === 'string' && failure.detail.length > 0);
  assert.doesNotMatch(failure.detail, /[/\\]/);
});

test('validate-cache reads the cache the launcher wrote and counts it', () => {
  const outDir = directory('out', 'validate');
  const cacheDir = directory('caches', 'validate');
  const shared = {
    MATCHLINE_PROOF_MODEL: fakeModel('validate'),
    MATCHLINE_PROOF_OUT: outDir,
    MATCHLINE_PROOF_CACHE: cacheDir,
  };
  assert.equal(runScript('extract.mjs', shared).status, 0);

  const run = runScript('validate-cache.mjs', shared);
  const report = reportOf(outDir, 'validate-cache');
  assert.deepEqual(failedChecks(report), []);
  assert.equal(run.status, 0);
  assert.equal(report.facts.objects, 76);
  assert.equal(report.facts.schemaVersion, '2');
  assert.equal(report.facts.selectionSets, 3);
});

test('validate-cache fails on a cache that does not pass validation', () => {
  const outDir = directory('out', 'validate-broken');
  const { cacheDir, cachePath } = cacheDirectoryWith('validate-broken', (target) => {
    writeDragonFixtureWithUnresolvedSearch(target);
  });
  const db = new DatabaseSync(cachePath);
  try {
    // A cache that survived a killed writer looks exactly like this: rows gone,
    // meta still claiming them.
    db.exec("UPDATE meta SET value = '9999' WHERE key = 'object_count'");
  } finally {
    db.close();
  }

  const run = runScript('validate-cache.mjs', {
    MATCHLINE_PROOF_OUT: outDir,
    MATCHLINE_PROOF_CACHE: cacheDir,
  });
  assert.equal(run.status, 1);
  const report = reportOf(outDir, 'validate-cache');
  assert.ok(failedChecks(report).includes('the cache passes full validation'));
  // The refusal is reported as its reason kind, never as the reader's message,
  // which would carry the path.
  assert.match(run.stdout, /object-count-mismatch/);
});

test('cache-hit proves the second run reused the file and never extracted', () => {
  const outDir = directory('out', 'cache-hit');
  const cacheDir = directory('caches', 'cache-hit');
  const shared = {
    MATCHLINE_PROOF_MODEL: fakeModel('cache-hit'),
    MATCHLINE_PROOF_OUT: outDir,
    MATCHLINE_PROOF_CACHE: cacheDir,
  };
  assert.equal(runScript('extract.mjs', shared).status, 0);

  const run = runScript('cache-hit.mjs', shared);
  const report = reportOf(outDir, 'cache-hit');
  assert.deepEqual(failedChecks(report), []);
  assert.equal(run.status, 0);
  assert.deepEqual(report.facts.stagesSeen, ['hash']);
});

test('cache-hit fails when the second run extracts again', () => {
  const outDir = directory('out', 'cache-hit-miss');
  const cacheDir = directory('caches', 'cache-hit-miss');
  assert.equal(
    runScript('extract.mjs', {
      MATCHLINE_PROOF_MODEL: fakeModel('cache-hit-miss'),
      MATCHLINE_PROOF_OUT: outDir,
      MATCHLINE_PROOF_CACHE: cacheDir,
    }).status,
    0,
  );

  // A different model in the same directory: the launcher cannot hit the cache
  // it holds, so it extracts — which is precisely what this script must catch.
  const run = runScript('cache-hit.mjs', {
    MATCHLINE_PROOF_MODEL: fakeModel('cache-hit-other'),
    MATCHLINE_PROOF_OUT: outDir,
    MATCHLINE_PROOF_CACHE: cacheDir,
  });
  assert.equal(run.status, 1);
  const report = reportOf(outDir, 'cache-hit');
  assert.ok(failedChecks(report).includes('the result says cache-hit'));
  assert.ok(failedChecks(report).includes("stage 'walk' was NOT reported"));
});

test('cancellation cancels mid-walk and proves nothing was left behind', () => {
  const outDir = directory('out', 'cancel');
  const run = runScript('cancellation.mjs', {
    MATCHLINE_PROOF_MODEL: fakeModel('cancel', { walkTicks: 60, tickMs: 20 }),
    MATCHLINE_PROOF_OUT: outDir,
    MATCHLINE_PROOF_CACHE: directory('caches', 'cancel'),
  });

  const report = reportOf(outDir, 'cancellation');
  assert.deepEqual(failedChecks(report), []);
  assert.equal(run.status, 0);
  assert.ok(report.facts.cancelSentAtMs >= 0);
});

test('cancellation fails when the launcher ignores the cancel and finishes', () => {
  const outDir = directory('out', 'cancel-ignored');
  const run = runScript('cancellation.mjs', {
    MATCHLINE_PROOF_MODEL: fakeModel('cancel-ignored', {
      walkTicks: 2,
      tickMs: 0,
      ignoreCancel: true,
    }),
    MATCHLINE_PROOF_OUT: outDir,
    MATCHLINE_PROOF_CACHE: directory('caches', 'cancel-ignored'),
  });

  assert.equal(run.status, 1);
  const report = reportOf(outDir, 'cancellation');
  const failed = failedChecks(report);
  assert.ok(failed.includes('the launcher reported CANCELLED'));
  assert.ok(failed.includes('no cache file was left behind'));
});

test('selection-sets accepts a cache whose fixed selections resolved', () => {
  const outDir = directory('out', 'sets');
  const cacheDir = directory('caches', 'sets');
  const shared = {
    MATCHLINE_PROOF_MODEL: fakeModel('sets'),
    MATCHLINE_PROOF_OUT: outDir,
    MATCHLINE_PROOF_CACHE: cacheDir,
  };
  assert.equal(runScript('extract.mjs', shared).status, 0);

  const run = runScript('selection-sets.mjs', shared);
  const report = reportOf(outDir, 'selection-sets');
  assert.deepEqual(failedChecks(report), []);
  assert.equal(run.status, 0);
  assert.equal(report.facts.setsWithMembers, 2);
  // Names are client data: the summary carries counts and kinds only.
  assert.equal(JSON.stringify(report).includes('Air Handling'), false);
});

test('selection-sets fails when every set came back empty', () => {
  // The exact shape of the ModelItem-equality assumption failing: sets present,
  // members gone. Getting a pass here would make gate 15 meaningless.
  const outDir = directory('out', 'sets-empty');
  const { cacheDir, cachePath } = cacheDirectoryWith('sets-empty', (target) => {
    writeDragonFixtureWithUnresolvedSearch(target);
  });
  const db = new DatabaseSync(cachePath);
  try {
    db.exec('DELETE FROM selection_set_members');
  } finally {
    db.close();
  }

  const run = runScript('selection-sets.mjs', {
    MATCHLINE_PROOF_OUT: outDir,
    MATCHLINE_PROOF_CACHE: cacheDir,
  });
  assert.equal(run.status, 1);
  const failed = failedChecks(reportOf(outDir, 'selection-sets'));
  assert.ok(failed.includes('at least one set resolved to members'));
  assert.ok(failed.includes('no fixed selection resolved to nothing'));
});

test('search-sets passes on a resolved search and records the gate as proven', () => {
  const outDir = directory('out', 'search');
  const cacheDir = directory('caches', 'search');
  const shared = {
    MATCHLINE_PROOF_MODEL: fakeModel('search'),
    MATCHLINE_PROOF_OUT: outDir,
    MATCHLINE_PROOF_CACHE: cacheDir,
  };
  assert.equal(runScript('extract.mjs', shared).status, 0);

  const run = runScript('search-sets.mjs', shared);
  const report = reportOf(outDir, 'search-sets');
  assert.deepEqual(failedChecks(report), []);
  assert.equal(run.status, 0);
  assert.equal(report.facts.searchSets, 1);
  assert.equal(report.facts.resolvedWithMembers, 1);
  assert.equal(report.facts.unresolved, 0);
  assert.equal(report.facts.gate16Proven, true);
});

test('search-sets accepts an honestly unresolved search, and says the gate is not proven', () => {
  const outDir = directory('out', 'search-unresolved');
  const { cacheDir } = cacheDirectoryWith('search-unresolved', (target) => {
    writeDragonFixtureWithUnresolvedSearch(target);
  });

  const run = runScript('search-sets.mjs', {
    MATCHLINE_PROOF_OUT: outDir,
    MATCHLINE_PROOF_CACHE: cacheDir,
  });

  const report = reportOf(outDir, 'search-sets');
  assert.equal(run.status, 0);
  assert.equal(report.facts.unresolved, 1);
  assert.equal(report.facts.unresolvedWarnings, 1);
  // Resolved and unresolved side by side is the whole point of the column.
  assert.equal(report.facts.resolvedWithMembers, 1);
  assert.equal(report.facts.gate16Proven, false);
  // The set's name is in the cache's warning and must not be in the artifact.
  assert.equal(JSON.stringify(report).includes(DRAGON_UNRESOLVED_SET_NAME), false);
});

test('search-sets fails on an unresolved set nobody was warned about', () => {
  // Empty-as-answer wearing a flag: the row admits it is unresolved but nothing
  // told the operator, so the model would silently filter to nothing.
  const outDir = directory('out', 'search-silent');
  const { cacheDir, cachePath } = cacheDirectoryWith('search-silent', (target) => {
    writeDragonFixtureWithUnresolvedSearch(target);
  });
  const db = new DatabaseSync(cachePath);
  try {
    db.exec("DELETE FROM warnings WHERE code = 'SEARCH_SET_UNRESOLVED'");
  } finally {
    db.close();
  }

  const run = runScript('search-sets.mjs', {
    MATCHLINE_PROOF_OUT: outDir,
    MATCHLINE_PROOF_CACHE: cacheDir,
  });
  assert.equal(run.status, 1);
  assert.ok(
    failedChecks(reportOf(outDir, 'search-sets')).includes(
      'every unresolved set is named by a SEARCH_SET_UNRESOLVED warning',
    ),
  );
});

test('search-sets fails when an unresolved set carries members anyway', () => {
  const outDir = directory('out', 'search-members');
  const { cacheDir, cachePath } = cacheDirectoryWith('search-members', (target) => {
    writeDragonFixtureWithUnresolvedSearch(target);
  });
  const db = new DatabaseSync(cachePath);
  try {
    const unresolvedId = db
      .prepare('SELECT id FROM selection_sets WHERE membership_resolved = 0')
      .get().id;
    db.prepare('INSERT INTO selection_set_members (set_id, object_id) VALUES (?, 1)').run(
      unresolvedId,
    );
  } finally {
    db.close();
  }

  const run = runScript('search-sets.mjs', {
    MATCHLINE_PROOF_OUT: outDir,
    MATCHLINE_PROOF_CACHE: cacheDir,
  });
  assert.equal(run.status, 1);
  assert.ok(
    failedChecks(reportOf(outDir, 'search-sets')).includes('no unresolved set carries member rows'),
  );
});

test('error-classification drives the always-available failures and skips the rest by name', () => {
  const outDir = directory('out', 'errors');
  // No MATCHLINE_PROOF_MODEL and no too-new fixture: both fixture-dependent
  // cases must skip, visibly, rather than pass or vanish.
  const run = runScript('error-classification.mjs', {
    MATCHLINE_PROOF_OUT: outDir,
    MATCHLINE_PROOF_CACHE: directory('caches', 'errors'),
    MATCHLINE_PROOF_MODEL: '',
    MATCHLINE_PROOF_TOO_NEW_MODEL: '',
  });

  const report = reportOf(outDir, 'error-classification');
  assert.deepEqual(failedChecks(report), []);
  assert.equal(run.status, 0);
  assert.equal(report.skipped, true);

  const skips = report.checks.filter((check) => check.status === 'skip').map((check) => check.name);
  assert.equal(skips.length, 2);
  assert.ok(skips.some((name) => name.includes('NW_VERSION_TOO_NEW')));
  // A skip has to be legible in the log, not only in the JSON.
  assert.match(run.stdout, /SKIP/);
  assert.match(run.stdout, /did NOT run/);
});

test('a proof summary that would carry model-derived text is refused, not written', async () => {
  const { writeReport } = await import('../../scripts/windows-proof/proof-lib.mjs');
  const outDir = directory('out', 'anonymity');

  assert.throws(
    () => writeReport(outDir, 'leaky', { cachePath: 'C:\\Projects\\Client\\Site.nwd' }),
    /looks model-derived/,
  );
  assert.throws(
    () => writeReport(outDir, 'leaky', { facts: { model: 'Building-A.nwd' } }),
    /looks model-derived/,
  );
  // Counts and codes are fine, and that is what every script actually writes.
  writeReport(outDir, 'clean', { objects: 76, warningsByCode: { PROPERTY_READ_FAILED: 1 } });
  assert.equal(reportOf(outDir, 'clean').objects, 76);
});
