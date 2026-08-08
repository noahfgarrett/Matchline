/**
 * Revision output (PRODUCT.md §12.4).
 *
 * Replacing the NWD and showing the MEL diff is the last step of the founding
 * epic (§23.15): the value of a model-first register is that the *next* model
 * revision is a reviewable change, not a re-do. §12.4's list is binding, and
 * every bullet on it is a typed list here:
 *
 * | §12.4                       | this module                                   |
 * | --------------------------- | --------------------------------------------- |
 * | Added assets                | {@link MelRevisionDiff.added}                 |
 * | Removed assets              | {@link MelRevisionDiff.removed}               |
 * | Changed tags/aliases        | {@link MelRevisionDiff.changedTags}           |
 * | Changed descriptions        | {@link MelRevisionDiff.changedDescriptions}   |
 * | Changed System Keys         | {@link MelRevisionDiff.changedSystemKeys}     |
 * | Changed hierarchy levels    | {@link MelRevisionDiff.changedHierarchyLevels}|
 * | Moved parents               | {@link MelRevisionDiff.movedParents}          |
 * | New/removed dependencies    | {@link MelRevisionDiff.dependencyChanges}     |
 * | New duplicate/conflict items| {@link MelRevisionDiff.newConflicts}          |
 *
 * ## Identity across revisions
 *
 * The Equipment Tag is the key. A tag that only the new revision has is an
 * *added* asset; a tag only the old one has is *removed*. That is the honest
 * default — a renamed asset is genuinely indistinguishable, from the two
 * workbooks alone, from one asset disappearing while another appears.
 *
 * A rename is therefore a **claim**, and the caller makes it:
 * {@link DiffMelRevisionsOptions.renamedTags} maps old tag → new tag, and a
 * hinted pair is one asset whose tag changed rather than an add and a remove.
 * A hint that does not describe these two revisions is refused rather than
 * ignored, because a silently dropped hint reads, in the output, exactly like a
 * real add/remove pair.
 *
 * ## What the diff is a diff of
 *
 * Canonical MEL rows — what the export *prints*. Fields that never reach §12.1
 * (a system's confidence tier, its conflict status) cannot change this diff,
 * because they cannot change the delivered workbook either.
 *
 * A tag carried by more than one row (`DUPLICATE_MODEL_TAG`, never merged —
 * §9.3) is compared using its first row in canonical order, and the duplication
 * itself is reported through {@link MelRevisionDiff.newConflicts} rather than as
 * a scatter of field changes.
 */

import type { CanonicalMelRow } from './columns.js';
import { MelExportError } from './errors.js';
import { compareCodeUnits } from './order.js';
import type { GeneratedMelAsset } from './rows.js';
import { buildCanonicalMelRows } from './rows.js';

/* ---- result shapes ---- */

/** An asset that exists in only one of the two revisions. */
export interface MelAssetChange {
  readonly canonicalTag: string;
  /** The whole canonical row, from whichever revision holds it. */
  readonly row: CanonicalMelRow;
}

/** One field of one asset, before and after. */
export interface MelFieldChange {
  /** The asset's tag in the *current* revision. */
  readonly canonicalTag: string;
  readonly before: string;
  readonly after: string;
}

/** Which projected grouping level moved. */
export type MelHierarchyLevel = 'building' | 'ssmDiscipline';

/**
 * A change to one of the levels the SSM projection groups by (§11).
 *
 * Building and SSM Discipline only. Native Discipline is a source fact the
 * projection does not group on, and §12.4's list is binding — a native
 * discipline that changed is visible in the workbook, not in this category.
 */
export interface MelHierarchyLevelChange extends MelFieldChange {
  readonly level: MelHierarchyLevel;
}

/**
 * One dependency gained or lost.
 *
 * `before`/`after` are the whole Dependencies cell on each side, so the entry
 * reads as a change to the asset rather than as a bare edge.
 */
export interface MelDependencyChange extends MelFieldChange {
  readonly dependencyTag: string;
}

