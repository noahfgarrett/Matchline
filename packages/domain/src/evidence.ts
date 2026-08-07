/**
 * How much weight a claim carries when two sources disagree.
 *
 * The numbers are ordered on purpose: a higher tier wins a conflict, so
 * reconciliation can compare tiers directly rather than consulting a table.
 * Model evidence outranks everything because Matchline is model-first.
 */
export type EvidenceTier = 1 | 2 | 3 | 4;

export const EVIDENCE_TIER = {
  /** Read from the 3D model itself. */
  MODEL: 4,
  /** An engineered document that an engineer stamped: power study, cable schedule. */
  ENGINEERED_DOCUMENT: 3,
  /** A tracking document that follows the work: equipment list, schedule. */
  TRACKING_DOCUMENT: 2,
  /** Derived by rule from other evidence rather than stated by any source. */
  INFERRED: 1,
} as const satisfies Record<string, EvidenceTier>;

/** Which source a claim came out of. Mirrors the vocabulary in `SourceStatus`. */
export type SourceKind = 'MODEL' | 'FLOW' | 'PMD' | 'MEL' | 'MANUAL';
