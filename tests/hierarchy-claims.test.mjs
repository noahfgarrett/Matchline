import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  HIERARCHY_CLAIM_KIND,
  MANUAL_OVERRIDE_PRIORITY,
  resolveHierarchyClaims,
} from '../src/hierarchy/claims.js'

const PARENT = HIERARCHY_CLAIM_KIND.STRUCTURAL_PARENT
const DEPENDENCY = HIERARCHY_CLAIM_KIND.DEPENDENCY

const parent = (id, subjectId, targetId, priority, extra = {}) => ({
  id, kind: PARENT, subjectId, targetId, priority, ...extra,
})

const dependency = (id, subjectId, targetId, priority, extra = {}) => ({
  id, kind: DEPENDENCY, subjectId, targetId, priority, ...extra,
})

test('observations and candidates retain provenance in a projection-friendly snapshot', () => {
  const snapshot = resolveHierarchyClaims({
    observations: [
      { id: 'o-load', entityId: 'LOAD-1', tag: 'LOAD-1', provenance: { file: 'easy.xlsx', sheet: 'Power', row: 9 } },
      { id: 'o-panel', entityId: 'PANEL-1', tag: 'PANEL-1', provenance: { file: 'cable.xlsx', row: 4 } },
    ],
    candidates: [
      parent('p1', 'LOAD-1', 'PANEL-1', 20, { provenance: { source: 'cable', row: 4 } }),
      dependency('d1', 'LOAD-1', 'UPS-1', 10, { provenance: { source: 'easyPower', row: 9 } }),
      dependency('d2', 'LOAD-1', 'GEN-1', 5, { provenance: { source: 'mel', row: 12 } }),
    ],
  })

  assert.equal(snapshot.valid, true)
  assert.equal(snapshot.byId['LOAD-1'].parentId, 'PANEL-1')
  assert.deepEqual(snapshot.byId['LOAD-1'].dependencyIds, ['UPS-1', 'GEN-1'])
  assert.deepEqual(snapshot.byId['LOAD-1'].observationIds, ['o-load'])
  assert.deepEqual(snapshot.observations[0].provenance, { file: 'easy.xlsx', sheet: 'Power', row: 9 })
  assert.deepEqual(snapshot.candidates.find(candidate => candidate.id === 'p1').provenance,
    { source: 'cable', row: 4 })
  assert.deepEqual(snapshot.byId['LOAD-1'].parentResolution.provenance,
    [{ candidateId: 'p1', provenance: { source: 'cable', row: 4 } }])
})

test('higher explicit priority wins while every superseded candidate remains available', () => {
  const snapshot = resolveHierarchyClaims({
    candidates: [
      parent('low', 'LOAD-1', 'PANEL-OLD', 10, { order: 0 }),
      parent('high', 'LOAD-1', 'PANEL-NEW', 30, { order: 99 }),
    ],
  })
  const entity = snapshot.byId['LOAD-1']

  assert.equal(entity.parentId, 'PANEL-NEW')
  assert.equal(entity.parentResolution.selectedCandidateId, 'high')
  assert.deepEqual(entity.parentResolution.supersededCandidateIds, ['low'])
  assert.deepEqual(entity.parentResolution.candidateIds, ['high', 'low'])
})

test('deterministic order selects representative evidence only when the parent agrees', () => {
  const snapshot = resolveHierarchyClaims({
    candidates: [
      parent('later', 'LOAD-1', 'PANEL-1', 20, { order: 20, provenance: { row: 20 } }),
      parent('earlier', 'LOAD-1', 'PANEL-1', 20, { order: 10, provenance: { row: 10 } }),
    ],
  })
  const resolution = snapshot.byId['LOAD-1'].parentResolution

  assert.equal(resolution.status, 'resolved')
  assert.equal(resolution.selectedCandidateId, 'earlier')
  assert.deepEqual(resolution.supportingCandidateIds, ['earlier', 'later'])
  assert.equal(snapshot.ambiguities.length, 0)
})

