export const HIERARCHY_CLAIM_KIND = Object.freeze({
  STRUCTURAL_PARENT: 'structural-parent',
  DEPENDENCY: 'dependency',
})

export const MANUAL_OVERRIDE_PRIORITY = Number.MAX_SAFE_INTEGER

function cloneData(value, seen = new Map()) {
  if (value == null || typeof value !== 'object') return value
  if (seen.has(value)) return seen.get(value)
  if (Array.isArray(value)) {
    const copy = []
    seen.set(value, copy)
    for (const item of value) copy.push(cloneData(item, seen))
    return copy
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError('observations, candidates, and provenance must contain only plain data')
  }
  const copy = prototype === null ? Object.create(null) : {}
  seen.set(value, copy)
  for (const key of Object.keys(value)) copy[key] = cloneData(value[key], seen)
  return copy
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value == null || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  /* Object.keys, not Reflect.ownKeys: cloneData guarantees plain data with
     enumerable string keys only, and this walk covers every record and claim
     in the snapshot — the symbol machinery was pure overhead at scale. */
  for (const key of Object.keys(value)) deepFreeze(value[key], seen)
  return Object.freeze(value)
}

function compareText(a, b) {
  const left = String(a)
  const right = String(b)
  return left < right ? -1 : left > right ? 1 : 0
}

function requiredId(value, label) {
  const id = typeof value === 'string' ? value.trim() : ''
  if (!id) throw new TypeError(`${label} must be a non-empty string`)
  return id
}

function optionalId(value, fallback, label) {
  return value == null || value === '' ? fallback : requiredId(value, label)
}

function numericPriority(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} must have an explicit finite numeric priority`)
  }
  if (value >= MANUAL_OVERRIDE_PRIORITY) {
    throw new RangeError(`${label} priority must be lower than MANUAL_OVERRIDE_PRIORITY`)
  }
  return value
}

function numericOrder(value, fallback, label) {
  if (value == null) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${label} order must be a finite number`)
  }
  return value
}

function normalizeObservation(input, index, usedIds) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`observation at index ${index} must be an object`)
  }
  const copy = cloneData(input)
  const id = optionalId(input.id, `observation:${index}`, `observation at index ${index} id`)
  if (usedIds.has(id)) throw new Error(`duplicate observation id: ${id}`)
  usedIds.add(id)
  copy.id = id
  copy.entityId = requiredId(input.entityId, `observation ${id} entityId`)
  copy.provenance = cloneData(input.provenance == null ? null : input.provenance)
  return copy
}

function normalizeCandidate(input, index, manual, usedIds, fallbackOrder) {
  const label = manual ? `manual override at index ${index}` : `candidate at index ${index}`
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`${label} must be an object`)
  }
  if (!manual && input.manual === true) {
    throw new TypeError(`${label} must be passed through manualOverrides to receive manual precedence`)
  }
  const copy = cloneData(input)
  const id = optionalId(input.id, `${manual ? 'manual' : 'candidate'}:${index}`, `${label} id`)
  if (usedIds.has(id)) throw new Error(`duplicate candidate id: ${id}`)
  usedIds.add(id)

  const kind = input.kind
  if (kind !== HIERARCHY_CLAIM_KIND.STRUCTURAL_PARENT && kind !== HIERARCHY_CLAIM_KIND.DEPENDENCY) {
    throw new TypeError(`${label} has unsupported kind: ${String(kind)}`)
  }
  if (!Object.prototype.hasOwnProperty.call(input, 'targetId')) {
    throw new TypeError(`${label} must declare targetId`)
  }
  const targetId = input.targetId == null
    ? null
    : requiredId(input.targetId, `${label} targetId`)
  if (kind === HIERARCHY_CLAIM_KIND.DEPENDENCY && targetId == null) {
    throw new TypeError(`${label} dependency targetId must be a non-empty string`)
  }

  copy.id = id
  copy.kind = kind
  copy.subjectId = requiredId(input.subjectId, `${label} subjectId`)
  copy.targetId = targetId
  copy.priority = manual
    ? MANUAL_OVERRIDE_PRIORITY
    : numericPriority(input.priority, label)
  copy.order = numericOrder(input.order, fallbackOrder, label)
  copy.manual = manual
  copy.provenance = cloneData(input.provenance == null ? null : input.provenance)
  return copy
}

function comparePrecedence(left, right) {
  if (left.manual !== right.manual) return left.manual ? -1 : 1
  if (left.priority !== right.priority) return right.priority - left.priority
  if (left.order !== right.order) return left.order - right.order
  return compareText(left.id, right.id)
}

function compareStoredCandidates(left, right) {
  if (left.order !== right.order) return left.order - right.order
  return compareText(left.id, right.id)
}

function samePrecedence(left, right) {
  return left.manual === right.manual && left.priority === right.priority
}

function provenanceFor(candidates) {
  return candidates.map(candidate => ({
    candidateId: candidate.id,
    provenance: candidate.provenance,
  }))
}

function choiceKey(targetId) {
  return targetId == null ? '\u0000root' : `\u0001${targetId}`
}

