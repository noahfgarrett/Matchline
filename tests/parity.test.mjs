import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { SCENARIOS, captureScenario } from './support/snapshot.mjs'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

for (const scenario of SCENARIOS) {
  test(`parity: ${scenario.name} matches the approved Eagle snapshot`, async () => {
    const golden = JSON.parse(readFileSync(resolve(rootDir, 'tests/golden', `${scenario.name}.json`), 'utf8'))
    const actual = await captureScenario(scenario)
    assert.deepEqual(actual, golden)
  })
}
