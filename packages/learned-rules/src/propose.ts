/**
 * Applying the learned pairing rules (donor `inferNesting`).
 *
 * Assets are bucketed by system -- the same-partition constraint -- and each
 * one is run through the single shared policy. Nothing here writes a hierarchy:
 * the output is a list of proposals, and only the ones whose class earned the
 * claim grade during self-grading are allowed to compete as claim-grade
 * candidates on the parent ladder (PRODUCT.md §11.1 tier 6). Everything else is
 * review-queue material.
 */
import { classifyDescription } from './classify.js';
import { affinityKey } from './keys.js';
import { pickParent, type PolicyItem, type PolicyModel } from './policy.js';
import { clean, compareText, normalizeText, numberRunsOf } from './text.js';
import type {
  ClassGradeEntry,
  LearnedRuleSet,
  NestingAsset,
  NestingGrade,
  ProposedNesting,
} from './types.js';

/** Rebuilds the donor's working model from the persisted plain form. */
function modelOf(ruleSet: LearnedRuleSet): PolicyModel {
  const childOnly = new Set<string>();
  const parentCapable = new Set<string>();
  for (const gate of ruleSet.roleGates) {
    if (gate.isChildOnly) childOnly.add(gate.class);
    if (gate.isParentCapable) parentCapable.add(gate.class);
  }
  const affinity = new Map<string, number>();
  for (const entry of ruleSet.affinities) {
    affinity.set(affinityKey(entry.childClass, entry.parentClass), entry.observations);
  }
  return {
    isChildClass: (cls) => cls !== '' && childOnly.has(cls),
    isParentCapable: (cls) => cls !== '' && parentCapable.has(cls),
    affinity: (childClass, parentClass) =>
      affinity.get(affinityKey(childClass, parentClass)) ?? 0,
  };
}

function gradesOf(ruleSet: LearnedRuleSet): ReadonlyMap<string, ClassGradeEntry> {
  const grades = new Map<string, ClassGradeEntry>();
  for (const entry of ruleSet.grades) grades.set(entry.class, entry);
  return grades;
}

function itemOf(asset: NestingAsset, cls: string): PolicyItem {
  return {
    id: asset.assetId,
    tag: clean(asset.tag),
    cls,
    familyKey: normalizeText(asset.familyKey),
    numberRuns: asset.tagNumberRuns ?? numberRunsOf(asset.tag),
  };
}

/**
 * Proposes a parent for each asset the learned rules can place.
 *
 * An asset takes part only when it has a system key: without a partition there
 * is no defensible peer set, and the donor skips those records for the same
 * reason. Classes come from the learned description table alone -- never from
 * the asset's own tag -- so the rules stand or fall on what they actually
 * learned.
 *
 * Results are sorted by child asset id; the function is pure and deterministic.
 */
export function proposeNestings(
  ruleSet: LearnedRuleSet,
  assets: ReadonlyArray<NestingAsset>,
): ReadonlyArray<ProposedNesting> {
  const model = modelOf(ruleSet);
  const grades = gradesOf(ruleSet);

  const items = new Map<string, PolicyItem>();
  const byPartition = new Map<string, PolicyItem[]>();
  for (const asset of assets) {
    const partition = normalizeText(asset.systemKey);
    if (partition === '') continue;
    const hit = classifyDescription(ruleSet, asset.description, asset.discipline);
    const item = itemOf(asset, hit === null ? '' : hit.class);
    items.set(asset.assetId, item);
    let bucket = byPartition.get(partition);
    if (bucket === undefined) {
      bucket = [];
      byPartition.set(partition, bucket);
    }
    bucket.push(item);
  }

  const proposals: ProposedNesting[] = [];
  for (const asset of assets) {
    const item = items.get(asset.assetId);
    if (item === undefined) continue;
    const partition = byPartition.get(normalizeText(asset.systemKey)) ?? [];
    const peers = partition.filter((peer) => peer.id !== item.id);
    if (peers.length === 0) continue;

    const pick = pickParent(item, peers, model);
    if (pick === null) continue;

    /* Containment is claim-grade by design intent (the donor's rule A): a tag
       that literally extends another at a separator boundary is not a
       statistical guess. Everything else inherits its class's self-graded
       standing, and an ungraded class can only ever propose. */
    const graded = grades.get(item.cls);
    const grade: NestingGrade =
      pick.rule === 'containment' ? 'claim' : (graded?.grade ?? 'proposal');
    const confidence = pick.rule === 'containment' ? 1 : (graded?.precision ?? 0);

    proposals.push({
      childAssetId: item.id,
      parentAssetId: pick.parent.id,
      rule: pick.rule,
      ruleDetail: pick.detail,
      confidence,
      grade,
    });
  }

  return proposals.sort((a, b) => compareText(a.childAssetId, b.childAssetId));
}
