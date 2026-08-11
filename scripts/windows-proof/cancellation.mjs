/**
 * Proof 4 of 7: cancelling mid-walk leaves nothing behind.
 *
 * CONFIDENTIALITY. Counts, codes and timings only.
 *
 * Cancellation goes in the way the app sends it — one `cancel` line on stdin —
 * because that is the path that kills the Navisworks process the launcher
 * started, deletes its partials, and exits `CANCELLED`. A signal skips all
 * three and would prove none of them.
 *
 * It runs in its own cache directory. A cancelled run must leave no cache, and
 * checking that in the directory where extract.mjs already left one would be
 * checking nothing.
 *
 * If the model finishes before a cancel can be injected, this FAILS rather than
 * skipping: the gate is real and unproven, and the fix is a model big enough to
 * cancel — which any model worth proving on is.
 */
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
} from './proof-lib.mjs';

const report = new ProofReport('cancellation');
const settings = proofSettings();

if (!requireSettings(report, settings, ['model', 'extractor'])) {
  report.finish(settings.outDir);
} else {
  emptyDirectory(settings.cancelCacheDir);

  // Cancel on the first sign that the model is actually being read. `walk` is
  // the stage that lasts; cancelling at `open` would test a different thing and
  // would race the process start.
  const run = await runExtractor(
    extractorArguments(settings.modelPath, settings.cancelCacheDir),
    { cancelWhen: (message) => message.type === 'progress' && message.stage === 'walk' },
  );

  const cancelWasSent = run.cancelSentAtMs !== null;
  report.check(
    'the run reached the walk stage, so a cancel could be sent',
    cancelWasSent,
    cancelWasSent
      ? null
      : `the run ended in ${String(run.elapsedMs)}ms without a walk line; this gate needs a model ` +
        'large enough to cancel mid-walk',
  );

  if (cancelWasSent) {
    const errors = run.messages.filter((message) => message.type === 'error');
    const cancelled = errors.find((error) => error.code === 'CANCELLED');
    report.check(
      'the launcher reported CANCELLED',
      cancelled !== undefined,
      cancelled === undefined
        ? `error codes seen: ${errors.map((error) => error.code).join(', ') || 'none'}`
        : null,
    );
    report.check(
      'the exit code is 9',
      run.exitCode === EXIT_CODES.cancelled,
      `exit code ${String(run.exitCode)}`,
    );
    report.check(
      'no result line was emitted',
      run.messages.every((message) => message.type !== 'result'),
    );

    const caches = cacheFileNames(settings.cancelCacheDir);
    const leftovers = leftoverFileNames(settings.cancelCacheDir);
    report.check(
      'no cache file was left behind',
      caches.length === 0,
      `${String(caches.length)} cache file(s)`,
    );
    report.check(
      'no .partial and no .ndjson.tmp were left behind',
      leftovers.length === 0,
      `${String(leftovers.length)} leftover file(s)`,
    );

    report.fact('cancelSentAtMs', run.cancelSentAtMs);
    report.fact('elapsedMs', run.elapsedMs);
    report.fact('msFromCancelToExit', run.elapsedMs - run.cancelSentAtMs);
  }

  report.fact('stagesSeen', [...run.stageFirstSeenMs.keys()].sort());
  report.finish(settings.outDir);
}
