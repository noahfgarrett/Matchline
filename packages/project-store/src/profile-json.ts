/**
 * Reading a `SiteProfile` back out of stored JSON, field by field.
 *
 * A profile is hand-editable JSON by design (PRODUCT.md §13.3), so the project
 * file cannot assume the text it holds still matches the type -- someone may
 * have edited it, or it may predate a field. §13.3 also says every save
 * validates before publication, so `saveProfile` runs this same function on the
 * way in: a profile that cannot be read back is never written.
 */
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

import { ProjectStoreError } from './errors.js';
import {
  optionalStringAt,
  requireArrayAt,
  requireBooleanAt,
  requireFilledStringAt,
  requireIntegerAt,
  requireMemberAt,
  requireRecordAt,
  requireStringArrayAt,
  requireStringAt,
  type Fail,
} from './validate.js';

const fail: Fail = (field, detail) => {
  throw new ProjectStoreError({ kind: 'invalid-profile', field, detail });
};

const SEGMENT_NAMES = [
  'role',
  'system',
  'unit',
  'instance',
] as const satisfies ReadonlyArray<SegmentName>;

const SEGMENT_EXTRACTOR_KINDS = [
  'alphaPrefix',
  'digitSuffix',
  'token',
  'tokenRange',
  'charRange',
] as const satisfies ReadonlyArray<SegmentExtractor['kind']>;

const NORMALIZATION_KINDS = [
  'trim',
  'uppercase',
  'stripPrefix',
  'padStart',
  'alias',
] as const satisfies ReadonlyArray<NormalizationStep['kind']>;

const COMPONENT_KINDS = [
  'model-field',
  'tag-segment',
  'mel-lookup',
  'direct-column',
  'composite',
  'manual',
] as const satisfies ReadonlyArray<SystemComponentConfig['kind']>;

function readPropertyRef(value: unknown, field: string): PropertyRef {
  const record = requireRecordAt(value, field, fail);
  return {
    category: requireStringAt(record['category'], `${field}.category`, fail),
    name: requireFilledStringAt(record['name'], `${field}.name`, fail),
  };
}

function readOptionalPropertyRef(value: unknown, field: string): PropertyRef | undefined {
  return value === undefined ? undefined : readPropertyRef(value, field);
}

function readPropertyMappings(value: unknown, field: string): PropertyMappings {
  const record = requireRecordAt(value, field, fail);
  const description = readOptionalPropertyRef(record['description'], `${field}.description`);
  const equipmentType = readOptionalPropertyRef(record['equipmentType'], `${field}.equipmentType`);
  const building = readOptionalPropertyRef(record['building'], `${field}.building`);
  const nativeDiscipline = readOptionalPropertyRef(
    record['nativeDiscipline'],
    `${field}.nativeDiscipline`,
  );

  const mappings: {
    equipmentTag: PropertyRef;
    description?: PropertyRef;
    equipmentType?: PropertyRef;
    building?: PropertyRef;
    nativeDiscipline?: PropertyRef;
  } = { equipmentTag: readPropertyRef(record['equipmentTag'], `${field}.equipmentTag`) };
  if (description !== undefined) {
    mappings.description = description;
  }
  if (equipmentType !== undefined) {
    mappings.equipmentType = equipmentType;
  }
  if (building !== undefined) {
    mappings.building = building;
  }
  if (nativeDiscipline !== undefined) {
    mappings.nativeDiscipline = nativeDiscipline;
  }
  return mappings;
}

function optionalStringArray(
  value: unknown,
  field: string,
): ReadonlyArray<string> | undefined {
  return value === undefined ? undefined : requireStringArrayAt(value, field, fail);
}

function readAssetFilters(value: unknown, field: string): AssetFilterConfig {
  const record = requireRecordAt(value, field, fail);
  const filters: {
    requireTagProperty: boolean;
    collapseComponents: boolean;
    includedClasses?: ReadonlyArray<string>;
    excludedClasses?: ReadonlyArray<string>;
    acceptedTagPatterns?: ReadonlyArray<string>;
    selectionSetNames?: ReadonlyArray<string>;
    includedSourceModelFiles?: ReadonlyArray<string>;
    separatelyCommissionableClasses?: ReadonlyArray<string>;
  } = {
    requireTagProperty: requireBooleanAt(
      record['requireTagProperty'],
      `${field}.requireTagProperty`,
      fail,
    ),
    collapseComponents: requireBooleanAt(
      record['collapseComponents'],
      `${field}.collapseComponents`,
      fail,
    ),
  };

  const optionalLists = [
    'includedClasses',
    'excludedClasses',
    'acceptedTagPatterns',
    'selectionSetNames',
    'includedSourceModelFiles',
    'separatelyCommissionableClasses',
  ] as const;
  for (const key of optionalLists) {
    const list = optionalStringArray(record[key], `${field}.${key}`);
    if (list !== undefined) {
      filters[key] = list;
    }
  }
  return filters;
}

