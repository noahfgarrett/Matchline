/**
 * `SiteProfileV2` — one versioned profile, and the migration off the split brain
 * (RELEASE-1.0-PLAN "SiteProfileV2").
 *
 * ## The bug this type removes
 *
 * A profile used to be two halves that travelled together by convention rather
 * than by type. {@link SiteProfile} carried mappings, filters, anatomy and the
 * resolver; the hierarchy, the role graph, the ladder, the discipline
 * projection and the parent-tag property were "configuration the Site Profile
 * cannot yet carry" and arrived on the compiler's input instead — which meant
 * the desktop stored them in a second table, the portable package glued them
 * back together as `{draft, config}`, and the sections P0-7 and P0-8 added had
 * nowhere to live at all.
 *
 * V2 is the whole rule set in one value. A site's decisions are one document,
 * one stored revision, one exported package.
 *
 * ## Serializable in full
 *
 * A profile is hand-editable JSON (PRODUCT.md §13.3), it is stored in a JSON
 * column and it crosses IPC. So every section here is JSON: no `Map`, no `Set`,
 * no `Date`. Where the engine's own shape is a map — a derived attribute's
 * manual table, an assignment rule's custom fields, the discipline projection,
 * the identity aliases — this file carries the ordered pair list a profile
 * author writes and publishes the `migrate*` function that lifts it. Exactly
 * the arrangement {@link PropertyMappingsInput} and `HierarchyConfigInput`
 * already have: entry points migrate on the way in, and nothing inside the
 * engine sees an input shape.
 *
 * Profiles still never embed model files or spreadsheet rows — only addresses
 * of them (§13.3). Project-specific configuration stays outside: the captured
 * EXTO template belongs to one project's export, not to the site's rule set.
 */
import type { NormalizationStep, SystemResolverConfig } from './resolver-config.js';
import type { SegmentName, TagAnatomyConfig } from './anatomy.js';
import type { AttributeResolver, DerivedAttributeDefinition } from './derived-attributes.js';
import type {
  SourceAssignmentRule,
  SourceAssignments,
  SourceAssignmentScope,
} from './model-universe.js';
import {
  LADDER_SOURCE_ORDER_BEFORE_MEL_PARENT,
  type HierarchyConfigInput,
  type ParentLadderConfig,
  type RoleGraphConfig,
} from './hierarchy-config.js';
import type {
  AssetFilterConfig,
  PropertyMappingsInput,
  PropertyRef,
  SiteProfile,
} from './profile.js';

/* ------------------------------------------------------- serializable pairs */

/** One `key -> value` entry of a section the engine reads as a map. */
export interface ProfileMapEntry {
  readonly key: string;
  readonly value: string;
}

/**
 * `nativeDiscipline -> ssmDiscipline`, one rewrite per row.
 *
 * A list rather than a record so the order a profile author wrote survives a
 * round-trip and a half-typed `from` cannot collide with another row onto one
 * JSON key.
 */
export interface DisciplineRewrite {
  readonly from: string;
  readonly to: string;
}

/** One foreign tag spelling and the canonical tag it means. */
export interface TagAlias {
  readonly from: string;
  readonly to: string;
}

/**
 * A parent/child pair the site wrote down, spelled as tags.
 *
 * Tags and never asset ids: a lookup table is a document a site maintains, and
 * an internal asset id means nothing in one. Used by both the profile-lookup
 * rung (PRODUCT.md §11.1 tier 3) and the prior-SSM rung (tier 7).
 */
export interface ParentPair {
  readonly childTag: string;
  readonly parentTag: string;
}

/* ------------------------------------------------------------ identity */

/**
 * What the identity ladder is allowed to treat as the same equipment.
 *
 * The engine's `IdentityConfig` (`@matchline/identity`) is the same information
 * with `aliases` as a map and the anatomy inlined. The anatomy is deliberately
 * absent here: the profile already states one in {@link SiteProfileV2.tagAnatomy}
 * and carrying a second copy is how the two drift apart.
 */
