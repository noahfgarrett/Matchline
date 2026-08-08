/**
 * Training: a finished SSM / registry export in, a serializable rule set out.
 *
 * Ported from the donor's `learnNestingModel` (role counts, class-pair
 * affinities, self-grading) and `learnItemMasterTable`'s description ->
 * classification half. Four passes over the rows:
 *
 *   1. description patterns -> class, majority vote per (discipline, pattern)
 *   2. the export's own parent links -> per-class role counts and class-pair
 *      affinities, same-system links only
 *   3. gates derived from those counts
 *   4. self-grade: replay the pairing policy over the export's real answers and
 *      count, per class
 *
 * Deterministic by construction: every emitted array is sorted, and every
 * majority vote breaks ties on the label, so re-ordering the input rows cannot
 * move a single byte of the output.
 */
import { affinityKey, classificationKey } from './keys.js';
import { pickParent, type PolicyItem, type PolicyModel } from './policy.js';
import {
  CHILD_ONLY_MAX_PARENT_RATE,
  CHILD_ONLY_MIN_SIGHTINGS,
  GRADE_MIN_PRECISION,
  GRADE_MIN_PREDICTIONS,
  MIN_AFFINITY_OBSERVATIONS,
  PARENT_CAPABLE_MIN_PARENT_RATE,
  PARENT_CAPABLE_MIN_PARENTINGS,
} from './thresholds.js';
import {
  clean,
  descriptionPattern,
  normalizeText,
  numberRunsOf,
  roleClassOf,
  round,
  tagKey,
} from './text.js';
import type {
  AffinityEntry,
  ClassGradeEntry,
  ClassificationEntry,
  LearnedRuleSet,
  RoleGateEntry,
  TrainingRow,
} from './types.js';

export interface TrainOptions {
  /** Free text naming the export the rules came from; shown in the profile. */
  readonly label?: string;
}

/** The donor's `lookup` majority, with a label tie-break for order independence. */
function dominant(votes: ReadonlyMap<string, number>): {
  label: string;
  count: number;
  total: number;
} {
  let label = '';
  let count = 0;
  let total = 0;
  for (const [candidate, tally] of votes) {
    total += tally;
    if (tally > count || (tally === count && (label === '' || candidate < label))) {
      label = candidate;
      count = tally;
    }
  }
  return { label, count, total };
}

interface ClassBucket {
  readonly discipline: string;
  readonly pattern: string;
  readonly votes: Map<string, number>;
}

interface AffinityBucket {
  readonly childClass: string;
  readonly parentClass: string;
  observations: number;
}

interface IndexedRow {
  readonly row: TrainingRow;
  readonly key: string;
  readonly cls: string;
  readonly system: string;
}

function indexRow(row: TrainingRow): IndexedRow {
  return {
    row,
    key: tagKey(row.equipmentTag),
    cls: roleClassOf(row.equipmentTag),
    system: normalizeText(row.systemKey),
  };
}

function policyItemOf(indexed: IndexedRow): PolicyItem {
  return {
    id: indexed.key,
    tag: clean(indexed.row.equipmentTag),
    cls: indexed.cls,
    familyKey: normalizeText(indexed.row.familyKey),
    numberRuns: numberRunsOf(indexed.row.equipmentTag),
  };
}

