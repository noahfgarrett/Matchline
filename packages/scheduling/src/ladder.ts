/**
 * The milestone fallback ladder (donor `src/compiler/ladders.js`, spec §6a).
 *
 * Every asset gets a milestone at every level of schedule maturity, so an
 * immature or absent P6 lands more assets on lower rungs rather than leaving
 * holes. The next compile against a fuller schedule promotes them.
 *
 * ```
 * rung 1  an activity names this asset's equipment tag explicitly
 * rung 2  an activity carries this asset's system (UPN) in an explicit column
 * rung 3  the system is extracted from an activity's NAME by pattern
 * rung 4  nothing found: the building-ready bucket, the SOP's own default
 * ```
 *
 * ## The precedence rules, exactly as the donor states them
 *
 * 1. **Milestone-flagged activities claim a system first.** The activity list is
 *    sorted so flagged milestones come before plain activities, with a stable
 *    sort so equal-flag activities keep source order. An activity row can then
 *    fill a gap without ever shadowing a real L2 milestone.
 * 2. **First claim on a system wins.** Once a system key is claimed, later
 *    activities cannot take it; the rung recorded is the rung of the claim that
 *    landed, not the best rung anyone offered. Within a single activity the
 *    explicit UPN column is claimed before the name pattern, so rung 2 beats
 *    rung 3 for that activity — but an earlier activity's rung-3 claim still
 *    beats a later activity's rung-2 claim. That is the donor's ordering and it
 *    is preserved, because promoting by rung instead would let a distant
 *    activity outrank the first milestone that named the system.
 * 3. **Per asset, the direct tag always wins.** An equipment-tag match is rung 1
 *    regardless of what any system claim says.
 *
 * ## What is not guessed
 *
 * An activity that claimed nothing an asset could use is reported in
 * {@link MilestoneLadderResult.unmatchedActivities} with a typed reason. It is
 * never fuzzily attached to a plausible asset.
 */

import type { Provenance } from '@matchline/domain';

import type { P6Activity } from './p6.js';
import { clean, systemKeyOf, tagKey } from './text.js';

/** The rung a milestone assignment came from. Lower is more direct. */
export type MilestoneRung = 1 | 2 | 3 | 4;

/** What the ladder needs to know about one asset. */
export interface MilestoneAsset {
  readonly assetId: string;
  readonly canonicalTag: string;
  /** The resolved system identifier (UPN on a common site). */
  readonly systemKey?: string;
  readonly building?: string;
}

/** An assignment made from a real schedule activity: rungs 1 through 3. */
export interface ScheduledMilestone {
  readonly assetId: string;
  readonly rung: 1 | 2 | 3;
  /** The activity's name, or its code when the activity has no name. */
  readonly label: string;
  readonly activityId: string;
  /** The activity's own provenance, stamped with the rung that used it. */
  readonly provenance: Provenance;
}

/** The rung-4 default: no schedule evidence, so the building-ready bucket. */
export interface DefaultMilestone {
  readonly assetId: string;
  readonly rung: 4;
  readonly label: string;
  /** The bucket the asset fell into. `''` when no source stated a building. */
  readonly building: string;
}

/** One asset's milestone. `rung` is the discriminator. */
export type MilestoneAssignment = ScheduledMilestone | DefaultMilestone;

/** Why an activity produced no assignment. */
export type UnmatchedActivityReason =
  /** It names no equipment tag, and no system in a column or in its name. */
  | 'no-identifier'
  /** Everything it claimed was already claimed by an earlier activity. */
  | 'superseded'
  /** It holds a claim, but no asset carries that tag or that system. */
  | 'no-matching-asset';

/** An activity the ladder could not use, and why. */
export interface UnmatchedActivity {
  readonly activityId: string;
  readonly name: string;
  readonly reason: UnmatchedActivityReason;
}

/** Options for {@link assignMilestones}. */
export interface MilestoneLadderOptions {
  /** Rung-4 label. Defaults to {@link DEFAULT_BUILDING_READY_LABEL}. */
  readonly buildingReadyLabel?: string;
  /** Rung-3 extraction pattern. Defaults to {@link DEFAULT_UPN_PATTERN}. */
  readonly upnPattern?: RegExp;
}

/** How many assets landed on each rung. */
export type MilestoneRungCounts = { readonly [Rung in MilestoneRung]: number };

/** The result of {@link assignMilestones}. */
export interface MilestoneLadderResult {
  /** One per asset, in the order the assets were supplied. */
  readonly assignments: ReadonlyArray<MilestoneAssignment>;
  /** Activities no asset used, in the order they were supplied. */
  readonly unmatchedActivities: ReadonlyArray<UnmatchedActivity>;
  readonly byRung: MilestoneRungCounts;
}

/** The SOP's own default bucket (donor `hierarchy.milestones.buildingReadyLabel`). */
export const DEFAULT_BUILDING_READY_LABEL = 'OP / Building Ready';

/**
 * The donor's default rung-3 pattern.
 *
 * Capture group 1 is the system token. `UPN 2201`, `UPN-2201` and `UPN#2201`
 * all match, and a milestone covering several systems at once — `UPN
 * 115/116/117 Energization` — captures the whole run for
 * {@link extractMilestoneUpns} to split.
 */
