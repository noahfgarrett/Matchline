import { ATTRIBUTE_KEYS, type AttributeKey, type SsmDisciplineProjection } from '@matchline/compiler';
import {
  LADDER_SOURCE_ORDER,
  type AttributeResolver,
  type DerivedAttributeDefinition,
  type HierarchyConfig,
  type HierarchyLevelConfig,
  type LadderSourceKind,
  type ParentLadderConfig,
  type PropertyRef,
  type RoleGraphConfig,
  type SourceAssignmentRule,
  type SourceAssignments,
} from '@matchline/domain';
import { CONFIG_KEYS, type ConfigEntry, type ProjectStore } from '@matchline/project-store';

import {
  projectConfigSchema,
  type WireAttributeChoice,
  type WireAttributeResolver,
  type WireConfigPatch,
  type WireDerivedAttribute,
  type WireHierarchyLevel,
  type WireLadderSource,
  type WireProjectConfig,
  type WireSourceAssignmentRule,
} from '../../shared/schemas.js';

/**
 * The sections screens 6 and 7 configure: where they live in the project file,
 * and the one conversion between their wire shape and what
 * `@matchline/compiler` takes on `CompileProjectInput`.
 *
 * ## Why these are not part of the draft Site Profile
 *
 * `SiteProfile` in `@matchline/domain` carries property mappings, asset
 * filters, tag anatomy and the System Resolver — and nothing else.
 * `CompileProjectInput`'s own header says why: the hierarchy, the role graph,
 * the ladder, the discipline projection and the parent-tag property are
 * "configuration the Site Profile cannot yet carry", so the compiler takes them
 * as input rather than widening a shared domain type from the orchestrator.
 *
 * The desktop app keeps them together in {@link WireProjectConfig}, in the
 * shape a profile section would eventually hold. When the domain type grows
 * these sections, this file becomes a move rather than a redesign.
 *
 * ## Where they persist
 *
 * In the project file's `config` table, one row per section (schema v2, widened
 * in v3). That is the whole point of v2: before it these lived in the app's
 * machine-local state file keyed by project path, so moving or copying a
 * `.matchline` file silently reset the wizard to its defaults. A project file
 * now carries its own configuration, and the portable profile package
 * (PRODUCT.md §13.3) remains the way to carry it to a *different* project.
 *
 * The sixth section, `extoTemplate`, is not a wizard screen's — it is captured
 * in the exports view from the site's own registry workbook. It lives here
 * because it is configuration this project's EXTO export is written on, and
 * because it must travel with the file for the same reason the other five must.
 */

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

/** A project that has never been to screens 6-7. */
export function defaultProjectConfig(): WireProjectConfig {
  return {
    hierarchy: { levels: [...DEFAULT_HIERARCHY_LEVELS] },
    roleGraph: { rules: [] },
    ladder: { tiers: [...LADDER_SOURCE_ORDER] },
    ssmDisciplineProjection: [],
    parentTagProperty: null,
    // No captured layout: the EXTO export uses the engine's generic Rev21 map
    // until the site supplies a workbook of its own.
    extoTemplate: null,
    // A new project defines no attributes of its own and no assignment rules.
    // Empty is the truth, not a placeholder: the built-in attribute keys and an
    // object's own properties are what a project starts with.
    derivedAttributes: [],
    sourceAssignmentRules: [],
  };
}

/** Applies one screen's write. Sections the patch does not name are untouched. */
export function applyConfigPatch(
  config: WireProjectConfig,
  patch: WireConfigPatch,
): WireProjectConfig {
  return {
    hierarchy: patch.hierarchy ?? config.hierarchy,
    roleGraph: patch.roleGraph ?? config.roleGraph,
    ladder: patch.ladder ?? config.ladder,
    ssmDisciplineProjection: patch.ssmDisciplineProjection ?? config.ssmDisciplineProjection,
    parentTagProperty:
      patch.parentTagProperty === undefined ? config.parentTagProperty : patch.parentTagProperty,
    extoTemplate: patch.extoTemplate === undefined ? config.extoTemplate : patch.extoTemplate,
    derivedAttributes: patch.derivedAttributes ?? config.derivedAttributes,
    sourceAssignmentRules: patch.sourceAssignmentRules ?? config.sourceAssignmentRules,
  };
}

