/**
 * One review queue out of eleven stages.
 *
 * Every stage raises its own review items and none of them can see the others,
 * so the same decision arrives more than once: a duplicated model tag is a
 * catalog item; the fuzzy identity behind a flow node is raised while resolving
 * the flow's tags; a system conflict is raised per subject and again on the
 * batch result. A person should see each decision once.
 *
 * Identity is `@matchline/ssm-compiler`'s `reviewKey` -- the same flattening the
 * snapshot dedupes its own items with, so an item that survives here and an item
 * that survived there are compared by exactly one rule. Order is `reviewKey`
 * order, which is stable across shuffled inputs and independent of which stage
 * happened to raise an item first.
 */
import type { ReviewItem } from '@matchline/domain';
import { compareReviewItems, reviewKey } from '@matchline/ssm-compiler';

/**
 * Merge every stage's review items into one deduped, deterministic list.
 *
 * The first item under a key wins. Which one that is does not depend on stage
 * order: the input is sorted before it is deduped, so two structurally
 * identical items are interchangeable by construction.
 */
export function aggregateReviewItems(
  groups: ReadonlyArray<ReadonlyArray<ReviewItem>>,
): ReadonlyArray<ReviewItem> {
  const all: ReviewItem[] = [];
  for (const group of groups) {
    all.push(...group);
  }
  all.sort(compareReviewItems);

  const deduped = new Map<string, ReviewItem>();
  for (const item of all) {
    const key = reviewKey(item);
    if (!deduped.has(key)) {
      deduped.set(key, item);
    }
  }
  return [...deduped.values()];
}
