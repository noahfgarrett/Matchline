/**
 * The model-side asset record and the inclusion-impact report.
 *
 * A `ModelAsset` is what one extraction cache plus one Site Profile says about
 * one physical thing -- nothing more. It is deliberately NOT a
 * `CanonicalAsset` (domain `asset.ts`): the canonical record is assembled
 * later, once spreadsheets, identity reconciliation and the System Resolver
 * have had their say. Widening the domain type here would let a model-only
 * reading masquerade as a reconciled answer.
 */
import type { PropertyRef, Provenance, SourceStatus } from '@matchline/domain';

/**
 * Which statuses a model-first pass can produce.
 *
 * Derived from the domain union rather than restated, so a rename in
 * `SourceStatus` stops this file compiling instead of drifting from it.
 * `MODEL_ONLY` is not here: whether an asset is model-*only* cannot be known
 * until other sources are read (PRODUCT.md §9.3).
 */
export type ModelAssetStatus = Extract<
  SourceStatus,
  'MODEL_CONFIRMED' | 'DUPLICATE_MODEL_TAG'
>;

/**
 * The audit record for one field of one asset.
 *
 * It IS a domain `Provenance` -- usable anywhere provenance is expected -- and
 * additionally carries the cache address in structured form, because
 * `propertyOrColumn` is a display string and a later stage needs the
 * `(category, name)` pair back without parsing it.
 */
export interface AssetFieldProvenance extends Provenance {
  /** The cache property this value was read from. */
  readonly property: PropertyRef;
  /** Which of the asset's `objectIds` supplied it. */
  readonly objectId: number;
}

/**
 * Per-field provenance for an asset. A key is present exactly when the
 * corresponding field on the asset is populated.
 *
 * `canonicalTag` is optional for one reason only: with
 * `requireTagProperty: false` an untagged object can still become an asset,
 * and inventing a tag provenance for a tag that does not exist would be a lie.
 */
export interface ModelAssetProvenance {
  readonly canonicalTag?: AssetFieldProvenance;
  readonly description?: AssetFieldProvenance;
  readonly equipmentType?: AssetFieldProvenance;
  readonly building?: AssetFieldProvenance;
  readonly nativeDiscipline?: AssetFieldProvenance;
}

/** One asset as the model alone describes it. */
export interface ModelAsset {
  /**
   * Deterministic and content-derived, so the same cache rebuilds the same
   * ids: `tag:<canonicalTag>` when the tag is unique, `tag:<canonicalTag>#<objectId>`
   * when it is duplicated, and `object:<objectId>` for an untagged asset.
   */
  readonly assetId: string;
  /** The tag as the model spells it, trimmed. `''` when the asset is untagged. */
  readonly canonicalTag: string;
  readonly description?: string;
  readonly equipmentType?: string;
  readonly building?: string;
  readonly nativeDiscipline?: string;
  readonly status: ModelAssetStatus;
  /**
   * The representative object first, then every component collapsed into it in
   * ascending cache-ordinal order. Never empty.
   */
  readonly objectIds: ReadonlyArray<number>;
  /** Source model of the representative object; `null` when the cache has none. */
  readonly sourceModelId: number | null;
  readonly provenance: ModelAssetProvenance;
}

/**
 * The candidate filters, in the order `buildAssetCatalog` applies them
 * (PRODUCT.md §6.6). The order is part of the contract: a class exclusion is
 * reported before a tag requirement, so the wizard's impact numbers explain
 * *why* an object left, not merely that it did.
 */
export const FILTER_STAGES = [
  'source-model-files',
  'classes',
  'selection-sets',
  'tag-presence',
  'tag-patterns',
] as const;

export type FilterStageName = (typeof FILTER_STAGES)[number];

/** What one filter stage did. `inCount - droppedCount` objects went on. */
export interface FilterStageImpact {
  readonly stage: FilterStageName;
  /** Objects entering the stage. */
  readonly inCount: number;
  /** Objects this stage removed. Zero when the stage is not configured. */
  readonly droppedCount: number;
}

/**
 * The inclusion impact the setup wizard must show before a profile is saved
 * (PRODUCT.md §6.6). Every number is derived from one pass over one cache, so
 * the same inputs always produce the same report.
 */
export interface InclusionImpact {
  /** Objects in the cache, filters or no filters. */
  readonly totalObjects: number;
  /** One entry per stage in `FILTER_STAGES` order, always all of them. */
  readonly candidatesAfterEachFilter: ReadonlyArray<FilterStageImpact>;
  /** Candidates absorbed into an ancestor candidate by component collapse. */
  readonly collapsedCount: number;
  readonly finalAssetCount: number;
  /** Distinct tags carried by more than one asset; one review item each. */
  readonly duplicateTagCount: number;
  /** Objects dropped by `requireTagProperty`. Also counted in the stage list. */
  readonly untaggedDroppedCount: number;
}
