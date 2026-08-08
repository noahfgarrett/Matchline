/**
 * `@matchline/scheduling` — the commissioning schedule outputs (E4).
 *
 * ```
 * P6 .xer / activity .xlsx ─▶ p6      ─▶ typed activities with provenance
 *                                │
 * canonical assets ─────────────┴▶ ladder  ─▶ one milestone per asset (4 rungs)
 *
 * ResolvedSnapshot + disciplines ─▶ sequence     ─▶ sequence number per asset
 *                                └▶ predecessors ─▶ system predecessor matrix
 *                                                   └▶ .xlsx
 * ```
 *
 * Sequencing orders assets *inside* a (building, discipline, system) block; the
 * predecessor matrix orders the blocks against each other. Neither guesses: an
 * activity that matches nothing is reported, and a precedence cycle is reported
 * rather than broken.
 *
 * The three asset shapes ({@link MilestoneAsset}, {@link SequenceAsset},
 * {@link PredecessorAsset}) are separate because each function needs different
 * fields, but one row carrying `assetId`, `canonicalTag`, `discipline`,
 * `building` and `systemKey` satisfies all three.
 *
 * Pure, deterministic, and dependent on nothing outside the workspace.
 */

export { readP6ActivitySheet, readXerSchedule } from './p6.js';
export type {
  P6Activity,
  P6ColumnMapping,
  P6Field,
  P6Link,
  P6ReadStats,
  P6Schedule,
  ReadP6SheetOptions,
  ReadXerOptions,
} from './p6.js';

export {
  assignMilestones,
  DEFAULT_BUILDING_READY_LABEL,
  DEFAULT_UPN_PATTERN,
  extractMilestoneUpns,
} from './ladder.js';
export type {
  DefaultMilestone,
  MilestoneAssignment,
  MilestoneAsset,
  MilestoneLadderOptions,
  MilestoneLadderResult,
  MilestoneRung,
  MilestoneRungCounts,
  ScheduledMilestone,
  UnmatchedActivity,
  UnmatchedActivityReason,
} from './ladder.js';

export { computeSequence, DEFAULT_TOP_DOWN_PATTERN, disciplinePolarity } from './sequence.js';
export type {
  AssetSequence,
  PolarityOverrides,
  SequenceAsset,
  SequenceGroup,
  SequenceGroupKey,
  SequenceOptions,
  SequencePolarity,
  SequenceResult,
} from './sequence.js';

export {
  buildPredecessorMatrix,
  DEFAULT_PREDECESSOR_SHEET_NAME,
  PREDECESSOR_HEADERS,
  PREDECESSOR_SEPARATOR,
  writePredecessorWorkbook,
} from './predecessors.js';
export type {
  FlowOrderEdge,
  PredecessorAsset,
  PredecessorEdge,
  PredecessorEvidence,
  PredecessorEvidenceKind,
  PredecessorMatrix,
  PredecessorOptions,
  PredecessorRow,
  WritePredecessorOptions,
} from './predecessors.js';

export { naturalCompare, systemKeyOf, tagKey } from './text.js';
