import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { buildHtml } from '../build/build.mjs'
import { loadApp } from './support/harness.mjs'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('SSMCompiler.html is up to date with src/', () => {
  const onDisk = readFileSync(resolve(rootDir, 'SSMCompiler.html'), 'utf8')
  assert.equal(onDisk, buildHtml(), 'SSMCompiler.html is stale — run `npm run build`')
})

test('the generated file carries a do-not-edit banner', () => {
  const onDisk = readFileSync(resolve(rootDir, 'SSMCompiler.html'), 'utf8')
  assert.match(onDisk, /GENERATED FILE — do not edit directly/)
})

test('the built bundle runs in strict mode', async () => {
  // A probe function written inline in an app.eval() call would always report
  // sloppy mode, regardless of the bundle's real strictness: each app.eval()
  // call runs as its own freshly-compiled top-level script (like a separate
  // <script> tag or a fresh indirect eval), and a function's [[Strict]] flag
  // is fixed by the script it is lexically defined in, not by who calls it
  // later. So loadApp() plants the probe inside the app script's own
  // execution and exposes it as app.isStrict() — see tests/support/harness.mjs.
  const app = await loadApp()
  assert.equal(app.isStrict(), true,
    'the built bundle must run in strict mode — check that "use strict" is the first statement of the app <script> block')
})
