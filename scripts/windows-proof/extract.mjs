/**
 * Proof 1 of 7: extract the runner's model with the real launcher.
 *
 * CONFIDENTIALITY. Counts, codes and timings only — no paths beyond basenames,
 * no file names, no property values. See proof-lib.mjs.
 *
 * This is the cold run. The proof cache directory is cleared first so that a
 * re-dispatch proves an extraction rather than quietly proving a cache hit;
 * cache-hit.mjs is the script whose job that is, and it runs straight after.
 *
 * Drives `Matchline.Extractor.exe --input <model> --cache-dir <cache>`, which
 * is the launcher's own command line (docs/WINDOWS-RUNBOOK.md §6b). The app
 * additionally passes `--input-sha256`; this does not, so the launcher's own
 * hashing stage is exercised too.
 */
import { basename } from 'node:path';

import {
  cacheFileNames,
  emptyDirectory,
  EXIT_CODES,
  extractorArguments,
  leftoverFileNames,
  ProofReport,
  proofSettings,
  requireSettings,
  runExtractor,
  countBy,
} from './proof-lib.mjs';

const report = new ProofReport('extract');
const settings = proofSettings();

if (!requireSettings(report, settings, ['model', 'extractor'])) {
  report.finish(settings.outDir);
} else {
  emptyDirectory(settings.cacheDir);

  const run = await runExtractor(extractorArguments(settings.modelPath, settings.cacheDir));

  report.check('the launcher started', run.spawned, run.spawnError);
  report.check(
    'the launcher exited 0',
    run.exitCode === EXIT_CODES.ok,
    run.exitCode === EXIT_CODES.ok ? null : `exit code ${String(run.exitCode)}`,
  );

  const errors = run.messages.filter((message) => message.type === 'error');
  report.check(
    'no error line was emitted',
    errors.length === 0,
    errors.length === 0 ? null : `codes: ${errors.map((error) => error.code).join(', ')}`,
  );

  const results = run.messages.filter((message) => message.type === 'result');
  report.check(
    'exactly one result line',
    results.length === 1,
    `${String(results.length)} result line(s)`,
  );

  const result = results[0];
  report.check(
    'the result is a fresh extraction, not a cache hit',
    result?.status === 'ok',
    result === undefined ? 'no result' : `status ${result.status}`,
  );
  report.check(
    'the extraction produced objects',
    (result?.objects ?? 0) > 0,
    `objects ${String(result?.objects ?? 0)}`,
  );

  // The stages a full run must pass through. `sets` is only emitted when the
  // model has saved sets, so it is reported rather than required here;
  // selection-sets.mjs and search-sets.mjs are where sets are judged.
  const stagesSeen = [...run.stageFirstSeenMs.keys()].sort();
  for (const stage of ['hash', 'detect', 'open', 'walk', 'convert', 'finalize']) {
    report.check(`stage '${stage}' was reported`, run.stageFirstSeenMs.has(stage));
  }

  const caches = cacheFileNames(settings.cacheDir);
  report.check(
    'exactly one cache file, named by content hash',
    caches.length === 1,
    `${String(caches.length)} file(s) matching <64 hex>.sqlite`,
  );

  const leftovers = leftoverFileNames(settings.cacheDir);
  report.check(
    'no .partial and no .ndjson.tmp survived',
    leftovers.length === 0,
    leftovers.length === 0 ? null : `${String(leftovers.length)} leftover file(s)`,
  );

  // The launcher reports the cache it wrote; that path must be the one in the
  // directory this run owns, and it is compared by basename so no path is kept.
  report.check(
    'the reported cache is the file on disk',
    result !== undefined && caches.includes(basename(result.cachePath)),
  );

  report.fact('objects', result?.objects ?? 0);
  report.fact('warningsStored', result?.warnings ?? 0);
  report.fact('warningCodesForwarded', countBy(
    run.messages.filter((message) => message.type === 'warning').map((message) => message.code),
  ));
  report.fact('stagesSeen', stagesSeen);
  report.fact('stageFirstSeenMs', Object.fromEntries([...run.stageFirstSeenMs.entries()].sort()));
  report.fact('elapsedMs', run.elapsedMs);
  report.fact('hashedByLauncher', true);

  report.finish(settings.outDir);
}
