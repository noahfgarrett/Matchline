import type {
  AssetFilterConfig,
  NormalizationStep,
  PropertyMappings,
  PropertyRef,
  SegmentExtractor,
  SegmentName,
  SiteProfile,
  SystemComponentConfig,
  SystemResolverConfig,
  TagAnatomyConfig,
} from '@matchline/domain';

import type {
  WireAssetFilters,
  WireDraftPatch,
  WireDraftProfile,
  WirePropertyMappings,
  WireSystemResolver,
  WireTagAnatomy,
} from '../../shared/schemas.js';

/**
 * The wizard's draft Site Profile, and the one conversion between the wire
 * shape and `@matchline/domain`'s published shape.
 *
 * A draft is not a `SiteProfile`. It exists mid-decision: no tag property
 * picked, an anatomy with no segments taught, a resolver chain with no rungs.
 * The domain type cannot say any of that, so the draft says it — and every
 * "is this section actually configured?" question is answered here, once, by
 * the `has*` predicates, rather than re-guessed at each call site.
 *
 * Empty sections are dropped on the way out. A profile that carries
 * `tagAnatomy: { segments: {} }` would claim the site taught an anatomy that
 * matches nothing; absent is the truth.
 */

export class DraftIncompleteError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'DraftIncompleteError';
  }
}

/**
 * A brand-new draft.
 *
 * The two defaults that are decisions rather than blanks: `requireTagProperty`
 * starts on, because a commissioning register is built from tagged equipment,
 * and `collapseComponents` starts off, because absorbing components is a claim
 * about a site that no site has made yet. Both are visible toggles on screen 3.
 */
export function emptyDraft(name: string): WireDraftProfile {
  return {
    profileId: slugify(name),
    name,
    version: 1,
    propertyMappings: {
      equipmentTag: null,
      description: null,
      equipmentType: null,
      building: null,
      nativeDiscipline: null,
      wbs: null,
      itemMaster: null,
      equipmentClassification: null,
    },
    assetFilters: {
      includedClasses: [],
      excludedClasses: [],
      requireTagProperty: true,
      acceptedTagPatterns: [],
      selectionSetNames: [],
      includedSourceModelFiles: [],
      collapseComponents: false,
      separatelyCommissionableClasses: [],
    },
    tagAnatomy: {
      separators: ['-'],
      ignoredSuffixes: [],
      segments: [],
      familyKeyTemplate: '',
      localFamilyTemplate: '',
    },
    systemResolver: {
      keyChain: [],
      descriptionChain: [],
      normalization: [],
      conflictPolicy: 'review',
      labelTemplate: '',
    },
  };
}

/** `Dragon Building 14` -> `dragon-building-14`. Never empty. */
function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.length === 0 ? 'site' : slug;
}

/** Applies one screen's write. Sections the patch does not name are untouched. */
export function applyPatch(draft: WireDraftProfile, patch: WireDraftPatch): WireDraftProfile {
  return {
    profileId: patch.name === undefined ? draft.profileId : slugify(patch.name),
    name: patch.name ?? draft.name,
    version: draft.version,
    propertyMappings: patch.propertyMappings ?? draft.propertyMappings,
    assetFilters: patch.assetFilters ?? draft.assetFilters,
    tagAnatomy: patch.tagAnatomy ?? draft.tagAnatomy,
    systemResolver: patch.systemResolver ?? draft.systemResolver,
  };
}

/* --------------------------------------------------------------- predicates */

/** Screen 3 is answered: there is a property to read equipment tags from. */
export function hasMappings(draft: WireDraftProfile): boolean {
  return draft.propertyMappings.equipmentTag !== null;
}

/** Screen 4 is answered: at least one segment has been taught. */
export function hasAnatomy(draft: WireDraftProfile): boolean {
  return draft.tagAnatomy.segments.length > 0;
}

/** Screen 5 is answered: the key chain has at least one rung. */
export function hasResolver(draft: WireDraftProfile): boolean {
  return draft.systemResolver.keyChain.length > 0;
}

/* ------------------------------------------------------------ wire -> domain */

function toPropertyRef(ref: { readonly category: string; readonly name: string }): PropertyRef {
  return { category: ref.category, name: ref.name };
}

/**
 * @throws DraftIncompleteError when no equipment tag property has been chosen —
 * the one mapping with no default (PRODUCT.md §6.5).
 */
