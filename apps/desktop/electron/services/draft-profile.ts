import { LADDER_SOURCE_ORDER, migrateMappedProperty } from '@matchline/domain';
import type {
  AssetFilterConfig,
  AttributeResolverInput,
  AuthorityRule,
  DerivedAttributeDefinitionInput,
  DisciplineRewrite,
  HierarchyConfigInput,
  MappedPropertyChainInput,
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
  SopRulesConfig,
  SsmAuditConfig,
  SystemComponentConfig,
  SystemResolverConfig,
  TagAnatomyConfig,
} from '@matchline/domain';

import type { IdentityConfig } from '@matchline/identity';

import { liftMappedProperty, MAPPED_PROPERTY_FIELDS } from '../../shared/schemas.js';
// Re-exported so the draft's starting point and its one recommendation are
// found in the same place; the function itself is shared because the Quick
// Setup screen builds the patch and the renderer cannot import main.
export { starterProfile } from '../../shared/starter-profile.js';
import type {
  WireAssetFilters,
  WireAttributeResolver,
  WireDraftPatch,
  WireDraftProfile,
  WireHierarchyLevel,
  WireIdentityConfig,
  WireMappedProperty,
  WireMappedPropertyField,
  WirePropertyMappings,
  WirePropertyRef,
  WireSourceAssignmentRule,
  WireSystemComponent,
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
    propertyMappings: emptyMappings(),
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
      // On for a project nobody has published yet: it is what the SSM SOP says,
      // and there is no stored register for it to move anything in. A profile
      // lifted from a revision gets the opposite default, below.
      applyIcDisciplineRule: true,
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
    // The one normalization step a new site gets for free. It is not a rule
    // about what this site calls things -- it is what an en dash and a hyphen
    // have in common -- and without it a tag pasted out of a specification
    // never matches the same tag typed into a model (audit: "unicode tag
    // hygiene regressed vs donor").
    identityConfig: {
      tagNormalization: [{ kind: 'unicodeFold' }],
      aliases: [],
      fuzzyMaxDistance: 0,
    },
    profileLookup: [],
    priorSsm: [],
    // Every SSM Audit rule on. A rule a site wants silenced is a decision that
    // site makes on screen 8, having seen what the rule actually says.
    ssmAudit: { disabledRuleIds: [] },
    // Every SOP rule on. They stay inert until the ladder carries the
    // `sop-rule` rung, which `emptyDraft` does and a migrated profile does not.
    sopRules: { disabledRuleIds: [] },
    authorityRules: [],
    profileTestExamples: [],
  };
}

/**
 * Every mapped field as an empty chain: nobody has mapped anything yet.
 *
 * Spelled out field by field rather than built from `MAPPED_PROPERTY_FIELDS` in
 * a loop, because a loop produces a partial record as far as the compiler is
 * concerned and this shape has no optional keys. The guard against forgetting a
 * new field is `EveryMappedFieldListed` in the schema, which is a compile-time
 * check on the list itself.
 */
function emptyMappings(): WirePropertyMappings {
  const unmapped = (): WireMappedProperty => ({ chain: [], bySource: [] });
  return {
    equipmentTag: unmapped(),
    description: unmapped(),
    equipmentType: unmapped(),
    building: unmapped(),
    nativeDiscipline: unmapped(),
    wbs: unmapped(),
    itemMaster: unmapped(),
    equipmentClassification: unmapped(),
  };
}

/**
 * One mapping in the chain shape, whichever spelling arrived.
 *
 * A patch handed straight to the service — a test, a future importer — has not
 * been through `draftPatchSchema`, so the lift has to run here too. It is the
 * schema's own {@link liftMappedProperty}, called rather than reimplemented.
 */
function liftWireMapping(value: unknown): WireMappedProperty {
  const lifted = liftMappedProperty(value) as {
    readonly chain?: readonly WirePropertyRef[];
    readonly bySource?: readonly { readonly sourceId: string; readonly chain: readonly WirePropertyRef[] }[];
  };
  return {
    chain: [...(lifted.chain ?? [])],
    bySource: (lifted.bySource ?? []).map((override) => ({
      sourceId: override.sourceId,
      chain: [...override.chain],
    })),
  };
}

/** {@link liftWireMapping} over a whole mapping set, field by declared field. */
export function liftWireMappings(input: WirePropertyMappings): WirePropertyMappings {
  return {
    equipmentTag: liftWireMapping(input.equipmentTag),
    description: liftWireMapping(input.description),
    equipmentType: liftWireMapping(input.equipmentType),
    building: liftWireMapping(input.building),
    nativeDiscipline: liftWireMapping(input.nativeDiscipline),
    wbs: liftWireMapping(input.wbs),
    itemMaster: liftWireMapping(input.itemMaster),
    equipmentClassification: liftWireMapping(input.equipmentClassification),
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
    propertyMappings:
      patch.propertyMappings === undefined
        ? draft.propertyMappings
        : liftWireMappings(patch.propertyMappings),
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
    ssmAudit: patch.ssmAudit ?? draft.ssmAudit,
    sopRules: patch.sopRules ?? draft.sopRules,
    authorityRules: patch.authorityRules ?? draft.authorityRules,
    profileTestExamples: patch.profileTestExamples ?? draft.profileTestExamples,
  };
}

