import { LADDER_SOURCE_ORDER, migrateMappedProperty } from '@matchline/domain';
import type {
  AssetFilterConfig,
  AttributeResolverInput,
  AuthorityRule,
  DerivedAttributeDefinitionInput,
  DisciplineRewrite,
  HierarchyConfigInput,
  MappedPropertyInput,
  NormalizationStep,
  ParentLadderConfig,
  ParentPair,
  ProfileIdentityConfig,
  ProfileTestExample,
  PropertyMappingsInput,
  PropertyRef,
  RoleGraphConfig,
  SegmentExtractor,
  SegmentName,
  SiteProfileV2,
  SourceAssignmentRuleInput,
  SourceAssignmentsInput,
  SystemComponentConfig,
  SystemResolverConfig,
  TagAnatomyConfig,
} from '@matchline/domain';

import type {
  WireAssetFilters,
  WireAttributeResolver,
  WireDraftPatch,
  WireDraftProfile,
  WireHierarchyLevel,
  WireIdentityConfig,
  WirePropertyMappings,
  WireSourceAssignmentRule,
  WireSystemResolver,
  WireTagAnatomy,
} from '../../shared/schemas.js';

/**
 * The wizard's draft Site Profile, and the one conversion between the wire
 * shape and `@matchline/domain`'s published `SiteProfileV2`.
 *
 * A draft is not a `SiteProfileV2`. It exists mid-decision: no tag property
 * picked, an anatomy with no segments taught, a resolver chain with no rungs.
 * The domain type cannot say any of that, so the draft says it — and every
 * "is this section actually configured?" question is answered here, once, by
 * the `has*` predicates, rather than re-guessed at each call site.
 *
 * Since SiteProfileV2 the draft carries the WHOLE rule set, the sections screens
 * 6 and 7 configure included. They used to live in the project's `config` table
 * and reach the compiler as separate inputs; a site's decisions are one document
 * now, and `project-config.ts` keeps only what belongs to the project.
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
 * The default preset: Building / SSM Discipline / System, with Building and
 * System as boundaries and SSM Discipline as a visible grouping only (P0-5).
 *
 * Two different questions used to get the same answer here. DECISIONS.md #1
 * says a boundary that IS enabled is hard, with no feed-chain exception — that
 * is about what a boundary *means*. P0-5 is about which levels a new project
 * should *enable*, and a commissioning discipline is not one of them: a startup
 * family is a mechanical unit, its controls panel, its drive and its instrument
 * (MAH/PLC/VFD/TIT), and a structural discipline cuts that one family into four
 * roots. Discipline stays a level, so the tree still groups by it; it just does
 * not break parents.
 *
 * The System boundary compares the System Key and never the wording (P0-6):
 * `attributeKey` here is the level's *key* attribute.
 *
 * `missingValuePolicy: 'unassigned-group'` on all three is deliberate. `review`
 * would open the wizard with a queue of items about equipment nobody has
 * decided anything about yet; an `(unassigned)` bucket says the same thing
 * where a person is already looking.
 */