export function toPropertyMappings(wire: WirePropertyMappings): PropertyMappings {
  if (wire.equipmentTag === null) {
    throw new DraftIncompleteError(
      'Pick the property that holds the equipment tag before previewing assets.',
    );
  }

  // Built key by key rather than spread: under `exactOptionalPropertyTypes` an
  // explicit `description: undefined` is not the same as an absent key, and
  // `PropertyMappings` means absent.
  const mappings: {
    equipmentTag: PropertyRef;
    description?: PropertyRef;
    equipmentType?: PropertyRef;
    building?: PropertyRef;
    nativeDiscipline?: PropertyRef;
    wbs?: PropertyRef;
    itemMaster?: PropertyRef;
    equipmentClassification?: PropertyRef;
  } = { equipmentTag: toPropertyRef(wire.equipmentTag) };

  if (wire.description !== null) {
    mappings.description = toPropertyRef(wire.description);
  }
  if (wire.equipmentType !== null) {
    mappings.equipmentType = toPropertyRef(wire.equipmentType);
  }
  if (wire.building !== null) {
    mappings.building = toPropertyRef(wire.building);
  }
  if (wire.nativeDiscipline !== null) {
    mappings.nativeDiscipline = toPropertyRef(wire.nativeDiscipline);
  }
  // `?? null` rather than `!== null`: a draft written by an older build carries
  // no key for these three at all, and an absent key means the same thing a null
  // does — nobody has mapped it.
  const wbs = wire.wbs ?? null;
  if (wbs !== null) {
    mappings.wbs = toPropertyRef(wbs);
  }
  const itemMaster = wire.itemMaster ?? null;
  if (itemMaster !== null) {
    mappings.itemMaster = toPropertyRef(itemMaster);
  }
  const equipmentClassification = wire.equipmentClassification ?? null;
  if (equipmentClassification !== null) {
    mappings.equipmentClassification = toPropertyRef(equipmentClassification);
  }
  return mappings;
}

/** Empty lists become absent keys: "no restriction", not "restrict to nothing". */
export function toAssetFilters(wire: WireAssetFilters): AssetFilterConfig {
  const filters: {
    includedClasses?: readonly string[];
    excludedClasses?: readonly string[];
    requireTagProperty: boolean;
    acceptedTagPatterns?: readonly string[];
    selectionSetNames?: readonly string[];
    includedSourceModelFiles?: readonly string[];
    collapseComponents: boolean;
    separatelyCommissionableClasses?: readonly string[];
  } = {
    requireTagProperty: wire.requireTagProperty,
    collapseComponents: wire.collapseComponents,
  };

  if (wire.includedClasses.length > 0) {
    filters.includedClasses = [...wire.includedClasses];
  }
  if (wire.excludedClasses.length > 0) {
    filters.excludedClasses = [...wire.excludedClasses];
  }
  if (wire.acceptedTagPatterns.length > 0) {
    filters.acceptedTagPatterns = [...wire.acceptedTagPatterns];
  }
  if (wire.selectionSetNames.length > 0) {
    filters.selectionSetNames = [...wire.selectionSetNames];
  }
  if (wire.includedSourceModelFiles.length > 0) {
    filters.includedSourceModelFiles = [...wire.includedSourceModelFiles];
  }
  if (wire.separatelyCommissionableClasses.length > 0) {
    filters.separatelyCommissionableClasses = [...wire.separatelyCommissionableClasses];
  }
  return filters;
}

/** `null` when nothing has been taught yet. */
export function toTagAnatomy(wire: WireTagAnatomy): TagAnatomyConfig | null {
  if (wire.segments.length === 0) {
    return null;
  }

  const segments: Partial<Record<SegmentName, SegmentExtractor>> = {};
  for (const row of wire.segments) {
    segments[row.segment] = row.extractor;
  }

  const config: {
    separators: readonly string[];
    ignoredSuffixes?: readonly string[];
    segments: Readonly<Partial<Record<SegmentName, SegmentExtractor>>>;
    familyKeyTemplate?: string;
    localFamilyTemplate?: string;
  } = { separators: [...wire.separators], segments };

  if (wire.ignoredSuffixes.length > 0) {
    config.ignoredSuffixes = [...wire.ignoredSuffixes];
  }
  if (wire.familyKeyTemplate.length > 0) {
    config.familyKeyTemplate = wire.familyKeyTemplate;
  }
  if (wire.localFamilyTemplate.length > 0) {
    config.localFamilyTemplate = wire.localFamilyTemplate;
  }
  return config;
}