test('equal-priority distinct parents are ambiguous and never first-wins', () => {
  const forward = resolveHierarchyClaims({
    candidates: [
      parent('a', 'LOAD-1', 'PANEL-A', 20, { order: 1, provenance: { row: 1 } }),
      parent('b', 'LOAD-1', 'PANEL-B', 20, { order: 2, provenance: { row: 2 } }),
    ],
  })
  const reversed = resolveHierarchyClaims({
    candidates: [
      parent('b', 'LOAD-1', 'PANEL-B', 20, { order: 2, provenance: { row: 2 } }),
      parent('a', 'LOAD-1', 'PANEL-A', 20, { order: 1, provenance: { row: 1 } }),
    ],
  })

  for (const snapshot of [forward, reversed]) {
    const entity = snapshot.byId['LOAD-1']
    assert.equal(entity.parentId, null)
    assert.equal(entity.parentResolution.status, 'ambiguous')
    assert.deepEqual(entity.parentResolution.competingParentIds, ['PANEL-A', 'PANEL-B'])
    assert.deepEqual(entity.parentResolution.supportingCandidateIds, ['a', 'b'])
    assert.equal(snapshot.valid, false)
  }
})

test('an explicit manual override outranks every source candidate and can choose a root', () => {
  const moved = resolveHierarchyClaims({
    candidates: [parent('source', 'LOAD-1', 'PANEL-A', 1000000)],
    manualOverrides: [{
      id: 'move',
      kind: PARENT,
      subjectId: 'LOAD-1',
      targetId: 'PANEL-B',
      provenance: { user: 'Noah', reason: 'placement review' },
    }],
  })
  const rooted = resolveHierarchyClaims({
    candidates: [parent('source', 'LOAD-1', 'PANEL-A', 1000000)],
    manualOverrides: [{
      id: 'root',
      kind: PARENT,
      subjectId: 'LOAD-1',
      targetId: null,
      provenance: { reason: 'intentional root' },
    }],
  })

  assert.equal(moved.byId['LOAD-1'].parentId, 'PANEL-B')
  assert.equal(moved.byId['LOAD-1'].parentResolution.manual, true)
  assert.equal(moved.candidates.find(candidate => candidate.id === 'move').priority, MANUAL_OVERRIDE_PRIORITY)
  assert.deepEqual(moved.manualOverrideIds, ['move'])
  assert.equal(rooted.byId['LOAD-1'].parentId, null)
  assert.equal(rooted.byId['LOAD-1'].parentResolution.status, 'resolved')
  assert.equal(rooted.byId['LOAD-1'].parentResolution.explicitRoot, true)
})

test('conflicting manual overrides remain ambiguous', () => {
  const snapshot = resolveHierarchyClaims({
    manualOverrides: [
      { id: 'm1', kind: PARENT, subjectId: 'LOAD-1', targetId: 'PANEL-A', order: 1 },
      { id: 'm2', kind: PARENT, subjectId: 'LOAD-1', targetId: 'PANEL-B', order: 2 },
    ],
  })

  assert.equal(snapshot.byId['LOAD-1'].parentId, null)
  assert.equal(snapshot.byId['LOAD-1'].parentResolution.status, 'ambiguous')
  assert.equal(snapshot.ambiguities[0].manual, true)
})

test('dependencies are additive, deduplicated by target, and retain all supporting claims', () => {
  const snapshot = resolveHierarchyClaims({
    candidates: [
      dependency('ups-low', 'LOAD-1', 'UPS-1', 5, { provenance: { source: 'easyPower' } }),
      dependency('gen', 'LOAD-1', 'GEN-1', 10, { provenance: { source: 'mel' } }),
      dependency('ups-high', 'LOAD-1', 'UPS-1', 20, { provenance: { source: 'cable' } }),
    ],
  })
  const entity = snapshot.byId['LOAD-1']

  assert.deepEqual(entity.dependencyIds, ['UPS-1', 'GEN-1'])
  assert.equal(entity.dependencies.length, 2)
  assert.deepEqual(entity.dependencies[0].candidateIds, ['ups-high', 'ups-low'])
  assert.deepEqual(entity.dependencies[0].provenance, [
    { candidateId: 'ups-high', provenance: { source: 'cable' } },
    { candidateId: 'ups-low', provenance: { source: 'easyPower' } },
  ])
})

