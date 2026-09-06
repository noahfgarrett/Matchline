import { ssmDisciplineOf } from '@matchline/compiler';
import type { MelCatalogRow } from '@matchline/system-resolver';

import { BOUNDARY_MISSING_LIMIT } from '../../shared/schemas.js';
import type {
  WireDerivedAttribute,
  WireHierarchyConfig,
  WireHierarchyLevel,
  WireHierarchyNote,
  WireHierarchyProjection,
  WireHierarchyProjectionLevel,
} from '../../shared/schemas.js';

import { resolveDerived, type DerivedPreviewSubject } from './derived-preview.js';

/**
 * What a level stack would do to the assets this project already has, before
 * anybody publishes it (audit blocker B3).
 *
 * ## Why it exists
 *
 * The default stack makes Building and System boundaries. On a model that
 * states neither — which is most Revit federations before a profile is
 * written — every asset is unknown at both, a boundary refuses to nest across
 * unknown, and the compile succeeds with every asset a root under
 * `(unassigned)`. Nothing said so until screen 8's completeness report, which
 * is after the publish. These are the same counts, on the same draft, one
 * screen earlier.
 *
 * ## It resolves attributes the way the compiler does, and does not restate it
 *
 * `@matchline/compiler` owns `attributesFor` and does not export it, for the
 * reason `derived-preview.ts` sets out. What IS exported is `ssmDisciplineOf`,
 * which is the only built-in attribute with a rule in it, and it is called
 * rather than copied. The rest are catalog fields read straight off the asset
 * and the three system fields read off what the resolver settled on — the same
 * `DerivedPreviewSubject` the derived-attribute preview is built from, so a
 * level addressing a derived attribute and the attribute's own preview can
 * never disagree.
 *
 * Blank is not a value, and missing stays missing (ENGINE.md binding rule 4):
 * an asset that states nothing at a level is counted in `assetsWithoutValue`
 * and is not given a bucket to share with every other asset nobody located.
 */

/** Every built-in level attribute, resolved for one asset. */
function builtInAttributesOf(
  context: DerivedPreviewSubject,
  disciplineProjection: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const { asset, system } = context;
  const attributes = new Map<string, string>();
  const put = (key: string, value: string | undefined): void => {
    const trimmed = value?.trim() ?? '';
    if (trimmed !== '') {
      attributes.set(key, trimmed);
    }
  };

  put('canonicalTag', asset.canonicalTag);
  put('description', asset.description);
  put('equipmentType', asset.equipmentType);
  put('building', asset.building);
  put('nativeDiscipline', asset.nativeDiscipline);
  put('ssmDiscipline', ssmDisciplineOf(asset.nativeDiscipline, disciplineProjection));

  if (system !== null) {
    put('systemKey', system.systemKey);
    put('systemDescription', system.systemDescription);
    put('systemLabel', system.systemLabel);
  }
  return attributes;
}

/**
 * The counts, level by level.
 *
 * A boundary level is measured on what it COMPARES — `boundaryAttributeKey`
 * when the level names one — because that is the field the fold refuses to nest
 * across, and measuring it on its display key would report a site as complete
 * while every parent was being demoted. This is the rule `buildCompleteness`
 * follows, restated here for the one reason it must be: the compiler's version
 * runs after the compile.
 */
export function buildHierarchyProjection(
  levels: readonly WireHierarchyLevel[],
  contexts: readonly DerivedPreviewSubject[],
  derivedDefinitions: readonly WireDerivedAttribute[],
  disciplineProjection: ReadonlyMap<string, string>,
  melByAsset: ReadonlyMap<string, readonly MelCatalogRow[]>,
): WireHierarchyProjection {
  if (levels.length === 0) {
    return {
      state: 'blocked',
      reason: 'This profile has no hierarchy levels, so there is nothing to group by yet.',
    };
  }

  const measured = levels.map((level) => ({
    level,
    attributeKey: level.boundary
      ? (level.boundaryAttributeKey ?? level.attributeKey)
      : level.attributeKey,
    distinct: new Set<string>(),
    without: 0,
  }));

  const definitionById = new Map(
    derivedDefinitions.map((definition) => [definition.attributeId, definition] as const),
  );

  for (const context of contexts) {
    const builtIn = builtInAttributesOf(context, disciplineProjection);
    for (const entry of measured) {
      const definition = definitionById.get(entry.attributeKey);
      const value =
        definition === undefined
          ? (builtIn.get(entry.attributeKey) ?? null)
          : resolveDerived(definition, context, melByAsset);
      if (value === null) {
        entry.without += 1;
        continue;
      }
      entry.distinct.add(value);
    }
  }

  return {
    state: 'ready',
    assetCount: contexts.length,
    levels: measured.map((entry): WireHierarchyProjectionLevel => ({
      levelId: entry.level.levelId,
      displayName: entry.level.displayName,
      attributeKey: entry.attributeKey,
      boundary: entry.level.boundary,
      distinctValueCount: entry.distinct.size,
      assetsWithoutValue: entry.without,
    })),
  };
}

/**
 * The stack Quick Setup proposes, with the boundary flags decided against this
 * project rather than against the fixture the preset was written for.
 *
 * The levels themselves never change — Building / SSM Discipline / System is
 * P0-5 and a wizard does not get to reorder a site's commissioning stack. What
 * changes is the one flag that can turn a register into a list of roots: a
 * level more than {@link BOUNDARY_MISSING_LIMIT} of the site cannot state is
 * proposed as a grouping instead, with the reason, so a person turning it back
 * on is doing it knowing what it costs.
 *
 * A projection that could not be computed leaves the preset exactly as it is:
 * "no tag property has been accepted yet" is not evidence that a boundary is
 * wrong.
 */
export function proposeHierarchy(
  preset: readonly WireHierarchyLevel[],
  projection: WireHierarchyProjection,
): { readonly hierarchy: WireHierarchyConfig; readonly notes: readonly WireHierarchyNote[] } {
  if (projection.state !== 'ready' || projection.assetCount === 0) {
    return { hierarchy: { levels: [...preset] }, notes: [] };
  }

  const byLevelId = new Map(projection.levels.map((level) => [level.levelId, level] as const));
  const notes: WireHierarchyNote[] = [];
  const levels = preset.map((level): WireHierarchyLevel => {
    const measured = byLevelId.get(level.levelId);
    if (!level.boundary || measured === undefined) {
      return level;
    }
    const share = measured.assetsWithoutValue / projection.assetCount;
    if (share <= BOUNDARY_MISSING_LIMIT) {
      notes.push({
        levelId: level.levelId,
        kept: true,
        note:
          `${level.displayName} stays structural: ${String(measured.assetsWithoutValue)} of ` +
          `${String(projection.assetCount)} assets state nothing for it, and it makes ` +
          `${String(measured.distinctValueCount)} groups.`,
      });
      return level;
    }
    notes.push({
      levelId: level.levelId,
      kept: false,
      note:
        `${level.displayName} is proposed as a grouping rather than a structural level: ` +
        `${String(measured.assetsWithoutValue)} of ${String(projection.assetCount)} assets ` +
        `state nothing for it (${String(Math.round(share * 100))}%). As a boundary it would ` +
        'refuse to nest every one of them and they would all become roots. Map the field, or ' +
        'turn the boundary back on yourself on screen 6.',
    });
    return { ...level, boundary: false };
  });

  return { hierarchy: { levels }, notes };
}