export interface ProfileIdentityConfig {
  /** Applied to the evidence tag and the canonical tag alike, in order. */
  readonly tagNormalization: ReadonlyArray<NormalizationStep>;
  /** Evidence tag -> canonical tag. Matched exactly; an alias is a fact. */
  readonly aliases: ReadonlyArray<TagAlias>;
  /** Maximum Levenshtein distance for a fuzzy proposal. Absent means the default. */
  readonly fuzzyMaxDistance?: number;
}

/* --------------------------------------------- derived attributes (P0-7) */

/**
 * A derived attribute's `manual` rung as JSON: an ordered list, not a map.
 *
 * The engine's rung carries `ReadonlyMap<string, string>`, which `JSON.stringify`
 * writes as `{}`. A profile that stored one would silently lose every hand-made
 * assignment the moment it was saved.
 */
export interface ManualAttributeAssignment {
  readonly assetId: string;
  readonly value: string;
}

/** One resolver rung as a profile spells it (P0-7). */
export type AttributeResolverInput =
  | { readonly kind: 'model-property'; readonly chain: ReadonlyArray<PropertyRef> }
  | { readonly kind: 'tag-segment'; readonly segment: SegmentName }
  | { readonly kind: 'source-assignment'; readonly key: string }
  | {
      readonly kind: 'system-field';
      readonly field: 'systemKey' | 'systemDescription' | 'systemLabel';
    }
  | { readonly kind: 'composite'; readonly template: string }
  | {
      readonly kind: 'mel-lookup';
      readonly joinBy: 'equipmentTag';
      readonly returnField: string;
    }
  | {
      readonly kind: 'manual';
      readonly assignments: ReadonlyArray<ManualAttributeAssignment>;
    };

/** One site-defined attribute as a profile spells it (P0-7). */
export interface DerivedAttributeDefinitionInput {
  readonly attributeId: string;
  readonly displayName: string;
  readonly resolverChain: ReadonlyArray<AttributeResolverInput>;
}

/**
 * One resolver rung in the shape the evaluator reads.
 *
 * Only `manual` changes; every other rung is already the engine's own shape and
 * is returned untouched rather than rebuilt, so a rung added to
 * {@link AttributeResolver} cannot be silently dropped here.
 */
export function migrateAttributeResolver(input: AttributeResolverInput): AttributeResolver {
  if (input.kind !== 'manual') {
    return input;
  }
  // A later pair for one asset loses to the earlier one: the order the list was
  // written in decides, which is the rule every ordered section here follows.
  return {
    kind: 'manual',
    assignments: new Map(
      input.assignments.map((entry) => [entry.assetId, entry.value] as const).reverse(),
    ),
  };
}

/** {@link migrateAttributeResolver} over a whole registry. */
export function migrateDerivedAttributes(
  input: ReadonlyArray<DerivedAttributeDefinitionInput>,
): ReadonlyArray<DerivedAttributeDefinition> {
  return input.map((definition) => ({
    attributeId: definition.attributeId,
    displayName: definition.displayName,
    resolverChain: definition.resolverChain.map(migrateAttributeResolver),
  }));
}

/* ------------------------------------------ source assignment rules (P0-8) */

/** What one rule's matched documents assert, as a profile spells it. */
export interface SourceAssignmentsInput {
  readonly building?: string;
  readonly nativeDiscipline?: string;
  /** Site-defined fields, in the order the author wrote them. */
  readonly custom?: ReadonlyArray<ProfileMapEntry>;
}

/** One profile-level assignment rule as a profile spells it (P0-8). */
export interface SourceAssignmentRuleInput {
  readonly scope: SourceAssignmentScope;
  readonly match: string;
  readonly assign: SourceAssignmentsInput;
}

/**
 * One rule's assignments in the shape the asset catalog reads.
 *
 * A blank standard field is dropped rather than assigned: a half-typed row must
 * not be able to assign an empty building to a whole file.
 */
