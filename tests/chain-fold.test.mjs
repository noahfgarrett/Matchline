import test from 'node:test'
import assert from 'node:assert/strict'
import { buildProjectApp, canonicalRecordOf } from './support/compiler-harness.mjs'

/* The electrical feed-chain rules, confirmed by example with Noah:
   - Within a top-down discipline (Electrical/LSS/Security), the Easy Power /
     Cable Schedule chain IS the hierarchy: GIS on top under 602 Medium
     Voltage, fed equipment nested beneath it even when its own MEL UPN names
     a different system. The register keeps each row's OWN MEL attributes.
   - Feed sources outrank the MEL's System Parent column for that gear.
   - A feed crossing buildings or disciplines still demotes to a dependency.
   - MEL panel-side spellings (-A/-B/-C) tie to the Easy Power spelling. */

const FILES = ['compiler-chain-ep.xlsx', 'compiler-chain-cable.xlsx', 'compiler-chain-mel.xlsx']

test('the electrical chain survives system boundaries: GIS on top, feeds nested beneath', async () => {
  const app = await buildProjectApp(FILES)
  const xfm = canonicalRecordOf(app, 'B14-XFM-6041')
  assert.equal(xfm.ssmParentTag, 'GIS-01', 'the 604 transformer nests under the 602 GIS by feed')
  assert.equal(xfm.system, '604 Normal Power', 'its register row keeps its OWN MEL system')
  assert.equal(xfm.building, 'B14')
  const lvs = canonicalRecordOf(app, 'B14-LVS-6041')
  assert.equal(lvs.ssmParentTag, 'B14-XFM-6041', 'the chain continues down the feed')
})

test('feed sources outrank a wrong MEL System Parent for electrical gear', async () => {
  const app = await buildProjectApp(FILES)
  const lvs = canonicalRecordOf(app, 'B14-LVS-6041')
  assert.equal(lvs.ssmParentTag, 'B14-XFM-6041', 'the Easy Power feed wins the slot')
  const runnersUp = JSON.parse(app.eval(`
    JSON.stringify((S.resolvedSnapshot.byId[tagKey('B14-LVS-6041')] || {}).decision || null)
  `))
  const melStillRecorded = JSON.parse(app.eval(`
    JSON.stringify(S.resolvedSnapshot.candidates.some(c =>
      c.subjectId === tagKey('B14-LVS-6041') && /mel/.test(String(c.provenance && c.provenance.source)) ))
  `))
  assert.equal(melStillRecorded, true, 'the outranked MEL assertion stays recorded as a claim')
})

test('a feed crossing buildings demotes: remote gear roots in its own building with a dependency', async () => {
  const app = await buildProjectApp(FILES)
  const remote = canonicalRecordOf(app, 'B31-XFM-7777')
  assert.equal(remote.ssmParentTag, '', 'B31 gear does not nest under the B14 chain')
  assert.ok(remote.dependencies.some(d => /LVS-6041/.test(d)), `the feed survives as a dependency, got: ${remote.dependencies}`)
  assert.equal(remote.building, 'B31')
})

test('a feed crossing disciplines still demotes: the RIO keeps its own block', async () => {
  const app = await buildProjectApp(FILES)
  const rio = canonicalRecordOf(app, 'B14-RIO-6500')
  assert.equal(rio.ssmParentTag, '', 'I&C equipment never nests under an electrical feeder')
  assert.ok(rio.dependencies.some(d => /LVS-6041/.test(d)), 'the power feed is a dependency')
  assert.equal(rio.system, '650 FMS Network')
})

test('MEL panel-side spellings (-A/-B) merge into the Easy Power spelling with MEL attributes', async () => {
  const app = await buildProjectApp(FILES)
  const gis = canonicalRecordOf(app, 'GIS-01')
  assert.ok(gis, 'one canonical GIS record')
  assert.equal(gis.building, 'B14', 'attributes come from the MEL rows')
  assert.equal(gis.system, '602 Medium Voltage')
  const spellings = JSON.parse(app.eval(`
    JSON.stringify(S.ssmCombined.filter(row => /GIS-01/i.test(String(row[0]))).map(row => String(row[0])))
  `))
  assert.deepEqual(spellings, ['GIS-01'], 'the register carries one spelling, sides merged')
})

test('the SSM tree shows the chain under 602 Medium Voltage with GIS at the top', async () => {
  const app = await buildProjectApp(FILES)
  const path = JSON.parse(app.eval(`
    JSON.stringify((function () {
      const mode = activeModes(activeProfile()).find(m => m.executor === 'projected');
      const projection = S.projections[mode.id];
      const node = [...projection.nodeById.values()].find(n => n.name === 'B14-XFM-6041');
      const trail = [];
      for (let cursor = node; cursor; cursor = cursor.parent) trail.unshift(cursor.name);
      return trail;
    })())
  `))
  assert.deepEqual(path, ['B14', 'Electrical', '602 Medium Voltage', 'GIS-01', 'B14-XFM-6041'],
    'the fed transformer renders inside the chain root\'s system block')
})
