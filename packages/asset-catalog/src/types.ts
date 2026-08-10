/**
 * The model-side asset record and the inclusion-impact report.
 *
 * A `ModelAsset` is what one model universe plus one Site Profile says about
 * one physical thing -- nothing more. It is deliberately NOT a
 * `CanonicalAsset` (domain `asset.ts`): the canonical record is assembled
 * later, once spreadsheets, identity reconciliation and the System Resolver
 * have had their say. Widening the domain type here would let a model-only
 * reading masquerade as a reconciled answer.
 */
import type {
  ModelObjectKey,
  PropertyRef,
  Provenance,
  SourceStatus,
} from '@matchline/domain';

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

/** What every field provenance carries, whichever kind of evidence it is. */
interface AssetProvenanceBase extends Provenance {
  /**
   * Which of the asset's objects the record is about. For a model property,
   * the object that supplied the value; for a source assignment, the
   * representative object, so a reviewer still has something to select.
   */
  readonly objectId: number;
}

/**
 * A value read out of the model.
 *
 * It IS a domain `Provenance` -- usable anywhere provenance is expected -- and
 * additionally carries the cache address in structured form, because
 * `propertyOrColumn` is a display string and a later stage needs the
 * `(category, name)` pair back without parsing it.
 */
export interface ModelPropertyProvenance extends AssetProvenanceBase {
  readonly origin: 'model-property';
  /** The cache property this value was read from. */
  readonly property: PropertyRef;
}

/**
 * A value the project asserted about the whole source (P0-8).
 *
 * There is no property to name, which is the point: an assignment is what the
 * site says when the model does not say it. An explicit object property always
 * wins, so this record can only ever appear on a field the model left empty.
 */
export interface SourceAssignmentProvenance extends AssetProvenanceBase {
  readonly origin: 'source-assignment';
}

/**
 * The audit record for one field of one asset.
 *
 * Discriminated on `origin` rather than left as one shape with an optional
 * property: "read from Dragon Data > Building" and "assigned to this whole
 * source" are different claims about where a value came from, and a reader
 * should not have to infer which by testing a field for `undefined`.
 */
export type AssetFieldProvenance = ModelPropertyProvenance | SourceAssignmentProvenance;

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
  readonly wbs?: AssetFieldProvenance;
  readonly itemMaster?: AssetFieldProvenance;
  readonly equipmentClassification?: AssetFieldProvenance;
}

/** One asset as the model universe alone describes it. */
export interface ModelAsset {
  /**
   * Deterministic and content-derived, so the same universe rebuilds the same
   * ids: `tag:<tag>` when the tag is unique across the whole universe,
   * `tag:<tag>#<sourceId>/<objectId>` when it is duplicated, and
   * `object:<sourceId>/<objectId>` for an untagged asset.
   *
   * A unique tag's id names no source on purpose: identity is site-wide, so
   * moving a piece of equipment from one file to another must not rename it.
   * Only a tag that stopped identifying one thing needs the object that carries
   * it, and that object is only addressable together with its source.
   *
   * `<tag>` is the canonical tag with `%` escaped to `%25` and `#` to `%23`, in
   * that order; the source id is escaped the same way by
   * `modelObjectKeyToString`. `#` is the duplicate separator, so a site that
   * writes one in a tag would otherwise be able to spell another asset's id
   * exactly. Both escapes are injective, so two distinct inputs always produce
   * two distinct ids.
   */
  readonly assetId: string;
  /** The tag as the model spells it, trimmed. `''` when the asset is untagged. */
  readonly canonicalTag: string;
  readonly description?: string;
  readonly equipmentType?: string;
  readonly building?: string;
  readonly nativeDiscipline?: string;
  /**
   * The three register fields a site may state in the model rather than leave to
   * a learned table (`PropertyMappings`). Present exactly when the profile
   * mapped the property *and* the model had a value for it — so present means
   * "the model says so", and a learned table is never consulted for a field the
   * model already answered.
   */
  readonly wbs?: string;
  readonly itemMaster?: string;
  readonly equipmentClassification?: string;
  readonly status: ModelAssetStatus;
  /**
   * The representative object first, then every component collapsed into it in
   * ascending cache-ordinal order. Never empty, and every key names the same
   * source: collapse is confined to one cache, because ancestry is.
   */
  readonly objectKeys: ReadonlyArray<ModelObjectKey>;
  /**
   * The object ordinals of {@link objectKeys}, in the same order.
   *
   * @deprecated An ordinal is only meaningful inside one source, so this is
   * ambiguous the moment a project registers a second one. Read `objectKeys`.
   * Kept for the round that migrates the compiler; removed in this milestone.
   */
  readonly objectIds: ReadonlyArray<number>;
  /**
   * The tags carried by the components collapsed into this asset, in
   * `objectKeys` order. Empty when nothing tagged was absorbed.
   *
   * Those tags no longer name assets, so evidence spelled with one of them will
   * attach here. Recording them keeps that traceable; each one also raises an
   * `absorbed-tagged-component` review item.
   */
  readonly absorbedTags: ReadonlyArray<string>;
  /** The model source this asset was read from. Every object key shares it. */
  readonly sourceId: string;
  /** Source model of the representative object; `null` when the cache has none. */
  readonly sourceModelId: number | null;
  /**
   * The site-defined attributes its source assigns, by attribute key
   * (`SourceAssignments.custom`), key order ascending.
   *
   * Empty when the source assigns none. Standard fields do not appear here --
   * an assigned `building` is a `building`, recorded with source-assignment
   * provenance, because a consumer should not have to look in two places for
   * one field.
   */
  readonly assignedAttributes: ReadonlyMap<string, string>;
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
 * What the filters did to one source.
 *
 * No duplicate count: a duplicated tag is a fact about the universe, not about
 * a source, and a per-source number would read as "this file has duplicates"
 * when the other claimant is in another file entirely.
 */
export interface SourceInclusionImpact {
  readonly sourceId: string;
  /** Objects in this source's cache, filters or no filters. */
  readonly totalObjects: number;
  /** One entry per stage in `FILTER_STAGES` order, always all of them. */
  readonly candidatesAfterEachFilter: ReadonlyArray<FilterStageImpact>;
  readonly collapsedCount: number;
  readonly finalAssetCount: number;
  readonly untaggedDroppedCount: number;
}

/**
 * The inclusion impact the setup wizard must show before a profile is saved
 * (PRODUCT.md §6.6). Every number is derived from one pass over each cache, so
 * the same inputs always produce the same report.
 *
 * The top-level numbers are universe totals; `bySource` breaks the same pass
 * down per source, because "42 objects left" is not actionable until a person
 * knows which file they left.
 */
export interface InclusionImpact {
  /** Objects across every source, filters or no filters. */
  readonly totalObjects: number;
  /** One entry per stage in `FILTER_STAGES` order, summed across sources. */
  readonly candidatesAfterEachFilter: ReadonlyArray<FilterStageImpact>;
  /** Candidates absorbed into an ancestor candidate by component collapse. */
  readonly collapsedCount: number;
  readonly finalAssetCount: number;
  /** Distinct tags carried by more than one asset anywhere; one review item each. */
  readonly duplicateTagCount: number;
  /** Objects dropped by `requireTagProperty`. Also counted in the stage list. */
  readonly untaggedDroppedCount: number;
  /** Keyed by source id ascending, one entry per source that was read. */
  readonly bySource: ReadonlyMap<string, SourceInclusionImpact>;
}
