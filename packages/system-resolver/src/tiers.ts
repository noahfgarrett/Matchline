/**
 * Which component kind carries how much weight (PRODUCT.md §4.1, §5.2).
 *
 * `EvidenceTier` tops out at 4, so "the human is always the final override"
 * cannot be expressed as a fifth tier. It is expressed structurally instead:
 * a manual assignment wins the chain outright regardless of rung position (see
 * `resolveSystems`), and sits at the ceiling tier so it also wins any
 * tier comparison a downstream stage makes.
 */
import { EVIDENCE_TIER, type EvidenceTier } from '@matchline/domain';

import type { SystemComponentKind } from './types.js';

export const COMPONENT_EVIDENCE_TIER = {
  /** A person said so. Ceiling of the domain scale; authority is structural. */
  manual: EVIDENCE_TIER.MODEL,
  /** A mapped model property stated it outright. */
  'model-field': EVIDENCE_TIER.MODEL,
  /** A column the user pointed at and labelled "System": equally explicit. */
  'direct-column': EVIDENCE_TIER.MODEL,
  /** The MEL is a tracking document that follows the work, not a statement of record. */
  'mel-lookup': EVIDENCE_TIER.TRACKING_DOCUMENT,
  /** Cut out of a tag by a profile rule: derived, never stated by a source. */
  'tag-segment': EVIDENCE_TIER.INFERRED,
  /**
   * Assembled from other values; the real tier is the lowest among the
   * placeholders it filled, computed per evaluation. This entry is the floor
   * used when a template fills no placeholders at all.
   */
  composite: EVIDENCE_TIER.INFERRED,
} as const satisfies Record<SystemComponentKind, EvidenceTier>;

/** A composite is only as trustworthy as its weakest input. */
export function lowestTier(tiers: ReadonlyArray<EvidenceTier>): EvidenceTier {
  let lowest: EvidenceTier = EVIDENCE_TIER.MODEL;
  for (const tier of tiers) {
    if (tier < lowest) {
      lowest = tier;
    }
  }
  return lowest;
}
