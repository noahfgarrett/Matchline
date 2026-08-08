/**
 * The matching ladder (PRODUCT.md §9.2).
 *
 * Tiers run in `IDENTITY_TIER_ORDER` and the first unambiguous hit wins, so a
 * tag reachable at two tiers is always reported at the stronger one. Two rules
 * shape everything else here:
 *
 * 1. Ambiguity is terminal. A tier that finds several distinct canonical tags
 *    stops the ladder and raises a review item. Falling through to a looser
 *    tier after refusing to decide at a stronger one would produce exactly the
 *    guess the refusal was protecting against.
 * 2. Fuzzy never matches. It only ever ranks proposals for a person
 *    ("Fuzzy identity should never auto-merge without review").
 */
import {
  assertNever,
  IDENTITY_TIER_ORDER,
  type AmbiguousSuffixReviewItem,
  type FuzzyIdentityReviewItem,
  type IdentityCandidate,
  type IdentityOutcome,
  type IdentityTier,
  type ReviewItem,
} from '@matchline/domain';

import { anatomyIdentityKey, describeAnatomyKey } from './anatomy-key.js';
import { boundaryCuts } from './boundary.js';
import { boundedDistance } from './distance.js';
import { normalizeTag } from './normalize.js';
import type { IdentityAsset, IdentityIndex, ResolveTagsResult } from './types.js';

/** How many proposals a reviewer is shown. Past three it is noise, not help. */
export const FUZZY_CANDIDATE_LIMIT = 3;

/** Every tier that can actually produce a match. */
type MatchingTier = Exclude<IdentityTier, 'fuzzy-proposal'>;

/** UTF-16 code-unit order, so ordering never depends on a locale. */
function compareText(left: string, right: string): number {
  if (left < right) {
    return -1;
  }
  return left > right ? 1 : 0;
}

type TierResult =
  | { readonly kind: 'miss' }
  | { readonly kind: 'match'; readonly assetId: string; readonly detail: string }
  | { readonly kind: 'ambiguous'; readonly candidateAssetIds: ReadonlyArray<string> };

type CandidateChoice =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'one';
      readonly assetId: string;
      readonly canonicalTag: string;
      /** How many assets share that one canonical tag. Above 1 is a duplicate. */
      readonly sharingAssets: number;
    }
  | { readonly kind: 'ambiguous'; readonly candidateAssetIds: ReadonlyArray<string> };

/**
 * Turns a tier's candidate set into a decision.
 *
 * Several assets carrying *different* canonical tags is a genuine ambiguity and
 * nothing is chosen. Several assets carrying the *same* canonical tag is a
 * duplicate model tag: the duplicate is already a review item raised upstream
 * by the asset catalog, so resolving here to the first assetId by code-unit
 * order records one answer instead of multiplying every downstream fact by the
 * number of copies.
 */
function chooseCandidate(entries: ReadonlyArray<IdentityAsset>): CandidateChoice {
  const unique = new Map<string, IdentityAsset>();
  for (const entry of entries) {
    if (!unique.has(entry.assetId)) {
      unique.set(entry.assetId, entry);
    }
  }
  const candidates = [...unique.values()];
  if (candidates.length === 0) {
    return { kind: 'none' };
  }

  const tags = new Set(candidates.map((candidate) => candidate.canonicalTag));
  if (tags.size > 1) {
    return {
      kind: 'ambiguous',
      candidateAssetIds: candidates
        .map((candidate) => candidate.assetId)
        .sort((left, right) => compareText(left, right)),
    };
  }

  const [first] = [...candidates].sort((left, right) => compareText(left.assetId, right.assetId));
  if (first === undefined) {
    return { kind: 'none' };
  }
  return {
    kind: 'one',
    assetId: first.assetId,
    canonicalTag: first.canonicalTag,
    sharingAssets: candidates.length,
  };
}

function withDuplicateNote(detail: string, sharingAssets: number): string {
  if (sharingAssets <= 1) {
    return detail;
  }
  return `${detail}; that tag is on ${sharingAssets} assets, first assetId by code-unit order chosen`;
}

/** Collapses a choice into a tier result using the caller's phrasing. */
function decide(choice: CandidateChoice, describe: (choice: CandidateChoice) => string): TierResult {
  switch (choice.kind) {
    case 'none':
      return { kind: 'miss' };
    case 'ambiguous':
      return { kind: 'ambiguous', candidateAssetIds: choice.candidateAssetIds };
    case 'one':
      return {
        kind: 'match',
        assetId: choice.assetId,
        detail: withDuplicateNote(describe(choice), choice.sharingAssets),
      };
    default:
      return assertNever(choice, 'unhandled CandidateChoice');
  }
}

