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
 * An ordered fallback chain of addresses for ONE field (P0-8, hard gate 5).
 *
 * The rungs are tried in order and the first one that states a non-blank value
 * wins; the rest are not consulted. A chain is not a merge and not a vote: a
 * site that spells its building in `Dragon Data > Building` on the mechanical
 * model and in `Element > Level` on the architectural one is stating a
 * preference, and the order IS the statement.
 *
 * An empty chain is legal and means "this site did not map the field" -- the
 * same thing an absent mapping meant before chains existed.
 */
export type PropertyChain = ReadonlyArray<PropertyRef>;

/**
 * One source's replacement for a field's chain, as a profile spells it (P0-8).
 *
 * A list of pairs rather than a record, so a hand-edited profile round-trips in
 * the order its author wrote and two sources cannot collide onto one JSON key.
 * The engine reads it as a map -- see {@link MappedProperty}.
 */
export interface SourcePropertyChain {
  /** The project's `sourceId`. Never a file name (P0-1). */
  readonly sourceId: string;
  readonly chain: PropertyChain;
}

/**
 * One mapped field, as the engine reads it (P0-8).
 *
 * `chain` is what every source uses unless it names its own. `bySource` REPLACES
 * the chain for the sources it names rather than extending it: "on this file the
 * building is somewhere else" is the statement, and appending the global chain
 * behind it would silently re-introduce the address the site just overrode.
 */
export interface MappedProperty {
  readonly chain: PropertyChain;
  /** `sourceId` -> the chain that source uses instead of {@link chain}. */
  readonly bySource?: ReadonlyMap<string, PropertyChain>;
}

/** A mapped field written as a chain, in either spelling of `bySource`. */
export interface MappedPropertyChainInput {
  readonly chain: PropertyChain;
  readonly bySource?: ReadonlyMap<string, PropertyChain> | ReadonlyArray<SourcePropertyChain>;
}

/**
 * A mapped field however it was written.
 *
 * A bare {@link PropertyRef} is how every profile before P0-8 spelled a mapping,
 * and {@link migrateMappedProperty} lifts it to a one-rung chain. Nothing inside
 * the engine sees this type: entry points migrate on the way in, exactly as
 * `HierarchyConfigInput` does for levels.
 */
export type MappedPropertyInput = PropertyRef | MappedPropertyChainInput;

/**
 * Which extracted property plays which role for this site (PRODUCT.md §6.5).
 *
 * Every field is an ordered fallback chain with optional per-source overrides
 * since P0-8; see {@link MappedProperty}. The last three are the register columns
 * a site can *also* choose to state in the model rather than leave to a learned
 * table. Mapping one is how a site says "the model already knows this" — and a
 * mapped, non-blank value outranks any learned assignment for that field,
 * because a fact beats an inference. Leaving one unmapped is not a gap; it hands
 * the field to the learned tables, which is where it was before this existed.
 */
export interface PropertyMappings {
  /** The only mapping with no default: without a tag there is no identity. */
  readonly equipmentTag: MappedProperty;
  readonly description?: MappedProperty;
  readonly equipmentType?: MappedProperty;
  readonly building?: MappedProperty;
  readonly nativeDiscipline?: MappedProperty;
  /** Registry "WBS", when the model states it. */
  readonly wbs?: MappedProperty;
  /** Registry "Item Master Unique Identifier", when the model states it. */
  readonly itemMaster?: MappedProperty;
  /** Registry "Equipment Classification", when the model states it. */
  readonly equipmentClassification?: MappedProperty;
}

/** {@link PropertyMappings} in any spelling a stored profile may carry. */
export interface PropertyMappingsInput {
  readonly equipmentTag: MappedPropertyInput;
  readonly description?: MappedPropertyInput;
  readonly equipmentType?: MappedPropertyInput;
  readonly building?: MappedPropertyInput;
  readonly nativeDiscipline?: MappedPropertyInput;
  readonly wbs?: MappedPropertyInput;
  readonly itemMaster?: MappedPropertyInput;
  readonly equipmentClassification?: MappedPropertyInput;
}