/** New and removed dependencies, each keyed by the depending asset's tag. */
export interface MelDependencyChanges {
  readonly added: ReadonlyArray<MelDependencyChange>;
  readonly removed: ReadonlyArray<MelDependencyChange>;
}

/** How many entries each §12.4 category produced. */
export interface MelRevisionDiffSummary {
  readonly added: number;
  readonly removed: number;
  readonly changedTags: number;
  readonly changedDescriptions: number;
  readonly changedSystemKeys: number;
  readonly changedHierarchyLevels: number;
  readonly movedParents: number;
  readonly dependenciesAdded: number;
  readonly dependenciesRemoved: number;
  readonly newConflicts: number;
}

/** The §12.4 revision output. Every list is deterministically ordered. */
export interface MelRevisionDiff {
  readonly added: ReadonlyArray<MelAssetChange>;
  readonly removed: ReadonlyArray<MelAssetChange>;
  /** `before` is the old tag, `after` the new one. Only hinted renames appear. */
  readonly changedTags: ReadonlyArray<MelFieldChange>;
  readonly changedDescriptions: ReadonlyArray<MelFieldChange>;
  readonly changedSystemKeys: ReadonlyArray<MelFieldChange>;
  readonly changedHierarchyLevels: ReadonlyArray<MelHierarchyLevelChange>;
  /** System Parent Equipment Tag changed. Independent of the System Key. */
  readonly movedParents: ReadonlyArray<MelFieldChange>;
  readonly dependencyChanges: MelDependencyChanges;
  /**
   * Tags that carry a duplicate/conflict reason now and did not before.
   * `before`/`after` are the reason sets, `'; '`-joined.
   */
  readonly newConflicts: ReadonlyArray<MelFieldChange>;
  readonly summary: MelRevisionDiffSummary;
}

/** Options for {@link diffMelRevisions}. */
export interface DiffMelRevisionsOptions {
  /**
   * Renames the caller is claiming: old tag → new tag. Each pair must name a
   * tag the previous revision has and a tag the current revision has, and
   * neither may exist on the other side.
   */
  readonly renamedTags?: ReadonlyMap<string, string>;
}

/* ---- the diff ---- */

/** Separator for the joined cells, matching `rows.ts`. */
const VALUE_SEPARATOR = '; ';

/**
 * The §9.3 statuses that mean the register is not settled for a tag.
 *
 * Matched as substrings because `inclusionStatus` is free text — an asset can
 * carry several statuses and the caller decides how to render that (`rows.ts`).
 */
const CONFLICT_STATUSES = ['DUPLICATE_MODEL_TAG', 'MODEL_CONFLICT', 'UNRESOLVED_IDENTITY'] as const;

/** Reported when a tag has more than one row, whatever its inclusion status says. */
const DUPLICATE_TAG_REASON = 'DUPLICATE_TAG';

/**
 * Diff two revisions of the generated MEL.
 *
 * Pure and total on the two revisions: an empty diff — nothing added, nothing
 * removed, nothing changed — is the correct answer for a re-run of the same
 * model, and it comes back as empty lists and a summary of zeros rather than as
 * an absence.
 *
 * @throws {MelExportError} `inapplicable-rename-hint` for a hint that does not
 * describe these two revisions.
 */