/** `null` when the key chain is empty — nothing to resolve a system from. */
export function toSystemResolver(wire: WireSystemResolver): SystemResolverConfig | null {
  if (wire.keyChain.length === 0) {
    return null;
  }

  const config: {
    keyChain: readonly SystemComponentConfig[];
    descriptionChain: readonly SystemComponentConfig[];
    normalization: readonly NormalizationStep[];
    conflictPolicy: 'review' | 'precedence';
    labelTemplate?: string;
  } = {
    keyChain: [...wire.keyChain],
    descriptionChain: [...wire.descriptionChain],
    normalization: [...wire.normalization],
    conflictPolicy: wire.conflictPolicy,
  };

  if (wire.labelTemplate.length > 0) {
    config.labelTemplate = wire.labelTemplate;
  }
  return config;
}

/**
 * The draft as a publishable `SiteProfile`.
 *
 * @throws DraftIncompleteError when the equipment tag mapping is still unset.
 */
export function toSiteProfile(draft: WireDraftProfile): SiteProfile {
  const anatomy = toTagAnatomy(draft.tagAnatomy);
  const resolver = toSystemResolver(draft.systemResolver);

  const profile: {
    profileId: string;
    name: string;
    version: number;
    propertyMappings: PropertyMappings;
    assetFilters: AssetFilterConfig;
    tagAnatomy?: TagAnatomyConfig;
    systemResolver?: SystemResolverConfig;
  } = {
    profileId: draft.profileId,
    name: draft.name,
    version: draft.version,
    propertyMappings: toPropertyMappings(draft.propertyMappings),
    assetFilters: toAssetFilters(draft.assetFilters),
  };

  if (anatomy !== null) {
    profile.tagAnatomy = anatomy;
  }
  if (resolver !== null) {
    profile.systemResolver = resolver;
  }
  return profile;
}

/* ------------------------------------------------------------ domain -> wire */

const SEGMENT_ORDER: readonly SegmentName[] = ['role', 'system', 'unit', 'instance'];

/** Rehydrates a draft from a stored revision, so reopening resumes the wizard. */
export function fromSiteProfile(profile: SiteProfile): WireDraftProfile {
  const base = emptyDraft(profile.name);
  const anatomy = profile.tagAnatomy;
  const resolver = profile.systemResolver;

  return {
    profileId: profile.profileId,
    name: profile.name,
    version: profile.version,
    propertyMappings: {
      equipmentTag: profile.propertyMappings.equipmentTag,
      description: profile.propertyMappings.description ?? null,
      equipmentType: profile.propertyMappings.equipmentType ?? null,
      building: profile.propertyMappings.building ?? null,
      nativeDiscipline: profile.propertyMappings.nativeDiscipline ?? null,
      wbs: profile.propertyMappings.wbs ?? null,
      itemMaster: profile.propertyMappings.itemMaster ?? null,
      equipmentClassification: profile.propertyMappings.equipmentClassification ?? null,
    },
    assetFilters: {
      includedClasses: [...(profile.assetFilters.includedClasses ?? [])],
      excludedClasses: [...(profile.assetFilters.excludedClasses ?? [])],
      requireTagProperty: profile.assetFilters.requireTagProperty,
      acceptedTagPatterns: [...(profile.assetFilters.acceptedTagPatterns ?? [])],
      selectionSetNames: [...(profile.assetFilters.selectionSetNames ?? [])],
      includedSourceModelFiles: [...(profile.assetFilters.includedSourceModelFiles ?? [])],
      collapseComponents: profile.assetFilters.collapseComponents,
      separatelyCommissionableClasses: [
        ...(profile.assetFilters.separatelyCommissionableClasses ?? []),
      ],
    },
    tagAnatomy:
      anatomy === undefined
        ? base.tagAnatomy
        : {
            separators: [...anatomy.separators],
            ignoredSuffixes: [...(anatomy.ignoredSuffixes ?? [])],
            segments: SEGMENT_ORDER.flatMap(
              (
                segment: SegmentName,
              ): ReadonlyArray<{ segment: SegmentName; extractor: SegmentExtractor }> => {
                const extractor = anatomy.segments[segment];
                return extractor === undefined ? [] : [{ segment, extractor }];
              },
            ),
            familyKeyTemplate: anatomy.familyKeyTemplate ?? '',
            localFamilyTemplate: anatomy.localFamilyTemplate ?? '',
          },
    systemResolver:
      resolver === undefined
        ? base.systemResolver
        : {
            keyChain: [...resolver.keyChain],
            descriptionChain: [...resolver.descriptionChain],
            normalization: [...resolver.normalization],
            conflictPolicy: resolver.conflictPolicy,
            labelTemplate: resolver.labelTemplate ?? '',
          },
  };
}