/* ---------------------------------------------------------- the config table */

/**
 * Every section as one object, or `null` when the project has none.
 *
 * `null` covers both "never configured" and "configured by something this build
 * cannot read": the caller treats them the same way, because the honest
 * response to either is to open the wizard on its defaults rather than to
 * half-apply a config and let a compile run against it.
 *
 * The sections are written together by {@link writeProjectConfig}, so the table
 * is either empty or complete; a partial table is corruption, and parsing the
 * whole thing at once is what notices.
 */
export function readProjectConfig(store: ProjectStore): WireProjectConfig | null {
  const entries = store.listConfig();
  if (entries.length === 0) {
    return null;
  }

  const byKey = new Map(entries.map((entry: ConfigEntry): [string, unknown] => [
    entry.key,
    entry.value,
  ]));
  const parsed = projectConfigSchema.safeParse({
    hierarchy: byKey.get('hierarchy'),
    roleGraph: byKey.get('roleGraph'),
    ladder: byKey.get('ladder'),
    ssmDisciplineProjection: byKey.get('ssmDisciplineProjection'),
    parentTagProperty: byKey.get('parentTagProperty') ?? null,
    extoTemplate: byKey.get('extoTemplate') ?? null,
    // No `?? []`: the schema's own `.default([])` is what turns an absent key
    // into an empty list, and it is the one place that decision is made. A file
    // written before schema v6 has no row for either, which means the project
    // defines none.
    derivedAttributes: byKey.get('derivedAttributes'),
    sourceAssignmentRules: byKey.get('sourceAssignmentRules'),
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Writes every section in one transaction.
 *
 * All of them every time, rather than only the ones a patch named: the table's
 * meaning is "what this project is configured to", and a half-written table
 * would let a later read pick up six current sections and one stale one.
 */
export function writeProjectConfig(store: ProjectStore, config: WireProjectConfig): void {
  store.withTransaction((): void => {
    for (const key of CONFIG_KEYS) {
      store.saveConfig(key, config[key]);
    }
  });
}

/* ------------------------------------------------------------ wire -> domain */

/**
 * The wire levels as the engine's own shape (P0-6).
 *
 * `WireHierarchyLevel.attributeKey` is the level's KEY attribute — the name
 * screen 6 and the stored project file have always used for it — and it becomes
 * `keyAttributeKey` here. The two optional keys are passed through only when the
 * project states them, so a level that names neither collapses to exactly what
 * it was before the split: one attribute, grouping and comparing and labelling.
 */
export function toHierarchyConfig(config: WireProjectConfig): HierarchyConfig {
  const levels: HierarchyLevelConfig[] = config.hierarchy.levels.map((level) => ({
    levelId: level.levelId,
    displayName: level.displayName,
    keyAttributeKey: level.attributeKey,
    ...(level.displayAttributeKey === undefined
      ? {}
      : { displayAttributeKey: level.displayAttributeKey }),
    ...(level.boundaryAttributeKey === undefined
      ? {}
      : { boundaryAttributeKey: level.boundaryAttributeKey }),
    boundary: level.boundary,
    missingValuePolicy: level.missingValuePolicy,
    sort: level.sort,
  }));
  return { levels };
}

export function toRoleGraph(config: WireProjectConfig): RoleGraphConfig | null {
  if (config.roleGraph.rules.length === 0) {
    return null;
  }
  return { rules: config.roleGraph.rules.map((rule) => ({ ...rule })) };
}

/**
 * The ladder, or `null` to let the compiler use its own default.
 *
 * An empty `tiers` is not "no preference" — it would disable every rung and
 * root the whole site — so it is the one value that has to be refused rather
 * than passed through.
 */
export function toLadder(config: WireProjectConfig): ParentLadderConfig | null {
  const tiers: LadderSourceKind[] = config.ladder.tiers.map(
    (tier: WireLadderSource): LadderSourceKind => tier,
  );
  return tiers.length === 0 ? null : { tiers };
}

export function toDisciplineProjection(
  config: WireProjectConfig,
): SsmDisciplineProjection | null {
  if (config.ssmDisciplineProjection.length === 0) {
    return null;
  }
  const projection = new Map<string, string>();
  for (const rewrite of config.ssmDisciplineProjection) {
    projection.set(rewrite.from, rewrite.to);
  }
  return projection;
}

export function toParentTagProperty(config: WireProjectConfig): PropertyRef | null {
  const ref = config.parentTagProperty;
  return ref === null ? null : { category: ref.category, name: ref.name };
}

/** One wire resolver rung as the engine's own (P0-7). */
function toAttributeResolver(wire: WireAttributeResolver): AttributeResolver {
  switch (wire.kind) {
    case 'model-property':
      return { kind: 'model-property', chain: wire.chain.map((ref) => ({ ...ref })) };
    case 'tag-segment':
      return { kind: 'tag-segment', segment: wire.segment };
    case 'source-assignment':
      return { kind: 'source-assignment', key: wire.key };
    case 'system-field':
      return { kind: 'system-field', field: wire.field };
    case 'composite':
      return { kind: 'composite', template: wire.template };
    case 'mel-lookup':
      return { kind: 'mel-lookup', joinBy: wire.joinBy, returnField: wire.returnField };
    case 'manual':
      // The pairs become the map the engine reads. A later pair for one asset
      // loses to the earlier one, so the order the list was written in decides,
      // which is the same rule every other list on the wire follows.
      return {
        kind: 'manual',
        assignments: new Map(
          wire.assignments.map((entry) => [entry.assetId, entry.value] as const).reverse(),
        ),
      };
    default: {
      const exhaustive: never = wire;
      throw new Error(`unhandled attribute resolver: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * The project's derived attribute registry, or `null` when it defines none.
 *
 * `null` rather than `[]` so the caller leaves the key off `CompileProjectInput`
 * entirely — under `exactOptionalPropertyTypes` a present `undefined` is not an
 * absent key, and the compiler's other optional sections are all read that way.
 */
export function toDerivedAttributes(
  config: WireProjectConfig,
): ReadonlyArray<DerivedAttributeDefinition> | null {
  if (config.derivedAttributes.length === 0) {
    return null;
  }
  return config.derivedAttributes.map((definition) => ({
    attributeId: definition.attributeId,
    displayName: definition.displayName,
    resolverChain: definition.resolverChain.map(toAttributeResolver),
  }));
}

/** One rule's `assign`, with blanks left off rather than assigned as empty. */
function toAssignments(wire: WireSourceAssignmentRule['assign']): SourceAssignments {
  const assignments: {
    building?: string;
    nativeDiscipline?: string;
    custom?: ReadonlyMap<string, string>;
  } = {};
  if (wire.building !== '') {
    assignments.building = wire.building;
  }
  if (wire.nativeDiscipline !== '') {
    assignments.nativeDiscipline = wire.nativeDiscipline;
  }
  if (wire.custom.length > 0) {
    assignments.custom = new Map(
      wire.custom.map((entry) => [entry.key, entry.value] as const).reverse(),
    );
  }
  return assignments;
}

/** The profile-level assignment rules, or `null` when the project has none. */
export function toSourceAssignmentRules(
  config: WireProjectConfig,
): ReadonlyArray<SourceAssignmentRule> | null {
  if (config.sourceAssignmentRules.length === 0) {
    return null;
  }
  return config.sourceAssignmentRules.map((rule) => ({
    scope: rule.scope,
    match: rule.match,
    assign: toAssignments(rule.assign),
  }));
}

/* ------------------------------------------------------------- attributes */

interface AttributeDescription {
  readonly label: string;
  readonly what: string;
  readonly example: string;
}

/**
 * Plain-language names for `@matchline/compiler`'s attribute keys.
 *
 * Keyed by `AttributeKey`, so a key added to the engine without a description
 * here stops this file compiling — a level the user can pick but not read is
 * worse than no level at all.
 */
const ATTRIBUTE_DESCRIPTIONS: Readonly<Record<AttributeKey, AttributeDescription>> = {
  canonicalTag: {
    label: 'Equipment tag',
    what: 'The tag itself. One group per piece of equipment — almost never what you want as a level.',
    example: 'MAH001-10-01',
  },
  description: {
    label: 'Description',
    what: 'The description property you mapped on screen 3.',
    example: 'Dragon Air Handling Unit',
  },
  equipmentType: {
    label: 'Equipment type',
    what: 'The type property you mapped on screen 3.',
    example: 'Air Handler',
  },
  building: {
    label: 'Building',
    what: 'Which building the model puts the equipment in.',
    example: 'D1',
  },
  nativeDiscipline: {
    label: 'Native discipline',
    what: 'The discipline exactly as the model spells it, before any rewrite.',
    example: 'I&C',
  },
  ssmDiscipline: {
    label: 'SSM Discipline',
    what: 'The commissioning discipline, after the rewrites you set on screen 7.',
    example: 'I&C becomes Mechanical',
  },
  systemKey: {
    label: 'System Key',
    what: 'The machine key the System Resolver settled on. Stable, so boundaries use it.',
    example: '001',
  },
  systemDescription: {
    label: 'System description',
    what: 'The words that go with the key. Rewording these must never move equipment.',
    example: 'Mechanical Dry Air Handling',
  },
  systemLabel: {
    label: 'System label',
    what: 'Key and description together, as the register prints it.',
    example: '001 Mechanical Dry Air Handling',
  },
};

/**
 * What one derived rung reads, in a sentence fragment (P0-7).
 *
 * The Composer shows a derived attribute beside the built-ins, and a row whose
 * only description is "derived" tells a person nothing about whether it is the
 * field they want. Naming the first rung's evidence is the shortest honest
 * answer to "where does this come from?".
 */
function describeResolver(resolver: WireAttributeResolver): string {
  switch (resolver.kind) {
    case 'model-property': {
      const first = resolver.chain[0];
      return first === undefined
        ? 'a model property (none chosen yet)'
        : `the model property ${first.category} > ${first.name}`;
    }
    case 'tag-segment':
      return `the tag's ${resolver.segment} segment`;
    case 'source-assignment':
      return `the source assignment "${resolver.key}"`;
    case 'system-field':
      return `the resolved ${resolver.field}`;
    case 'composite':
      return `the template ${resolver.template}`;
    case 'mel-lookup':
      return `the MEL's ${resolver.returnField}, joined by equipment tag`;
    case 'manual':
      return 'a table somebody filled in by hand';
    default: {
      const exhaustive: never = resolver;
      throw new Error(`unhandled attribute resolver: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * The level-attribute menu, with how many distinct values each one actually has.
 *
 * Built-ins first, in `ATTRIBUTE_KEYS` order, then the project's own derived
 * attributes in the order it defines them (P0-7). Both are addressable by a
 * level in exactly the same way, so both belong in one menu — a derived
 * attribute a person cannot pick is a registry nobody can use.
 *
 * `distinctValueCount` is `null` when nothing has been compiled yet — a count
 * of zero would read as "this attribute is empty", which is a different claim.
 */
export function attributeChoices(
  distinctValues: ReadonlyMap<string, number> | null,
  derived: ReadonlyArray<WireDerivedAttribute> = [],
): readonly WireAttributeChoice[] {
  const countOf = (key: string): number | null =>
    distinctValues === null ? null : (distinctValues.get(key) ?? 0);

  const builtIn = ATTRIBUTE_KEYS.map((attributeKey: AttributeKey): WireAttributeChoice => {
    const description = ATTRIBUTE_DESCRIPTIONS[attributeKey];
    return {
      attributeKey,
      label: description.label,
      what: description.what,
      example: description.example,
      distinctValueCount: countOf(attributeKey),
    };
  });

  const siteDefined = derived.map((definition): WireAttributeChoice => {
    const first = definition.resolverChain[0];
    return {
      attributeKey: definition.attributeId,
      label: definition.displayName,
      what:
        'An attribute this project derives. The first rung of its chain that ' +
        'states a value wins; an asset no rung answers for simply has none.',
      // Reads as a phrase on its own in the chip hint, and after the level
      // card's "Example: " prefix. Once something has been compiled the chip
      // shows the distinct-value count instead.
      example:
        first === undefined
          ? 'no rungs configured yet, so this resolves for nobody'
          : `resolved from ${describeResolver(first)}`,
      distinctValueCount: countOf(definition.attributeId),
    };
  });

  return [...builtIn, ...siteDefined];
}