function compareTarget(left, right) {
  if (left == null) return right == null ? 0 : -1
  if (right == null) return 1
  return compareText(left, right)
}

function resolveParent(entityId, candidates) {
  const ranked = candidates.slice().sort(comparePrecedence)
  if (!ranked.length) {
    return {
      resolution: {
        status: 'none',
        parentId: null,
        explicitRoot: false,
        priority: null,
        manual: false,
        selectedCandidateId: null,
        supportingCandidateIds: [],
        supersededCandidateIds: [],
        candidateIds: [],
        provenance: [],
      },
      ambiguity: null,
    }
  }

  const leading = ranked.filter(candidate => samePrecedence(candidate, ranked[0]))
  const choices = new Map()
  for (const candidate of leading) {
    const key = choiceKey(candidate.targetId)
    if (!choices.has(key)) choices.set(key, { parentId: candidate.targetId, candidates: [] })
    choices.get(key).candidates.push(candidate)
  }
  const orderedChoices = [...choices.values()]
    .sort((left, right) => compareTarget(left.parentId, right.parentId))

  if (orderedChoices.length > 1) {
    const candidateIds = leading.map(candidate => candidate.id)
    const ambiguity = {
      id: `ambiguous-parent:${entityId}`,
      type: 'ambiguous-parent',
      entityId,
      priority: ranked[0].priority,
      manual: ranked[0].manual,
      parentIds: orderedChoices.map(choice => choice.parentId),
      candidateIds,
      provenance: provenanceFor(leading),
    }
    return {
      resolution: {
        status: 'ambiguous',
        parentId: null,
        explicitRoot: false,
        priority: ranked[0].priority,
        manual: ranked[0].manual,
        selectedCandidateId: null,
        supportingCandidateIds: candidateIds,
        supersededCandidateIds: ranked.slice(leading.length).map(candidate => candidate.id),
        candidateIds: ranked.map(candidate => candidate.id),
        competingParentIds: ambiguity.parentIds,
        provenance: ambiguity.provenance,
      },
      ambiguity,
    }
  }

  const supporting = orderedChoices[0].candidates.slice().sort(comparePrecedence)
  const parentId = orderedChoices[0].parentId
  return {
    resolution: {
      status: 'resolved',
      parentId,
      explicitRoot: parentId == null,
      priority: ranked[0].priority,
      manual: ranked[0].manual,
      selectedCandidateId: supporting[0].id,
      supportingCandidateIds: supporting.map(candidate => candidate.id),
      supersededCandidateIds: ranked.slice(leading.length).map(candidate => candidate.id),
      candidateIds: ranked.map(candidate => candidate.id),
      provenance: provenanceFor(supporting),
    },
    ambiguity: null,
  }
}

function resolveDependencies(candidates) {
  const byTarget = new Map()
  for (const candidate of candidates) {
    if (!byTarget.has(candidate.targetId)) byTarget.set(candidate.targetId, [])
    byTarget.get(candidate.targetId).push(candidate)
  }
  const resolved = [...byTarget.entries()].map(([dependencyId, claims]) => {
    const ranked = claims.slice().sort(comparePrecedence)
    return {
      dependencyId,
      selectedCandidateId: ranked[0].id,
      candidateIds: ranked.map(candidate => candidate.id),
      priority: ranked[0].priority,
      manual: ranked[0].manual,
      provenance: provenanceFor(ranked),
      _selected: ranked[0],
    }
  })
  resolved.sort((left, right) =>
    comparePrecedence(left._selected, right._selected) ||
    compareText(left.dependencyId, right.dependencyId))
  return resolved.map(({ _selected, ...dependency }) => dependency)
}

function rotateCycle(entityIds) {
  let first = 0
  for (let index = 1; index < entityIds.length; index++) {
    if (compareText(entityIds[index], entityIds[first]) < 0) first = index
  }
  return entityIds.slice(first).concat(entityIds.slice(0, first))
}

function findCycles(parentByEntity, entityIds) {
  const finished = new Set()
  const cycles = []
  for (const start of entityIds) {
    if (finished.has(start)) continue
    const path = []
    const position = new Map()
    let current = start
    while (current != null && !finished.has(current)) {
      if (position.has(current)) {
        cycles.push(rotateCycle(path.slice(position.get(current))))
        break
      }
      position.set(current, path.length)
      path.push(current)
      current = parentByEntity.get(current) ?? null
    }
    for (const entityId of path) finished.add(entityId)
  }
  return cycles.sort((left, right) => compareText(left.join('\u0000'), right.join('\u0000')))
}

/**
 * Resolve independently-produced hierarchy claims into a deterministic snapshot.
 *
 * A structural candidate is:
 *   { kind: 'structural-parent', subjectId, targetId, priority, order?, provenance? }
 * `targetId: null` is an explicit root claim. Dependencies require a target ID.
 * Manual overrides use the same shape, are supplied through `manualOverrides`,
 * and are promoted above every source/rule candidate.
 */
