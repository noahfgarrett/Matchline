import test from 'node:test'
import assert from 'node:assert/strict'
import { foldClaimsByPartition, recordPartitionKey } from '../src/compiler/fold.js'
import { HIERARCHY_CLAIM_KIND } from '../src/hierarchy/claims.js'
import { buildProjectApp, canonicalRecordOf } from './support/compiler-harness.mjs'

/* The partition fold (spec §5): parent-vs-dependency is the feed relationship
   crossed with the partition. Same bucket → structural parent. Different
   bucket → dependency, and the subject roots in its own system block. */

const partition = values => id => values[id] ?? null
const parentClaim = (subjectId, targetId, priority, id) =>
  ({ id, kind: HIERARCHY_CLAIM_KIND.STRUCTURAL_PARENT, subjectId, targetId, priority, order: 0, provenance: { source: 'cable' } })

test('canonical RIO case: cross-UPN feeder becomes a dependency claim', () => {
  const out = foldClaimsByPartition([parentClaim('rio650', 'panel603', 900, 'p1')],
    partition({ rio650: 'OC31|I&C|650 FMS', panel603: 'OC31|ELECTRICAL|603 Low Voltage' }))
  assert.equal(out.filter(c => c.kind === HIERARCHY_CLAIM_KIND.STRUCTURAL_PARENT).length, 0)
  const dep = out.find(c => c.kind === HIERARCHY_CLAIM_KIND.DEPENDENCY)
  assert.equal(dep.subjectId, 'rio650')
  assert.equal(dep.targetId, 'panel603')
  assert.match(dep.provenance.demoted, /650 FMS.*603 Low Voltage/)
})

test('same-partition candidate survives while cross-partition one demotes, regardless of priority', () => {
  const out = foldClaimsByPartition([
    parentClaim('vfd', 'elecPanel', 1000, 'p1'),
    parentClaim('vfd', 'mah', 500, 'p2'),
  ], partition({ vfd: 'B|MECH|101 MAH', mah: 'B|MECH|101 MAH', elecPanel: 'B|ELECTRICAL|603 LV' }))
  const parents = out.filter(c => c.kind === HIERARCHY_CLAIM_KIND.STRUCTURAL_PARENT)
  assert.equal(parents.length, 1)
  assert.equal(parents[0].targetId, 'mah')
  assert.equal(out.find(c => c.kind === HIERARCHY_CLAIM_KIND.DEPENDENCY).targetId, 'elecPanel')
})

test('unknown partitions never demote — a boundary crossing must be proven', () => {
  const out = foldClaimsByPartition([parentClaim('a', 'b', 900, 'p1')], partition({ a: 'B|E|603 LV' }))
  assert.equal(out[0].kind, HIERARCHY_CLAIM_KIND.STRUCTURAL_PARENT)
})

test('dependency claims pass through untouched', () => {
  const dep = { id: 'd1', kind: HIERARCHY_CLAIM_KIND.DEPENDENCY, subjectId: 'a', targetId: 'c', priority: 1000, order: 1, provenance: {} }
  assert.deepEqual(foldClaimsByPartition([dep], partition({})), [dep])
})

test('recordPartitionKey requires every component to be explicit — fallback attributes never form a partition', () => {
  const explicitRecord = { building: 'B14', discipline: 'I&C', system: '650 FMS',
    context: { explicit: { building: true, discipline: true, system: true } } }
  assert.equal(recordPartitionKey(explicitRecord), 'B14|I&C|650 FMS')
  const fallbackSystem = { building: 'B14', discipline: 'Electrical', system: '602 Medium Voltage',
    context: { explicit: { building: true, discipline: true, system: false } } }
  assert.equal(recordPartitionKey(fallbackSystem), null)
  const unassigned = { building: 'Unassigned Building', discipline: 'I&C', system: '650 FMS',
    context: { explicit: { building: true, discipline: true, system: true } } }
  assert.equal(recordPartitionKey(unassigned), null)
})

/* Integration: the compiler fixtures wire B14-RIO-6500 (I&C / 650) to a cable
   feed from B14-LVS-1234 (Electrical / 1234), and MTR-9001 (Mechanical / 2201)
   to an Easy Power feed from the same switchgear. Both must root in their own
   systems with the feeder as a dependency. */

test('integration: cross-UPN cable feed roots the RIO with the panel as dependency', async () => {
  const app = await buildProjectApp(['easy-power.xlsx', 'compiler-cable.xlsx', 'compiler-mel.xlsx'])
  const rio = canonicalRecordOf(app, 'B14-RIO-6500')
  assert.equal(rio.ssmParentTag, '', 'RIO must root — no structural parent inside 650')
  assert.ok(rio.dependencies.some(d => /LVS-1234/.test(d)), `LVS feeder must be a dependency, got: ${rio.dependencies}`)
})

test('integration: same-partition cable parent survives while the electrical feed demotes', async () => {
  // MTR-9001: cable says AHU-7001 (same partition, wins the parent slot), Easy
  // Power feeds it from LVS-1234 (Electrical / 1234 — demotes to dependency),
  // and the MEL asserts AHU-7002 (loses to cable; surfaces as a contradiction
  // in the Completed MEL export, not as a silent override).
  const app = await buildProjectApp(['easy-power.xlsx', 'compiler-cable.xlsx', 'compiler-mel.xlsx'])
  const mtr = canonicalRecordOf(app, 'MTR-9001')
  assert.equal(mtr.ssmParentTag, 'B14-AHU-7001', 'same-partition cable feed takes the parent slot')
  assert.ok(mtr.dependencies.some(d => /LVS-1234/.test(d)), `LVS feeder must be a dependency, got: ${mtr.dependencies}`)
})

test('integration: records without MEL partitions keep their flow parents', async () => {
  const app = await buildProjectApp(['easy-power.xlsx', 'compiler-cable.xlsx', 'compiler-mel.xlsx'])
  const mtr = canonicalRecordOf(app, 'MTR-9002')
  assert.ok(mtr.ssmParentTag, 'MTR-9002 has no MEL row, so its electrical parent must survive the fold')
})

test('integration: a parent never repeats as its own dependency (SOP rule)', async () => {
  const app = await buildProjectApp(['easy-power.xlsx', 'compiler-cable.xlsx', 'compiler-mel.xlsx'])
  const duplicates = JSON.parse(app.eval(`
    JSON.stringify([...S.canonicalModel.values()]
      .filter(r => r.ssmParentTag && [...r.dependencies].some(d => tagKey(d) === tagKey(r.ssmParentTag)))
      .map(r => r.tag))
  `))
  assert.deepEqual(duplicates, [], 'no record lists its structural parent as a dependency')
})

test('integration: a MEL-only asset nests under its asserted same-partition System Parent', async () => {
  const app = await buildProjectApp(['easy-power.xlsx', 'compiler-cable.xlsx', 'compiler-mel.xlsx'])
  const fcu = canonicalRecordOf(app, 'B14-FCU-7101')
  assert.ok(fcu, 'MEL-only FCU exists')
  assert.equal(fcu.ssmParentTag, 'B14-AHU-7001', 'the MEL System Parent assertion becomes a claim even with no electrical source')
})
