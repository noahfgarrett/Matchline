import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  APP_VERSION,
  LEGACY_UPDATE_CREDENTIAL_KEY,
  UPDATE_REPOSITORY,
  UPDATE_RELEASE_API,
  UPDATE_TIMEOUT_MS,
  isNewerVersion,
  trustedUpdateAssetApiUrl,
  notesHtml,
  selectUpdateAsset,
  versionedUpdateFilename,
  updateInfoFromRelease,
  fetchLatestUpdateRelease,
  fetchGitHubAssetBlob,
  downloadUpdateFile,
  embedProfileTransferInHtml,
  clearLegacyUpdateCredential,
  githubUpdateHeaders,
} from '../src/update/private-update.js'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/* Module-level globals stubbed per test: fetch, document, and DecompressionStream.
   Download helpers are imported explicitly by the updater,
   so these tests no longer depend on the generated bundle's shared scope. */

function makeFetchSpy(impl) {
  const calls = []
  const spy = async (...args) => {
    calls.push(args)
    if (impl) return impl(...args)
    throw new Error('fetch should not have been called')
  }
  spy.calls = calls
  return spy
}

function makeLocalStorageStub(entries = []) {
  const store = new Map(entries)
  return {
    getItem: key => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: key => store.delete(key),
    _store: store,
  }
}

function makeDocumentStub() {
  const created = []
  return {
    createElement(tag) {
      const el = { tag, href: '', download: '', rel: '', clicked: false, click() { el.clicked = true }, remove() {} }
      created.push(el)
      return el
    },
    body: { appendChild(el) { return el } },
    _created: created,
  }
}

test('isNewerVersion orders semantic versions correctly', () => {
  assert.equal(isNewerVersion('2.2.0', '2.1.1'), true)
  assert.equal(isNewerVersion('10.0.0', '9.9.9'), true)
  assert.equal(isNewerVersion('2.1.1', '2.1.1'), false)
  assert.equal(isNewerVersion('', '2.1.1'), false)
})

test('trustedUpdateAssetApiUrl accepts only the public SSManagement release channel', () => {
  const trusted = 'https://api.github.com/repos/noahfgarrett/SSManagement-Releases/releases/assets/12345'
  assert.equal(trustedUpdateAssetApiUrl(trusted), trusted)
  // The pre-rename channel name stays trusted: the repo was renamed and
  // GitHub's redirect may still surface the old path during the transition.
  const legacy = 'https://api.github.com/repos/noahfgarrett/SSMCompiler-Releases/releases/assets/12345'
  assert.equal(trustedUpdateAssetApiUrl(legacy), legacy)
  assert.equal(trustedUpdateAssetApiUrl('https://api.github.com/repos/attacker/evil/releases/assets/1'), '')
  assert.equal(
    trustedUpdateAssetApiUrl('https://api.github.com.evil.com/repos/noahfgarrett/SSMCompiler-Releases/releases/assets/1'),
    '',
  )
  assert.equal(trustedUpdateAssetApiUrl('https://api.github.com/repos/noahfgarrett/SSManagement/releases/assets/1'), '')
  assert.equal(trustedUpdateAssetApiUrl('https://api.github.com/repos/noahfgarrett/SSM-Builder/releases/assets/1'), '')
  assert.equal(trustedUpdateAssetApiUrl('https://example.com/not-related'), '')
})

test('notesHtml escapes HTML so a release body cannot inject markup', () => {
  const html = notesHtml('- <img src=x onerror=alert(1)>')
  assert.doesNotMatch(html, /<img/)
  assert.match(html, /&lt;img/)
})

test('selectUpdateAsset prefers the gzip HTML asset and keeps the plain HTML as fallback', () => {
  const assets = [
    {
      name: 'SSManagement.html',
      url: 'https://api.github.com/repos/noahfgarrett/SSMCompiler-Releases/releases/assets/1',
      browser_download_url: 'https://example.com/SSManagement.html',
    },
    {
      name: 'SSManagement.html.gz',
      url: 'https://api.github.com/repos/noahfgarrett/SSMCompiler-Releases/releases/assets/2',
      browser_download_url: 'https://example.com/SSManagement.html.gz',
    },
  ]
  const selected = selectUpdateAsset(assets)
  assert.equal(selected.downloadKind, 'gzip-html')
  assert.equal(selected.assetName, 'SSManagement.html.gz')
  assert.equal(selected.fallbackAssetName, 'SSManagement.html')
})

test('versionedUpdateFilename sanitises the version into a safe filename', () => {
  assert.equal(versionedUpdateFilename('3.0.0'), 'SSManagement-v3.0.0.html')
  assert.equal(versionedUpdateFilename('v3.0.0'), 'SSManagement-v3.0.0.html')
  const traversal = versionedUpdateFilename('../../etc/passwd')
  assert.ok(!traversal.includes('/'), `expected path separators to be stripped, got: ${traversal}`)
})

test('downloaded replacement HTML embeds one portable profile handoff', async () => {
  const source='<html><body><main>SSManagement</main></body></html>';
  const first=await embedProfileTransferInHtml(new Blob([source],{type:'text/html'}),'QUJD');
  const firstText=await first.text();
  assert.match(firstText,/id="ssmanagement-profile-transfer">QUJD<\/script><\/body>/);
  const second=await embedProfileTransferInHtml(first,'REVG');
  const secondText=await second.text();
  assert.equal((secondText.match(/id="ssmanagement-profile-transfer"/g)||[]).length,1);
  assert.match(secondText,/>REVG<\/script><\/body>/);
})

test('updateInfoFromRelease returns null when the release tag matches the current app version', () => {
  assert.equal(updateInfoFromRelease({ tag_name: APP_VERSION, assets: [] }), null)
  assert.equal(updateInfoFromRelease({ tag_name: 'v' + APP_VERSION, assets: [] }), null)
})