export const DEFAULT_HIERARCHY_LEVELS: readonly WireHierarchyLevel[] = [
  {
    levelId: 'building',
    displayName: 'Building',
    attributeKey: 'building',
    boundary: true,
    missingValuePolicy: 'unassigned-group',
    sort: 'label',
  },
  {
    levelId: 'ssm-discipline',
    displayName: 'SSM Discipline',
    attributeKey: 'ssmDiscipline',
    boundary: false,
    missingValuePolicy: 'unassigned-group',
    sort: 'label',
  },
  {
    levelId: 'system',
    displayName: 'System',
    attributeKey: 'systemKey',
    displayAttributeKey: 'systemLabel',
    boundary: true,
    missingValuePolicy: 'unassigned-group',
    sort: 'key',
  },
];

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
    // The sections that used to be the project `config` table's. A new profile
    // starts from the default level preset (P0-5) and the full ladder, because
    // those are the two the compiler would otherwise supply itself; everything
    // else starts empty, which is the truth about a site nobody has taught yet.
    sourceAssignments: [],
    derivedAttributes: [],
    hierarchy: { levels: [...DEFAULT_HIERARCHY_LEVELS] },
    roleGraph: { rules: [] },
    ladder: { tiers: [...LADDER_SOURCE_ORDER] },
    ssmDisciplineProjection: [],
    parentTagProperty: null,
    stableIdProperty: null,
    identityConfig: { tagNormalization: [], aliases: [], fuzzyMaxDistance: 0 },
    profileLookup: [],
    priorSsm: [],
    authorityRules: [],
    profileTestExamples: [],
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
    sourceAssignments: patch.sourceAssignments ?? draft.sourceAssignments,
    assetFilters: patch.assetFilters ?? draft.assetFilters,
    tagAnatomy: patch.tagAnatomy ?? draft.tagAnatomy,
    systemResolver: patch.systemResolver ?? draft.systemResolver,
    derivedAttributes: patch.derivedAttributes ?? draft.derivedAttributes,
    hierarchy: patch.hierarchy ?? draft.hierarchy,
    roleGraph: patch.roleGraph ?? draft.roleGraph,
    ladder: patch.ladder ?? draft.ladder,
    ssmDisciplineProjection: patch.ssmDisciplineProjection ?? draft.ssmDisciplineProjection,
    // `null` is a decision here — "nothing is mapped" — so an absent key is what
    // "the patch said nothing about this" has to be, not a nullish fallback.
    parentTagProperty:
      patch.parentTagProperty === undefined ? draft.parentTagProperty : patch.parentTagProperty,
    stableIdProperty:
      patch.stableIdProperty === undefined ? draft.stableIdProperty : patch.stableIdProperty,
    identityConfig: patch.identityConfig ?? draft.identityConfig,
    profileLookup: patch.profileLookup ?? draft.profileLookup,
    priorSsm: patch.priorSsm ?? draft.priorSsm,
    authorityRules: patch.authorityRules ?? draft.authorityRules,
    profileTestExamples: patch.profileTestExamples ?? draft.profileTestExamples,
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
 * The wizard's single-property mappings as the domain takes them.
 *
 * Each field stays one `PropertyRef` on the wire this round: screen 3 picks one
 * property, and `PropertyRef` is a legal `MappedPropertyInput` that every engine
 * entry point lifts to a one-rung chain (P0-8). Editing a chain or a per-source
 * override is a Site Profile Studio job, not a wizard one.
 *
 * @throws DraftIncompleteError when no equipment tag property has been chosen —
 * the one mapping with no default (PRODUCT.md §6.5).
 */
