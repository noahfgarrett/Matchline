/**
 * The Site Profile: the site-specific half of the compiled rule set
 * (PRODUCT.md §13). Sections are added as execution stages land, so this shape
 * grows; it stays flat and explicit rather than generic, because a profile is
 * hand-editable JSON and a reader has to be able to see what a site actually
 * configured.
 *
 * Profiles never embed model files or spreadsheet rows -- only addresses of
 * them (PRODUCT.md §13.3).
 */
import type { TagAnatomyConfig } from './anatomy.js';
import type { SystemResolverConfig } from './resolver-config.js';

/**
 * Where a value lives in the extraction cache.
 *
 * Navisworks property names repeat across categories (`Item > Name` is not
 * `Revit Type > Name`), so a property is only addressable as the pair.
 */
export interface PropertyRef {
  readonly category: string;
  readonly name: string;
}

/**
 * Which extracted property plays which role for this site (PRODUCT.md §6.5).
 *
 * The last three are the register columns a site can *also* choose to state in
 * the model rather than leave to a learned table. Mapping one is how a site says
 * "the model already knows this" — and a mapped, non-blank value outranks any
 * learned assignment for that field, because a fact beats an inference. Leaving
 * one unmapped is not a gap; it hands the field to the learned tables, which is
 * where it was before this existed.
 */
export interface PropertyMappings {
  /** The only mapping with no default: without a tag there is no identity. */
  readonly equipmentTag: PropertyRef;
  readonly description?: PropertyRef;
  readonly equipmentType?: PropertyRef;
  readonly building?: PropertyRef;
  readonly nativeDiscipline?: PropertyRef;
  /** Registry "WBS", when the model states it. */
  readonly wbs?: PropertyRef;
  /** Registry "Item Master Unique Identifier", when the model states it. */
  readonly itemMaster?: PropertyRef;
  /** Registry "Equipment Classification", when the model states it. */
  readonly equipmentClassification?: PropertyRef;
}

/**
 * Which model objects become candidate assets (PRODUCT.md §6.6).
 *
 * Every filter is opt-in except the two booleans, which are decisions a site
 * must make rather than inherit: whether a missing tag disqualifies an object,
 * and whether a matched asset absorbs its descendants.
 */
export interface AssetFilterConfig {
  /** Navisworks class names kept. Empty/absent means "no class restriction". */
  readonly includedClasses?: ReadonlyArray<string>;
  /** Applied after `includedClasses`; an exclusion always wins. */
  readonly excludedClasses?: ReadonlyArray<string>;
  /** Whether `propertyMappings.equipmentTag` must be present and non-blank. */
  readonly requireTagProperty: boolean;
  /** Tag shapes the site accepts. Interpreted by the asset catalog, not here. */
  readonly acceptedTagPatterns?: ReadonlyArray<string>;
  /** Selection/search sets whose members are equipment. */
  readonly selectionSetNames?: ReadonlyArray<string>;
  /** Source model file names to read; absent means every source model. */
  readonly includedSourceModelFiles?: ReadonlyArray<string>;
  /** When true, a matched asset absorbs descendants that do not match on their own. */
  readonly collapseComponents: boolean;
  /** Classes that stay their own asset even under `collapseComponents`. */
  readonly separatelyCommissionableClasses?: ReadonlyArray<string>;
}

/** One site's published rule set. Versioned; see PRODUCT.md §13.3. */
export interface SiteProfile {
  readonly profileId: string;
  readonly name: string;
  /** Monotonic. A profile is republished, never edited in place. */
  readonly version: number;
  readonly propertyMappings: PropertyMappings;
  readonly assetFilters: AssetFilterConfig;
  readonly tagAnatomy?: TagAnatomyConfig;
  readonly systemResolver?: SystemResolverConfig;
}
