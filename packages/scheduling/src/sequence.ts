/**
 * Commissioning sequence numbers (donor `src/compiler/sequence.js`, spec §5).
 *
 * ## The rule ported, as the donor states it
 *
 * > Within a system block: topological order of the structural tree, direction
 * > set by discipline polarity — Electrical/LSS/Security commission top-down
 * > (parents before children: LVSS → transformer → panelboard), Mechanical/I&C
 * > bottom-up (children before parents: TETs before the MAH).
 *
 * In terms of the walk: **top-down numbers pre-order** (a node before its
 * children — source to load down the structural chain), **bottom-up numbers
 * post-order** (every child before its parent). Roots, and each node's children,
 * are visited in natural tag order, so the numbering is fixed by the tree and
 * the tags rather than by the order assets arrive.
 *
 * ## Which disciplines are top-down
 *
 * The donor's default is a regular expression, `/elec|lss|security|fire/i`,
 * against the discipline text — note that it matches Fire as well as the three
 * named in the comment — and a per-discipline profile map overrides it. Both
 * are ported verbatim: {@link DEFAULT_TOP_DOWN_PATTERN} and
 * {@link SequenceOptions.polarity}.
 *
 * ## Group scope — the donor's known limitation, kept
 *
 * Numbering happens **within a (building, discipline, system) group**. A
 * structural parent outside the asset's own group is not a parent here: the
 * asset roots inside its group and is numbered there. So a feed chain that
 * crosses systems does not produce one continuous sequence across them, and
 * this function does not order systems relative to each other at all. That is
 * deliberate, not an oversight — cross-system ordering is the predecessor
 * matrix's job (`predecessors.ts`), and under DECISIONS.md #1 a cross-boundary
 * feed is a dependency rather than a nesting anyway, so the structural tree the
 * snapshot hands over never crosses a group boundary in the first place.
 */

import type { ResolvedSnapshot } from '@matchline/domain';

import { clean, naturalCompare } from './text.js';

/** Which end of the structural chain is commissioned first. */
export type SequencePolarity = 'top-down' | 'bottom-up';

/** What sequencing needs to know about one asset. */
export interface SequenceAsset {
  readonly assetId: string;
  /** Used for the tie-break ordering between siblings. */
  readonly canonicalTag: string;
  /** The SSM discipline, whose polarity sets the walk direction. */
  readonly discipline: string;
  readonly building?: string;
  readonly systemKey?: string;
}

/** The (building, discipline, system) block a sequence number counts within. */
export interface SequenceGroupKey {
  readonly building: string;
  readonly discipline: string;
  readonly systemKey: string;
}

/** One asset's place in the commissioning order. */
export interface AssetSequence {
  readonly assetId: string;
  /** 1-based, and restarts in every group. */
  readonly sequence: number;
  readonly group: SequenceGroupKey;
  readonly polarity: SequencePolarity;
}

/** One numbered block. */
export interface SequenceGroup {
  readonly key: SequenceGroupKey;
  readonly polarity: SequencePolarity;
  /** Asset ids in sequence order. */
  readonly assetIds: ReadonlyArray<string>;
}

/** `{ discipline: polarity }`, overriding the default pattern. */
export type PolarityOverrides = Readonly<Record<string, SequencePolarity>>;

/** Options for {@link computeSequence}. */
export interface SequenceOptions {
  /** Per-discipline overrides (the donor's `hierarchy.polarity` map). */
  readonly polarity?: PolarityOverrides;
}

/** The result of {@link computeSequence}. */
export interface SequenceResult {
  /** One per numbered asset, ordered by group then sequence. */
  readonly sequences: ReadonlyArray<AssetSequence>;
  /** Groups in natural (building, discipline, system) order. */
  readonly groups: ReadonlyArray<SequenceGroup>;
  /**
   * Assets the walk never reached, in natural tag order.
   *
   * Only reachable when a group's parent links form a cycle — every member has
   * an in-group parent, so the group has no root to start from. The compiler
   * breaks structural cycles before a snapshot exists, so this is normally
   * empty; it is reported rather than silently dropped because an unnumbered
   * asset must not disappear from a commissioning register.
   */
  readonly unsequencedAssetIds: ReadonlyArray<string>;
}

/** The donor's default: these disciplines commission source-to-load. */
export const DEFAULT_TOP_DOWN_PATTERN = /elec|lss|security|fire/i;

/**
 * The polarity for one discipline.
 *
 * A configured value wins, looked up by the discipline as given and then by its
 * trimmed form; otherwise {@link DEFAULT_TOP_DOWN_PATTERN} decides, and anything
 * it does not match is bottom-up.
 */