export function diffMelRevisions(
  previous: ReadonlyArray<GeneratedMelAsset>,
  current: ReadonlyArray<GeneratedMelAsset>,
  options: DiffMelRevisionsOptions = {},
): MelRevisionDiff {
  const before = groupByTag(previous);
  const after = groupByTag(current);
  const previousTagOf = validateRenames(options.renamedTags, before, after);
  const renamedFrom = new Set<string>(previousTagOf.values());

  const added: MelAssetChange[] = [];
  const removed: MelAssetChange[] = [];
  const changedTags: MelFieldChange[] = [];
  const changedDescriptions: MelFieldChange[] = [];
  const changedSystemKeys: MelFieldChange[] = [];
  const changedHierarchyLevels: MelHierarchyLevelChange[] = [];
  const movedParents: MelFieldChange[] = [];
  const dependenciesAdded: MelDependencyChange[] = [];
  const dependenciesRemoved: MelDependencyChange[] = [];
  const newConflicts: MelFieldChange[] = [];

  for (const [canonicalTag, currentRows] of after) {
    const previousTag = previousTagOf.get(canonicalTag) ?? canonicalTag;
    const previousRows = before.get(previousTag);
    const currentReasons = conflictReasons(currentRows);

    if (previousRows === undefined) {
      const row = currentRows[0];
      if (row !== undefined) added.push({ canonicalTag, row });
      if (currentReasons.length > 0) {
        newConflicts.push({ canonicalTag, before: '', after: currentReasons.join(VALUE_SEPARATOR) });
      }
      continue;
    }

    const previousRow = previousRows[0];
    const currentRow = currentRows[0];
    if (previousRow === undefined || currentRow === undefined) continue;

    if (previousTag !== canonicalTag) {
      changedTags.push({ canonicalTag, before: previousTag, after: canonicalTag });
    }
    pushIfChanged(
      changedDescriptions,
      canonicalTag,
      previousRow.equipmentDescription,
      currentRow.equipmentDescription,
    );
    pushIfChanged(changedSystemKeys, canonicalTag, previousRow.systemKey, currentRow.systemKey);
    for (const level of HIERARCHY_LEVELS) {
      if (previousRow[level] !== currentRow[level]) {
        changedHierarchyLevels.push({
          canonicalTag,
          level,
          before: previousRow[level],
          after: currentRow[level],
        });
      }
    }
    pushIfChanged(
      movedParents,
      canonicalTag,
      previousRow.systemParentEquipmentTag,
      currentRow.systemParentEquipmentTag,
    );

    const previousDeps = splitDependencies(previousRow.dependencies);
    const currentDeps = splitDependencies(currentRow.dependencies);
    for (const dependencyTag of currentDeps) {
      if (previousDeps.has(dependencyTag)) continue;
      dependenciesAdded.push({
        canonicalTag,
        dependencyTag,
        before: previousRow.dependencies,
        after: currentRow.dependencies,
      });
    }
    for (const dependencyTag of previousDeps) {
      if (currentDeps.has(dependencyTag)) continue;
      dependenciesRemoved.push({
        canonicalTag,
        dependencyTag,
        before: previousRow.dependencies,
        after: currentRow.dependencies,
      });
    }

    const previousReasons = conflictReasons(previousRows);
    if (currentReasons.some((reason) => !previousReasons.includes(reason))) {
      newConflicts.push({
        canonicalTag,
        before: previousReasons.join(VALUE_SEPARATOR),
        after: currentReasons.join(VALUE_SEPARATOR),
      });
    }
  }

  for (const [canonicalTag, previousRows] of before) {
    if (after.has(canonicalTag) || renamedFrom.has(canonicalTag)) continue;
    const row = previousRows[0];
    if (row !== undefined) removed.push({ canonicalTag, row });
  }

  added.sort(byTag);
  removed.sort(byTag);
  changedTags.sort(byTag);
  changedDescriptions.sort(byTag);
  changedSystemKeys.sort(byTag);
  changedHierarchyLevels.sort(
    (a, b) => byTag(a, b) || compareCodeUnits(a.level, b.level),
  );
  movedParents.sort(byTag);
  dependenciesAdded.sort((a, b) => byTag(a, b) || compareCodeUnits(a.dependencyTag, b.dependencyTag));
  dependenciesRemoved.sort(
    (a, b) => byTag(a, b) || compareCodeUnits(a.dependencyTag, b.dependencyTag),
  );
  newConflicts.sort(byTag);

  return {
    added,
    removed,
    changedTags,
    changedDescriptions,
    changedSystemKeys,
    changedHierarchyLevels,
    movedParents,
    dependencyChanges: { added: dependenciesAdded, removed: dependenciesRemoved },
    newConflicts,
    summary: {
      added: added.length,
      removed: removed.length,
      changedTags: changedTags.length,
      changedDescriptions: changedDescriptions.length,
      changedSystemKeys: changedSystemKeys.length,
      changedHierarchyLevels: changedHierarchyLevels.length,
      movedParents: movedParents.length,
      dependenciesAdded: dependenciesAdded.length,
      dependenciesRemoved: dependenciesRemoved.length,
      newConflicts: newConflicts.length,
    },
  };
}

