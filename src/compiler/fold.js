import { HIERARCHY_CLAIM_KIND } from '../hierarchy/claims.js'

/* The partition fold (spec §5): a structural-parent claim whose subject and
   target live in different partition buckets is demoted to a dependency claim
   with the crossing recorded in provenance. Unknown buckets never demote — a
   boundary crossing must be proven, not assumed. Pure: claims in, claims out.

   options.keepCrossing(claim): a caller-supplied exception for claims that may
   nest ACROSS partitions — the electrical feed chain, where the Easy Power /
   Cable Schedule hierarchy is the structure and only the building boundary
   still demotes. The predicate decides; the fold stays pure. */
export function foldClaimsByPartition(claims, partitionOf, options) {
  const keepCrossing = options && options.keepCrossing
  return claims.map(claim => {
    if (claim.kind !== HIERARCHY_CLAIM_KIND.STRUCTURAL_PARENT) return claim
    const subject = partitionOf(claim.subjectId), target = partitionOf(claim.targetId)
    if (!subject || !target || subject === target) return claim
    if (keepCrossing && keepCrossing(claim)) return claim
    return {
      ...claim,
      id: 'fold:' + claim.id,
      kind: HIERARCHY_CLAIM_KIND.DEPENDENCY,
      provenance: { ...claim.provenance, demoted: `crosses ${subject} → ${target}` },
    }
  })
}

/* Partition key for a resolved record: the SSM grouping tuple. Null unless
   every component is EXPLICIT (MEL / rule / override derived) — profile
   fallback values like the default system name would otherwise manufacture
   phantom partitions and demote parents that were never proven to cross a
   boundary. Unassigned placeholders are unknown for the same reason. */
export function recordPartitionKey(record) {
  const explicit = record && record.context && record.context.explicit
  if (!explicit || !explicit.building || !explicit.discipline || !explicit.system) return null
  const parts = [record.building, record.discipline, record.system]
  if (parts.some(part => !part || /^unassigned/i.test(part))) return null
  return parts.join('|')
}