export function disciplinePolarity(
  discipline: string,
  overrides: PolarityOverrides = {},
): SequencePolarity {
  const configured = overrides[discipline] ?? overrides[clean(discipline)];
  if (configured === 'top-down' || configured === 'bottom-up') return configured;
  return DEFAULT_TOP_DOWN_PATTERN.test(discipline) ? 'top-down' : 'bottom-up';
}

/** A group under construction. */
interface GroupBuild {
  readonly key: SequenceGroupKey;
  readonly members: SequenceAsset[];
}

/**
 * Number every supplied asset within its own (building, discipline, system)
 * group, in its discipline's polarity.
 *
 * The structural parent comes from the snapshot: a node whose parent decision is
 * `resolved` nests under that parent, and every other status — root,
 * provisional-root, unresolved, or no node at all — is a root of its group. An
 * asset the snapshot never mentions is still numbered, as a root, because a
 * register row without a sequence number is not a usable output.
 */
export function computeSequence(
  snapshot: ResolvedSnapshot,
  assets: ReadonlyArray<SequenceAsset>,
  options: SequenceOptions = {},
): SequenceResult {
  const groups = new Map<string, GroupBuild>();
  for (const asset of assets) {
    const key: SequenceGroupKey = {
      building: clean(asset.building),
      discipline: clean(asset.discipline),
      systemKey: clean(asset.systemKey),
    };
    const id = groupId(key);
    const existing = groups.get(id);
    if (existing === undefined) groups.set(id, { key, members: [asset] });
    else existing.members.push(asset);
  }

  const sequences: AssetSequence[] = [];
  const built: SequenceGroup[] = [];
  const unsequenced: SequenceAsset[] = [];

  for (const group of [...groups.values()].sort((left, right) =>
    compareGroupKeys(left.key, right.key),
  )) {
    const members = group.members;
    const byId = new Map(members.map((member) => [member.assetId, member]));
    const children = new Map<string, SequenceAsset[]>(
      members.map((member) => [member.assetId, []]),
    );
    const roots: SequenceAsset[] = [];
    for (const member of members) {
      const decision = snapshot.nodes.get(member.assetId)?.parent;
      const parentId =
        decision !== undefined && decision.status === 'resolved' ? decision.parentAssetId : null;
      /* A parent outside this group is not a parent here — the donor's
         group-scoped lookup, kept deliberately (see the file comment). */
      const parent = parentId === null ? undefined : byId.get(parentId);
      if (parent !== undefined && parent.assetId !== member.assetId) {
        children.get(parent.assetId)?.push(member);
      } else {
        roots.push(member);
      }
    }
    roots.sort(byTag);
    for (const list of children.values()) list.sort(byTag);

    const polarity = disciplinePolarity(group.key.discipline, options.polarity);
    const ordered: string[] = [];
    const visited = new Set<string>();
    let index = 0;
    const walk = (asset: SequenceAsset): void => {
      /* Cannot trigger on an acyclic tree; the guard is what keeps a malformed
         snapshot from recursing forever rather than reporting a cycle. */
      if (visited.has(asset.assetId)) return;
      visited.add(asset.assetId);
      const record = (): void => {
        index++;
        ordered.push(asset.assetId);
        sequences.push({
          assetId: asset.assetId,
          sequence: index,
          group: group.key,
          polarity,
        });
      };
      if (polarity === 'top-down') record();
      for (const child of children.get(asset.assetId) ?? []) walk(child);
      if (polarity !== 'top-down') record();
    };
    for (const root of roots) walk(root);

    for (const member of members) {
      if (!visited.has(member.assetId)) unsequenced.push(member);
    }
    built.push({ key: group.key, polarity, assetIds: ordered });
  }

  return {
    sequences,
    groups: built,
    unsequencedAssetIds: [...unsequenced].sort(byTag).map((asset) => asset.assetId),
  };
}

/** Sibling order: natural by tag, with the asset id as a total-order tie-break. */
function byTag(left: SequenceAsset, right: SequenceAsset): number {
  const byName = naturalCompare(left.canonicalTag, right.canonicalTag);
  return byName !== 0 ? byName : naturalCompare(left.assetId, right.assetId);
}

/** Group identity, for the bucketing map only. */
function groupId(key: SequenceGroupKey): string {
  return JSON.stringify([key.building, key.discipline, key.systemKey]);
}

/** Groups are emitted in natural building, then discipline, then system order. */
function compareGroupKeys(left: SequenceGroupKey, right: SequenceGroupKey): number {
  return (
    naturalCompare(left.building, right.building) ||
    naturalCompare(left.discipline, right.discipline) ||
    naturalCompare(left.systemKey, right.systemKey)
  );
}