export const DEFAULT_UPN_PATTERN = /\bUPN\s*[-#]?\s*([A-Za-z0-9./-]+)/i;

/**
 * Every system identifier a milestone name claims.
 *
 * One milestone can cover several systems, so the captured token is split on
 * `/` and every part claims the milestone independently.
 *
 * A global pattern is re-created without the `g` flag before use: `String.match`
 * with `g` returns whole matches and no capture groups, and a `lastIndex` that
 * survives between calls would make the result depend on call order.
 */
export function extractMilestoneUpns(
  name: string,
  pattern: RegExp = DEFAULT_UPN_PATTERN,
): ReadonlyArray<string> {
  const usable = pattern.global ? new RegExp(pattern.source, pattern.flags.replace(/g/g, '')) : pattern;
  const match = clean(name).match(usable);
  const captured = match?.[1];
  if (captured === undefined) return [];
  return captured
    .split('/')
    .map((part) => clean(part))
    .filter((part) => part !== '');
}

/** A system claim: which activity took the key, and on which rung. */
interface SystemClaim {
  readonly activity: P6Activity;
  readonly rung: 2 | 3;
}

/**
 * Assign one milestone to every asset.
 *
 * Deterministic: the assignments follow the asset order supplied, and the claims
 * behind them follow the activity order supplied (after the stable
 * milestones-first sort), so the same inputs always produce the same result.
 */
export function assignMilestones(
  activities: ReadonlyArray<P6Activity>,
  assets: ReadonlyArray<MilestoneAsset>,
  options: MilestoneLadderOptions = {},
): MilestoneLadderResult {
  const buildingReadyLabel = clean(options.buildingReadyLabel) || DEFAULT_BUILDING_READY_LABEL;
  const upnPattern = options.upnPattern ?? DEFAULT_UPN_PATTERN;

  /* Milestone-flagged tasks claim a system first; `sort` is stable, so equal
     flags keep the order the schedule was read in. */
  const ordered = [...activities].sort(
    (left, right) => Number(right.isMilestone) - Number(left.isMilestone),
  );

  const byTag = new Map<string, P6Activity>();
  const bySystem = new Map<string, SystemClaim>();
  for (const activity of ordered) {
    const tag = tagKey(activity.equipmentTag);
    if (tag !== '' && !byTag.has(tag)) byTag.set(tag, activity);
    claimSystem(bySystem, activity.upn, activity, 2);
    for (const upn of extractMilestoneUpns(activity.name, upnPattern)) {
      claimSystem(bySystem, upn, activity, 3);
    }
  }

  const assignments: MilestoneAssignment[] = [];
  const used = new Set<P6Activity>();
  const byRung: Record<MilestoneRung, number> = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const asset of assets) {
    const direct = byTag.get(tagKey(asset.canonicalTag));
    if (direct !== undefined) {
      used.add(direct);
      byRung[1]++;
      assignments.push(scheduled(asset.assetId, direct, 1));
      continue;
    }
    const system = systemKeyOf(asset.systemKey);
    const claim = system === '' ? undefined : bySystem.get(system);
    if (claim !== undefined) {
      used.add(claim.activity);
      byRung[claim.rung]++;
      assignments.push(scheduled(asset.assetId, claim.activity, claim.rung));
      continue;
    }
    byRung[4]++;
    assignments.push({
      assetId: asset.assetId,
      rung: 4,
      label: buildingReadyLabel,
      building: clean(asset.building),
    });
  }

  const unmatchedActivities: UnmatchedActivity[] = [];
  for (const activity of activities) {
    if (used.has(activity)) continue;
    unmatchedActivities.push({
      activityId: activity.activityId,
      name: activity.name,
      reason: unmatchedReasonOf(activity, upnPattern, byTag, bySystem),
    });
  }

  return { assignments, unmatchedActivities, byRung };
}

/** Take a system key for an activity, unless an earlier one already has it. */
function claimSystem(
  bySystem: Map<string, SystemClaim>,
  value: string,
  activity: P6Activity,
  rung: 2 | 3,
): void {
  const key = systemKeyOf(value);
  if (key === '' || bySystem.has(key)) return;
  bySystem.set(key, { activity, rung });
}

/** An assignment from an activity, with the rung recorded on the provenance. */
function scheduled(assetId: string, activity: P6Activity, rung: 1 | 2 | 3): ScheduledMilestone {
  return {
    assetId,
    rung,
    label: activity.name || activity.activityCode,
    activityId: activity.activityId,
    provenance: { ...activity.provenance, rule: 'milestone-ladder', fallbackRung: rung },
  };
}

/**
 * Why an unused activity went unused.
 *
 * The three reasons are genuinely different problems: `no-identifier` is a
 * schedule that never says what it is commissioning, `superseded` is a duplicate
 * claim on a system another activity already owns, and `no-matching-asset` is a
 * schedule and a model that disagree about what exists.
 */
function unmatchedReasonOf(
  activity: P6Activity,
  upnPattern: RegExp,
  byTag: ReadonlyMap<string, P6Activity>,
  bySystem: ReadonlyMap<string, SystemClaim>,
): UnmatchedActivityReason {
  const tag = tagKey(activity.equipmentTag);
  const systems = [activity.upn, ...extractMilestoneUpns(activity.name, upnPattern)]
    .map((value) => systemKeyOf(value))
    .filter((value) => value !== '');
  if (tag === '' && systems.length === 0) return 'no-identifier';
  const holdsTag = tag !== '' && byTag.get(tag) === activity;
  const holdsSystem = systems.some((system) => bySystem.get(system)?.activity === activity);
  return holdsTag || holdsSystem ? 'no-matching-asset' : 'superseded';
}
