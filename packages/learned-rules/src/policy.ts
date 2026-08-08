/**
 * The one pairing policy, shared by self-grading and inference.
 *
 * Ported from the donor's `pickParent`. Training and application MUST run the
 * identical function or the self-graded precision is a number about a different
 * algorithm than the one that ships -- that shared-policy property is what
 * makes the claim grade mean anything.
 *
 * Rules, in the donor's order:
 *   A. containment -- the tag literally extends another tag in the same
 *      partition, at a separator boundary and by something substantive.
 *      Claim-grade by design intent, and it does not need a learned class.
 *   B. role gate + shared number run + class-pair affinity, unique best.
 */
import {
  CONTAINMENT_MIN_EXTENSION,
  CONTAINMENT_MIN_PARENT_BODY,
  MIN_AFFINITY_OBSERVATIONS,
} from './thresholds.js';
import { compareText, sharedRun, tagBody, tagKey } from './text.js';
import type { NestingRule } from './types.js';

/** One candidate in a partition -- a training row or an asset, both reduced to this. */
export interface PolicyItem {
  /** Stable identity within the run: a tag key when training, an asset id when applying. */
  readonly id: string;
  readonly tag: string;
  readonly cls: string;
  readonly familyKey: string;
  readonly numberRuns: ReadonlyArray<string>;
}

/** The learned gates the policy consults, as functions so training can use live counts. */
export interface PolicyModel {
  isChildClass(cls: string): boolean;
  isParentCapable(cls: string): boolean;
  affinity(childClass: string, parentClass: string): number;
}

export interface PolicyPick {
  readonly rule: NestingRule;
  readonly parent: PolicyItem;
  readonly detail: string;
}

const SEPARATOR = /[-_./\s]/;

/**
 * Donor containment: `…-00_PS2-RACK` genuinely extends its PLC, while `…-05A`
 * merely extends its sibling `…-05` by a letter and `…-RIO650-1-03` runs
 * straight past the short header tag `…-RIO` with no boundary.
 *
 * The donor took the longest container; ties on body length are broken by tag
 * key so the answer cannot depend on partition order.
 */
function containerFor(item: PolicyItem, peers: ReadonlyArray<PolicyItem>): PolicyItem | null {
  const childTag = tagKey(item.tag);
  if (childTag === '') return null;
  const childBody = tagBody(item.tag);

  const containers = peers
    .filter((peer) => {
      const parentTag = tagKey(peer.tag);
      const parentBody = tagBody(peer.tag);
      return (
        parentBody.length >= CONTAINMENT_MIN_PARENT_BODY &&
        childBody.length - parentBody.length >= CONTAINMENT_MIN_EXTENSION &&
        childTag.startsWith(parentTag) &&
        SEPARATOR.test(childTag.charAt(parentTag.length))
      );
    })
    .sort((a, b) => {
      const byLength = tagBody(b.tag).length - tagBody(a.tag).length;
      return byLength !== 0 ? byLength : compareText(tagKey(a.tag), tagKey(b.tag));
    });

  return containers[0] ?? null;
}

interface ScoredPeer {
  readonly peer: PolicyItem;
  /** 1 when both carry the same non-empty family key (PRODUCT.md §11.2). */
  readonly family: number;
  readonly run: number;
  readonly pairs: number;
}

/**
 * Picks a parent for `item` out of `peers`, which must already be the item's
 * own partition with the item itself removed.
 *
 * Returns `null` for "no answer" -- including the ambiguous case, where two
 * candidates are equally good. The donor refuses rather than guesses there, and
 * so does the identity ladder (PRODUCT.md §9.2): a tie is information, and a
 * coin flip would poison the precision measurement.
 */
export function pickParent(
  item: PolicyItem,
  peers: ReadonlyArray<PolicyItem>,
  model: PolicyModel,
): PolicyPick | null {
  const container = containerFor(item, peers);
  if (container !== null) {
    return {
      rule: 'containment',
      parent: container,
      detail: `${item.tag} extends ${container.tag}`,
    };
  }

  if (!model.isChildClass(item.cls)) return null;

  const scored: ScoredPeer[] = peers
    .filter((peer) => model.isParentCapable(peer.cls))
    .map((peer) => ({
      peer,
      family: item.familyKey !== '' && peer.familyKey === item.familyKey ? 1 : 0,
      run: sharedRun(item.numberRuns, peer.numberRuns),
      pairs: model.affinity(item.cls, peer.cls),
    }))
    .filter((entry) => entry.run >= 1)
    .sort((a, b) => b.family - a.family || b.run - a.run || b.pairs - a.pairs);

  const best = scored[0];
  if (best === undefined) return null;
  if (best.pairs < MIN_AFFINITY_OBSERVATIONS) return null;

  const ambiguous = scored.some(
    (entry) =>
      entry.peer.id !== best.peer.id &&
      entry.family === best.family &&
      entry.run === best.run &&
      entry.pairs === best.pairs,
  );
  if (ambiguous) return null;

  const family = best.family === 1 ? `; family key ${item.familyKey}` : '';
  return {
    rule: 'role-affinity',
    parent: best.peer,
    detail:
      `${item.cls} nests under ${best.peer.cls} (${best.pairs}x in training); ` +
      `shared number run ${best.run}${family}`,
  };
}