/** Every mapped role, for callers that walk them in a fixed order. */
export const MAPPED_PROPERTY_FIELDS = [
  'equipmentTag',
  'description',
  'equipmentType',
  'building',
  'nativeDiscipline',
  'wbs',
  'itemMaster',
  'equipmentClassification',
] as const;

/** One of {@link MAPPED_PROPERTY_FIELDS}. */
export type MappedPropertyField = (typeof MAPPED_PROPERTY_FIELDS)[number];

/**
 * Compile-time completeness guard. Adding a field to `PropertyMappings` without
 * listing it above resolves this to `false` and the assignment stops compiling.
 */
type EveryMappedFieldListed =
  Exclude<keyof PropertyMappings, MappedPropertyField> extends never ? true : false;

const MAPPED_FIELDS_ARE_COMPLETE: EveryMappedFieldListed = true;
void MAPPED_FIELDS_ARE_COMPLETE;

/** Whether a mapping was written as a chain rather than as one property. */
function isChainInput(value: MappedPropertyInput): value is MappedPropertyChainInput {
  return 'chain' in value;
}

/**
 * One mapped field in the current shape, whichever way it was written.
 *
 * A bare `PropertyRef` becomes a one-rung chain with no per-source override,
 * which is exactly what a pre-P0-8 profile meant: one address, every source.
 * Idempotent -- a mapping already in the current shape is returned with its
 * `bySource` normalized to a map and nothing else changed.
 */
export function migrateMappedProperty(input: MappedPropertyInput): MappedProperty {
  if (!isChainInput(input)) {
    return { chain: [input] };
  }
  const bySource = input.bySource;
  if (bySource === undefined) {
    return { chain: input.chain };
  }
  const map =
    bySource instanceof Map
      ? (bySource as ReadonlyMap<string, PropertyChain>)
      : new Map(
          (bySource as ReadonlyArray<SourcePropertyChain>).map((override) => [
            override.sourceId,
            override.chain,
          ]),
        );
  return { chain: input.chain, bySource: map };
}

/**
 * {@link migrateMappedProperty} over a whole mapping set.
 *
 * Walked from {@link MAPPED_PROPERTY_FIELDS} rather than field by field, so a
 * mapping added to `PropertyMappings` cannot be forgotten here and silently
 * dropped on the way into the engine. `equipmentTag` is then restated because
 * it is the one field with no default, and the type says so.
 */
export function migratePropertyMappings(input: PropertyMappingsInput): PropertyMappings {
  const mappings: { -readonly [Field in MappedPropertyField]?: MappedProperty } = {};
  for (const field of MAPPED_PROPERTY_FIELDS) {
    const mapping = input[field];
    if (mapping !== undefined) {
      mappings[field] = migrateMappedProperty(mapping);
    }
  }
  return { ...mappings, equipmentTag: migrateMappedProperty(input.equipmentTag) };
}

/**
 * The chain one source reads a field through.
 *
 * The source's own override when it has one, the global chain otherwise. This
 * is the only place the precedence between the two is decided, so a second
 * reading of it cannot drift from the first.
 */
export function chainFor(mapped: MappedProperty, sourceId: string): PropertyChain {
  return mapped.bySource?.get(sourceId) ?? mapped.chain;
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
  /**
   * The mappings in either spelling (P0-8).
   *
   * A profile is hand-editable JSON and a stored one may predate chains, so the
   * INPUT type is what a profile carries; every entry point runs
   * {@link migratePropertyMappings} on the way in and the engine only ever sees
   * chains. The same arrangement `HierarchyConfigInput` has for levels.
   */
  readonly propertyMappings: PropertyMappingsInput;
  readonly assetFilters: AssetFilterConfig;
  readonly tagAnatomy?: TagAnatomyConfig;
  readonly systemResolver?: SystemResolverConfig;
}
