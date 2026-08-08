/**
 * Identity reconciliation configuration and index shapes (PRODUCT.md §9).
 *
 * The index is built once per compile and reused for every foreign tag: the
 * connectivity importer, the MEL comparison and the PMD reader all ask the same
 * question against the same model-first universe, and they must get the same
 * answer.
 */
import type {
  IdentityOutcome,
  IdentityTier,
  NormalizationStep,
  ReviewItem,
  TagAnatomyConfig,
} from '@matchline/domain';

/** One canonical asset, reduced to the two fields identity actually needs. */
export interface IdentityAsset {
  readonly assetId: string;
  readonly canonicalTag: string;
}

/**
 * What the site taught about reconciling foreign spellings.
 *
 * Everything here is opt-in. An empty config still resolves exact tags, which
 * is the only tier that needs no site knowledge at all.
 */
export interface IdentityConfig {
  /**
   * Applied to the evidence tag and the canonical tag alike, in order. The
   * symmetry is the point: normalization decides what counts as the same
   * spelling, so applying it to one side only would let the ladder match tags
   * a site never said were equivalent.
   */
  readonly tagNormalization?: ReadonlyArray<NormalizationStep>;
  /**
   * Evidence tag -> canonical tag, stated by the site. Matched case-sensitively
   * and exactly: an alias is a fact a person entered, not a pattern.
   */
  readonly aliases?: ReadonlyMap<string, string>;
  /** Enables the anatomy tier. Absent means the tier never runs. */
  readonly anatomy?: TagAnatomyConfig;
  /** Defaults to every tier. Listing fewer narrows the ladder; order is fixed. */
  readonly enabledTiers?: ReadonlyArray<IdentityTier>;
  /** Maximum Levenshtein distance for a proposal. Defaults to 2. */
  readonly fuzzyMaxDistance?: number;
}

/** A canonical tag that another canonical tag extends at a separator boundary. */
export interface BoundaryPrefixEntry {
  readonly entry: IdentityAsset;
  /** The separator immediately after the prefix. */
  readonly separator: string;
}

/**
 * The reusable lookup structure.
 *
 * Every map's values keep the order the assets were supplied in, so a
 * duplicated tag always presents its assets the same way twice.
 */
export interface IdentityIndex {
  /**
   * Tag-bearing assets in supplied order. Assets with an empty canonical tag
   * are dropped: they have no identity for a foreign spelling to match.
   */
  readonly assets: ReadonlyArray<IdentityAsset>;
  readonly config: IdentityConfig;
  readonly enabledTiers: ReadonlySet<IdentityTier>;
  readonly fuzzyMaxDistance: number;
  /** Boundary characters for the suffix tier; the anatomy's, or the default set. */
  readonly separators: ReadonlyArray<string>;
  readonly byExactTag: ReadonlyMap<string, ReadonlyArray<IdentityAsset>>;
  readonly byNormalizedTag: ReadonlyMap<string, ReadonlyArray<IdentityAsset>>;
  /** Empty when the anatomy is absent or states nothing that could identify. */
  readonly byAnatomyKey: ReadonlyMap<string, ReadonlyArray<IdentityAsset>>;
  /** Every proper boundary prefix of every canonical tag. */
  readonly byBoundaryPrefix: ReadonlyMap<string, ReadonlyArray<BoundaryPrefixEntry>>;
}

/** A batch resolution: one outcome per input tag, plus what needs a person. */
export interface ResolveTagsResult {
  /** In input order, one per supplied tag. */
  readonly outcomes: ReadonlyArray<IdentityOutcome>;
  /** In first-occurrence order, one per (kind, tag) pair. */
  readonly reviewItems: ReadonlyArray<ReviewItem>;
}
