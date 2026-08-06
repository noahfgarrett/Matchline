import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

/* Artifact-level properties of the self-contained SSManagement.html build that
   no unit test against a module can express — Task 9 (see also tests/update.test.mjs,
   tests/build.test.mjs, and tests/source-style.test.mjs for the direct-import and
   build-process coverage this complements). */

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const html = readFileSync(resolve(rootDir, 'SSManagement.html'), 'utf8')
const pkg = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf8'))
const changelog = JSON.parse(readFileSync(resolve(rootDir, 'src/changelog.json'), 'utf8'))

test('the built artifact is a self-contained, offline single file with a public release channel', () => {
  assert.match(html, /<title>SSManagement<\/title>/)
  /* Regression guard for the v0.1.0 rebrand corruption: an unescaped `&` in a
     sed replacement re-injected the old SSManagement header four times inside
     the tagline span. The brand block must be exactly one h1 + one tag span. */
  assert.match(html, /<div><h1>SSManagement<\/h1><span class="tag">documents&nbsp;in&nbsp;&rarr;&nbsp;ssm&nbsp;out<\/span><\/div>/)
  assert.equal([...html.matchAll(/<h1>/g)].length, 1, 'the brand block must be exactly one h1 — a rebrand sed once re-injected the header four times inside the tagline')
  assert.doesNotMatch(html, /<span class="tag">[^<]*<h1>/, 'no h1 may nest inside the tagline span')
  assert.match(html, /const UPDATE_REPOSITORY = 'noahfgarrett\/SSManagement-Releases';/)
  assert.match(html, new RegExp(`const APP_VERSION = '${pkg.version.replaceAll('.', '\\.')}'`))
  /* No service worker and no PWA manifest. A bare `register\(` used to stand in
     for the first of those; it now also matches FinalizationRegistry.register()
     inside vendored PDF.js, which has nothing to do with service workers. The
     two named tokens below are the actual prohibition and both are absent, so
     the registration check is written out precisely rather than by proxy. */
  assert.doesNotMatch(html, /serviceWorker/, 'no service worker may be referenced')
  assert.doesNotMatch(html, /manifest\.json|\.webmanifest/, 'no PWA manifest may be referenced')
  assert.doesNotMatch(html, /navigator\s*\.\s*serviceWorker|\.register\s*\(\s*['"`][^'"`]*sw\.js/,
    'no service-worker registration may be present')
  assert.doesNotMatch(html, /<script[^>]+src=/, 'no external scripts may be referenced')
  assert.doesNotMatch(html, /<link[^>]+stylesheet/, 'no external stylesheets may be referenced')
  assert.doesNotMatch(html, /noahfgarrett\/SSM-Builder/, 'SSManagement must never consume SSM Builder releases')
})

test('no GitHub Pages deployment workflow exists in this private repository', () => {
  assert.equal(existsSync(resolve(rootDir, '.github/workflows/deploy-pages.yml')), false)
})

test('the public updater contains no GitHub credential or token UI', () => {
  assert.doesNotMatch(html, /gh[pousr]_[A-Za-z0-9]{16,}/)
  assert.doesNotMatch(html, /github_pat_[A-Za-z0-9_]{20,}/)
  assert.doesNotMatch(html, /Private Updates/)
  assert.doesNotMatch(html, /privateUpdateToken/)
})

test('the LotusWorks logo is embedded as inline data, not an external asset reference', () => {
  assert.match(html, /<img class="lotus-logo" alt="LotusWorks" src="data:image\/png;base64,/)
})

test('the changelog data preserves its release history, its release-type taxonomy, and the current version', () => {
  assert.equal(changelog[0].version, pkg.version, 'the newest changelog entry should describe the current release')
  const versions = new Set(changelog.map(entry => entry.version))
  for (const v of ['1.1.5', '1.1.4', '1.1.3', '1.1.2', '1.1.1', '1.1.0', '1.0.9', '1.0.8', '1.0.7', '1.0.6', '1.0.5', '1.0.4', '1.0.3', '1.0.2']) {
    assert.ok(versions.has(v), `changelog.json is missing version ${v}`)
  }
  const types = new Set(changelog.map(entry => entry.type))
  assert.ok(types.has('feature'))
  assert.ok(types.has('fix'))
  assert.ok(types.has('major'))
})

/* UNRESOLVED CLASSIFICATION — reported rather than deleted (Task 9 instructions).
   pwa/manifest.webmanifest and pwa/sw.js are a dormant, not-yet-wired PWA deployment
   path (see README.md: "retained for a future access-controlled deployment"). They are
   not part of SSManagement.html (the single-file artifact the rest of this file
   describes), so they do not fit "Artifact" as defined for that file; they also are not
   business logic reachable by importing a module (sw.js runs only under a ServiceWorker
   global), so "Convertible" does not fit either; and nothing else in the suite covers
   them, so they are not "Subsumed". Kept here, trimmed to the properties with real
   signal, until Stage B decides whether this deployment path ships or is deleted. */
test('the dormant PWA deployment assets declare standalone display and versioned offline caching', () => {
  const manifest = readFileSync(resolve(rootDir, 'pwa/manifest.webmanifest'), 'utf8')
  const serviceWorker = readFileSync(resolve(rootDir, 'pwa/sw.js'), 'utf8')
  assert.match(manifest, /"display": "standalone"/)
  assert.match(serviceWorker, /const CACHE_NAME = 'ssmanagement-pwa-v1'/)
  assert.match(serviceWorker, /caches\.match\('\.\/index\.html'\)/)
})
