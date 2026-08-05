import { clean } from '../core/text.js'
import { S, tagKey } from '../state.js'
import { extoRegistryRows } from '../io/exto.js'
import { recordPartitionKey } from './fold.js'
import { activeProfile } from '../profile/schema.js'

/* ---- Graded nesting inference (spec §5) ----
   Equipment Description decides the ROLE (parent-capable equipment vs child
   device — siblings never compete for parenthood), number nomenclature picks
   the INSTANCE. Learned from a prior registry export, and SELF-GRADED against
   it: the model replays its own policy over the registry's real Closest Parent
   answers, per child class. Classes that prove out (>=85% precision on >=10
   rows) build the hierarchy as low-priority claims — evidence always outranks
   them, and provenance says "inferred". Everything else stays a proposal for
   the review/massage pass. Measured on a real 18k-row registry the claim-grade
   slice (motors, VFDs, drives, unit valves…) runs 93–100% precision.

   Rules, in order:
     A. containment — the tag literally extends another same-partition tag
        (PLC racks, power supplies). Claim-grade by design intent.
     B. role gate + shared number run + class-pair affinity (>=3), unique best.

   Inert without a registry to learn from. */

const NEST_MIN_AFFINITY = 3
const NEST_GRADE_MIN_ROWS = 10
const NEST_GRADE_MIN_PRECISION = 0.85

export function coordsOf(tag) { return (clean(tag).toLowerCase().match(/\d+/g) || []) }
function tagBody(tag) { return clean(tag).toLowerCase().replace(/[^a-z0-9]/g, '') }
export function sharedRun(a, b) {
  let best = 0
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    let n = 0
    while (i + n < a.length && j + n < b.length && a[i + n] === b[j + n]) n++
    if (n > best) best = n
  }
  return best
}

/* The one policy, shared by self-grading and inference. Items: {tag, cls, group}. */
function pickParent(item, peers, model) {
  const body = tagBody(item.tag)
  /* Containment demands a SUBSTANTIVE extension (>=3 chars) that continues at
     a SEPARATOR boundary: "…-00_PS2-RACK" genuinely extends its PLC, while
     "…-05A" merely extends its sibling "…-05" by a letter, and "…-RIO650-1-03"
     runs straight past the short header tag "…-RIO" with no boundary. */
  const childTag = clean(item.tag).toLowerCase()
  const container = peers
    .filter(peer => {
      const parentTag = clean(peer.tag).toLowerCase(), parentBody = tagBody(peer.tag)
      return parentBody.length >= 6 && body.length - parentBody.length >= 3
        && childTag.startsWith(parentTag) && /[-_./\s]/.test(childTag[parentTag.length] || '')
    })
    .sort((a, b) => tagBody(b.tag).length - tagBody(a.tag).length)[0]
  if (container) return { pick: container, rule: 'containment',
    rationale: `${item.tag} extends ${container.tag}` }
  if (!model.isChildClass(item.cls)) return null
  const rc = coordsOf(item.tag)
  const scored = peers
    .filter(peer => model.isParentCapable(peer.cls))
    .map(peer => [peer, sharedRun(rc, coordsOf(peer.tag)), model.affinity(item.cls, peer.cls)])
    .filter(([, run]) => run >= 1)
    .sort((a, b) => b[1] - a[1] || b[2] - a[2])
  if (!scored.length) return null
  const [best, run, pairs] = scored[0]
  if (pairs < NEST_MIN_AFFINITY) return null
  if (scored.some(entry => entry[0] !== best && entry[1] === run && entry[2] === pairs)) return null
  return { pick: best, rule: 'role-affinity',
    rationale: `${item.cls} nests under ${best.cls} (${pairs}× in registry); shared number run ${run}`,
    runnersUp: scored.slice(1, 3).map(([peer]) => peer.tag) }
}

/* Rebuild a working model from the plain form persisted in the profile, so the
   registry's rules keep applying in sessions where it is not uploaded. */
function hydrateNestingModel(plain) {
  const roles = plain.roles || {}, affinity = plain.affinity || {}, grades = plain.grades || {}
  const ratio = cls => { const [p, c] = roles[cls] || [0, 0]; return (p + c) ? p / (p + c) : 0 }
  return {
    learned: true,
    isChildClass: cls => !!cls && ratio(cls) < 0.05 && ((roles[cls] || [0, 0])[1]) >= NEST_GRADE_MIN_ROWS,
    isParentCapable: cls => !!cls && ratio(cls) >= 0.15 && ((roles[cls] || [0, 0])[0]) >= 5,
    affinity: (childClass, parentClass) => affinity[childClass + '|' + parentClass] || 0,
    gradeOf: cls => grades[cls] || 'propose',
  }
}

