import assert from 'node:assert/strict';
import test from 'node:test';

import { COMPILE_STAGES, compileProject } from '@matchline/compiler';

import { SCALE_FLOORS, fingerprintOf, openScaleUniverse, scaleProfile } from './support.mjs';

/**
 * The pipeline at the size a real site has (RELEASE-1.0-PLAN, "Scale tests:
 * multi-cache >=250k objects aggregate, >=40k assets, >=1M property rows,
 * shuffled source order determinism").
 *
 * **Not part of `npm test`.** It writes about 170 MB of fixtures and compiles
 * them twice, which is a quarter of a minute and a couple of gigabytes of heap
 * — a price worth paying deliberately and not on every commit. `npm run
 * test:scale` is how it is asked for; the responsiveness half of the directive,
 * at modest sizes, is in the default suite as
 * `apps/desktop/test/compile-worker.test.mjs`.
 *
 * **No absolute time gates**, exactly as the plan says: a stage that took two
 * seconds on this machine may take six on a CI box with a slower disk, and a
 * test that failed for that would be a test about the box. The timings are
 * *recorded and reported* — `node --test` prints the diagnostics — so a
 * regression is visible to a person reading the run rather than asserted
 * against a number nobody can justify.
 *
 * What IS asserted is everything that does not depend on the machine: the
 * universe really is the size the plan asks for, the compile finishes, every
 * asset is accounted for, and registering the four files in a different order
 * is the same compile down to the byte.
 */

/** Stage durations, worked out from the announcements. */
function timedCompile(input) {
  const marks = [];
  const startedAt = Date.now();
  const project = compileProject({
    ...input,
    onStage: (stage) => {
      marks.push({ stage, at: Date.now() });
    },
  });
  const finishedAt = Date.now();

  // A stage is announced when it STARTS, so its duration runs to the next
  // announcement — and the last one runs to the end of the compile.
  const timings = marks.map((mark, index) => ({
    stage: mark.stage,
    ms: (marks[index + 1]?.at ?? finishedAt) - mark.at,
  }));
  return { project, timings, totalMs: finishedAt - startedAt };
}

function report(t, label, timings, totalMs) {
  const longest = [...timings].sort((left, right) => right.ms - left.ms).slice(0, 5);
  t.diagnostic(`${label}: ${String(totalMs)} ms total`);
  for (const entry of timings) {
    t.diagnostic(`  ${entry.stage.padEnd(20)} ${String(entry.ms).padStart(6)} ms`);
  }
  t.diagnostic(
    `  longest: ${longest.map((entry) => `${entry.stage} ${String(entry.ms)}ms`).join(', ')}`,
  );
}

test('a quarter-million-object universe compiles, and compiles the same twice', async (t) => {
  const universe = openScaleUniverse();
  t.after(() => {
    universe.close();
  });

  const { totals } = universe;
  t.diagnostic(
    `fixtures: ${String(totals.objectCount)} objects, ${String(totals.assetCount)} assets, ` +
      `${String(totals.propertyCount)} property rows, ` +
      `${String(Math.round(totals.byteSize / 1_000_000))} MB, ` +
      `written in ${String(universe.writeMs)} ms`,
  );

  assert.ok(
    totals.objectCount >= SCALE_FLOORS.objectCount,
    `${String(totals.objectCount)} objects is below the ${String(SCALE_FLOORS.objectCount)} floor`,
  );
  assert.ok(
    totals.assetCount >= SCALE_FLOORS.assetCount,
    `${String(totals.assetCount)} assets is below the ${String(SCALE_FLOORS.assetCount)} floor`,
  );
  assert.ok(
    totals.propertyCount >= SCALE_FLOORS.propertyCount,
    `${String(totals.propertyCount)} property rows is below the floor`,
  );
  assert.ok(universe.sources.length >= 4, 'and it is spread across at least four caches');

  const profile = scaleProfile();

  const first = timedCompile({ sources: universe.sources, profile });
  report(t, 'compile 1 (registration order)', first.timings, first.totalMs);

  assert.deepEqual(
    first.timings.map((entry) => entry.stage),
    [...COMPILE_STAGES],
    'every stage reported, in order, at this size too',
  );

  const stats = first.project.stats;
  assert.equal(stats.assetCount, totals.assetCount, 'every tagged object became an asset');
  assert.equal(stats.sourceCount, universe.sources.length);
  assert.equal(stats.duplicateTagCount, 0, 'the four files carry disjoint tags');
  assert.equal(stats.resolvedSystemCount, totals.assetCount, 'and the model states every system');
  assert.equal(stats.generatedMelRowCount, totals.assetCount, 'one generated MEL row per asset');
  // Four roles per family, laddered MAH -> PLC -> VFD -> TIT: three nestings and
  // one root per family, which is the shape the fixture is built to produce.
  const families = totals.assetCount / 4;
  assert.equal(stats.structuralClaimCount, families * 3);
  assert.equal(stats.snapshot.rootCount, families);
  assert.equal(stats.snapshot.cycleCount, 0);
  assert.equal(stats.snapshot.unresolvedCount, 0);

  const fingerprint = fingerprintOf(first.project);

  // Registered in a different order, which is the one thing about a universe a
  // compile must not depend on (P0-1). Held one at a time on purpose: two
  // forty-thousand-asset projects in memory to compare them would make this a
  // test about heap size.
  const shuffled = [
    universe.sources[2],
    universe.sources[0],
    universe.sources[3],
    universe.sources[1],
  ];
  const second = timedCompile({ sources: shuffled, profile });
  report(t, 'compile 2 (shuffled source order)', second.timings, second.totalMs);

  assert.deepEqual(
    fingerprintOf(second.project),
    fingerprint,
    'shuffling the source order changed nothing: same ids, same parents, same MEL bytes, same stats',
  );

  t.diagnostic(`peak rss: ${String(Math.round(process.memoryUsage().rss / 1_000_000))} MB`);
});
