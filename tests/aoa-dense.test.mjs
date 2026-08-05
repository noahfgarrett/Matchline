import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadApp } from './support/harness.mjs'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/* The app reads workbooks with {dense:true} for speed; the sparse path stays
   for anything that hands sheetAoa an address-keyed worksheet. The two paths
   must be indistinguishable — every downstream stage (detection, seeding,
   goldens) consumes this output. */

const FIXTURES = ['large.xlsx', 'compiler-mel.xlsx', 'easy-power.xlsx', 'cable-schedule.xlsx', 'mel.xlsx']

test('dense and sparse worksheet scans produce byte-identical AoA output', async () => {
  const app = await loadApp()
  for (const fixture of FIXTURES) {
    const bytes = [...readFileSync(resolve(rootDir, 'tests/fixtures', fixture))]
    app.eval(`globalThis.__bytes = new Uint8Array(${JSON.stringify(bytes)})`)
    const identical = JSON.parse(app.eval(`
      JSON.stringify((function () {
        const sparse = XLSX.read(__bytes, { type: 'array' });
        const dense = XLSX.read(__bytes, { type: 'array', dense: true });
        return sparse.SheetNames.map(name => {
          const a = sheetAoa(sparse.Sheets[name]);
          const b = sheetAoa(dense.Sheets[name]);
          return { name, same: JSON.stringify(a) === JSON.stringify(b), rows: a.aoa.length, denseRows: b.aoa.length };
        });
      })())
    `))
    for (const sheet of identical) {
      assert.equal(sheet.same, true, `${fixture} → ${sheet.name}: dense scan diverged (sparse ${sheet.rows} rows, dense ${sheet.denseRows})`)
      assert.ok(sheet.rows > 0, `${fixture} → ${sheet.name}: fixture unexpectedly empty`)
    }
  }
})

test('the async dense scan matches the synchronous one and yields mid-sheet', async () => {
  const app = await loadApp()
  const bytes = [...readFileSync(resolve(rootDir, 'tests/fixtures', 'large.xlsx'))]
  app.eval(`globalThis.__bytes = new Uint8Array(${JSON.stringify(bytes)})`)
  const result = JSON.parse(await app.evalAsync(`
    const wb = XLSX.read(__bytes, { type: 'array', dense: true });
    const name = wb.SheetNames[0];
    let chunks = 0;
    const sync = sheetAoa(wb.Sheets[name]);
    const chunked = await sheetAoaAsync(wb.Sheets[name], () => { chunks++; });
    return JSON.stringify({ same: JSON.stringify(sync) === JSON.stringify(chunked), chunks });
  `))
  assert.equal(result.same, true, 'chunked dense output must be byte-identical')
  assert.ok(result.chunks > 0, 'a large dense sheet must yield at least once mid-scan')
})