export function learnNestingModel() {
  const rows = []
  for (const key of S.extoSel || []) rows.push(...extoRegistryRows(key))
  if (!rows.length) {
    const persisted = activeProfile().learnedModels
    if (persisted && persisted.nesting) return hydrateNestingModel(persisted.nesting)
    return { learned: false }
  }
  const byId = new Map()
  for (const row of rows) { const k = tagKey(row.equipmentId); if (k && !byId.has(k)) byId.set(k, row) }
  const asParent = new Map(), asChild = new Map(), affinity = new Map(), truthPairs = []
  for (const row of rows) {
    const parent = byId.get(tagKey(row.closestParent))
    if (!parent || clean(parent.systemName).toLowerCase() !== clean(row.systemName).toLowerCase()) continue
    const childClass = clean(row.classification), parentClass = clean(parent.classification)
    if (!childClass || !parentClass) continue
    asChild.set(childClass, (asChild.get(childClass) || 0) + 1)
    asParent.set(parentClass, (asParent.get(parentClass) || 0) + 1)
    affinity.set(childClass + '|' + parentClass, (affinity.get(childClass + '|' + parentClass) || 0) + 1)
    truthPairs.push([row, parent])
  }
  const ratio = cls => {
    const p = asParent.get(cls) || 0, c = asChild.get(cls) || 0
    return (p + c) ? p / (p + c) : 0
  }
  const model = {
    learned: asParent.size > 0,
    isChildClass: cls => !!cls && ratio(cls) < 0.05 && (asChild.get(cls) || 0) >= NEST_GRADE_MIN_ROWS,
    isParentCapable: cls => !!cls && ratio(cls) >= 0.15 && (asParent.get(cls) || 0) >= 5,
    affinity: (childClass, parentClass) => affinity.get(childClass + '|' + parentClass) || 0,
  }
  /* Self-grade: replay the policy over the registry's own answers, per class. */
  const bySystem = new Map()
  for (const row of rows) {
    const group = clean(row.systemName).toLowerCase()
    if (!bySystem.has(group)) bySystem.set(group, [])
    bySystem.get(group).push({ tag: row.equipmentId, cls: clean(row.classification), key: tagKey(row.equipmentId) })
  }
  const scores = new Map()
  for (const [row, truthParent] of truthPairs) {
    const cls = clean(row.classification)
    if (!model.isChildClass(cls)) continue
    const item = { tag: row.equipmentId, cls }
    const peers = bySystem.get(clean(row.systemName).toLowerCase()).filter(peer => peer.key !== tagKey(row.equipmentId))
    const result = pickParent(item, peers, model)
    if (!scores.has(cls)) scores.set(cls, { predicted: 0, correct: 0 })
    if (result && result.rule === 'role-affinity') {
      const s = scores.get(cls); s.predicted++
      if (tagKey(result.pick.tag) === tagKey(truthParent.equipmentId)) s.correct++
    }
  }
  model.gradeOf = cls => {
    const s = scores.get(cls)
    if (!s || s.predicted < NEST_GRADE_MIN_ROWS) return 'propose'
    return (s.correct / s.predicted) >= NEST_GRADE_MIN_PRECISION ? 'claim' : 'propose'
  }
  /* Plain form for profile persistence: role counts, affinities, and the
     precomputed self-grades. */
  const plainRoles = {}
  for (const cls of new Set([...asParent.keys(), ...asChild.keys()]))
    plainRoles[cls] = [asParent.get(cls) || 0, asChild.get(cls) || 0]
  const plainGrades = {}
  for (const cls of scores.keys()) plainGrades[cls] = model.gradeOf(cls)
  model.plain = { roles: plainRoles, affinity: Object.fromEntries(affinity), grades: plainGrades }
  return model
}

export function inferNesting(records, model) {
  if (!model || !model.learned) return
  const byPartition = new Map()
  for (const record of records.values()) {
    if (!record.includeInRegister || record.isSyntheticRollup) continue
    const partition = recordPartitionKey(record)
    if (!partition) continue
    if (!byPartition.has(partition)) byPartition.set(partition, [])
    byPartition.get(partition).push({ tag: record.tag, key: record.key,
      cls: clean(record.attributes && record.attributes.equipmentClassification) })
  }
  for (const record of records.values()) {
    if (!record.includeInRegister || record.isSyntheticRollup) continue
    const partition = recordPartitionKey(record)
    if (!partition) continue
    const peers = byPartition.get(partition).filter(peer => peer.key !== record.key)
    if (!peers.length) continue
    const item = { tag: record.tag, cls: clean(record.attributes && record.attributes.equipmentClassification) }
    const result = pickParent(item, peers, model)
    if (!result) continue
    const grade = result.rule === 'containment' ? 'claim' : model.gradeOf(item.cls)
    record.nestingInference = { parent: result.pick.tag, rule: result.rule, grade,
      rationale: result.rationale, runnersUp: result.runnersUp || [] }
    record.provenance.push(`Nesting ${grade === 'claim' ? '(inferred claim)' : 'proposal'} · ${result.rationale}`)
  }
}

/* Electrical Flow view flip: the raw flow tree lists the instrument where the
   wiring put it, and below it what the instrument CONTROLS — the inferred
   equipment — as a marked reference node. Idempotent across rebuilds. */
export function attachControlsRefs() {
  if (!S.roots || !S.roots.length || !S.canonicalModel) return
  const strip = node => {
    for (const child of node.children) if (child.isControlsRef) S.nodeById.delete(child.id)
    node.children = node.children.filter(child => !child.isControlsRef)
    node.children.forEach(strip)
  }
  S.roots.forEach(strip)
  let n = 0
  for (const record of S.canonicalModel.values()) {
    const inference = record.nestingInference
    if (!inference) continue
    for (const occurrence of record.occurrences) {
      const node = S.nodeById.get(occurrence.nodeId)
      if (!node) continue
      const ref = { id: 'ctl' + (n++), name: `controls → ${inference.parent}`, depth: node.depth + 1,
        parent: node, children: [], isId: false, isLoad: false, isInstrument: false, isControlsRef: true,
        loadDependency: '', dependencyOverride: '', _raw: null }
      node.children.push(ref)
      S.nodeById.set(ref.id, ref)
    }
  }
}
