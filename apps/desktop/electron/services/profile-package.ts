import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  profilePackageSchema,
  type WireDraftProfile,
  type WireExportResult,
  type WireProfilePackage,
  type WireProfileSection,
  type WireProjectConfig,
} from '../../shared/schemas.js';

/**
 * Screen 9: the portable Site Profile package (PRODUCT.md §13.3).
 *
 * A profile package is decisions and nothing else — no model files, no
 * spreadsheet rows, not even the file names of either. It is the artifact that
 * makes a second site's setup start from the first site's answers.
 *
 * It carries the screens 6-7 sections alongside the draft, and since schema v2
 * so does the `.matchline` file itself (`project-config.ts`). The two are not
 * redundant: the project file is how *this* project keeps its configuration
 * when it moves, and the package is how a *different* project starts from it.
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

export function buildPackage(
  draft: WireDraftProfile,
  config: WireProjectConfig,
  appVersion: string,
  exportedAt: string,
): WireProfilePackage {
  return { formatVersion: 1, exportedAt, appVersion, draft, config };
}

export function writePackage(
  draft: WireDraftProfile,
  config: WireProjectConfig,
  appVersion: string,
  exportedAt: string,
  absolutePath: string,
): WireExportResult {
  const parsed = profilePackageSchema.safeParse(
    buildPackage(draft, config, appVersion, exportedAt),
  );
  if (!parsed.success) {
    throw new ProfilePackageError(
      `This profile cannot be written as a package yet: ${parsed.error.message}`,
    );
  }

  const text = `${JSON.stringify(parsed.data, null, 2)}\n`;
  const bytes = Buffer.from(text, 'utf8');
  writeFileSync(absolutePath, bytes);
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
  if (!parsed.success) {
    throw new ProfilePackageError(
      `${fileName} is not a Matchline profile package this build understands: ${parsed.error.message}`,
    );
  }
  return parsed.data;
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
  draft: WireDraftProfile,
  config: WireProjectConfig,
): readonly WireProfileSection[] {
  const mappings = draft.propertyMappings;
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

  const filters = draft.assetFilters;
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

  const boundaries = config.hierarchy.levels.filter((level) => level.boundary);

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
      name: 'Asset filters',
      what: 'Which model objects become commissionable equipment.',
      configured: true,
      detail:
        filterNotes.length === 0
          ? 'Nothing is filtered out.'
          : `${sentence(listed(filterNotes, 4))}.`,
    },
    {
      name: 'Tag anatomy',
      what: 'How a tag decomposes into role, system and family.',
      configured: draft.tagAnatomy.segments.length > 0,
      detail:
        draft.tagAnatomy.segments.length === 0
          ? ''
          : `${listed(
              draft.tagAnatomy.segments.map((segment) => segment.segment),
              4,
            )} taught; family key ${draft.tagAnatomy.familyKeyTemplate === '' ? 'not set' : draft.tagAnatomy.familyKeyTemplate}.`,
    },
    {
      name: 'System Resolver',
      what: 'Where a system key and its description come from.',
      configured: draft.systemResolver.keyChain.length > 0,
      detail:
        draft.systemResolver.keyChain.length === 0
          ? ''
          : `${String(draft.systemResolver.keyChain.length)} key sources, ` +
            `${String(draft.systemResolver.descriptionChain.length)} description sources, ` +
            `conflicts ${draft.systemResolver.conflictPolicy === 'review' ? 'go to review' : 'settled by order'}.`,
    },
    {
      name: 'Hierarchy Composer',
      what: 'The level stack the register is grouped by.',
      configured: config.hierarchy.levels.length > 0,
      detail:
        config.hierarchy.levels.length === 0
          ? ''
          : `${config.hierarchy.levels.map((level) => level.displayName).join(' / ')}.`,
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
      configured: config.roleGraph.rules.length > 0,
      detail:
        config.roleGraph.rules.length === 0
          ? ''
          : `${String(config.roleGraph.rules.length)} taught pairings, e.g. ${
              config.roleGraph.rules[0]?.parentRole ?? ''
            } parents ${config.roleGraph.rules[0]?.childRole ?? ''}.`,
    },
    {
      name: 'Parent ladder',
      what: 'The order evidence is trusted in when picking a structural parent.',
      configured: config.ladder.tiers.length > 0,
      detail:
        config.ladder.tiers.length === 0
          ? 'Every rung disabled — nothing would nest.'
          : `${String(config.ladder.tiers.length)} of 8 rungs enabled, strongest first: ${listed(
              [...config.ladder.tiers],
              3,
            )}.`,
    },
    {
      name: 'SSM discipline rules',
      what: 'Rewrites from the model’s discipline to the commissioning one.',
      configured: config.ssmDisciplineProjection.length > 0,
      detail:
        config.ssmDisciplineProjection.length === 0
          ? 'No rewrites. SSM Discipline is the model’s own spelling.'
          : `${listed(
              config.ssmDisciplineProjection.map((rewrite) => `${rewrite.from} → ${rewrite.to}`),
              3,
            )}.`,
    },
    {
      name: 'Explicit model relationships',
      what: 'The model property that names an asset’s parent outright.',
      configured: config.parentTagProperty !== null,
      detail:
        config.parentTagProperty === null
          ? 'Not mapped. The ladder infers parentage from flow, family and roles instead.'
          : `${config.parentTagProperty.category} > ${config.parentTagProperty.name}.`,
    },
  ];
}
