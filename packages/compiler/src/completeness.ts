/**
 * How much of the site the compile actually described (audit blocker B3).
 *
 * The failure this exists for: with the shipped default profile -- Building and
 * System as hard boundaries, no resolver, no building mapping -- every asset
 * becomes a root under `(unassigned)`, the compile reports success, screen 9
 * lists "Building - boundary", and no number anywhere says "0 of 34 assets are
 * nested". Every stage was honest and the whole was not.
 *
 * Everything here is read off what the fold and the resolver already decided.
 * No cache is opened, no tag is parsed and no rule is re-run: a report that
 * recomputed anything could disagree with the snapshot it describes, and then
 * there would be two answers to "is my equipment nested".
 */
import { boundaryAttributeOf, unicodeFold } from '@matchline/domain';
import type {
  CompletenessReport,
  HierarchyConfig,
  LadderSourceKind,
  LevelCompleteness,
  LevelDemotionCount,
  ResolvedSnapshot,
  ReviewItem,
  SsmRelationshipClaim,
  UnresolvedSystemCount,
} from '@matchline/domain';
import type { CompileSubject } from '@matchline/ssm-compiler';
import type { ResolveSystemsResult, SkippedRung } from '@matchline/system-resolver';

/** How many assets an aggregate review item names before it stops listing them. */
const EXAMPLE_LIMIT = 10;

/** What a report is built from: one stage's output each, nothing recomputed. */
export interface CompletenessInput {
  /** Already migrated, so a level's three keys are addressable (P0-6). */
  readonly hierarchy: HierarchyConfig;
  readonly subjects: ReadonlyArray<CompileSubject>;
  readonly snapshot: ResolvedSnapshot;
  readonly systems: ResolveSystemsResult;
  /** Assembled structural claims, to tell "rooted" from "nobody proposed anything". */
  readonly structuralClaims: ReadonlyArray<SsmRelationshipClaim>;
  /** MEL rows that stated no tag, no key and no description (audit low finding). */
  readonly melRowsDropped: number;
}

/** The report, plus the review items only this stage is in a position to raise. */
export interface CompletenessResult {
  readonly report: CompletenessReport;
  /** One `unresolved-system` item per distinct set of resolver skip reasons. */
  readonly reviewItems: ReadonlyArray<ReviewItem>;
}

/** UTF-16 code units, so two machines order one report the same way. */
function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Whether an asset states a value for one attribute.
 *
 * The fold's own reading (`boundaryValue` in `@matchline/ssm-compiler`): absent,
 * blank, or whitespace is unstated. The report has to agree with the fold about
 * what "stated" means, or it would tell a site its Building level is fully
 * populated while the fold refused every parent for want of a value.
 */
function states(subject: CompileSubject, attributeKey: string): boolean {
  const value = subject.attributes.get(attributeKey);
  if (value === undefined) {
    return false;
  }
  return unicodeFold(value).trim() !== '';
}

/** One skipped rung, in the words the review item prints. */
function describeRung(rung: SkippedRung): string {
  return `${rung.chain}[${String(rung.rungIndex)}] ${rung.component} ${rung.reason}`;
}

/**
 * Why the resolver came up empty for one asset.
 *
 * A chain with no rungs at all skipped nothing, which would flatten every such
 * asset into a group described by an empty list. That case is the commonest one
 * on a fresh project -- the shipped default profile configures no resolver --
 * and it deserves the sentence that actually explains it.
 */
const NO_RESOLVER_REASON = 'no system resolver rung produced a key';

function reasonsOf(skipped: ReadonlyArray<SkippedRung>): ReadonlyArray<string> {
  const reasons = new Set<string>();
  for (const rung of skipped) {
    if (rung.chain === 'keyChain') {
      reasons.add(describeRung(rung));
    }
  }
  return reasons.size === 0 ? [NO_RESOLVER_REASON] : [...reasons].sort(compareText);
}

/** One group of a counted item: the total, and the first ten members by id. */
interface Group {
  count: number;
  readonly examples: string[];
}

function record(groups: Map<string, Group>, key: string, assetId: string): void {
  const existing = groups.get(key);
  if (existing === undefined) {
    groups.set(key, { count: 1, examples: [assetId] });
    return;
  }
  existing.count += 1;
  if (existing.examples.length < EXAMPLE_LIMIT) {
    existing.examples.push(assetId);
  }
}

