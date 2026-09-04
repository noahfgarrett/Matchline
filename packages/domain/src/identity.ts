/**
 * Identity reconciliation results (PRODUCT.md §9).
 *
 * Types only; the matcher lives in `@matchline/identity`. The model owns the
 * asset universe, so reconciliation only ever answers one question: which
 * existing asset, if any, is this foreign spelling talking about. It never
 * creates an asset, and it never merges on a guess.
 */

/**
 * How a foreign tag was tied to a canonical one, weakest evidence last.
 *
 * The order is the ladder from §9.2 and it is load-bearing: the matcher walks
 * it in order and the first tier that produces an unambiguous hit wins, so a
 * tag reachable at two tiers is always reported at the stronger one.
 */
export type IdentityTier =
  | 'exact'
  | 'normalized'
  | 'alias'
  | 'anatomy'
  | 'suffix-unambiguous'
  | 'fuzzy-proposal';

/** Every `IdentityTier` in ladder order, for callers that walk it at runtime. */
export const IDENTITY_TIER_ORDER = [
  'exact',
  'normalized',
  'alias',
  'anatomy',
  'suffix-unambiguous',
  'fuzzy-proposal',
] as const satisfies ReadonlyArray<IdentityTier>;

/**
 * Compile-time completeness guard. Adding a member to `IdentityTier` without
 * adding it to `IDENTITY_TIER_ORDER` resolves this to `false` and the
 * assignment below stops compiling.
 */
type EveryIdentityTierListed =
  Exclude<IdentityTier, (typeof IDENTITY_TIER_ORDER)[number]> extends never ? true : false;

const IDENTITY_TIERS_ARE_COMPLETE: EveryIdentityTierListed = true;
void IDENTITY_TIERS_ARE_COMPLETE;

/**
 * A near-miss the engine refuses to act on.
 *
 * `tier` is fixed to `fuzzy-proposal` because a proposal is the only thing
 * edit distance is ever allowed to produce: "Fuzzy identity should never
 * auto-merge without review" (§9.2).
 */
export interface IdentityCandidate {
  readonly assetId: string;
  readonly tier: 'fuzzy-proposal';
  /** Levenshtein distance between the evidence tag and the canonical tag. */
  readonly distance: number;
}

/** A foreign tag tied to one canonical asset, with the tier that did it. */
export interface IdentityMatch {
  readonly status: 'matched';
  /** The spelling as the foreign source wrote it. */
  readonly evidenceTag: string;
  readonly assetId: string;
  readonly tier: IdentityTier;
  /** Names the evidence the tier used, in words a reviewer can check. */
  readonly detail: string;
  /**
   * How many assets carry the canonical tag this matched, `1` for a normal one.
   *
   * A tag on two assets still resolves -- to the first assetId in code-unit
   * order -- because multiplying every downstream fact by the number of copies
   * would be worse. But "resolved, and it named two assets" is a different
   * answer from "resolved", and a caller about to write a STRUCTURAL fact off
   * the back of it has to be able to tell: the compiler's claims bridge refuses
   * a parent named by a duplicated tag rather than picking one of them.
   */
  readonly sharingAssets: number;
}

/**
 * A foreign tag no tier could tie down.
 *
 * `candidates` are proposals only -- never a decision, and empty whenever
 * nothing came within the configured edit distance.
 */
export interface IdentityMiss {
  readonly status: 'unmatched';
  readonly evidenceTag: string;
  readonly candidates: ReadonlyArray<IdentityCandidate>;
}

/** Discriminated on `status`: matched carries an asset, unmatched carries proposals. */
export type IdentityOutcome = IdentityMatch | IdentityMiss;