export function migrateSourceAssignments(input: SourceAssignmentsInput): SourceAssignments {
  const assignments: {
    building?: string;
    nativeDiscipline?: string;
    custom?: ReadonlyMap<string, string>;
  } = {};
  if (input.building !== undefined && input.building !== '') {
    assignments.building = input.building;
  }
  if (input.nativeDiscipline !== undefined && input.nativeDiscipline !== '') {
    assignments.nativeDiscipline = input.nativeDiscipline;
  }
  if (input.custom !== undefined && input.custom.length > 0) {
    assignments.custom = new Map(
      input.custom.map((entry) => [entry.key, entry.value] as const).reverse(),
    );
  }
  return assignments;
}

/** {@link migrateSourceAssignments} over a whole rule list. */
export function migrateSourceAssignmentRules(
  input: ReadonlyArray<SourceAssignmentRuleInput>,
): ReadonlyArray<SourceAssignmentRule> {
  return input.map((rule) => ({
    scope: rule.scope,
    match: rule.match,
    assign: migrateSourceAssignments(rule.assign),
  }));
}

/* ------------------------------------------------ carried, not yet enforced */

/**
 * Which evidence a site declares authoritative for one field.
 *
 * **Carried, not enforced.** The precedence the engine applies is fixed by P0-8
 * (object property > source-model > logical source > confirmed filename
 * pattern) and by §6.5 (a mapped, non-blank property outranks a learned
 * assignment); nothing in this list changes it. It exists because "authority
 * rules" is one of the things a site writes down and sends to another site, and
 * because a stated belief that disagrees with what the engine did is exactly
 * the disagreement a reviewer needs to see. A future milestone that makes the
 * precedence configurable will read this; until then it is a note that travels.
 */
export interface AuthorityRule {
  /** A mapped property field name, or a derived attribute id. */
  readonly field: string;
  /** Where the site says the truth for that field lives. */
  readonly authority: 'model' | 'mel' | 'manual' | 'learned';
  /** Why, in the site's own words. */
  readonly note?: string;
}

/**
 * One thing the site expects its own profile to do.
 *
 * **Carried, not executed.** The plan lists "profile test examples" as a V2
 * section; this is the honest minimum of one — a sentence describing a case and
 * a sentence describing what should come out of it, so the expectation travels
 * with the rule set it is about. Nothing runs these. When a milestone makes
 * them executable it will replace `expectation` with something a machine can
 * check, and that is a change to this type rather than a new one.
 */
export interface ProfileTestExample {
  readonly description: string;
  readonly expectation: string;
}

/* ------------------------------------------------------------- the profile */

/**
 * One site's published rule set, whole (RELEASE-1.0-PLAN "SiteProfileV2").
 *
 * `formatVersion` is the discriminator every reader keys on: a stored revision,
 * an imported package or a hand-edited file is V2 when it says so and V1 when it
 * does not, and {@link migrateSiteProfileV1} is what makes the second case a
 * migration rather than a refusal.
 *
 * The optional-vs-empty split is deliberate and load-bearing. `tagAnatomy` and
 * `systemResolver` are absent when the site taught none, because "no anatomy" is
 * a state the engine behaves differently in. Every list section is present and
 * possibly empty, because "this site defined no derived attributes" is not a
 * different state from "this site defined zero of them", and an optional array
 * would give two spellings for one fact.
 */
/**
 * What a site has said about the SSM Audit gate (docs/ENGINE.md).
 *
 * One field, and deliberately only one: the rulebook is vendored from SSM-Audit
 * and pinned by parity, so a site does not get to reword a rule, re-grade its
 * severity, or add one. What it does get to say is "we know, and we do not want
 * to be told again" -- a rule whose findings are true of this site by design
 * (an electrical practice, a site-specific classification code) and which would
 * otherwise bury the queue.
 *
 * A disabled rule still runs. Its findings are dropped and it is listed as off,
 * so the rules screen can say what is being hidden and the count of checks
 * performed stays comparable between compiles.
 */
export interface SsmAuditConfig {
  /** Rule ids, e.g. `metadata.misc-upn-review`. Unknown ids are ignored. */
  readonly disabledRuleIds: ReadonlyArray<string>;
}

