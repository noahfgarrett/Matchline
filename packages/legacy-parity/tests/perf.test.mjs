import assert from 'node:assert/strict'
import { test } from 'node:test'
import { captureScenario } from './support/snapshot.mjs'

/* Budget is ~3x the Stage A baseline measured on 2026-07-25.
   Baseline: a 20,000-row EasyPower import (large.xlsx, 26,004 tree nodes)
   built in ~2,380ms on that run.
   It exists to catch order-of-magnitude regressions, not micro-drift. */
const BUDGET_MS = 8000

test('a 20,000-row import builds within the performance budget', async () => {
  const started = performance.now()
  const snap = await captureScenario({ name: 'large', files: ['large.xlsx'] })
  const elapsed = performance.now() - started
  assert.ok(snap.stats.nodes > 1000, `expected a large tree, got ${snap.stats.nodes} nodes`)
  assert.ok(elapsed < BUDGET_MS, `build took ${Math.round(elapsed)}ms, budget is ${BUDGET_MS}ms`)
})
