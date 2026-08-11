import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  profilePackageSchema,
  profilePackageV1Schema,
  type WireDraftProfile,
  type WireExportResult,
  type WireLegacyProjectConfig,
  type WireProfilePackage,
  type WireProfilePackageV1,
  type WireProfileSection,
  type WireProjectConfig,
} from '../../shared/schemas.js';
import { emptyDraft } from './draft-profile.js';

/**
 * Screen 9: the portable Site Profile package, format version 2
 * (PRODUCT.md §13.3, RELEASE-1.0-PLAN "SiteProfileV2").
 *
 * A profile package is decisions and nothing else — no model files, no
 * spreadsheet rows, not even the file names of either. It is the artifact that
 * makes a second site's setup start from the first site's answers.
 *
 * ## One profile, not two halves
 *
 * A v1 package was `{draft, config}`, because the sections screens 6 and 7
 * configure could not live in a Site Profile. They can now, so a v2 package is
 * one `profile` — and the project's own configuration is deliberately NOT in it:
 * a captured EXTO template is the layout of one site's registry workbook, and
 * another site opening this package does not use that sheet.
 *
 * ## v1 imports migrate, never refused
 *
 * The load-bearing half. Every package a site has already exported says
 * `formatVersion: 1`, and a build that simply moved the literal to 2 would start
 * refusing all of them. {@link readPackage} recognizes both, and
 * {@link migrateProfilePackage} joins a v1's two halves into the one profile —
 * which is the same join `project-session.ts` does for a project's own `config`
 * table, because it is the same migration.
 *
 * The package is validated on the way out as well as on the way in: §13.3 says
 * every save validates before publication, and a package that cannot be read
 * back is never written.
 */

export class ProfilePackageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ProfilePackageError';
  }
}

/**
 * The package a v2 export writes.
 *
 * `projectConfig` is accepted and deliberately not written. It exists on the
 * signature because the caller has one and because leaving it off would make the
 * omission look like an oversight: a package carries the SITE's rule set, and
 * this project's captured registry layout is not part of that (the plan:
 * "Project-specific stays outside (e.g. captured EXTO template)").
 */
export function buildPackage(
  profile: WireDraftProfile,
  projectConfig: WireProjectConfig,
  appVersion: string,
  exportedAt: string,
): WireProfilePackage {
  void projectConfig;
  return { formatVersion: 2, exportedAt, appVersion, profile };
}

export function writePackage(
  profile: WireDraftProfile,
  projectConfig: WireProjectConfig,
  appVersion: string,
  exportedAt: string,
  absolutePath: string,
): WireExportResult {
  const parsed = profilePackageSchema.safeParse(
    buildPackage(profile, projectConfig, appVersion, exportedAt),
  );
  if (!parsed.success) {
    throw new ProfilePackageError(
      `This profile cannot be written as a package yet: ${parsed.error.message}`,
    );
  }

  const text = `${JSON.stringify(parsed.data, null, 2)}\n`;
  const bytes = Buffer.from(text, 'utf8');
  // Temp file then rename (app-store.ts uses the same pattern): a package is
  // usually written over the previous export of itself, and a half-written one
  // wearing that name would be read as a whole one.
  const temporaryPath = `${absolutePath}.tmp`;
  try {
    writeFileSync(temporaryPath, bytes);
    renameSync(temporaryPath, absolutePath);
  } catch (error: unknown) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
  return {
    written: true,
    path: absolutePath,
    byteSize: bytes.byteLength,
    note:
      'Profile package written. It carries decisions only — no model objects and no ' +
      'spreadsheet rows, so it is safe to send to another site.',
  };
}

