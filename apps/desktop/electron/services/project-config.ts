import { ATTRIBUTE_KEYS, type AttributeKey, type SsmDisciplineProjection } from '@matchline/compiler';
import {
  LADDER_SOURCE_ORDER,
  type HierarchyConfig,
  type HierarchyLevelConfig,
  type LadderSourceKind,
  type ParentLadderConfig,
  type PropertyRef,
  type RoleGraphConfig,
} from '@matchline/domain';

import type {
  WireAttributeChoice,
  WireConfigPatch,
  WireHierarchyLevel,
  WireLadderSource,
  WireProjectConfig,
} from '../../shared/schemas.js';

/**
 * The sections screens 6 and 7 configure, and the one conversion between their
 * wire shape and what `@matchline/compiler` takes on `CompileProjectInput`.
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
 * shape a profile section would eventually hold, and the portable profile
 * package (PRODUCT.md §13.3) carries them alongside the draft. When the domain
 * type grows these sections, this file becomes a move rather than a redesign.
 */

/**
 * The default preset: Building / SSM Discipline / System, boundary on all three
 * (DECISIONS.md #1 — hard boundaries, no feed-chain exception).
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
    boundary: true,
    missingValuePolicy: 'unassigned-group',
    sort: 'label',
  },
  {
    levelId: 'system',
    displayName: 'System',
    attributeKey: 'systemKey',
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
  };
}

/* ------------------------------------------------------------ wire -> domain */

export function toHierarchyConfig(config: WireProjectConfig): HierarchyConfig {
  const levels: HierarchyLevelConfig[] = config.hierarchy.levels.map((level) => ({
    levelId: level.levelId,
    displayName: level.displayName,
    attributeKey: level.attributeKey,
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
 * The level-attribute menu, with how many distinct values each one actually has.
 *
 * `distinctValueCount` is `null` when nothing has been compiled yet — a count
 * of zero would read as "this attribute is empty", which is a different claim.
 */
export function attributeChoices(
  distinctValues: ReadonlyMap<string, number> | null,
): readonly WireAttributeChoice[] {
  return ATTRIBUTE_KEYS.map((attributeKey: AttributeKey): WireAttributeChoice => {
    const description = ATTRIBUTE_DESCRIPTIONS[attributeKey];
    return {
      attributeKey,
      label: description.label,
      what: description.what,
      example: description.example,
      distinctValueCount: distinctValues === null ? null : (distinctValues.get(attributeKey) ?? 0),
    };
  });
}