export function toPropertyMappings(wire: WirePropertyMappings): PropertyMappingsInput {
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

/* ------------------------------------- the sections that were the config */

/** One assignment rule's `assign`, with blanks left off rather than assigned. */
function toAssignments(wire: WireSourceAssignmentRule['assign']): SourceAssignmentsInput {
  const assignments: {
    building?: string;
    nativeDiscipline?: string;
    custom?: ReadonlyArray<{ key: string; value: string }>;
  } = {};
  if (wire.building !== '') {
    assignments.building = wire.building;
  }
  if (wire.nativeDiscipline !== '') {
    assignments.nativeDiscipline = wire.nativeDiscipline;
  }
  if (wire.custom.length > 0) {
    assignments.custom = wire.custom.map((entry) => ({ key: entry.key, value: entry.value }));
  }
  return assignments;
}

/** The profile-level assignment rules (P0-8). */
export function toSourceAssignments(
  draft: WireDraftProfile,
): ReadonlyArray<SourceAssignmentRuleInput> {
  return draft.sourceAssignments.map((rule) => ({
    scope: rule.scope,
    match: rule.match,
    assign: toAssignments(rule.assign),
  }));
}

/**
 * The site's attribute registry (P0-7).
 *
 * A straight copy: the wire and the profile spell a derived attribute the same
 * way, including the `manual` rung's ordered pair list. The map the evaluator
 * reads is built by `migrateDerivedAttributes` inside the compiler, which is
 * the one place that conversion happens.
 */
export function toDerivedAttributes(
  draft: WireDraftProfile,
): ReadonlyArray<DerivedAttributeDefinitionInput> {
  return draft.derivedAttributes.map((definition) => ({
    attributeId: definition.attributeId,
    displayName: definition.displayName,
    resolverChain: definition.resolverChain.map((rung) => ({ ...rung })),
  }));
}

/**
 * The level stack (P0-6).
 *
 * `WireHierarchyLevel.attributeKey` is the level's KEY attribute — the name
 * screen 6 and every stored project have always used — and `HierarchyConfigInput`
 * accepts exactly that spelling, so this is a copy rather than a translation.
 * `migrateHierarchyConfig` normalizes it on the way into the engine.
 */
export function toHierarchy(draft: WireDraftProfile): HierarchyConfigInput {
  return {
    levels: draft.hierarchy.levels.map((level) => ({
      levelId: level.levelId,
      displayName: level.displayName,
      // Either spelling. The wire schema lifts `keyAttributeKey` onto
      // `attributeKey` for anything that arrives over IPC, but a level handed
      // straight to the service — a test, a future importer — has not been
      // through it, and losing a site's levels to a spelling is not acceptable.
      attributeKey:
        level.attributeKey ??
        (level as { readonly keyAttributeKey?: string }).keyAttributeKey ??
        '',
      ...(level.displayAttributeKey === undefined
        ? {}
        : { displayAttributeKey: level.displayAttributeKey }),
      ...(level.boundaryAttributeKey === undefined
        ? {}
        : { boundaryAttributeKey: level.boundaryAttributeKey }),
      boundary: level.boundary,
      missingValuePolicy: level.missingValuePolicy,
      sort: level.sort,
    })),
  };
}

export function toRoleGraph(draft: WireDraftProfile): RoleGraphConfig {
  return { rules: draft.roleGraph.rules.map((rule) => ({ ...rule })) };
}

/**
 * The ladder, or the full walk order when every rung was turned off.
 *
 * An empty `tiers` is not "no preference" — it would disable every rung and root
 * the whole site — so it is the one value that is refused rather than published.
 */
export function toLadder(draft: WireDraftProfile): ParentLadderConfig {
  return draft.ladder.tiers.length === 0
    ? { tiers: [...LADDER_SOURCE_ORDER] }
    : { tiers: [...draft.ladder.tiers] };
}

export function toDisciplineProjection(
  draft: WireDraftProfile,
): ReadonlyArray<DisciplineRewrite> {
  return draft.ssmDisciplineProjection.map((rewrite) => ({ ...rewrite }));
}

/** `fuzzyMaxDistance: 0` is the wire's "use the engine's default", so it is dropped. */
export function toIdentityConfig(wire: WireIdentityConfig): ProfileIdentityConfig {
  const config: {
    tagNormalization: ReadonlyArray<NormalizationStep>;
    aliases: ReadonlyArray<{ from: string; to: string }>;
    fuzzyMaxDistance?: number;
  } = {
    tagNormalization: [...wire.tagNormalization],
    aliases: wire.aliases.map((alias) => ({ ...alias })),
  };
  if (wire.fuzzyMaxDistance > 0) {
    config.fuzzyMaxDistance = wire.fuzzyMaxDistance;
  }
  return config;
}

function toParentPairs(pairs: ReadonlyArray<ParentPair>): ReadonlyArray<ParentPair> {
  return pairs.map((pair) => ({ childTag: pair.childTag, parentTag: pair.parentTag }));
}

/** A blank note is no note, not an empty one. */
function toAuthorityRules(draft: WireDraftProfile): ReadonlyArray<AuthorityRule> {
  return draft.authorityRules.map((rule) => ({
    field: rule.field,
    authority: rule.authority,
    ...(rule.note === '' ? {} : { note: rule.note }),
  }));
}

function toTestExamples(draft: WireDraftProfile): ReadonlyArray<ProfileTestExample> {
  return draft.profileTestExamples.map((example) => ({ ...example }));
}

/**
 * The draft as a publishable `SiteProfileV2`.
 *
 * @throws DraftIncompleteError when the equipment tag mapping is still unset.
 */
export function toSiteProfile(draft: WireDraftProfile): SiteProfileV2 {
  const anatomy = toTagAnatomy(draft.tagAnatomy);
  const resolver = toSystemResolver(draft.systemResolver);

  const profile: {
    formatVersion: 2;
    profileId: string;
    name: string;
    version: number;
    propertyMappings: PropertyMappingsInput;
    sourceAssignments: ReadonlyArray<SourceAssignmentRuleInput>;
    assetFilters: AssetFilterConfig;
    tagAnatomy?: TagAnatomyConfig;
    systemResolver?: SystemResolverConfig;
    derivedAttributes: ReadonlyArray<DerivedAttributeDefinitionInput>;
    hierarchy: HierarchyConfigInput;
    roleGraph: RoleGraphConfig;
    ladder: ParentLadderConfig;
    ssmDisciplineProjection: ReadonlyArray<DisciplineRewrite>;
    parentTagProperty: PropertyRef | null;
    stableIdProperty: PropertyRef | null;
    identityConfig: ProfileIdentityConfig;
    profileLookup: ReadonlyArray<ParentPair>;
    priorSsm: ReadonlyArray<ParentPair>;
    authorityRules: ReadonlyArray<AuthorityRule>;
    profileTestExamples: ReadonlyArray<ProfileTestExample>;
  } = {
    formatVersion: 2,
    profileId: draft.profileId,
    name: draft.name,
    version: draft.version,
    propertyMappings: toPropertyMappings(draft.propertyMappings),
    sourceAssignments: toSourceAssignments(draft),
    assetFilters: toAssetFilters(draft.assetFilters),
    derivedAttributes: toDerivedAttributes(draft),
    hierarchy: toHierarchy(draft),
    roleGraph: toRoleGraph(draft),
    ladder: toLadder(draft),
    ssmDisciplineProjection: toDisciplineProjection(draft),
    parentTagProperty: draft.parentTagProperty === null ? null : { ...draft.parentTagProperty },
    stableIdProperty: draft.stableIdProperty === null ? null : { ...draft.stableIdProperty },
    identityConfig: toIdentityConfig(draft.identityConfig),
    profileLookup: toParentPairs(draft.profileLookup),
    priorSsm: toParentPairs(draft.priorSsm),
    authorityRules: toAuthorityRules(draft),
    profileTestExamples: toTestExamples(draft),
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

/**
 * One stored mapping as the wizard's single-property picker can show it.
 *
 * A profile written before P0-8 is one `PropertyRef` and passes through. A
 * profile carrying a chain narrows to its first rung, because that is the rung
 * the site preferred and the picker has room for exactly one — the remaining
 * rungs and any per-source overrides stay in the published profile, which is
 * where they were configured. The wizard is a view of a draft, not the profile.
 */
function firstRungOf(mapping: MappedPropertyInput | undefined): PropertyRef | null {
  if (mapping === undefined) {
    return null;
  }
  return migrateMappedProperty(mapping).chain[0] ?? null;
}

/** Rehydrates a draft from a stored revision, so reopening resumes the wizard. */
export function fromSiteProfile(profile: SiteProfileV2): WireDraftProfile {
  const base = emptyDraft(profile.name);
  const anatomy = profile.tagAnatomy;
  const resolver = profile.systemResolver;

  return {
    profileId: profile.profileId,
    name: profile.name,
    version: profile.version,
    propertyMappings: {
      equipmentTag: firstRungOf(profile.propertyMappings.equipmentTag),
      description: firstRungOf(profile.propertyMappings.description),
      equipmentType: firstRungOf(profile.propertyMappings.equipmentType),
      building: firstRungOf(profile.propertyMappings.building),
      nativeDiscipline: firstRungOf(profile.propertyMappings.nativeDiscipline),
      wbs: firstRungOf(profile.propertyMappings.wbs),
      itemMaster: firstRungOf(profile.propertyMappings.itemMaster),
      equipmentClassification: firstRungOf(profile.propertyMappings.equipmentClassification),
    },
    sourceAssignments: profile.sourceAssignments.map((rule) => ({
      scope: rule.scope,
      match: rule.match,
      assign: {
        building: rule.assign.building ?? '',
        nativeDiscipline: rule.assign.nativeDiscipline ?? '',
        custom: (rule.assign.custom ?? []).map((entry) => ({ ...entry })),
      },
    })),
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
    derivedAttributes: profile.derivedAttributes.map((definition) => ({
      attributeId: definition.attributeId,
      displayName: definition.displayName,
      resolverChain: definition.resolverChain.map(toWireResolver),
    })),
    // A profile lifted from a V1 revision states no levels at all, which would
    // open the Composer on an empty stack a person never chose. The preset is
    // what a new project gets and it is what a profile that never had one gets.
    hierarchy:
      profile.hierarchy.levels.length === 0
        ? base.hierarchy
        : { levels: profile.hierarchy.levels.map(toWireLevel) },
    roleGraph: { rules: profile.roleGraph.rules.map((rule) => ({ ...rule })) },
    ladder:
      profile.ladder.tiers.length === 0 ? base.ladder : { tiers: [...profile.ladder.tiers] },
    ssmDisciplineProjection: profile.ssmDisciplineProjection.map((rewrite) => ({ ...rewrite })),
    parentTagProperty: profile.parentTagProperty === null ? null : { ...profile.parentTagProperty },
    stableIdProperty: profile.stableIdProperty === null ? null : { ...profile.stableIdProperty },
    identityConfig: {
      tagNormalization: [...profile.identityConfig.tagNormalization],
      aliases: profile.identityConfig.aliases.map((alias) => ({ ...alias })),
      fuzzyMaxDistance: profile.identityConfig.fuzzyMaxDistance ?? 0,
    },
    profileLookup: profile.profileLookup.map((pair) => ({ ...pair })),
    priorSsm: profile.priorSsm.map((pair) => ({ ...pair })),
    authorityRules: profile.authorityRules.map((rule) => ({
      field: rule.field,
      authority: rule.authority,
      note: rule.note ?? '',
    })),
    profileTestExamples: profile.profileTestExamples.map((example) => ({ ...example })),
  };
}

/** One resolver rung as the wire spells it: the same fields, mutable arrays. */
function toWireResolver(rung: AttributeResolverInput): WireAttributeResolver {
  switch (rung.kind) {
    case 'model-property':
      return { kind: 'model-property', chain: rung.chain.map((ref) => ({ ...ref })) };
    case 'manual':
      return { kind: 'manual', assignments: rung.assignments.map((entry) => ({ ...entry })) };
    default:
      return rung;
  }
}

/**
 * One level in the wire's spelling, whichever way the profile wrote it.
 *
 * A profile is hand-editable JSON and the engine's own name for the grouping
 * attribute is `keyAttributeKey`; the wire and every stored project call it
 * `attributeKey`. Both arrive here and neither is refused.
 */
function toWireLevel(level: HierarchyConfigInput['levels'][number]): WireHierarchyLevel {
  const attributeKey =
    'keyAttributeKey' in level ? level.keyAttributeKey : level.attributeKey;
  return {
    levelId: level.levelId,
    displayName: level.displayName,
    attributeKey,
    ...(level.displayAttributeKey === undefined
      ? {}
      : { displayAttributeKey: level.displayAttributeKey }),
    ...(level.boundaryAttributeKey === undefined
      ? {}
      : { boundaryAttributeKey: level.boundaryAttributeKey }),
    boundary: level.boundary,
    missingValuePolicy: level.missingValuePolicy,
    sort: level.sort,
  };
}