function readSegmentExtractor(value: unknown, field: string): SegmentExtractor {
  const record = requireRecordAt(value, field, fail);
  const kind = requireMemberAt(record['kind'], SEGMENT_EXTRACTOR_KINDS, `${field}.kind`, fail);
  switch (kind) {
    case 'alphaPrefix':
    case 'digitSuffix':
    case 'token':
      return { kind, token: requireIntegerAt(record['token'], `${field}.token`, fail) };
    case 'tokenRange':
      return {
        kind,
        from: requireIntegerAt(record['from'], `${field}.from`, fail),
        to: requireIntegerAt(record['to'], `${field}.to`, fail),
      };
    case 'charRange':
      return {
        kind,
        token: requireIntegerAt(record['token'], `${field}.token`, fail),
        from: requireIntegerAt(record['from'], `${field}.from`, fail),
        to: requireIntegerAt(record['to'], `${field}.to`, fail),
      };
    default: {
      const exhaustive: never = kind;
      return fail(`${field}.kind`, `unhandled extractor ${String(exhaustive)}`);
    }
  }
}

function readTagAnatomy(value: unknown, field: string): TagAnatomyConfig {
  const record = requireRecordAt(value, field, fail);
  const segmentsRecord = requireRecordAt(record['segments'], `${field}.segments`, fail);
  const segments: { -readonly [K in SegmentName]?: SegmentExtractor } = {};
  for (const name of SEGMENT_NAMES) {
    const entry = segmentsRecord[name];
    if (entry !== undefined) {
      segments[name] = readSegmentExtractor(entry, `${field}.segments.${name}`);
    }
  }

  const anatomy: {
    separators: ReadonlyArray<string>;
    segments: Readonly<Partial<Record<SegmentName, SegmentExtractor>>>;
    ignoredSuffixes?: ReadonlyArray<string>;
    familyKeyTemplate?: string;
    localFamilyTemplate?: string;
  } = {
    separators: requireStringArrayAt(record['separators'], `${field}.separators`, fail),
    segments,
  };

  const ignoredSuffixes = optionalStringArray(
    record['ignoredSuffixes'],
    `${field}.ignoredSuffixes`,
  );
  if (ignoredSuffixes !== undefined) {
    anatomy.ignoredSuffixes = ignoredSuffixes;
  }
  const familyKeyTemplate = optionalStringAt(
    record['familyKeyTemplate'],
    `${field}.familyKeyTemplate`,
    fail,
  );
  if (familyKeyTemplate !== undefined) {
    anatomy.familyKeyTemplate = familyKeyTemplate;
  }
  const localFamilyTemplate = optionalStringAt(
    record['localFamilyTemplate'],
    `${field}.localFamilyTemplate`,
    fail,
  );
  if (localFamilyTemplate !== undefined) {
    anatomy.localFamilyTemplate = localFamilyTemplate;
  }
  return anatomy;
}

function readNormalizationStep(value: unknown, field: string): NormalizationStep {
  const record = requireRecordAt(value, field, fail);
  const kind = requireMemberAt(record['kind'], NORMALIZATION_KINDS, `${field}.kind`, fail);
  switch (kind) {
    case 'trim':
    case 'uppercase':
      return { kind };
    case 'stripPrefix':
      return { kind, prefix: requireStringAt(record['prefix'], `${field}.prefix`, fail) };
    case 'padStart':
      return {
        kind,
        length: requireIntegerAt(record['length'], `${field}.length`, fail),
        fill: requireStringAt(record['fill'], `${field}.fill`, fail),
      };
    case 'alias':
      return {
        kind,
        from: requireStringAt(record['from'], `${field}.from`, fail),
        to: requireStringAt(record['to'], `${field}.to`, fail),
      };
    default: {
      const exhaustive: never = kind;
      return fail(`${field}.kind`, `unhandled normalization ${String(exhaustive)}`);
    }
  }
}