export function resolveHierarchyClaims({
  observations = [],
  candidates = [],
  manualOverrides = [],
} = {}) {
  if (!Array.isArray(observations)) throw new TypeError('observations must be an array')
  if (!Array.isArray(candidates)) throw new TypeError('candidates must be an array')
  if (!Array.isArray(manualOverrides)) throw new TypeError('manualOverrides must be an array')

  const observationIds = new Set()
  const normalizedObservations = observations.map((observation, index) =>
    normalizeObservation(observation, index, observationIds))
  const candidateIds = new Set()
  const normalizedCandidates = candidates.map((candidate, index) =>
    normalizeCandidate(candidate, index, false, candidateIds, index))
  const normalizedManualOverrides = manualOverrides.map((candidate, index) =>
    normalizeCandidate(candidate, index, true, candidateIds, candidates.length + index))
  const allCandidates = normalizedCandidates
    .concat(normalizedManualOverrides)
    .sort(compareStoredCandidates)

  const allEntityIds = new Set()
  const observationIdsByEntity = new Map()
  for (const observation of normalizedObservations) {
    allEntityIds.add(observation.entityId)
    if (!observationIdsByEntity.has(observation.entityId)) observationIdsByEntity.set(observation.entityId, [])
    observationIdsByEntity.get(observation.entityId).push(observation.id)
  }
  const candidatesByEntity = new Map()
  for (const candidate of allCandidates) {
    allEntityIds.add(candidate.subjectId)
    if (candidate.targetId != null) allEntityIds.add(candidate.targetId)
    if (!candidatesByEntity.has(candidate.subjectId)) candidatesByEntity.set(candidate.subjectId, [])
    candidatesByEntity.get(candidate.subjectId).push(candidate)
  }

  const entityIds = [...allEntityIds].sort(compareText)
  const mutableEntities = new Map()
  const ambiguities = []
  const parentByEntity = new Map()
  for (const entityId of entityIds) {
    const ownCandidates = candidatesByEntity.get(entityId) || []
    const parent = resolveParent(
      entityId,
      ownCandidates.filter(candidate => candidate.kind === HIERARCHY_CLAIM_KIND.STRUCTURAL_PARENT),
    )
    if (parent.ambiguity) ambiguities.push(parent.ambiguity)
    if (parent.resolution.status === 'resolved' && parent.resolution.parentId != null) {
      parentByEntity.set(entityId, parent.resolution.parentId)
    }
    const dependencies = resolveDependencies(
      ownCandidates.filter(candidate => candidate.kind === HIERARCHY_CLAIM_KIND.DEPENDENCY),
    )
    mutableEntities.set(entityId, {
      id: entityId,
      observationIds: (observationIdsByEntity.get(entityId) || []).slice(),
      parentId: parent.resolution.parentId,
      dependencyIds: dependencies.map(dependency => dependency.dependencyId),
      parentResolution: parent.resolution,
      dependencies,
      issueIds: parent.ambiguity ? [parent.ambiguity.id] : [],
    })
  }

  const cycles = findCycles(parentByEntity, entityIds).map((cycleEntityIds, index) => {
    const id = `structural-cycle:${index + 1}`
    const edges = cycleEntityIds.map(entityId => {
      const entity = mutableEntities.get(entityId)
      return {
        subjectId: entityId,
        targetId: entity.parentResolution.parentId,
        candidateIds: entity.parentResolution.supportingCandidateIds,
        provenance: entity.parentResolution.provenance,
      }
    })
    return {
      id,
      type: 'structural-cycle',
      entityIds: cycleEntityIds,
      candidateIds: edges.flatMap(edge => edge.candidateIds),
      edges,
      provenance: edges.flatMap(edge => edge.provenance),
    }
  })

  for (const cycle of cycles) {
    for (const entityId of cycle.entityIds) {
      const entity = mutableEntities.get(entityId)
      const resolution = entity.parentResolution
      entity.parentId = null
      entity.issueIds.push(cycle.id)
      entity.parentResolution = {
        ...resolution,
        status: 'cycle',
        proposedParentId: resolution.parentId,
        parentId: null,
        cycleId: cycle.id,
      }
    }
  }

  const entities = entityIds.map(entityId => mutableEntities.get(entityId))
  const byId = Object.create(null)
  for (const entity of entities) byId[entity.id] = entity
  const issues = ambiguities.concat(cycles)
  return deepFreeze({
    schemaVersion: 1,
    valid: issues.length === 0,
    observations: normalizedObservations,
    candidates: allCandidates,
    manualOverrideIds: normalizedManualOverrides.map(candidate => candidate.id),
    entities,
    byId,
    ambiguities,
    cycles,
    issues,
    stats: {
      observations: normalizedObservations.length,
      candidates: allCandidates.length,
      entities: entities.length,
      resolvedParents: entities.filter(entity => entity.parentResolution.status === 'resolved').length,
      dependencies: entities.reduce((sum, entity) => sum + entity.dependencyIds.length, 0),
      ambiguities: ambiguities.length,
      cycles: cycles.length,
    },
  })
}