function chosenTag(choice: CandidateChoice): string {
  return choice.kind === 'one' ? choice.canonicalTag : '';
}

function exactTier(index: IdentityIndex, evidenceTag: string): TierResult {
  const entries = index.byExactTag.get(evidenceTag) ?? [];
  return decide(
    chooseCandidate(entries),
    (choice) => `evidence tag equals canonical tag "${chosenTag(choice)}"`,
  );
}

function normalizedTier(index: IdentityIndex, evidenceTag: string): TierResult {
  const steps = index.config.tagNormalization ?? [];
  const key = normalizeTag(evidenceTag, steps);
  const entries = index.byNormalizedTag.get(key) ?? [];
  return decide(
    chooseCandidate(entries),
    (choice) =>
      `evidence tag and canonical tag "${chosenTag(choice)}" both normalize to "${key}"`,
  );
}

function aliasTier(index: IdentityIndex, evidenceTag: string): TierResult {
  const canonical = index.config.aliases?.get(evidenceTag);
  if (canonical === undefined) {
    return { kind: 'miss' };
  }
  const entries = index.byExactTag.get(canonical) ?? [];
  return decide(
    chooseCandidate(entries),
    () => `profile alias "${evidenceTag}" names canonical tag "${canonical}"`,
  );
}

function anatomyTier(index: IdentityIndex, evidenceTag: string): TierResult {
  const anatomy = index.config.anatomy;
  if (anatomy === undefined || index.byAnatomyKey.size === 0) {
    return { kind: 'miss' };
  }
  const key = anatomyIdentityKey(anatomy, evidenceTag);
  if (key === undefined) {
    return { kind: 'miss' };
  }
  // Identical raw tags are the exact tier's business, not this one.
  const entries = (index.byAnatomyKey.get(key) ?? []).filter(
    (entry) => entry.canonicalTag !== evidenceTag,
  );
  return decide(
    chooseCandidate(entries),
    (choice) =>
      `same tag anatomy as canonical tag "${chosenTag(choice)}" (${describeAnatomyKey(key)})`,
  );
}

/**
 * The donor's unambiguous-suffix rule, generalized model-first.
 *
 * A candidate is a canonical tag the evidence tag continues past a separator,
 * or one that continues the evidence tag the same way. Letter-suffixed siblings
 * are unrelated by construction: `MAH001-10-01-A` and `MAH001-10-01-B` both
 * extend a common stem but neither extends the other, and DECISIONS.md holds
 * that suffixed tags are distinct identities.
 */
function suffixTier(index: IdentityIndex, evidenceTag: string): TierResult {
  const found = new Map<string, { readonly entry: IdentityAsset; readonly detail: string }>();

  for (const cut of boundaryCuts(evidenceTag, index.separators)) {
    for (const entry of index.byExactTag.get(cut.prefix) ?? []) {
      if (found.has(entry.assetId)) {
        continue;
      }
      found.set(entry.assetId, {
        entry,
        detail: `evidence tag extends canonical tag "${entry.canonicalTag}" past "${cut.separator}"`,
      });
    }
  }

  for (const boundary of index.byBoundaryPrefix.get(evidenceTag) ?? []) {
    if (found.has(boundary.entry.assetId)) {
      continue;
    }
    found.set(boundary.entry.assetId, {
      entry: boundary.entry,
      detail: `canonical tag "${boundary.entry.canonicalTag}" extends the evidence tag past "${boundary.separator}"`,
    });
  }

  const choice = chooseCandidate([...found.values()].map((candidate) => candidate.entry));
  return decide(choice, (decided) =>
    decided.kind === 'one' ? (found.get(decided.assetId)?.detail ?? '') : '',
  );
}

function runTier(index: IdentityIndex, evidenceTag: string, tier: MatchingTier): TierResult {
  switch (tier) {
    case 'exact':
      return exactTier(index, evidenceTag);
    case 'normalized':
      return normalizedTier(index, evidenceTag);
    case 'alias':
      return aliasTier(index, evidenceTag);
    case 'anatomy':
      return anatomyTier(index, evidenceTag);
    case 'suffix-unambiguous':
      return suffixTier(index, evidenceTag);
    default:
      return assertNever(tier, 'unhandled IdentityTier');
  }
}

/**
 * Ranked near-misses: distance ascending, then canonical tag, then assetId.
 *
 * Capped, because the point is to give a reviewer something to accept or
 * reject, not to hand them the whole register sorted by regret.
 */
