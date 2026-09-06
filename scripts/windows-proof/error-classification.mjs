/**
 * Proof 7 of 7: the failure vocabulary.
 *
 * CONFIDENTIALITY. Codes and exit codes only. The launcher's error messages can
 * name paths, so none of them is copied into the summary.
 *
 * Each case drives a documented failure and checks that the launcher answers
 * with the documented code AND the documented exit code — a caller that cannot
 * parse stdout still learns what went wrong from the exit status
 * (native/extractor/ExitCodes.cs), so both halves have to agree.
 *
 * Cases that need a fixture the runner may not have are SKIPPED, by name and
 * out loud, with the variable that would supply them. A skip is visible; a
 * silently missing case is how a vocabulary rots.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  EXIT_CODES,
  extractorArguments,
  ProofReport,
  proofSettings,
  requireSettings,
  runExtractor,
} from './proof-lib.mjs';

const report = new ProofReport('error-classification');
const settings = proofSettings();

if (!requireSettings(report, settings, ['extractor'])) {
  report.finish(settings.outDir);
  process.exit();
}

const scratch = path.join(settings.cacheDir, 'errors');

/** Runs one case and checks the code and the exit status together. */
async function expect(name, args, code, exitCode) {
  const run = await runExtractor(args);
  const errors = run.messages.filter((message) => message.type === 'error');
  const seen = errors.map((error) => error.code);
  report.check(
    `${name} reports ${code}`,
    seen.includes(code),
    seen.includes(code) ? null : `codes seen: ${seen.join(', ') || 'none'}`,
  );
  report.check(
    `${name} exits ${String(exitCode)}`,
    run.exitCode === exitCode,
    run.exitCode === exitCode ? null : `exit code ${String(run.exitCode)}`,
  );
  report.check(
    `${name} produces no result line`,
    run.messages.every((message) => message.type !== 'result'),
  );
  return seen;
}

// --- always available: nothing but a wrong command line is needed -------------

await expect(
  'a --input that does not exist',
  extractorArguments(path.join(scratch, 'no-such-model.nwd'), scratch),
  'INPUT_NOT_FOUND',
  EXIT_CODES.inputNotFound,
);

await expect(
  'an unrecognised argument',
  ['--input', path.join(scratch, 'anything.nwd'), '--not-a-flag', 'x'],
  'INVALID_ARGS',
  EXIT_CODES.invalidArguments,
);

await expect(
  'a malformed --input-sha256',
  [...extractorArguments(path.join(scratch, 'anything.nwd'), scratch), '--input-sha256', 'nothex'],
  'INVALID_ARGS',
  EXIT_CODES.invalidArguments,
);

/**
 * A hash the launcher is told rather than made to compute.
 *
 * The NW_NOT_INSTALLED probe needs a real file, because the launcher checks the
 * input exists before it looks for Navisworks (ExtractionRunner.Run). It does
 * NOT need that file hashed: hashing comes first in the same method, so without
 * this flag the probe reads every byte of the proof model -- a full pass over a
 * multi-gigabyte NWD -- to reach a failure that has nothing to do with its
 * contents. `--input-sha256` is documented as an assertion the launcher trusts
 * rather than verifies, and trusting a dummy is safe here precisely because the
 * run fails before anything is written: no cache is filed under this name, and
 * the only thing the value addresses is a `<sha>.sqlite` that does not exist.
 */
const DUMMY_SHA256 = 'f'.repeat(64);

// A --navisworks-dir with no Roamer.exe in it is the documented way to reach
// NW_NOT_INSTALLED without uninstalling anything.
if (settings.modelPath === null) {
  report.skip(
    'an install directory with no Navisworks in it reports NW_NOT_INSTALLED',
    'needs MATCHLINE_PROOF_MODEL, because the launcher checks the input before the install',
  );
} else {
  const emptyInstall = mkdtempSync(path.join(os.tmpdir(), 'matchline-no-navisworks-'));
  await expect(
    'an install directory with no Navisworks in it',
    [
      ...extractorArguments(settings.modelPath, scratch),
      '--input-sha256',
      DUMMY_SHA256,
      '--navisworks-dir',
      emptyInstall,
    ],
    'NW_NOT_INSTALLED',
    EXIT_CODES.navisworksNotInstalled,
  );
}

// --- fixture-dependent: skipped by name when the runner lacks them ------------

if (settings.tooNewModelPath === null) {
  report.skip(
    'an NWD published by a newer Navisworks reports NW_VERSION_TOO_NEW',
    'no fixture on this runner; set MATCHLINE_PROOF_TOO_NEW_MODEL to an NWD saved by a newer ' +
      'release than the installed one. Until then the too-new classification stays unverified ' +
      'and FailureClassifier keeps its guessed message wording',
  );
} else {
  const seen = await expect(
    'an NWD from a newer Navisworks',
    extractorArguments(settings.tooNewModelPath, scratch),
    'NW_VERSION_TOO_NEW',
    EXIT_CODES.navisworksVersionTooNew,
  );
  // OPEN_FAILED here is the specific, expected way this can be wrong: the
  // classifier matches on message wording that was guessed, not observed.
  report.fact('tooNewFellBackToOpenFailed', seen.includes('OPEN_FAILED'));
}

report.finish(settings.outDir);