test('structural cycles are flagged and quarantined without discarding proposed edges', () => {
  const snapshot = resolveHierarchyClaims({
    candidates: [
      parent('a-to-b', 'A', 'B', 10, { provenance: { row: 1 } }),
      parent('b-to-c', 'B', 'C', 10, { provenance: { row: 2 } }),
      parent('c-to-a', 'C', 'A', 10, { provenance: { row: 3 } }),
      parent('child-to-a', 'CHILD', 'A', 10, { provenance: { row: 4 } }),
    ],
  })

  assert.equal(snapshot.valid, false)
  assert.equal(snapshot.cycles.length, 1)
  assert.deepEqual(snapshot.cycles[0].entityIds, ['A', 'B', 'C'])
  assert.deepEqual(snapshot.cycles[0].candidateIds, ['a-to-b', 'b-to-c', 'c-to-a'])
  for (const [entityId, proposedParentId] of [['A', 'B'], ['B', 'C'], ['C', 'A']]) {
    const entity = snapshot.byId[entityId]
    assert.equal(entity.parentId, null)
    assert.equal(entity.parentResolution.status, 'cycle')
    assert.equal(entity.parentResolution.proposedParentId, proposedParentId)
    assert.ok(entity.issueIds.includes(snapshot.cycles[0].id))
  }
  assert.equal(snapshot.byId.CHILD.parentId, 'A', 'non-cycle descendants retain their resolved edge')
  assert.deepEqual(snapshot.cycles[0].provenance, [
    { candidateId: 'a-to-b', provenance: { row: 1 } },
    { candidateId: 'b-to-c', provenance: { row: 2 } },
    { candidateId: 'c-to-a', provenance: { row: 3 } },
  ])
})

test('a self-parent is reported as a one-node structural cycle', () => {
  const snapshot = resolveHierarchyClaims({
    candidates: [parent('self', 'A', 'A', 10)],
  })

  assert.deepEqual(snapshot.cycles[0].entityIds, ['A'])
  assert.equal(snapshot.byId.A.parentId, null)
  assert.equal(snapshot.byId.A.parentResolution.proposedParentId, 'A')
})

test('the returned snapshot is detached from inputs and deeply frozen', () => {
  const observation = {
    id: 'o1',
    entityId: 'A',
    attributes: { building: 'B14' },
    provenance: { cells: [{ row: 2, column: 'A' }] },
  }
  const candidate = parent('p1', 'A', 'ROOT', 10, {
    provenance: { cells: [{ row: 2, column: 'B' }] },
  })
  const snapshot = resolveHierarchyClaims({
    observations: [observation],
    candidates: [candidate],
  })
  observation.attributes.building = 'CHANGED'
  observation.provenance.cells[0].row = 99
  candidate.provenance.cells[0].row = 99

  assert.equal(snapshot.observations[0].attributes.building, 'B14')
  assert.equal(snapshot.observations[0].provenance.cells[0].row, 2)
  assert.equal(snapshot.candidates[0].provenance.cells[0].row, 2)
  assert.ok(Object.isFrozen(snapshot))
  assert.ok(Object.isFrozen(snapshot.entities))
  assert.ok(Object.isFrozen(snapshot.byId.A))
  assert.ok(Object.isFrozen(snapshot.observations[0].provenance.cells[0]))
  assert.throws(() => { snapshot.byId.A.parentId = 'OTHER' }, TypeError)
  assert.throws(() => { snapshot.byId.NEW = {} }, TypeError)
})

test('ordinary candidates require a finite numeric priority', () => {
  assert.throws(
    () => resolveHierarchyClaims({
      candidates: [{ id: 'missing', kind: PARENT, subjectId: 'A', targetId: 'B' }],
    }),
    /explicit finite numeric priority/,
  )
  assert.throws(
    () => resolveHierarchyClaims({
      candidates: [parent('too-high', 'A', 'B', MANUAL_OVERRIDE_PRIORITY)],
    }),
    /lower than MANUAL_OVERRIDE_PRIORITY/,
  )
})