function bump(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

export function trainLearnedRules(
  rows: ReadonlyArray<TrainingRow>,
  opts?: TrainOptions,
): LearnedRuleSet {
  const indexed = rows.map(indexRow);

  /* 1. description pattern -> class, per (discipline, masked description). */
  const classBuckets = new Map<string, ClassBucket>();
  for (const entry of indexed) {
    const pattern = descriptionPattern(entry.row.description);
    if (pattern === '' || entry.cls === '') continue;
    const discipline = normalizeText(entry.row.discipline);
    const key = classificationKey(discipline, pattern);
    let bucket = classBuckets.get(key);
    if (bucket === undefined) {
      bucket = { discipline, pattern, votes: new Map<string, number>() };
      classBuckets.set(key, bucket);
    }
    bump(bucket.votes, entry.cls);
  }

  /* 2. the export's own parent links. A link only counts inside one system --
        the same-partition constraint the fold enforces later, applied to the
        evidence the rules are learned from. */
  const byTag = new Map<string, IndexedRow>();
  for (const entry of indexed) {
    if (entry.key !== '' && !byTag.has(entry.key)) byTag.set(entry.key, entry);
  }

  const asParent = new Map<string, number>();
  const asChild = new Map<string, number>();
  const affinityBuckets = new Map<string, AffinityBucket>();
  const truthPairs: Array<{ child: IndexedRow; parent: IndexedRow }> = [];

  for (const entry of indexed) {
    const parentKey = tagKey(entry.row.parentTag);
    if (parentKey === '' || parentKey === entry.key) continue;
    const parent = byTag.get(parentKey);
    if (parent === undefined) continue;
    if (parent.system !== entry.system) continue;
    if (entry.cls === '' || parent.cls === '') continue;

    bump(asChild, entry.cls);
    bump(asParent, parent.cls);
    const key = affinityKey(entry.cls, parent.cls);
    const bucket = affinityBuckets.get(key);
    if (bucket === undefined) {
      affinityBuckets.set(key, {
        childClass: entry.cls,
        parentClass: parent.cls,
        observations: 1,
      });
    } else {
      bucket.observations++;
    }
    truthPairs.push({ child: entry, parent });
  }

  /* 3. gates. `parentRate` is a share of link participations, not of rows: the
        donor's ratio asks "when this class was involved in a nesting, how often
        was it the parent?", which is what makes a class child-only. */
  const parentRateOf = (cls: string): number => {
    const parents = asParent.get(cls) ?? 0;
    const children = asChild.get(cls) ?? 0;
    return parents + children === 0 ? 0 : parents / (parents + children);
  };
  const isChildClass = (cls: string): boolean =>
    cls !== '' &&
    parentRateOf(cls) < CHILD_ONLY_MAX_PARENT_RATE &&
    (asChild.get(cls) ?? 0) >= CHILD_ONLY_MIN_SIGHTINGS;
  const isParentCapable = (cls: string): boolean =>
    cls !== '' &&
    parentRateOf(cls) >= PARENT_CAPABLE_MIN_PARENT_RATE &&
    (asParent.get(cls) ?? 0) >= PARENT_CAPABLE_MIN_PARENTINGS;

  const model: PolicyModel = {
    isChildClass,
    isParentCapable,
    affinity: (childClass, parentClass) =>
      affinityBuckets.get(affinityKey(childClass, parentClass))?.observations ?? 0,
  };

  /* 4. self-grade: replay the policy over the export's own answers. Only
        role-affinity picks are scored -- containment is claim-grade by design
        intent, and grading it would flatter every class that happens to own a
        rack or a power supply. */
  const bySystem = new Map<string, PolicyItem[]>();
  for (const entry of indexed) {
    let partition = bySystem.get(entry.system);
    if (partition === undefined) {
      partition = [];
      bySystem.set(entry.system, partition);
    }
    partition.push(policyItemOf(entry));
  }

  const scores = new Map<string, { predicted: number; correct: number }>();
  for (const { child, parent } of truthPairs) {
    if (!isChildClass(child.cls)) continue;
    let score = scores.get(child.cls);
    if (score === undefined) {
      score = { predicted: 0, correct: 0 };
      scores.set(child.cls, score);
    }
    const partition = bySystem.get(child.system) ?? [];
    const peers = partition.filter((peer) => peer.id !== child.key);
    const pick = pickParent(policyItemOf(child), peers, model);
    if (pick === null || pick.rule !== 'role-affinity') continue;
    score.predicted++;
    if (pick.parent.id === parent.key) score.correct++;
  }

  /* Emit. */
  const classification: ClassificationEntry[] = [];
  for (const bucket of classBuckets.values()) {
    const top = dominant(bucket.votes);
    if (top.total === 0) continue;
    classification.push({
      discipline: bucket.discipline,
      pattern: bucket.pattern,
      class: top.label,
      confidence: round(top.count / top.total, 2),
      sampleCount: top.total,
    });
  }
  classification.sort(
    (a, b) => a.discipline.localeCompare(b.discipline) || a.pattern.localeCompare(b.pattern),
  );

  const roleGates: RoleGateEntry[] = [...new Set([...asParent.keys(), ...asChild.keys()])]
    .map((cls) => ({
      class: cls,
      asParent: asParent.get(cls) ?? 0,
      asChild: asChild.get(cls) ?? 0,
      parentRate: round(parentRateOf(cls), 4),
      isChildOnly: isChildClass(cls),
      isParentCapable: isParentCapable(cls),
    }))
    .sort((a, b) => a.class.localeCompare(b.class));

  const affinities: AffinityEntry[] = [...affinityBuckets.values()]
    .filter((bucket) => bucket.observations >= MIN_AFFINITY_OBSERVATIONS)
    .map((bucket) => ({
      childClass: bucket.childClass,
      parentClass: bucket.parentClass,
      observations: bucket.observations,
    }))
    .sort(
      (a, b) =>
        a.childClass.localeCompare(b.childClass) || a.parentClass.localeCompare(b.parentClass),
    );

  const grades: ClassGradeEntry[] = [...scores.entries()]
    .map(([cls, score]) => {
      const precision = score.predicted === 0 ? 0 : score.correct / score.predicted;
      const earnsClaim =
        score.predicted >= GRADE_MIN_PREDICTIONS && precision >= GRADE_MIN_PRECISION;
      return {
        class: cls,
        predicted: score.predicted,
        correct: score.correct,
        precision: round(precision, 4),
        grade: earnsClaim ? ('claim' as const) : ('proposal' as const),
      };
    })
    .sort((a, b) => a.class.localeCompare(b.class));

  return {
    version: 1,
    classification,
    roleGates,
    affinities,
    grades,
    trainedFrom: { rowCount: rows.length, label: clean(opts?.label) },
  };
}