function readSystemComponent(value: unknown, field: string): SystemComponentConfig {
  const record = requireRecordAt(value, field, fail);
  const kind = requireMemberAt(record['kind'], COMPONENT_KINDS, `${field}.kind`, fail);
  switch (kind) {
    case 'model-field':
    case 'direct-column':
      return { kind, property: readPropertyRef(record['property'], `${field}.property`) };
    case 'tag-segment':
      return {
        kind,
        segment: requireMemberAt(record['segment'], SEGMENT_NAMES, `${field}.segment`, fail),
      };
    case 'mel-lookup':
      return {
        kind,
        joinBy: requireMemberAt(
          record['joinBy'],
          ['equipmentTag', 'systemKey'] as const,
          `${field}.joinBy`,
          fail,
        ),
        returnField: requireMemberAt(
          record['returnField'],
          ['systemKey', 'systemDescription'] as const,
          `${field}.returnField`,
          fail,
        ),
      };
    case 'composite':
      return { kind, template: requireStringAt(record['template'], `${field}.template`, fail) };
    case 'manual':
      return { kind };
    default: {
      const exhaustive: never = kind;
      return fail(`${field}.kind`, `unhandled component ${String(exhaustive)}`);
    }
  }
}

function readSystemResolver(value: unknown, field: string): SystemResolverConfig {
  const record = requireRecordAt(value, field, fail);
  const readChain = (raw: unknown, name: string): ReadonlyArray<SystemComponentConfig> =>
    requireArrayAt(raw, name, fail).map((item, index) =>
      readSystemComponent(item, `${name}[${index}]`),
    );

  const resolver: {
    keyChain: ReadonlyArray<SystemComponentConfig>;
    descriptionChain: ReadonlyArray<SystemComponentConfig>;
    normalization: ReadonlyArray<NormalizationStep>;
    conflictPolicy: 'review' | 'precedence';
    labelTemplate?: string;
  } = {
    keyChain: readChain(record['keyChain'], `${field}.keyChain`),
    descriptionChain: readChain(record['descriptionChain'], `${field}.descriptionChain`),
    normalization: requireArrayAt(record['normalization'], `${field}.normalization`, fail).map(
      (item, index) => readNormalizationStep(item, `${field}.normalization[${index}]`),
    ),
    conflictPolicy: requireMemberAt(
      record['conflictPolicy'],
      ['review', 'precedence'] as const,
      `${field}.conflictPolicy`,
      fail,
    ),
  };

  const labelTemplate = optionalStringAt(
    record['labelTemplate'],
    `${field}.labelTemplate`,
    fail,
  );
  if (labelTemplate !== undefined) {
    resolver.labelTemplate = labelTemplate;
  }
  return resolver;
}

/**
 * Validates an untyped value as a `SiteProfile`.
 *
 * @throws ProjectStoreError `invalid-profile`, naming the field that failed.
 */
export function validateSiteProfile(value: unknown): SiteProfile {
  const record = requireRecordAt(value, 'profile', fail);
  const version = requireIntegerAt(record['version'], 'profile.version', fail);
  if (version < 0) {
    fail('profile.version', `expected a non-negative version, got ${String(version)}`);
  }

  const profile: {
    profileId: string;
    name: string;
    version: number;
    propertyMappings: PropertyMappings;
    assetFilters: AssetFilterConfig;
    tagAnatomy?: TagAnatomyConfig;
    systemResolver?: SystemResolverConfig;
  } = {
    profileId: requireFilledStringAt(record['profileId'], 'profile.profileId', fail),
    name: requireFilledStringAt(record['name'], 'profile.name', fail),
    version,
    propertyMappings: readPropertyMappings(record['propertyMappings'], 'profile.propertyMappings'),
    assetFilters: readAssetFilters(record['assetFilters'], 'profile.assetFilters'),
  };

  if (record['tagAnatomy'] !== undefined) {
    profile.tagAnatomy = readTagAnatomy(record['tagAnatomy'], 'profile.tagAnatomy');
  }
  if (record['systemResolver'] !== undefined) {
    profile.systemResolver = readSystemResolver(
      record['systemResolver'],
      'profile.systemResolver',
    );
  }
  return profile;
}