/** The projected grouping levels, in the order they are reported. */
const HIERARCHY_LEVELS: ReadonlyArray<MelHierarchyLevel> = ['building', 'ssmDiscipline'];

function byTag(a: { readonly canonicalTag: string }, b: { readonly canonicalTag: string }): number {
  return compareCodeUnits(a.canonicalTag, b.canonicalTag);
}

function pushIfChanged(
  into: MelFieldChange[],
  canonicalTag: string,
  before: string,
  after: string,
): void {
  if (before !== after) into.push({ canonicalTag, before, after });
}

/** Canonical rows grouped by tag, in canonical row order. */
function groupByTag(assets: ReadonlyArray<GeneratedMelAsset>): Map<string, CanonicalMelRow[]> {
  const byTagKey = new Map<string, CanonicalMelRow[]>();
  for (const row of buildCanonicalMelRows(assets)) {
    const rows = byTagKey.get(row.equipmentTag);
    if (rows === undefined) byTagKey.set(row.equipmentTag, [row]);
    else rows.push(row);
  }
  return byTagKey;
}

function splitDependencies(cell: string): ReadonlySet<string> {
  if (cell === '') return new Set();
  return new Set(
    cell
      .split(VALUE_SEPARATOR)
      .map((tag) => tag.trim())
      .filter((tag) => tag !== ''),
  );
}

/** Every §9.3 reason this tag carries, in a fixed order. */
function conflictReasons(rows: ReadonlyArray<CanonicalMelRow>): ReadonlyArray<string> {
  const reasons: string[] = [];
  if (rows.length > 1) reasons.push(DUPLICATE_TAG_REASON);
  for (const status of CONFLICT_STATUSES) {
    if (rows.some((row) => row.inclusionStatus.includes(status))) reasons.push(status);
  }
  return reasons;
}

/**
 * Check the rename hints and return current tag → previous tag.
 *
 * Every failure is refused rather than dropped: a hint whose old tag is not in
 * the previous revision, whose new tag is not in the current one, whose two
 * tags are equal, or that would collide with a tag the other revision already
 * uses, describes a different pair of revisions than the ones supplied.
 */
function validateRenames(
  renamedTags: ReadonlyMap<string, string> | undefined,
  before: ReadonlyMap<string, ReadonlyArray<CanonicalMelRow>>,
  after: ReadonlyMap<string, ReadonlyArray<CanonicalMelRow>>,
): ReadonlyMap<string, string> {
  const previousTagOf = new Map<string, string>();
  if (renamedTags === undefined) return previousTagOf;
  for (const [fromTag, toTag] of renamedTags) {
    const refuse = (detail: string): never => {
      throw new MelExportError({ kind: 'inapplicable-rename-hint', fromTag, toTag, detail });
    };
    if (fromTag === toTag) refuse('the two tags are the same, so nothing was renamed');
    if (!before.has(fromTag)) refuse(`the previous revision has no '${fromTag}'`);
    if (!after.has(toTag)) refuse(`the current revision has no '${toTag}'`);
    if (after.has(fromTag)) refuse(`the current revision still has '${fromTag}'`);
    if (before.has(toTag)) refuse(`the previous revision already had '${toTag}'`);
    if (previousTagOf.has(toTag)) {
      refuse(`'${toTag}' is already claimed by '${previousTagOf.get(toTag) ?? ''}'`);
    }
    previousTagOf.set(toTag, fromTag);
  }
  return previousTagOf;
}
