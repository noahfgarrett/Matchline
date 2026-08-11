import { ATTRIBUTE_KEYS, type AttributeKey } from '@matchline/compiler';
import { CONFIG_KEYS, type ConfigEntry, type ProjectStore } from '@matchline/project-store';

import {
  legacyProjectConfigSchema,
  projectConfigSchema,
  type WireAttributeChoice,
  type WireAttributeResolver,
  type WireConfigPatch,
  type WireDerivedAttribute,
  type WireLegacyProjectConfig,
  type WireProjectConfig,
} from '../../shared/schemas.js';

/**
 * What is configuration of the PROJECT rather than of the site — and the reader
 * that finds the sections a pre-SiteProfileV2 project left in this table.
 *
 * ## What is left here, and why so little
 *
 * One section: the captured EXTO template. Everything else this table used to
 * hold — the hierarchy, the role graph, the ladder, the discipline projection,
 * the parent-tag property, the derived attributes, the assignment rules — is a
 * decision about how the SITE works, and a site's decisions are one document
 * now (RELEASE-1.0-PLAN "SiteProfileV2"; "Project-specific stays outside (e.g.
 * captured EXTO template)"). They live in the profile, they travel in the
 * profile package, and they are stored in the `profile` table as revisions.
 *
 * The EXTO template stays because it is not a rule: it is the layout of THIS
 * project's own registry workbook, captured in the exports view, and sending it
 * to another site would be sending them a sheet they do not use.
 *
 * ## The rows an older project still holds
 *
 * A project written before the consolidation has all eight rows. They are read
 * by {@link readLegacyProjectConfig}, merged into a new profile revision the
 * first time the project is opened (`project-session.ts`), and then removed by
 * {@link clearLegacyConfigSections}. The rows are never read by a compile again:
 * a value in two places is a value that can disagree with itself.
 */

/** A project that has captured no registry layout of its own. */
export function defaultProjectConfig(): WireProjectConfig {
  // No captured layout: the EXTO export uses the engine's generic Rev21 map
  // until the site supplies a workbook of its own.
  return { extoTemplate: null };
}

/** Applies one write. Sections the patch does not name are untouched. */
export function applyConfigPatch(
  config: WireProjectConfig,
  patch: WireConfigPatch,
): WireProjectConfig {
  return {
    extoTemplate: patch.extoTemplate === undefined ? config.extoTemplate : patch.extoTemplate,
  };
}

/* ---------------------------------------------------------- the config table */

/** The project's own configuration, or `null` when the table is empty. */
export function readProjectConfig(store: ProjectStore): WireProjectConfig | null {
  const entries = store.listConfig();
  if (entries.length === 0) {
    return null;
  }
  const byKey = configByKey(entries);
  const parsed = projectConfigSchema.safeParse({
    extoTemplate: byKey.get('extoTemplate') ?? null,
  });
  return parsed.success ? parsed.data : null;
}

function configByKey(entries: readonly ConfigEntry[]): ReadonlyMap<string, unknown> {
  return new Map(entries.map((entry: ConfigEntry): [string, unknown] => [entry.key, entry.value]));
}

/**
 * The profile sections a project written before SiteProfileV2 left in this
 * table, or `null` when it holds none.
 *
 * `null` covers both "this project was written by a build that already stored
 * them in the profile" and "these rows cannot be read": the caller treats them
 * the same way, because the honest response to either is to leave the profile
 * alone rather than half-merge a config nobody can vouch for.
 */
export function readLegacyProjectConfig(store: ProjectStore): WireLegacyProjectConfig | null {
  const entries = store.listConfig();
  if (entries.length === 0) {
    return null;
  }
  const byKey = configByKey(entries);
  // The five sections a pre-v2 table always wrote together. Absent means this
  // project has nothing to merge, which is not a failure.
  if (byKey.get('hierarchy') === undefined) {
    return null;
  }
  const parsed = legacyProjectConfigSchema.safeParse({
    hierarchy: byKey.get('hierarchy'),
    roleGraph: byKey.get('roleGraph'),
    ladder: byKey.get('ladder'),
    ssmDisciplineProjection: byKey.get('ssmDisciplineProjection'),
    parentTagProperty: byKey.get('parentTagProperty') ?? null,
    extoTemplate: byKey.get('extoTemplate') ?? null,
    derivedAttributes: byKey.get('derivedAttributes'),
    sourceAssignmentRules: byKey.get('sourceAssignmentRules'),
  });
  return parsed.success ? parsed.data : null;
}

/** The `config` keys that became profile sections. */
export const MOVED_CONFIG_KEYS = CONFIG_KEYS.filter((key) => key !== 'extoTemplate');

/**
 * Deletes the rows whose contents are now in the profile.
 *
 * Called only after the merged revision has been saved, and in the same
 * transaction as nothing else: a row removed before the profile that replaced it
 * was written would be a decision destroyed rather than moved.
 */
export function clearLegacyConfigSections(store: ProjectStore): void {
  store.withTransaction((): void => {
    for (const key of MOVED_CONFIG_KEYS) {
      store.deleteConfig(key);
    }
  });
}

/**
 * Puts an app-state legacy config back into the `config` table, verbatim.
 *
 * The one caller is the adoption path for a project configured by a build that
 * kept these sections in the installation's own state file. Writing them here
 * rather than merging them into the profile directly means there is ONE
 * migration into the profile — {@link readLegacyProjectConfig} plus the merge in
 * `project-session.ts` — instead of two that can disagree.
 */
export function writeLegacyProjectConfig(
  store: ProjectStore,
  config: WireLegacyProjectConfig,
): void {
  store.withTransaction((): void => {
    store.saveConfig('hierarchy', config.hierarchy);
    store.saveConfig('roleGraph', config.roleGraph);
    store.saveConfig('ladder', config.ladder);
    store.saveConfig('ssmDisciplineProjection', config.ssmDisciplineProjection);
    store.saveConfig('parentTagProperty', config.parentTagProperty);
    store.saveConfig('extoTemplate', config.extoTemplate);
    store.saveConfig('derivedAttributes', config.derivedAttributes);
    store.saveConfig('sourceAssignmentRules', config.sourceAssignmentRules);
  });
}

/** Writes the project's own configuration. */
export function writeProjectConfig(store: ProjectStore, config: WireProjectConfig): void {
  store.withTransaction((): void => {
    store.saveConfig('extoTemplate', config.extoTemplate);
  });
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