export interface SiteProfileV2 {
  readonly formatVersion: 2;
  readonly profileId: string;
  readonly name: string;
  /** Monotonic. A profile is republished, never edited in place. */
  readonly version: number;

  /** Which extracted property plays which role, as chains with per-source overrides (P0-8). */
  readonly propertyMappings: PropertyMappingsInput;
  /** What whole documents assert, when no object property says otherwise (P0-8). */
  readonly sourceAssignments: ReadonlyArray<SourceAssignmentRuleInput>;
  /** Which model objects become commissionable equipment (PRODUCT.md §6.6). */
  readonly assetFilters: AssetFilterConfig;
  /** How a tag decomposes. Absent when the site has taught none. */
  readonly tagAnatomy?: TagAnatomyConfig;
  /** Where a system key and its description come from. Absent when unconfigured. */
  readonly systemResolver?: SystemResolverConfig;
  /** The site's own attribute registry (P0-7). */
  readonly derivedAttributes: ReadonlyArray<DerivedAttributeDefinitionInput>;

  /** The level stack, outermost first, in either spelling of a level (P0-6). */
  readonly hierarchy: HierarchyConfigInput;
  /** Which roles may parent which roles (PRODUCT.md §11.2). */
  readonly roleGraph: RoleGraphConfig;
  /** The parent candidate ladder's walk order (PRODUCT.md §11.1). */
  readonly ladder: ParentLadderConfig;
  /** Explicit `nativeDiscipline -> ssmDiscipline` rewrites. */
  readonly ssmDisciplineProjection: ReadonlyArray<DisciplineRewrite>;
  /** The model property naming an asset's parent outright, or `null`. */
  readonly parentTagProperty: PropertyRef | null;
  /**
   * The model property the site nominates as its stable asset id (P0-9 tier 1).
   *
   * A site-wide equipment number a person maintains outranks every model-borne
   * id, because it follows the equipment from one document to the next. `null`
   * means the tier never runs and identity starts at the authoring object id.
   */
  readonly stableIdProperty: PropertyRef | null;

  /** Aliases, tag normalization and the fuzzy distance (P0-9). */
  readonly identityConfig: ProfileIdentityConfig;
  /** Accepted parent/child pairs the site wrote down (§11.1 tier 3). */
  readonly profileLookup: ReadonlyArray<ParentPair>;
  /** Parent/child pairs from a previously accepted SSM (§11.1 tier 7). */
  readonly priorSsm: ReadonlyArray<ParentPair>;

  /** Which SSM Audit rules this site has switched off. */
  readonly ssmAudit: SsmAuditConfig;

  /** Stated, carried, not enforced. See {@link AuthorityRule}. */
  readonly authorityRules: ReadonlyArray<AuthorityRule>;
  /** Stated, carried, not executed. See {@link ProfileTestExample}. */
  readonly profileTestExamples: ReadonlyArray<ProfileTestExample>;
}

/**
 * The V2 sections a V1 profile could not carry, as a caller supplies them.
 *
 * Every field is optional and every omission has one honest default, listed on
 * {@link migrateSiteProfileV1}. This is how the desktop hands over the rows its
 * `config` table used to hold: the migration is a join, not a guess.
 */
export interface SiteProfileV2Sections {
  readonly hierarchy?: HierarchyConfigInput;
  readonly ssmAudit?: SsmAuditConfig;
  readonly roleGraph?: RoleGraphConfig;
  readonly ladder?: ParentLadderConfig;
  readonly ssmDisciplineProjection?: ReadonlyArray<DisciplineRewrite>;
  readonly parentTagProperty?: PropertyRef | null;
  readonly stableIdProperty?: PropertyRef | null;
  readonly derivedAttributes?: ReadonlyArray<DerivedAttributeDefinitionInput>;
  readonly sourceAssignments?: ReadonlyArray<SourceAssignmentRuleInput>;
  readonly identityConfig?: ProfileIdentityConfig;
  readonly profileLookup?: ReadonlyArray<ParentPair>;
  readonly priorSsm?: ReadonlyArray<ParentPair>;
  readonly authorityRules?: ReadonlyArray<AuthorityRule>;
  readonly profileTestExamples?: ReadonlyArray<ProfileTestExample>;
}