function fuzzyCandidates(index: IdentityIndex, evidenceTag: string): ReadonlyArray<IdentityCandidate> {
  const scored: Array<{ assetId: string; canonicalTag: string; distance: number }> = [];
  for (const entry of index.assets) {
    const distance = boundedDistance(evidenceTag, entry.canonicalTag, index.fuzzyMaxDistance);
    if (distance <= index.fuzzyMaxDistance) {
      scored.push({ assetId: entry.assetId, canonicalTag: entry.canonicalTag, distance });
    }
  }

  scored.sort((left, right) => {
    if (left.distance !== right.distance) {
      return left.distance - right.distance;
    }
    const byTag = compareText(left.canonicalTag, right.canonicalTag);
    return byTag !== 0 ? byTag : compareText(left.assetId, right.assetId);
  });

  return scored.slice(0, FUZZY_CANDIDATE_LIMIT).map((candidate) => ({
    assetId: candidate.assetId,
    tier: 'fuzzy-proposal' as const,
    distance: candidate.distance,
  }));
}

interface Resolution {
  readonly outcome: IdentityOutcome;
  readonly reviewItems: ReadonlyArray<FuzzyIdentityReviewItem | AmbiguousSuffixReviewItem>;
}

function unmatched(
  evidenceTag: string,
  candidates: ReadonlyArray<IdentityCandidate>,
): IdentityOutcome {
  return { status: 'unmatched', evidenceTag, candidates };
}

function resolveOne(index: IdentityIndex, evidenceTag: string): Resolution {
  // An empty spelling is a blank cell, not a tag. Nothing is near it and
  // nothing about it needs a person.
  if (evidenceTag.length === 0) {
    return { outcome: unmatched(evidenceTag, []), reviewItems: [] };
  }

  for (const tier of IDENTITY_TIER_ORDER) {
    if (!index.enabledTiers.has(tier)) {
      continue;
    }

    if (tier === 'fuzzy-proposal') {
      const candidates = fuzzyCandidates(index, evidenceTag);
      if (candidates.length === 0) {
        break;
      }
      return {
        outcome: unmatched(evidenceTag, candidates),
        reviewItems: [
          {
            kind: 'fuzzy-identity',
            evidenceTag,
            candidates: candidates.map((candidate) => ({
              assetId: candidate.assetId,
              distance: candidate.distance,
            })),
          },
        ],
      };
    }

    const result = runTier(index, evidenceTag, tier);
    if (result.kind === 'match') {
      return {
        outcome: {
          status: 'matched',
          evidenceTag,
          assetId: result.assetId,
          tier,
          detail: result.detail,
        },
        reviewItems: [],
      };
    }
    if (result.kind === 'ambiguous') {
      return {
        outcome: unmatched(evidenceTag, []),
        reviewItems: [
          {
            kind: 'ambiguous-suffix',
            evidenceTag,
            candidateAssetIds: result.candidateAssetIds,
          },
        ],
      };
    }
  }

  return { outcome: unmatched(evidenceTag, []), reviewItems: [] };
}

/**
 * Resolves one foreign spelling against the model-first universe.
 *
 * An ambiguity resolves to an unmatched outcome with no candidates; the review
 * item explaining which assets collided is produced by `resolveTags`, which is
 * where review output belongs.
 */
export function resolveTag(index: IdentityIndex, evidenceTag: string): IdentityOutcome {
  return resolveOne(index, evidenceTag).outcome;
}

/**
 * Resolves a batch, in order, collecting what a person has to settle.
 *
 * A tag repeated in the batch resolves the same way every time and raises its
 * review item once: the same ambiguity listed twice is the same decision, not
 * two of them.
 */
export function resolveTags(
  index: IdentityIndex,
  tags: ReadonlyArray<string>,
): ResolveTagsResult {
  const outcomes: IdentityOutcome[] = [];
  const reviewItems: ReviewItem[] = [];
  const fuzzySeen = new Set<string>();
  const ambiguousSeen = new Set<string>();

  for (const tag of tags) {
    const resolution = resolveOne(index, tag);
    outcomes.push(resolution.outcome);
    for (const item of resolution.reviewItems) {
      const seen = item.kind === 'fuzzy-identity' ? fuzzySeen : ambiguousSeen;
      if (seen.has(tag)) {
        continue;
      }
      seen.add(tag);
      reviewItems.push(item);
    }
  }

  return { outcomes, reviewItems };
}
