import { clean } from '../core/text.js'
import { S, tagKey } from '../state.js'
import { extoRegistryRows } from '../io/exto.js'
import { recordPartitionKey } from './fold.js'

/* ---- Nesting proposals (spec §5, propose-don't-assume) ----
   Equipment Description decides the ROLE (parent-capable equipment vs child
   device — so siblings never compete for parenthood), number nomenclature
   picks the INSTANCE. Learned from a prior registry export; measured there at
   ~59% coverage / ~70% agreement with the human-built hierarchy, so this layer
   emits PROPOSALS — Completed MEL column + review queue with rationale and
   runners-up — never silent structural claims. Two rules:

     A. containment — the child tag literally extends another same-partition
        tag (PLC racks, power supplies): deterministic pick.
     B. role + shared number run + class-pair affinity: the child class must
        have an established convention (affinity ≥ 3) and a unique best match.

   Inert without a registry to learn from. */

const NEST_MIN_AFFINITY = 3

function classOf(record) {
  return clean(record.attributes && record.attributes.equipmentClassification)
}
function coordsOf(tag) { return (clean(tag).toLowerCase().match(/\d+/g) || []) }
function tagBody(tag) { return clean(tag).toLowerCase().replace(/[^a-z0-9]/g, '') }
function sharedRun(a, b) {
  let best = 0
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) {
    let n = 0
    while (i + n < a.length && j + n < b.length && a[i + n] === b[j + n]) n++
    if (n > best) best = n
  }
  return best
}

export function learnNestingModel() {
  const rows = []
  for (const key of S.extoSel || []) rows.push(...extoRegistryRows(key))
  if (!rows.length) return { learned: false }
  const byId = new Map()
  for (const row of rows) { const k = tagKey(row.equipmentId); if (k && !byId.has(k)) byId.set(k, row) }
  const asParent = new Map(), asChild = new Map(), affinity = new Map()
  for (const row of rows) {
    const parent = byId.get(tagKey(row.closestParent))
    if (!parent || clean(parent.systemName).toLowerCase() !== clean(row.systemName).toLowerCase()) continue
    const childClass = clean(row.classification), parentClass = clean(parent.classification)
    if (!childClass || !parentClass) continue
    asChild.set(childClass, (asChild.get(childClass) || 0) + 1)
    asParent.set(parentClass, (asParent.get(parentClass) || 0) + 1)
    const pairKey = childClass + '|' + parentClass
    affinity.set(pairKey, (affinity.get(pairKey) || 0) + 1)
  }
  const ratio = cls => {
    const p = asParent.get(cls) || 0, c = asChild.get(cls) || 0
    return (p + c) ? p / (p + c) : 0
  }
  return {
    learned: asParent.size > 0,
    isChildClass: cls => !!cls && ratio(cls) < 0.05 && (asChild.get(cls) || 0) >= 10,
    isParentCapable: cls => !!cls && ratio(cls) >= 0.15 && (asParent.get(cls) || 0) >= 5,
    affinity: (childClass, parentClass) => affinity.get(childClass + '|' + parentClass) || 0,
  }
}

export function proposeNesting(records, model) {
  if (!model || !model.learned) return
  const byPartition = new Map()
  for (const record of records.values()) {
    if (!record.includeInRegister || record.isSyntheticRollup) continue
    const partition = recordPartitionKey(record)
    if (!partition) continue
    if (!byPartition.has(partition)) byPartition.set(partition, [])
    byPartition.get(partition).push(record)
  }
  for (const record of records.values()) {
    if (!record.includeInRegister || record.isSyntheticRollup || record.ssmParentTag) continue
    const partition = recordPartitionKey(record)
    if (!partition) continue
    const peers = byPartition.get(partition).filter(peer => peer.key !== record.key)
    if (!peers.length) continue
    const body = tagBody(record.tag)
    /* Rule A — containment: the tag extends another tag in the same partition. */
    const container = peers
      .filter(peer => tagBody(peer.tag).length >= 6 && body.startsWith(tagBody(peer.tag)))
      .sort((a, b) => tagBody(b.tag).length - tagBody(a.tag).length)[0]
    if (container) {
      record.nestingProposal = { parent: container.tag, rule: 'containment',
        rationale: `${record.tag} extends ${container.tag}` }
      continue
    }
    /* Rule B — role gate, shared number run, class-pair affinity. */
    const childClass = classOf(record)
    if (!model.isChildClass(childClass)) continue
    const rc = coordsOf(record.tag)
    const scored = peers
      .filter(peer => model.isParentCapable(classOf(peer)))
      .map(peer => [peer, sharedRun(rc, coordsOf(peer.tag)), model.affinity(childClass, classOf(peer))])
      .filter(([, run]) => run >= 1)
      .sort((a, b) => b[1] - a[1] || b[2] - a[2])
    if (!scored.length) continue
    const [best, run, pairs] = scored[0]
    if (pairs < NEST_MIN_AFFINITY) continue
    const rival = scored.find(entry => entry[0] !== best && entry[1] === run && entry[2] === pairs)
    if (rival) continue
    record.nestingProposal = { parent: best.tag, rule: 'role-affinity',
      rationale: `${childClass} nests under ${classOf(best)} (${pairs}× in registry); shared number run ${run}`,
      runnersUp: scored.slice(1, 3).map(([peer]) => peer.tag) }
  }
}
