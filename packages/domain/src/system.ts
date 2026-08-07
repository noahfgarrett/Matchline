import type { EvidenceTier } from './evidence.js';
import type { Provenance } from './provenance.js';

/** Whether the sources agreed about which system an asset belongs to. */
export type SystemConflictStatus =
  | 'AGREED'
  | 'RESOLVED_BY_TIER'
  | 'AMBIGUOUS'
  | 'CONFLICTING'
  | 'UNRESOLVED';

/**
 * The system an asset belongs to, plus the evidence behind that answer.
 *
 * System assignment drives commissioning sequence, so a wrong answer is
 * expensive and the reasoning has to survive to review.
 */
export interface SystemResolution {
  /** Stable machine key used for grouping and joins. */
  readonly systemKey: string;
  readonly systemDescription?: string;
  /** Human-facing name shown in the register. */
  readonly systemLabel: string;
  readonly systemEvidence: ReadonlyArray<Provenance>;
  readonly systemConfidenceTier: EvidenceTier;
  readonly systemConflictStatus: SystemConflictStatus;
}
