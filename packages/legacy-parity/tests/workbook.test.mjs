import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { loadApp } from './support/harness.mjs'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/* ----------------------------------------------------------------------
 * extractStrikeCells runs on every uploaded workbook, but the strike data
 * it produces is consumed only by Cable Schedule ingestion (cellIsStruck,
 * called from buildDeps). It used to inflate the entire archive before
 * discovering the workbook had no strike-through styles at all -- which is
 * the common case, and the only case in which there is nothing to find.
 *
 * NOTE ON COVERAGE: the test harness stubs DOMParser (see support/harness.mjs),
 * so the XML parsing inside this function cannot be exercised here and the
 * strike feature itself has no behavioural coverage in this suite. What is
 * pinned below is the archive-reading strategy, which is what changed.
 * ---------------------------------------------------------------------- */

async function unzipCallsFor(file) {
  const app = await loadApp()
  const bytes = [...readFileSync(resolve(rootDir, 'tests/fixtures', file))]
  app.eval(`globalThis.__b = new Uint8Array(${JSON.stringify(bytes)})`)
  return JSON.parse(app.eval(`
    (function () {
      const calls = [];
      const real = fflate.unzipSync;
      fflate.unzipSync = function (data, opts) {
        const result = real(data, opts);
        calls.push({ filtered: !!(opts && opts.filter), entries: Object.keys(result).length });
        return result;
      };
      try { extractStrikeCells(__b); } finally { fflate.unzipSync = real; }
      return JSON.stringify(calls);
    })()
  `))
}

test('a workbook with no strike styles is never fully inflated', async () => {
  // large.xlsx is 6.7MB and inflates to 6.6MB. Reading only xl/styles.xml is
  // enough to prove there are no struck cells, so the sheet XML -- the whole
  // bulk of the archive -- is never decompressed or DOM-parsed.
  const calls = await unzipCallsFor('large.xlsx')
  assert.equal(calls.length, 1, `expected a single filtered read, got ${JSON.stringify(calls)}`)
  assert.equal(calls[0].filtered, true, 'the first read must be filtered, not a full inflate')
  assert.equal(calls[0].entries, 1, 'only xl/styles.xml should be decompressed')
})

test('the styles-only read still finds the style table it needs', async () => {
  // Guards the filter predicate itself: if it stopped matching xl/styles.xml,
  // extraction would silently find nothing on every workbook and struck cable
  // rows would stop being detected, with no error anywhere.
  const app = await loadApp()
  const bytes = [...readFileSync(resolve(rootDir, 'tests/fixtures/cable-schedule.xlsx'))]
  app.eval(`globalThis.__b = new Uint8Array(${JSON.stringify(bytes)})`)
  const entries = JSON.parse(app.eval(`
    JSON.stringify(Object.keys(fflate.unzipSync(__b, { filter: entry => entry.name === 'xl/styles.xml' })))
  `))
  assert.deepEqual(entries, ['xl/styles.xml'], 'the filter must still select the style table')
})

/* ----------------------------------------------------------------------
 * sheetAoa is the longest uninterrupted stretch of work in an import.
 * prewarmSheets yielded between sheets but not within one, so a single
 * large tab blocked the main thread straight through it.
 * ---------------------------------------------------------------------- */

test('the chunked sheet scan produces byte-identical output to the synchronous one', async () => {
  // The whole optimisation is only safe if this holds: same rows, same row
  // numbers, same padding, same order.
  const app = await loadApp()
  const bytes = [...readFileSync(resolve(rootDir, 'tests/fixtures/large.xlsx'))]
  app.eval(`globalThis.__b = new Uint8Array(${JSON.stringify(bytes)})`)
  const equal = await app.evalAsync(`
    const wb = XLSX.read(__b, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const sync = sheetAoa(ws);
    const async_ = await sheetAoaAsync(ws, null);
    return JSON.stringify({
      same: JSON.stringify(sync) === JSON.stringify(async_),
      rows: sync.aoa.length,
      cols: sync.aoa.length ? sync.aoa[0].length : 0,
    });
  `)
  const result = JSON.parse(equal)
  assert.equal(result.same, true, 'the chunked scan must produce exactly the synchronous result')
  assert.ok(result.rows > 1000, `fixture should be large enough to span chunks, got ${result.rows} rows`)
})

test('a large sheet yields more than once part-way through', async () => {
  // Guards the actual point of the change. If the chunk size ever grew past the
  // sheet size, output would still be correct and this is the only thing that
  // would notice the main thread had stopped being handed back.
  const app = await loadApp()
  const bytes = [...readFileSync(resolve(rootDir, 'tests/fixtures/large.xlsx'))]
  app.eval(`globalThis.__b = new Uint8Array(${JSON.stringify(bytes)})`)
  const yields = Number(await app.evalAsync(`
    const wb = XLSX.read(__b, { type: 'array' });
    let n = 0;
    await sheetAoaAsync(wb.Sheets[wb.SheetNames[0]], async () => { n++ });
    return String(n);
  `))
  assert.ok(yields > 1, `expected several mid-sheet yields on a large tab, got ${yields}`)
})

test('a small sheet does not yield at all', async () => {
  // No pointless round trips through the event loop on ordinary files.
  const app = await loadApp()
  const bytes = [...readFileSync(resolve(rootDir, 'tests/fixtures/easy-power.xlsx'))]
  app.eval(`globalThis.__b = new Uint8Array(${JSON.stringify(bytes)})`)
  const yields = Number(await app.evalAsync(`
    const wb = XLSX.read(__b, { type: 'array' });
    let n = 0;
    await sheetAoaAsync(wb.Sheets[wb.SheetNames[0]], async () => { n++ });
    return String(n);
  `))
  assert.equal(yields, 0, 'a sheet smaller than one chunk must complete without yielding')
})

test('extractStrikeCells returns a Map and tolerates non-zip input', async () => {
  const app = await loadApp()
  assert.equal(app.eval(`extractStrikeCells(new Uint8Array([1,2,3])) instanceof Map`), true)
  assert.equal(app.eval(`extractStrikeCells(new Uint8Array([1,2,3])).size`), 0,
    'input that is not a zip must return empty rather than throw')
})
