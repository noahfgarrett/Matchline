import test from 'node:test'
import assert from 'node:assert/strict'
import { buildProjectApp, buildEagleApp } from './support/compiler-harness.mjs'

/* An empty build must name its actual blocker — Noah hit the blanket "no
   hierarchy rows" toast in the field with no way to tell whether the MEL's
   headers were unrecognized, the profile gated seeding off, or the tab was
   simply sitting in the wrong selection group. */

test('a MEL tab with an unrecognized header row is named, not silently skipped', async () => {
  const app = await buildProjectApp(['compiler-mel-noheaders.xlsx'])
  const diag = JSON.parse(app.eval(`
    JSON.stringify({ mel: S.melSel.size, rows: S.ssmCombined.length, msg: emptyBuildDiagnosis() })
  `))
  assert.equal(diag.mel, 1, 'the tab named "Equipment List" is treated as a MEL by name')
  assert.equal(diag.rows, 0, 'nothing was built')
  assert.match(diag.msg, /no Equipment Tag header row was recognized/)
  assert.match(diag.msg, /Data Mapping/, 'the message points at the manual mapping fix')
})

test('the shipped built-in profile compiles a MEL alone — no site profile needed', async () => {
  /* Noah's field failure: the active profile on his work machine was the
     legacy-frozen Eagle, and a MEL-only build silently produced nothing. The
     shipped built-in must now be the universal compiler profile. */
  const app = await buildEagleApp(['compiler-mel.xlsx'])
  const built = JSON.parse(app.eval(`
    JSON.stringify({ profile: activeProfile().name, locked: activeProfile().locked, rows: S.ssmCombined.length })
  `))
  assert.equal(built.profile, 'SSManagement Default')
  assert.equal(built.locked, true)
  assert.ok(built.rows >= 10, `the built-in must seed the register from the MEL alone, got ${built.rows}`)
})

test('a profile with MEL seeding disabled names the gate instead of the generic toast', async () => {
  const app = await buildProjectApp(['compiler-mel.xlsx'])
  const diag = JSON.parse(app.eval(`
    JSON.stringify((function () {
      activeProfile().hierarchy.melSeed.enabled = false;
      S.roots = []; S.ssmCombined = [];
      return emptyBuildDiagnosis();
    })())
  `))
  assert.match(diag, /MEL seeding is off/)
  assert.match(diag, /switch to an editable site profile/)
})

test('a MEL-looking tab checked as a hierarchy sheet is pointed back to the MEL slot', async () => {
  const app = await buildProjectApp(['compiler-mel.xlsx'])
  const msg = JSON.parse(app.eval(`
    JSON.stringify((function () {
      const key = [...S.melSel][0];
      S.melSel.clear(); S.selected.add(key);
      S.roots = []; S.ssmCombined = [];
      return emptyBuildDiagnosis();
    })())
  `))
  assert.match(msg, /looks like a Master Equipment List/)
})

test('a healthy build with no recognizable sources keeps the generic message', async () => {
  const app = await buildProjectApp(['compiler-mel.xlsx'])
  const msg = JSON.parse(app.eval(`
    JSON.stringify((function () {
      S.melSel.clear(); S.selected.clear();
      S.roots = []; S.ssmCombined = [];
      return emptyBuildDiagnosis();
    })())
  `))
  assert.equal(msg, 'No hierarchy rows found in the selected tabs')
})
