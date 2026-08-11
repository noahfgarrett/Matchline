/**
 * Proof 3 of 7: the same model again is a cache hit, and Navisworks is never
 * started.
 *
 * CONFIDENTIALITY. Counts, codes and timings only.
 *
 * The evidence is threefold and none of it is the word "cache-hit" on its own:
 * the result line says `cache-hit`, the stages that only a real extraction
 * emits (`detect`, `open`, `walk`, `convert`) never appear, and the cache file
 * on disk is byte-for-byte the same file — same modification time, same size.
 * A launcher that quietly re-extracted would still say `ok` and would move that
 * timestamp.
 */
import { statSync } from 'node:fs';

import {
  cacheFileNames,
  EXIT_CODES,
  extractorArguments,
  leftoverFileNames,
  modifiedAtMs,
  ProofReport,
  proofSettings,
  requireSettings,
  runExtractor,
  soleCachePath,
} from './proof-lib.mjs';

const report = new ProofReport('cache-hit');
const settings = proofSettings();

if (!requireSettings(report, settings, ['model', 'extractor'])) {
  report.finish(settings.outDir);
  process.exit();
}

let cachePath;
try {
  cachePath = soleCachePath(settings.cacheDir);
} catch (error) {
  report.check('extract.mjs left exactly one cache to reuse', false, error.message);
  report.finish(settings.outDir);
  process.exit();
}

const before = { modifiedAtMs: modifiedAtMs(cachePath), bytes: statSync(cachePath).size };

const run = await runExtractor(extractorArguments(settings.modelPath, settings.cacheDir));

report.check(
  'the launcher exited 0',
  run.exitCode === EXIT_CODES.ok,
  run.exitCode === EXIT_CODES.ok ? null : `exit code ${String(run.exitCode)}`,
);

const results = run.messages.filter((message) => message.type === 'result');
const result = results[0];
report.check('exactly one result line', results.length === 1, `${String(results.length)} line(s)`);
report.check(
  'the result says cache-hit',
  result?.status === 'cache-hit',
  result === undefined ? 'no result' : `status ${result.status}`,
);

// A cache hit is decided before Navisworks is located, so none of the stages
// that follow detection may appear. This is the check that catches a launcher
// that started Roamer.exe and then noticed the cache.
for (const stage of ['detect', 'open', 'walk', 'convert', 'finalize']) {
  report.check(
    `stage '${stage}' was NOT reported`,
    !run.stageFirstSeenMs.has(stage),
    run.stageFirstSeenMs.has(stage) ? 'a cache hit must not reach this stage' : null,
  );
}

const after = { modifiedAtMs: modifiedAtMs(cachePath), bytes: statSync(cachePath).size };
report.check(
  'the cache file was not rewritten',
  before.modifiedAtMs !== null && before.modifiedAtMs === after.modifiedAtMs,
  before.modifiedAtMs === after.modifiedAtMs ? null : 'the modification time moved',
);
report.check('the cache file did not change size', before.bytes === after.bytes);
report.check(
  'still exactly one cache, and nothing partial',
  cacheFileNames(settings.cacheDir).length === 1 &&
    leftoverFileNames(settings.cacheDir).length === 0,
);

report.fact('objects', result?.objects ?? 0);
report.fact('elapsedMs', run.elapsedMs);
report.fact('cacheBytes', after.bytes);
report.fact('stagesSeen', [...run.stageFirstSeenMs.keys()].sort());

report.finish(settings.outDir);
