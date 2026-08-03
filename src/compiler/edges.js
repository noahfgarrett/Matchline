import { S, tagKey } from '../state.js'
import { recordSourceParentClaim } from '../hierarchy/build.js'

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
    if (!key || !records.has(key)) continue
    if (cableClaims && cableClaims.has(key)) continue
    if (tagKey(panel) === key) continue
    recordSourceParentClaim('cable', records.get(key).tag, panel, { status: 'compiler-edge' })
  }
}