/** An empty identity configuration: no aliases, no normalization, default distance. */
export function emptyIdentityConfig(): ProfileIdentityConfig {
  return { tagNormalization: [], aliases: [] };
}

/**
 * A V1 profile plus whatever its project held elsewhere, as one V2 profile.
 *
 * The defaults are the ones that change nothing:
 *
 * - `hierarchy` defaults to **no levels**. A V1 profile stated none, and
 *   inventing a level stack here would file a site's equipment somewhere nobody
 *   chose. The desktop passes its own default preset in, which is where that
 *   decision has always been made.
 * - `ladder` defaults to `LADDER_SOURCE_ORDER_BEFORE_MEL_PARENT`, which is the
 *   walk order the compiler used when no ladder was supplied — the same
 *   behaviour, now written down. Deliberately not the current
 *   `LADDER_SOURCE_ORDER`: a rung added to the engine after a profile was
 *   written is a rung that profile never asked for, and a migration that turned
 *   one on would start seeding a live site's hierarchy from a source nobody
 *   chose.
 * - `ssmAudit` defaults to **no rule disabled**: a V1 profile predates the gate
 *   entirely, and a migration that switched a rule off would hide findings
 *   nobody chose to hide.
 * - every other section defaults to empty or `null`, which is what "the project
 *   never configured this" meant on the compiler input it arrived on.
 *
 * Idempotent in the sense that matters: running it on a V1 profile twice
 * produces equal V2 profiles, and `version` is carried across rather than
 * bumped — a migration is not a republication, and pretending otherwise would
 * make every stored revision look edited.
 */
export function migrateSiteProfileV1(
  v1: SiteProfile,
  sections: SiteProfileV2Sections = {},
): SiteProfileV2 {
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
    authorityRules: ReadonlyArray<AuthorityRule>;
    profileTestExamples: ReadonlyArray<ProfileTestExample>;
  } = {
    formatVersion: 2,
    profileId: v1.profileId,
    name: v1.name,
    version: v1.version,
    propertyMappings: v1.propertyMappings,
    sourceAssignments: sections.sourceAssignments ?? [],
    assetFilters: v1.assetFilters,
    derivedAttributes: sections.derivedAttributes ?? [],
    hierarchy: sections.hierarchy ?? { levels: [] },
    roleGraph: sections.roleGraph ?? { rules: [] },
    ladder: sections.ladder ?? { tiers: [...LADDER_SOURCE_ORDER_BEFORE_MEL_PARENT] },
    ssmDisciplineProjection: sections.ssmDisciplineProjection ?? [],
    parentTagProperty: sections.parentTagProperty ?? null,
    stableIdProperty: sections.stableIdProperty ?? null,
    identityConfig: sections.identityConfig ?? emptyIdentityConfig(),
    profileLookup: sections.profileLookup ?? [],
    priorSsm: sections.priorSsm ?? [],
    // Every rule on. A migration that silenced one would hide a finding the
    // site never asked to hide.
    ssmAudit: sections.ssmAudit ?? { disabledRuleIds: [] },
    authorityRules: sections.authorityRules ?? [],
    profileTestExamples: sections.profileTestExamples ?? [],
  };

  // Built key by key rather than spread: under `exactOptionalPropertyTypes` an
  // explicit `tagAnatomy: undefined` is not an absent key, and absent is what
  // "this site taught no anatomy" has to be.
  if (v1.tagAnatomy !== undefined) {
    profile.tagAnatomy = v1.tagAnatomy;
  }
  if (v1.systemResolver !== undefined) {
    profile.systemResolver = v1.systemResolver;
  }
  return profile;
}

/**
 * Whether a value announces itself as a V2 profile.
 *
 * A shape check on the discriminator and nothing else: the store's
 * `validateSiteProfileV2` is what decides whether the rest of it is readable,
 * and duplicating half of that here would give two answers to one question.
 */
export function isSiteProfileV2(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { formatVersion?: unknown }).formatVersion === 2
  );
}