/* --------------------------------------------------------------- predicates */

/**
 * Screen 3 is answered: there is at least one property to read tags from.
 *
 * The chain, not one rung: a site whose tag lives in one place on the mechanical
 * model and another on the controls model has answered the question, and so has
 * a site that stated one address (P0-8).
 */
export function hasMappings(draft: WireDraftProfile): boolean {
  return liftWireMapping(draft.propertyMappings.equipmentTag).chain.length > 0;
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
 * One mapped field as the domain takes it: a chain, plus any per-source
 * override (P0-8).
 *
 * The overrides go across as the ordered pair list `MappedPropertyChainInput`
 * accepts, not as a `Map`: a profile is JSON, and `migrateMappedProperty` is the
 * one place the map is built.
 */
function toMappedProperty(mapping: WireMappedProperty): MappedPropertyChainInput {
  const chain = mapping.chain.map(toPropertyRef);
  // A blank override list is an absent key rather than an empty array, for the
  // reason every optional section here is: `{bySource: []}` would claim the site
  // stated per-source addresses and then named none.
  const overrides = mapping.bySource.filter((override) => override.chain.length > 0);
  if (overrides.length === 0) {
    return { chain };
  }
  return {
    chain,
    bySource: overrides.map((override) => ({
      sourceId: override.sourceId,
      chain: override.chain.map(toPropertyRef),
    })),
  };
}

/**
 * The wizard's mappings as the domain takes them (P0-8, hard gate 5).
 *
 * Every field is an ordered fallback chain with optional per-source overrides.
 * A field whose chain is empty is dropped rather than sent as an empty chain:
 * `PropertyMappings` means absent when a site did not map a field, and an empty
 * chain would be a second spelling of the same fact.
 *
 * Walked from `MAPPED_PROPERTY_FIELDS` rather than field by field, so a mapping
 * added to the wire cannot be forgotten here and silently dropped on the way
 * into the engine.
 *
 * @throws DraftIncompleteError when no equipment tag property has been chosen —
 * the one mapping with no default (PRODUCT.md §6.5).
 */
export function toPropertyMappings(wire: WirePropertyMappings): PropertyMappingsInput {
  const lifted = liftWireMappings(wire);
  if (lifted.equipmentTag.chain.length === 0) {
    throw new DraftIncompleteError(
      'Pick the property that holds the equipment tag before previewing assets.',
    );
  }

  // Built key by key rather than spread: under `exactOptionalPropertyTypes` an
  // explicit `description: undefined` is not the same as an absent key, and
  // `PropertyMappings` means absent.
  const mappings: { -readonly [Field in WireMappedPropertyField]?: MappedPropertyInput } = {};
  for (const field of MAPPED_PROPERTY_FIELDS) {
    const mapping = lifted[field];
    if (mapping.chain.length > 0) {
      mappings[field] = toMappedProperty(mapping);
    }
  }
  return { ...mappings, equipmentTag: toMappedProperty(lifted.equipmentTag) };
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
/**
 * One rung as the domain takes it.
 *
 * Only `exto-system-name` needs lifting: the wire spells "read the description
 * the chain already found" as `descriptionProperty: null`, because the config
 * table stores canonical JSON and an absent key round-trips as a null. Under
 * `exactOptionalPropertyTypes` an explicit `undefined` is not an absent key, so
 * the property is added or not added rather than set to undefined.
 */
function toSystemComponent(wire: WireSystemComponent): SystemComponentConfig {
  if (wire.kind !== 'exto-system-name') {
    return wire;
  }
  return {
    kind: 'exto-system-name',
    allowUniqueUpn: wire.allowUniqueUpn,
    ...(wire.descriptionProperty === null
      ? {}
      : { descriptionProperty: toPropertyRef(wire.descriptionProperty) }),
  };
}

/** The same rung on the way back out to the wizard. */
function toWireComponent(component: SystemComponentConfig): WireSystemComponent {
  if (component.kind !== 'exto-system-name') {
    return component;
  }
  return {
    kind: 'exto-system-name',
    allowUniqueUpn: component.allowUniqueUpn,
    descriptionProperty: component.descriptionProperty ?? null,
  };
}

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
    applyIcDisciplineRule: boolean;
  } = {
    keyChain: wire.keyChain.map(toSystemComponent),
    descriptionChain: wire.descriptionChain.map(toSystemComponent),
    normalization: [...wire.normalization],
    conflictPolicy: wire.conflictPolicy,
    applyIcDisciplineRule: wire.applyIcDisciplineRule,
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

/**
 * The profile-level assignment rules (P0-8).
 *
 * A rule whose `match` is still blank is dropped rather than published. The
 * editor writes every keystroke so the match preview can be live, which means a
 * rule exists from the moment somebody presses Add and before they have said
 * what it matches — and a rule that matches nothing is inert, while a rule the
 * engine read as matching everything would quietly assign a building to a whole
 * site. Absent is the truth about a rule nobody has finished writing.
 */
export function toSourceAssignments(
  draft: WireDraftProfile,
): ReadonlyArray<SourceAssignmentRuleInput> {
  return draft.sourceAssignments
    .filter((rule) => rule.match.trim() !== '')
    .map((rule) => ({
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
      // The SSM SOP's approved exception, carried straight through. Absent
      // stays absent: a level with no exception list folds as it always did.
      ...(level.boundaryExceptions === undefined
        ? {}
        : { boundaryExceptions: { childClasses: [...level.boundaryExceptions.childClasses] } }),
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

/**
 * The identity index config a draft implies, assembled the way `compileProject`
 * assembles it from the saved profile.
 *
 * Screen 6's previews join the MEL through identity, and they must reach the
 * same rows the compile reaches: the same normalization steps, the same
 * aliases, the same fuzzy distance, and the draft's own anatomy enabling the
 * anatomy tier without having to be configured twice. Anything the draft has
 * not stated is omitted rather than defaulted, because the engine's defaults
 * are the engine's to choose.
 */
export function toIdentityIndexConfig(draft: WireDraftProfile): IdentityConfig {
  const profileConfig = toIdentityConfig(draft.identityConfig);
  const anatomy = toTagAnatomy(draft.tagAnatomy);
  return {
    ...(profileConfig.tagNormalization.length === 0
      ? {}
      : { tagNormalization: profileConfig.tagNormalization }),
    ...(profileConfig.aliases.length === 0
      ? {}
      : {
          aliases: new Map(
            profileConfig.aliases.map((alias) => [alias.from, alias.to] as const),
          ),
        }),
    ...(profileConfig.fuzzyMaxDistance === undefined
      ? {}
      : { fuzzyMaxDistance: profileConfig.fuzzyMaxDistance }),
    ...(anatomy === null ? {} : { anatomy }),
  };
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
    ssmAudit: SsmAuditConfig;
    sopRules: SopRulesConfig;
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
    ssmAudit: { disabledRuleIds: [...draft.ssmAudit.disabledRuleIds] },
    sopRules: { disabledRuleIds: [...draft.sopRules.disabledRuleIds] },
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
 * One stored mapping as the chain editor shows it.
 *
 * A profile written before P0-8 is one `PropertyRef`; `migrateMappedProperty`
 * lifts it to a one-rung chain, which is what it always meant. The per-source
 * map comes back as the ordered pair list the wire carries, sorted by source id
 * so a stored profile and a re-read one produce the same rows.
 *
 * Nothing is narrowed any more: the whole chain and every override reach the
 * editor, which is what makes screen 3 a view of the profile rather than of its
 * first rung.
 */
function toWireMapping(mapping: MappedPropertyInput | undefined): WireMappedProperty {
  if (mapping === undefined) {
    return { chain: [], bySource: [] };
  }
  const migrated = migrateMappedProperty(mapping);
  const bySource = [...(migrated.bySource ?? new Map())]
    .map(([sourceId, chain]: readonly [string, readonly PropertyRef[]]) => ({
      sourceId,
      chain: chain.map((ref) => ({ ...ref })),
    }))
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  return { chain: migrated.chain.map((ref) => ({ ...ref })), bySource };
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
      equipmentTag: toWireMapping(profile.propertyMappings.equipmentTag),
      description: toWireMapping(profile.propertyMappings.description),
      equipmentType: toWireMapping(profile.propertyMappings.equipmentType),
      building: toWireMapping(profile.propertyMappings.building),
      nativeDiscipline: toWireMapping(profile.propertyMappings.nativeDiscipline),
      wbs: toWireMapping(profile.propertyMappings.wbs),
      itemMaster: toWireMapping(profile.propertyMappings.itemMaster),
      equipmentClassification: toWireMapping(profile.propertyMappings.equipmentClassification),
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
            keyChain: resolver.keyChain.map(toWireComponent),
            descriptionChain: resolver.descriptionChain.map(toWireComponent),
            normalization: [...resolver.normalization],
            conflictPolicy: resolver.conflictPolicy,
            labelTemplate: resolver.labelTemplate ?? '',
            // Absent means off, and a stored revision written before the rule
            // existed states nothing. Reopening a published project must not
            // change what its next compile decides.
            applyIcDisciplineRule: resolver.applyIcDisciplineRule ?? false,
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
    // A V1 revision predates the gate and carries no list; the migration
    // supplies an empty one, so a reopened wizard shows every rule switched on.
    ssmAudit: { disabledRuleIds: [...profile.ssmAudit.disabledRuleIds] },
    // Same story as the gate: a revision written before the SOP rules existed
    // carries no list, so a reopened wizard shows every rule switched on -- and
    // every one of them inert, because that revision's ladder has no `sop-rule`.
    sopRules: { disabledRuleIds: [...profile.sopRules.disabledRuleIds] },
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
    ...(level.boundaryExceptions === undefined
      ? {}
      : { boundaryExceptions: { childClasses: [...level.boundaryExceptions.childClasses] } }),
    missingValuePolicy: level.missingValuePolicy,
    sort: level.sort,
  };
}
