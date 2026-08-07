import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadApp } from './support/harness.mjs'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fx = f => [...readFileSync(resolve(rootDir, 'tests/fixtures', f))]

/* Field report: with Easy Power + cable alone the comparison read ~90-95%
   against the live working copy; adding the MEL made the Easy Power results
   "disappear". They were still there — buried under thousands of register
   rows the working copy never had, which the MEL seeds by construction. The
   two directions of 'nohit' are now separate buckets, and the combined view
   orders the noise last. */

async function buildWithWorkCopy(files) {
  const app = await loadApp()
  app.eval(`
    initProfiles();
    const SITE = normalizeProfile(makeDefaultProfile('Compare Site'));
    PROFILE_STORE.profiles.push(SITE); PROFILE_STORE.activeId = SITE.id;
    setRuleProfile(activeProfile());
  `)
  app.eval(`globalThis.__fixtures = ${JSON.stringify(files.map(f => ({ name: f, bytes: fx(f) })))}`)
  app.eval(`globalThis.__wc = ${JSON.stringify({ name: 'compiler-wc.xlsx', bytes: fx('compiler-wc.xlsx') })}`)
  await app.evalAsync(`
    for (const f of __fixtures) {
      const bytes = new Uint8Array(f.bytes);
      const wb = XLSX.read(bytes, { type: 'array', dense: true });
      S.files.push({ id: 'f' + S.files.length, name: f.name, ext: 'xlsx', size: bytes.length, wb,
        sheets: wb.SheetNames.slice(), strikes: extractStrikeCells(bytes), error: null });
    }
    S.workCopy = { name: __wc.name, wb: XLSX.read(new Uint8Array(__wc.bytes), { type: 'array', dense: true }) };
    parseWorkCopy();
    await prewarmSheets();
    for (const k of allHierKeys()) S.selected.add(k);
    await buildHierarchy();
    return '';
  `)
  return app
}

const FILES = ['easy-power.xlsx', 'compiler-ep.xlsx', 'compiler-cable.xlsx', 'compiler-mel.xlsx']

test('the nohit bucket splits by direction: working-copy gaps vs register extras', async () => {
  const app = await buildWithWorkCopy(FILES)
  const buckets = JSON.parse(app.eval(`
    JSON.stringify({
      gap: S.compareBuckets.gap.map(r => r.equip),
      extraCount: S.compareBuckets.extra.length,
      nohitCount: S.compareBuckets.nohit.length,
      offCount: S.compareBuckets.off.length,
    })
  `))
  assert.ok(buckets.gap.includes('GONE-1'), 'a working-copy row this build did not produce is a gap')
  assert.ok(buckets.extraCount > 0, 'MEL-seeded register rows absent from the working copy are extras')
  assert.equal(buckets.nohitCount, buckets.gap.length + buckets.extraCount, 'gap + extra partition nohit exactly')
  assert.ok(buckets.offCount >= 1, 'the RIO parent disagreement stays a non-match')
})

test('the combined view orders extras last, so matches never sink below register noise', async () => {
  const app = await buildWithWorkCopy(FILES)
  const order = JSON.parse(app.eval(`
    JSON.stringify(compareRowsFor('all','','all',null).map(r => compareBucketOf(r)))
  `))
  const rank = { off: 0, gap: 1, match: 2, extra: 3 }
  for (let i = 1; i < order.length; i++) {
    assert.ok(rank[order[i]] >= rank[order[i - 1]],
      `combined view out of order at ${i}: ${order[i - 1]} then ${order[i]}`)
  }
  assert.ok(order.includes('extra'), 'the MEL produced extras in this scenario')
  assert.equal(order[order.length - 1], 'extra', 'extras sit at the bottom of the combined view')
})