/* LOAD-BEARING. CHANGELOG is freeform prose injected verbatim into the built HTML
   (build/build.mjs), never passed through stripEsm. This confirms the built output's
   CHANGELOG round-trips exactly back to src/changelog.json, so prose corruption during
   the build (or a future edit to one copy but not the other) fails loudly here instead
   of silently shipping broken release notes. */
test('CHANGELOG in the built HTML matches src/changelog.json exactly', () => {
  const html = readFileSync(resolve(rootDir, 'SSManagement.html'), 'utf8')
  const changelogOnDisk = JSON.parse(readFileSync(resolve(rootDir, 'src/changelog.json'), 'utf8'))
  const marker = 'const CHANGELOG = '
  const start = html.indexOf(marker)
  assert.ok(start !== -1, 'const CHANGELOG = ... was not found in the built HTML')
  const bannerIdx = html.indexOf('/* GENERATED FILE', start)
  assert.ok(bannerIdx !== -1, 'GENERATED FILE banner was not found after the CHANGELOG injection')
  const raw = html.slice(start + marker.length, bannerIdx).replace(/;\s*$/, '')
  const changelogInHtml = JSON.parse(raw)
  assert.deepEqual(changelogInHtml, changelogOnDisk)
})

test('fetchLatestUpdateRelease anonymously checks only the public release channel', async () => {
  const originalFetch = globalThis.fetch
  const release = { tag_name: 'v9.9.9', assets: [] }
  const fetchSpy = makeFetchSpy(async () => ({ ok: true, json: async () => release }))
  globalThis.fetch = fetchSpy
  try {
    assert.equal(UPDATE_REPOSITORY, 'noahfgarrett/SSManagement-Releases')
    assert.deepEqual(await fetchLatestUpdateRelease(), release)
    assert.equal(fetchSpy.calls.length, 1)
    assert.equal(fetchSpy.calls[0][0], UPDATE_RELEASE_API)
    assert.equal(fetchSpy.calls[0][1].headers.Authorization, undefined)
    assert.equal(fetchSpy.calls[0][1].cache, 'no-store', 'a cached latest-release response can hide a new update')
    assert.ok(UPDATE_TIMEOUT_MS >= 10000, 'the one startup ping should tolerate a slower fresh connection')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('fetchGitHubAssetBlob refuses untrusted asset URLs before making any request', async () => {
  const originalFetch = globalThis.fetch
  const fetchSpy = makeFetchSpy()
  globalThis.fetch = fetchSpy
  const untrustedUrls = [
    'https://api.github.com/repos/attacker/evil/releases/assets/1',
    'https://api.github.com.evil.com/repos/noahfgarrett/SSMCompiler-Releases/releases/assets/1',
    'https://api.github.com/repos/noahfgarrett/SSManagement/releases/assets/1',
    'https://api.github.com/repos/noahfgarrett/SSM-Builder/releases/assets/1',
    'https://example.com/not-related',
  ]
  try {
    for (const url of untrustedUrls) {
      await assert.rejects(() => fetchGitHubAssetBlob(url), /not trusted/i, `expected ${url} to be rejected`)
    }
    assert.equal(fetchSpy.calls.length, 0, 'fetch must not be called for an untrusted asset URL')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('public update headers never attach credentials', () => {
  const headers = githubUpdateHeaders('application/vnd.github+json')
  assert.equal(headers.Authorization, undefined)
  assert.equal(headers.Accept, 'application/vnd.github+json')
})

test('the public updater removes credentials left by the retired private updater', () => {
  const originalLocalStorage = globalThis.localStorage
  const storage = makeLocalStorageStub([[LEGACY_UPDATE_CREDENTIAL_KEY, 'github_pat_retired']])
  globalThis.localStorage = storage
  try {
    clearLegacyUpdateCredential()
    assert.equal(storage.getItem(LEGACY_UPDATE_CREDENTIAL_KEY), null)
  } finally {
    globalThis.localStorage = originalLocalStorage
  }
})

test('downloadUpdateFile falls back to the public direct URL after both API tiers fail', async () => {
  const originalFetch = globalThis.fetch
  const originalDocument = globalThis.document
  const documentStub = makeDocumentStub()
  globalThis.document = documentStub
  const fetchSpy = makeFetchSpy(async () => { throw new Error('simulated network failure') })
  globalThis.fetch = fetchSpy

  const info = {
    version: '9.9.9',
    downloadKind: 'gzip-html',
    assetApiUrl: 'https://api.github.com/repos/noahfgarrett/SSMCompiler-Releases/releases/assets/111',
    assetName: 'SSManagement.html.gz',
    fallbackAssetApiUrl: 'https://api.github.com/repos/noahfgarrett/SSMCompiler-Releases/releases/assets/222',
    fallbackAssetName: 'SSManagement.html',
    downloadUrl: 'https://objects.githubusercontent.com/anonymous-gzip-download',
    fallbackDownloadUrl: 'https://objects.githubusercontent.com/anonymous-plain-download',
  }

  try {
    const result = await downloadUpdateFile(info)
    assert.equal(result.source, 'direct-url')
    assert.equal(fetchSpy.calls.length, 2)
    assert.equal(documentStub._created.length, 1)
    assert.equal(documentStub._created[0].href, info.fallbackDownloadUrl)
    assert.equal(documentStub._created[0].download, 'SSManagement-v9.9.9.html')
    assert.equal(documentStub._created[0].clicked, true)
  } finally {
    globalThis.fetch = originalFetch
    if (originalDocument === undefined) delete globalThis.document
    else globalThis.document = originalDocument
  }
})