export function readPackage(absolutePath: string): WireProfilePackage {
  const fileName = path.basename(absolutePath);

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(readFileSync(absolutePath, 'utf8'));
  } catch (error: unknown) {
    throw new ProfilePackageError(
      `${fileName} is not readable as JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const parsed = profilePackageSchema.safeParse(parsedJson);
  if (parsed.success) {
    return parsed.data;
  }

  // Not a v2. Before refusing, try the one shape that is not an error: a package
  // an earlier build wrote. "v1 imports migrate, never refused."
  const v1 = profilePackageV1Schema.safeParse(parsedJson);
  if (v1.success) {
    return migrateProfilePackage(v1.data);
  }

  throw new ProfilePackageError(
    `${fileName} is not a Matchline profile package this build understands: ${parsed.error.message}`,
  );
}

/**
 * A v1 package as one v2 package.
 *
 * The join is the whole migration: the draft's four sections and the config's
 * five become the one profile they always described together. Nothing is
 * dropped, including the sections a v1 config carried that the profile now owns
 * — `derivedAttributes` and `sourceAssignmentRules`, which schema v6 added and
 * which had nowhere else to go.
 *
 * `extoTemplate` is the one thing NOT carried across, and deliberately: a v2
 * package carries no project-specific configuration, and a template imported
 * into a project that has its own would silently replace it. The importing
 * project keeps whichever template it already captured.
 */
export function migrateProfilePackage(v1: WireProfilePackageV1): WireProfilePackage {
  return {
    formatVersion: 2,
    exportedAt: v1.exportedAt,
    appVersion: v1.appVersion,
    profile: mergeLegacyConfig(
      { ...emptyDraft(v1.draft.name), ...v1.draft },
      v1.config,
    ),
  };
}

/**
 * A profile plus the sections a pre-v2 `config` held, as one profile.
 *
 * Shared by the package importer and the project-open migration, because they
 * are the same join: two halves that travelled together by convention become one
 * value.
 *
 * A config section that STATES something wins, because the config is where those
 * sections were actually edited and the profile's copy of them is whatever a
 * default constructed. A section that states nothing — an empty level stack, an
 * empty ladder, a null property — loses, because a v1 config could predate the
 * section entirely and replacing a stated decision with silence is exactly the
 * silent loss gate 13 forbids.
 */
export function mergeLegacyConfig(
  profile: WireDraftProfile,
  config: WireLegacyProjectConfig,
): WireDraftProfile {
  return {
    ...profile,
    hierarchy:
      config.hierarchy.levels.length === 0
        ? profile.hierarchy
        : { levels: config.hierarchy.levels.map((level) => ({ ...level })) },
    roleGraph:
      config.roleGraph.rules.length === 0
        ? profile.roleGraph
        : { rules: config.roleGraph.rules.map((rule) => ({ ...rule })) },
    ladder:
      config.ladder.tiers.length === 0 ? profile.ladder : { tiers: [...config.ladder.tiers] },
    ssmDisciplineProjection:
      config.ssmDisciplineProjection.length === 0
        ? profile.ssmDisciplineProjection
        : config.ssmDisciplineProjection.map((rewrite) => ({ ...rewrite })),
    parentTagProperty:
      config.parentTagProperty === null
        ? profile.parentTagProperty
        : { ...config.parentTagProperty },
    derivedAttributes:
      config.derivedAttributes.length === 0
        ? profile.derivedAttributes
        : config.derivedAttributes.map((definition) => ({ ...definition })),
    sourceAssignments:
      config.sourceAssignmentRules.length === 0
        ? profile.sourceAssignments
        : config.sourceAssignmentRules.map((rule) => ({ ...rule })),
  };
}

/* ------------------------------------------------------------ the sections */

function listed(values: readonly string[], limit: number): string {
  return values.length <= limit
    ? values.join(', ')
    : `${values.slice(0, limit).join(', ')} and ${String(values.length - limit)} more`;
}

/** Sentence case for a detail built from lower-case fragments. */
function sentence(text: string): string {
  return text === '' ? '' : `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/**
 * What is configured and what is not, in the wizard's own words.
 *
 * The list is the visible half of PRODUCT.md §13.2. Sections this build does
 * not configure yet are deliberately absent rather than shown as permanently
 * unconfigured — a checklist item nothing can ever tick is noise.
 */
export function describeSections(
  profile: WireDraftProfile,
): readonly WireProfileSection[] {
  const mappings = profile.propertyMappings;
  const mapped = (
    [
      ['description', mappings.description],
      ['equipment type', mappings.equipmentType],
      ['building', mappings.building],
      ['discipline', mappings.nativeDiscipline],
    ] as const
  )
    .filter(([, ref]) => ref !== null)
    .map(([label]) => label);

  const filters = profile.assetFilters;
  const filterNotes: string[] = [];
  if (filters.requireTagProperty) {
    filterNotes.push('an equipment tag is required');
  }
  if (filters.includedClasses.length > 0) {
    filterNotes.push(`${String(filters.includedClasses.length)} classes included`);
  }
  if (filters.excludedClasses.length > 0) {
    filterNotes.push(`${String(filters.excludedClasses.length)} classes excluded`);
  }
  if (filters.collapseComponents) {
    filterNotes.push('components collapse into their equipment');
  }

  const boundaries = profile.hierarchy.levels.filter((level) => level.boundary);

  return [
    {
      name: 'Model property mappings',
      what: 'Which extracted property is the tag, the description, the building.',
      configured: mappings.equipmentTag !== null,
      detail:
        mappings.equipmentTag === null
          ? ''
          : `Tag from ${mappings.equipmentTag.category} > ${mappings.equipmentTag.name}` +
            (mapped.length === 0 ? '' : `, plus ${listed(mapped, 4)}.`),
    },
    {
      name: 'Stable asset identity',
      what: 'The site-wide asset number that follows equipment between documents.',
      configured: profile.stableIdProperty !== null,
      detail:
        profile.stableIdProperty === null
          ? 'Not mapped. Identity starts from the authoring object id instead.'
          : `${profile.stableIdProperty.category} > ${profile.stableIdProperty.name}.`,
    },
    {
      name: 'Asset filters',
      what: 'Which model objects become commissionable equipment.',
      configured: true,
      detail:
        filterNotes.length === 0
          ? 'Nothing is filtered out.'
          : `${sentence(listed(filterNotes, 4))}.`,
    },
    {
      name: 'Source assignments',
      what: 'What a whole file asserts when no object property says otherwise.',
      configured: profile.sourceAssignments.length > 0,
      detail:
        profile.sourceAssignments.length === 0
          ? 'No rules. Every value comes from the objects themselves.'
          : `${String(profile.sourceAssignments.length)} rules, e.g. ${
              profile.sourceAssignments[0]?.scope ?? ''
            } ${profile.sourceAssignments[0]?.match ?? ''}.`,
    },
    {
      name: 'Tag anatomy',
      what: 'How a tag decomposes into role, system and family.',
      configured: profile.tagAnatomy.segments.length > 0,
      detail:
        profile.tagAnatomy.segments.length === 0
          ? ''
          : `${listed(
              profile.tagAnatomy.segments.map((segment) => segment.segment),
              4,
            )} taught; family key ${profile.tagAnatomy.familyKeyTemplate === '' ? 'not set' : profile.tagAnatomy.familyKeyTemplate}.`,
    },
    {
      name: 'System Resolver',
      what: 'Where a system key and its description come from.',
      configured: profile.systemResolver.keyChain.length > 0,
      detail:
        profile.systemResolver.keyChain.length === 0
          ? ''
          : `${String(profile.systemResolver.keyChain.length)} key sources, ` +
            `${String(profile.systemResolver.descriptionChain.length)} description sources, ` +
            `conflicts ${profile.systemResolver.conflictPolicy === 'review' ? 'go to review' : 'settled by order'}.`,
    },
    {
      name: 'Derived attributes',
      what: 'Fields this site composes out of the evidence it already has.',
      configured: profile.derivedAttributes.length > 0,
      detail:
        profile.derivedAttributes.length === 0
          ? 'None. Levels group by the built-in attributes.'
          : `${listed(
              profile.derivedAttributes.map((definition) => definition.displayName),
              4,
            )}.`,
    },
    {
      name: 'Hierarchy Composer',
      what: 'The level stack the register is grouped by.',
      configured: profile.hierarchy.levels.length > 0,
      detail:
        profile.hierarchy.levels.length === 0
          ? ''
          : `${profile.hierarchy.levels.map((level) => level.displayName).join(' / ')}.`,
    },
    {
      name: 'Structural boundaries',
      what: 'Which levels equipment can never structurally nest across.',
      configured: boundaries.length > 0,
      detail:
        boundaries.length === 0
          ? 'No boundaries. Anything may nest under anything.'
          : `${boundaries.map((level) => level.displayName).join(', ')}.`,
    },
    {
      name: 'Role and relationship graph',
      what: 'Which roles may parent which other roles.',
      configured: profile.roleGraph.rules.length > 0,
      detail:
        profile.roleGraph.rules.length === 0
          ? ''
          : `${String(profile.roleGraph.rules.length)} taught pairings, e.g. ${
              profile.roleGraph.rules[0]?.parentRole ?? ''
            } parents ${profile.roleGraph.rules[0]?.childRole ?? ''}.`,
    },
    {
      name: 'Parent ladder',
      what: 'The order evidence is trusted in when picking a structural parent.',
      configured: profile.ladder.tiers.length > 0,
      detail:
        profile.ladder.tiers.length === 0
          ? 'Every rung disabled — nothing would nest.'
          : `${String(profile.ladder.tiers.length)} of 8 rungs enabled, strongest first: ${listed(
              [...profile.ladder.tiers],
              3,
            )}.`,
    },
    {
      name: 'SSM discipline rules',
      what: 'Rewrites from the model’s discipline to the commissioning one.',
      configured: profile.ssmDisciplineProjection.length > 0,
      detail:
        profile.ssmDisciplineProjection.length === 0
          ? 'No rewrites. SSM Discipline is the model’s own spelling.'
          : `${listed(
              profile.ssmDisciplineProjection.map((rewrite) => `${rewrite.from} → ${rewrite.to}`),
              3,
            )}.`,
    },
    {
      name: 'Explicit model relationships',
      what: 'The model property that names an asset’s parent outright.',
      configured: profile.parentTagProperty !== null,
      detail:
        profile.parentTagProperty === null
          ? 'Not mapped. The ladder infers parentage from flow, family and roles instead.'
          : `${profile.parentTagProperty.category} > ${profile.parentTagProperty.name}.`,
    },
  ];
}
