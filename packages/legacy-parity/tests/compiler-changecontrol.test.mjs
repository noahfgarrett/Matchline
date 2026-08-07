import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildProjectApp } from './support/compiler-harness.mjs'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/* Change control (spec §8.5): diffs against the imported working copy, with
   broken dependencies called out separately because the SOP requires approval
   to break one. */

test('the change-control sheet calls out broken dependencies, moved parents, and removals', async () => {
  const app = await buildProjectApp(['easy-power.xlsx', 'compiler-cable.xlsx', 'compiler-mel.xlsx'])
  const wcBytes = [...readFileSync(resolve(rootDir, 'tests/fixtures', 'compiler-wc.xlsx'))]
  app.eval(`globalThis.__wc = ${JSON.stringify(wcBytes)}`)
  const rows = JSON.parse(app.eval(`
    JSON.stringify((function () {
      const bytes = new Uint8Array(__wc);
      S.workCopy = { name: 'compiler-wc.xlsx', wb: XLSX.read(bytes, { type: 'array' }) };
      parseWorkCopy();
      const wb = XLSX.utils.book_new(), used = new Set();
      addChangeControlSheet(wb, used);
      return XLSX.utils.sheet_to_json(wb.Sheets['Change Control'], { header: 1, defval: '' });
    })())
  `))
  assert.deepEqual(rows[0], ['Change', 'Equipment', 'Detail'])
  const broken = rows.find(row => row[0] === 'Broken dependency (requires approval)')
  assert.ok(broken, 'broken dependency called out')
  assert.match(broken[1], /RIO-6500/)
  assert.match(broken[2], /XFM-9999/)
  assert.ok(rows.some(row => row[0] === 'Parent moved' && /RIO-6500/.test(row[1])), 'RIO no longer nests under the panel')
  assert.ok(rows.some(row => row[0] === 'Removed from register' && /GONE-1/.test(row[1])))
})