/** Demotions by (level, rung), read off the items the snapshot already raised. */
function demotionsOf(snapshot: ResolvedSnapshot): ReadonlyArray<LevelDemotionCount> {
  const counts = new Map<string, LevelDemotionCount>();
  const add = (levelId: string, ladderSource: LadderSourceKind, count: number): void => {
    const key = `${levelId} ${ladderSource}`;
    const existing = counts.get(key);
    counts.set(key, { levelId, ladderSource, count: (existing?.count ?? 0) + count });
  };

  for (const item of snapshot.reviewItems) {
    if (item.kind === 'boundary-demotion') {
      add(item.levelId, item.ladderSource, item.pairCount);
      continue;
    }
    // The manual rung reports per pair, because refusing a person is owed a
    // named row; here it is one more demotion at that level like any other.
    if (item.kind === 'manual-boundary-demotion') {
      add(item.boundaryLevelId, 'manual', 1);
    }
  }

  return [...counts.values()].sort((left, right) => {
    if (left.count !== right.count) {
      return right.count - left.count;
    }
    const byLevel = compareText(left.levelId, right.levelId);
    return byLevel !== 0 ? byLevel : compareText(left.ladderSource, right.ladderSource);
  });
}

/**
 * Everything the report says, in one pass over the assets.
 *
 * Deterministic: the subjects arrive in catalog order, every group's examples
 * are the first ten in that order, and every emitted list is sorted by content.
 */
export function buildCompleteness(input: CompletenessInput): CompletenessResult {
  const { hierarchy, subjects, snapshot, systems } = input;

  // Which assets any rung named a parent for. A claim pointing outside the
  // compile is evidence but not a candidate, so it does not count: the question
  // this answers is "did anything propose a parent that could have won".
  const known = new Set(subjects.map((subject) => subject.assetId));
  const hasCandidate = new Set<string>();
  for (const claim of input.structuralClaims) {
    if (claim.targetAssetId !== claim.subjectAssetId && known.has(claim.targetAssetId)) {
      hasCandidate.add(claim.subjectAssetId);
    }
  }
  for (const subject of subjects) {
    const suggested = subject.modelTreeParentId;
    if (suggested !== undefined && suggested !== subject.assetId && known.has(suggested)) {
      hasCandidate.add(subject.assetId);
    }
  }

  const levelCounts = hierarchy.levels.map((level) => ({
    level,
    // A boundary level is measured on what it COMPARES; a grouping level on what
    // it groups by. Measuring a boundary on its key would report a site as
    // complete while the fold was refusing every parent on another field.
    attributeKey: level.boundary ? boundaryAttributeOf(level) : level.keyAttributeKey,
    without: 0,
  }));

  let assetsNested = 0;
  let assetsRooted = 0;
  let assetsWithNoParentCandidate = 0;
  let assetsWithoutSystem = 0;
  const unresolvedGroups = new Map<string, Group>();

  for (const subject of subjects) {
    for (const entry of levelCounts) {
      if (!states(subject, entry.attributeKey)) {
        entry.without += 1;
      }
    }

    const node = snapshot.nodes.get(subject.assetId);
    const status = node?.parent.status;
    if (status === 'resolved') {
      assetsNested += 1;
    } else if (status === 'root' || status === 'provisional-root') {
      assetsRooted += 1;
    }
    if (!hasCandidate.has(subject.assetId)) {
      assetsWithNoParentCandidate += 1;
    }

    const resolution = systems.bySubject.get(subject.assetId);
    // No entry at all is the same fact as an entry that resolved nothing: this
    // asset has no system. It happens when a caller resolves a subset.
    if (resolution === undefined || resolution.resolution === null) {
      assetsWithoutSystem += 1;
      const reasons = reasonsOf(resolution?.skippedRungs ?? []);
      record(unresolvedGroups, reasons.join(' • '), subject.assetId);
    }
  }

  const levels: ReadonlyArray<LevelCompleteness> = levelCounts.map(
    (entry): LevelCompleteness => ({
      levelId: entry.level.levelId,
      displayName: entry.level.displayName,
      boundary: entry.level.boundary,
      attributeKey: entry.attributeKey,
      assetsWithoutValue: entry.without,
      blocksNesting: entry.level.boundary && entry.without > 0,
    }),
  );

  const unresolvedSystemBySkipReason: UnresolvedSystemCount[] = [];
  const reviewItems: ReviewItem[] = [];
  for (const [key, group] of unresolvedGroups) {
    const skipReasons = key.split(' • ');
    unresolvedSystemBySkipReason.push({ skipReasons, assetCount: group.count });
    reviewItems.push({
      kind: 'unresolved-system',
      skipReasons,
      assetCount: group.count,
      exampleAssetIds: group.examples,
    });
  }
  unresolvedSystemBySkipReason.sort((left, right) =>
    left.assetCount === right.assetCount
      ? compareText(left.skipReasons.join(', '), right.skipReasons.join(', '))
      : right.assetCount - left.assetCount,
  );

  return {
    report: {
      assetCount: subjects.length,
      assetsNested,
      assetsRooted,
      assetsWithNoParentCandidate,
      assetsWithoutSystem,
      levels,
      demotionsPerLevel: demotionsOf(snapshot),
      unresolvedSystemBySkipReason,
      melRowsDropped: input.melRowsDropped,
    },
    reviewItems,
  };
}
