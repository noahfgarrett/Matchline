/**
 * Connectivity as the connectivity documents state it (PRODUCT.md §2.2, §4.1).
 *
 * An observation is what one document said about two tags, nothing more. It is
 * deliberately tag-shaped rather than asset-shaped: the importer reads spellings
 * off a spreadsheet and has no standing to decide which asset a spelling means.
 * Identity reconciliation (§9) turns tags into asset ids afterwards, and a tag
 * that never resolves stays visible as a FLOW_ONLY or PMD_ONLY record rather
 * than disappearing into a failed join.
 */
import type { Provenance } from './provenance.js';
import type { RelationshipType } from './relationship.js';

/** Which connectivity document an observation was read out of. */
export type ConnectivitySourceKind = 'easypower' | 'cable-schedule' | 'pmd';

/**
 * One stated connection between two tags.
 *
 * `feed`: `fromTag` powers `toTag`, and `via` names the cable when the source
 * gave one. `pmd-relation`: `fromTag` is the panel, `toTag` the instrument or
 * point it terminates.
 *
 * `relationshipType` is carried rather than derived because the same physical
 * feed means different things in different projections -- Electrical Flow keeps
 * it as a feed, the SSM hierarchy may demote it to a dependency at a boundary
 * (§2.5) -- and the projection needs the source's own claim to start from.
 */
export interface ConnectivityObservation {
  readonly kind: 'feed' | 'pmd-relation';
  readonly fromTag: string;
  readonly toTag: string;
  /** Cable tag, when the source named the conductor between the two ends. */
  readonly via?: string;
  readonly sourceKind: ConnectivitySourceKind;
  readonly relationshipType: RelationshipType;
  readonly provenance: Provenance;
}
