import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCENARIOS, captureScenario } from './snapshot.mjs'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const htmlPath = process.argv[2] || resolve(rootDir, 'SSMCompiler.html')
mkdirSync(resolve(rootDir, 'tests/golden'), { recursive: true })

for (const scenario of SCENARIOS) {
  const snap = await captureScenario(scenario, htmlPath)
  writeFileSync(
    resolve(rootDir, 'tests/golden', `${scenario.name}.json`),
    JSON.stringify(snap, null, 2) + '\n',
  )
  console.log('captured', scenario.name, '—', snap.register.length, 'register rows')
}
