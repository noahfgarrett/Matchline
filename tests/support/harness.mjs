import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext, Script } from 'node:vm'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const BOOT_MARKER = '/* ---- boot ---- */'
// Name of a marker function planted inside the app script itself (see loadApp)
// so strict-mode tests can observe the script's real [[Strict]] status. A
// function's strictness is fixed at parse time by the script it is lexically
// part of — a function defined later, via a separate runInContext/eval call,
// is always its own (sloppy) top-level script and can never observe whether
// an earlier, separately-run script was strict. Planting the probe inside the
// same runInContext call as the app code, then calling it afterwards, is the
// only way to genuinely observe that.
const STRICT_PROBE_GLOBAL = '__ssmStrictProbe'

// Non-reflective stub: querySelector fabricates a fresh disconnected element on
// every call and appendChild's _children is never read back, so read-after-write
// does not work. A test that needs to read DOM state must fix that first.
function stubElement(tag = 'div') {
  return {
    tagName: String(tag).toUpperCase(), _children: [], dataset: {},
    style: { setProperty() {} },
    textContent: '', innerHTML: '', value: '', hidden: false, disabled: false,
    scrollTop: 0, scrollLeft: 0, clientHeight: 600, isConnected: true, parentElement: null,
    classList: {
      _s: new Set(),
      add(...c) { c.forEach(x => this._s.add(x)) },
      remove(...c) { c.forEach(x => this._s.delete(x)) },
      toggle(c, f) { f === undefined ? (this._s.has(c) ? this._s.delete(c) : this._s.add(c)) : (f ? this._s.add(c) : this._s.delete(c)) },
      contains(c) { return this._s.has(c) },
    },
    setAttribute() {}, getAttribute() { return null }, removeAttribute() {},
    hasAttribute() { return false }, addEventListener() {}, removeEventListener() {},
    appendChild(c) { this._children.push(c); return c }, removeChild() {}, remove() {},
    insertAdjacentHTML() {}, click() {}, focus() {}, closest() { return null },
    querySelector() { return stubElement() }, querySelectorAll() { return [] },
    getBoundingClientRect() { return { top: 0, left: 0, width: 800, height: 600 } },
    scrollIntoView() {}, cloneNode() { return stubElement() }, matches() { return false },
  }
}

function makeSandbox() {
  const store = new Map()
  const sandbox = {
    console, setTimeout, clearTimeout, setInterval, clearInterval, performance,
    Intl, URL, Blob, TextDecoder, TextEncoder,
    navigator: { storage: null },
    requestAnimationFrame: cb => setTimeout(() => cb(performance.now()), 0),
    cancelAnimationFrame: clearTimeout,
    document: {
      body: stubElement('body'), documentElement: stubElement('html'),
      querySelector() { return stubElement() }, querySelectorAll() { return [] },
      createElement(t) { return stubElement(t) },
      createDocumentFragment() { return stubElement('fragment') },
      addEventListener() {}, removeEventListener() {},
    },
    localStorage: {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k),
    },
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    ResizeObserver: class { observe() {} disconnect() {} },
    DOMParser: class { parseFromString() { return { querySelectorAll: () => [] } } },
    scrollTo() {}, getComputedStyle: () => ({ getPropertyValue: () => '' }),
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  return sandbox
}

/**
 * Load a built SSManagement.html into an isolated VM.
 * The boot block is stripped so nothing auto-runs on load.
 */
/**
 * Compiled scripts, cached per HTML file.
 *
 * Every loadApp used to re-PARSE the whole bundle -- well over a megabyte of
 * source -- into a fresh context, and `node --test` fans out across every core.
 * That reliably segfaulted V8: first in legend-studio, then, once that file was
 * fixed, in whichever file had become the next-biggest context creator. Fixing
 * it per file never converged because the cause is the parsing, not any one
 * test.
 *
 * `vm.Script` compiles once and can be run into as many contexts as needed, so
 * the cost is paid a single time per process no matter how many apps a file
 * loads.
 */
const scriptCache = new Map()

function compiledApp(htmlPath) {
  const cached = scriptCache.get(htmlPath)
  if (cached) return cached

  const html = readFileSync(htmlPath, 'utf8')
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1])

  /* Blocks are identified by content, not by index. This same loader also opens
     the FROZEN SSM Builder HTML for the differential, which is a different app
     with its own block count, so a fixed index or a fixed total is wrong. */
  const appIndex = blocks.findIndex(block => block.includes(BOOT_MARKER))
  if (appIndex === -1) {
    throw new Error(`boot marker ${BOOT_MARKER} not found in any script block — refusing to load, because running the boot block would mutate profile state and fire network requests`)
  }

  const preludes = []
  for (let index = 0; index < appIndex; index++) {
    /* The PDF.js block is ~1.8 MB of source strings and is deliberately SKIPPED.
       Nothing here can execute it (no Worker, no dynamic import of a Blob URL),
       and leaving LEGEND_PDFJS_LIB undefined exercises the genuine
       extractor-unavailable path. */
    if (/^\s*const LEGEND_PDFJS_LIB\s*=/.test(blocks[index])) continue
    preludes.push(new Script(blocks[index], { filename: `${htmlPath}#prelude${index}` }))
  }

  const bootAt = blocks[appIndex].indexOf(BOOT_MARKER)
  const appSource = blocks[appIndex].slice(0, bootAt)
    + `\nglobalThis.${STRICT_PROBE_GLOBAL} = function () { return this === undefined }\n`
  const compiled = { preludes, app: new Script(appSource, { filename: `${htmlPath}#app` }) }
  scriptCache.set(htmlPath, compiled)
  return compiled
}

export async function loadApp(htmlPath = resolve(rootDir, 'SSManagement.html')) {
  const { preludes, app } = compiledApp(htmlPath)
  const sandbox = makeSandbox()
  const ctx = createContext(sandbox)
  for (const prelude of preludes) prelude.runInContext(ctx)
  app.runInContext(ctx)

  return {
    ctx,
    sandbox,
    eval: code => runInContext(code, ctx),
    evalAsync: code => runInContext(`(async () => { ${code} })()`, ctx),
    // True iff the app <script> block runs in strict mode. Must be read via
    // this pre-planted probe, not a probe function written inline at the call
    // site — see STRICT_PROBE_GLOBAL above for why.
    isStrict: () => runInContext(`${STRICT_PROBE_GLOBAL}()`, ctx),
  }
}
