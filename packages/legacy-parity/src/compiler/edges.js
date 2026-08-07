import { S, tagKey } from '../state.js'
import { cleanRegisterTag } from '../core/tags.js'
import { melSystemParentTags, melTagLookup, recordSourceParentClaim } from '../hierarchy/build.js'

/* Compiler edge assembly (spec §5.1): the raw-tree cable stage only records
   claims for loads that already hold an Easy Power register row, so a cable
   row feeding a MEL-seeded record never produced an edge. Walk the raw cable
   map (S.deps: lowercased load → panel, first feed kept) and record the
   missing load→panel claims for records the canonical model knows. Existing
   cable claims are left alone — the validated-chain stage outranks this pass
   by getting there first. */
export function recordCompilerCableEdges(records) {
  const cableClaims = S.sourceParentClaims && S.sourceParentClaims.cable
  for (const [loadLower, panel] of S.deps || []) {
    const key = tagKey(loadLower)
    if (!key) continue
    let record = records.get(key)
    if (!record) {
      /* The cable schedule may spell the load without the building prefix the
         MEL uses — resolve through the same unambiguous suffix lookup that
         unifies record identity. */
      const lookup = melTagLookup(loadLower)
      if (lookup.record && lookup.candidates.length === 1) record = records.get(tagKey(lookup.record.tag))
    }
    if (!record) continue
    if (cableClaims && (cableClaims.has(key) || cableClaims.has(record.key))) continue
    if (tagKey(panel) === record.key) continue
    recordSourceParentClaim('cable', record.tag, panel, { status: 'compiler-edge' })
  }
}

/* Same gap for MEL assertions: the raw-tree stage records System Parent claims
   only for tags the Easy Power register knows, so a MEL-only asset's asserted
   parent never became a claim. First tag is the structural-parent assertion,
   trailing tags are additive dependencies (matching the raw-tree semantics). */
export function recordCompilerMelClaims(records) {
  const melClaims = S.sourceParentClaims && S.sourceParentClaims.mel
  for (const row of S.melRows || []) {
    const key = tagKey(row.tag)
    if (!key || !records.has(key)) continue
    if (melClaims && melClaims.has(key)) continue
    const tags = melSystemParentTags(row.systemParent)
    if (!tags.length) continue
    if (tagKey(tags[0]) !== key) recordSourceParentClaim('mel', records.get(key).tag, tags[0], { status: 'system-parent-column', compiler: true })
    for (const extra of tags.slice(1)) {
      const target = cleanRegisterTag(extra)
      if (target && tagKey(target) !== key) records.get(key).dependencies.add(target)
    }
  }
}
