/**
 * Reading a `SiteProfile` back out of stored JSON, field by field.
 *
 * A profile is hand-editable JSON by design (PRODUCT.md §13.3), so the project
 * file cannot assume the text it holds still matches the type -- someone may
 * have edited it, or it may predate a field. §13.3 also says every save
 * validates before publication, so `saveProfile` runs this same function on the
 * way in: a profile that cannot be read back is never written.
 */
import {
  emptyIdentityConfig,
  MAPPED_PROPERTY_FIELDS,
  migrateSiteProfileV1,
  type AssetFilterConfig,
  type AttributeResolverInput,
  type AuthorityRule,
  type HierarchyLevelConfig,
  type HierarchyLevelConfigInput,
  type LadderSourceKind,
  type ParentPair,
  type ProfileIdentityConfig,
  type ProfileMapEntry,
  type SiteProfileV2,
  type SourceAssignmentScope,
  type SourceAssignmentsInput,
  type SsmAuditConfig,
  type TagAlias,
  type MappedPropertyField,
  type MappedPropertyInput,
  type NormalizationStep,
  type PropertyChain,
  type PropertyMappingsInput,
  type PropertyRef,
  type SegmentExtractor,
  type SegmentName,
  type SiteProfile,
  type SourcePropertyChain,
  type SystemComponentConfig,
  type SystemResolverConfig,
  type TagAnatomyConfig,
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
  'unicodeFold',
] as const satisfies ReadonlyArray<NormalizationStep['kind']>;

const COMPONENT_KINDS = [
  'model-field',
  'tag-segment',
  'mel-lookup',
  'direct-column',
  'composite',
  'upn-from-tag',
  'exto-system-name',
  'manual',
] as const satisfies ReadonlyArray<SystemComponentConfig['kind']>;

function readPropertyRef(value: unknown, field: string): PropertyRef {
  const record = requireRecordAt(value, field, fail);
  return {
    category: requireStringAt(record['category'], `${field}.category`, fail),
    name: requireFilledStringAt(record['name'], `${field}.name`, fail),
  };
}

function readPropertyChain(value: unknown, field: string): PropertyChain {
  return requireArrayAt(value, field, fail).map((item, index) =>
    readPropertyRef(item, `${field}[${index}]`),
  );
}

/**
 * One mapped field, in whichever spelling the stored profile carries (P0-8).
 *
 * A record with a `chain` is a P0-8 mapping; anything else is read as the single
 * `PropertyRef` every profile before P0-8 wrote, and `migratePropertyMappings`
 * lifts it to a one-rung chain when an engine reads it. This function does NOT
 * lift: `saveProfile` stores what this returns, and rewriting a site's profile
 * into a spelling nobody asked for is not a validator's business.
 *
 * `bySource` is a list of `{sourceId, chain}` rather than an object, so the
 * order a profile author wrote survives and two sources cannot collide onto one
 * JSON key. The engine's own shape is a map; `migrateMappedProperty` converts.
 */
function readMappedProperty(value: unknown, field: string): MappedPropertyInput {
  const record = requireRecordAt(value, field, fail);
  if (record['chain'] === undefined) {
    return readPropertyRef(value, field);
  }

  const chain = readPropertyChain(record['chain'], `${field}.chain`);
  const overrides = record['bySource'];
  if (overrides === undefined) {
    return { chain };
  }
  const bySource: ReadonlyArray<SourcePropertyChain> = requireArrayAt(
    overrides,
    `${field}.bySource`,
    fail,
  ).map((item, index) => {
    const at = `${field}.bySource[${index}]`;
    const entry = requireRecordAt(item, at, fail);
    return {
      sourceId: requireFilledStringAt(entry['sourceId'], `${at}.sourceId`, fail),
      chain: readPropertyChain(entry['chain'], `${at}.chain`),
    };
  });
  return { chain, bySource };
}

function readPropertyMappings(value: unknown, field: string): PropertyMappingsInput {
  const record = requireRecordAt(value, field, fail);

  const mappings: { -readonly [Field in MappedPropertyField]?: MappedPropertyInput } = {};
  // Walked from the domain's own list rather than restated field by field: a
  // mapping this function forgot would be validated away on the way in and
  // silently absent from every profile the store wrote back out.
  for (const key of MAPPED_PROPERTY_FIELDS) {
    const stored = record[key];
    if (stored !== undefined) {
      mappings[key] = readMappedProperty(stored, `${field}.${key}`);
    }
  }

  return {
    ...mappings,
    // The only mapping with no default: without a tag there is no identity, so
    // its absence is a failure rather than an omission.
    equipmentTag:
      mappings.equipmentTag ??
      readMappedProperty(record['equipmentTag'], `${field}.equipmentTag`),
  };
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
    case 'unicodeFold':
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
    case 'upn-from-tag':
      return { kind };
    case 'exto-system-name': {
      const component: {
        kind: 'exto-system-name';
        allowUniqueUpn: boolean;
        descriptionProperty?: PropertyRef;
      } = {
        kind,
        allowUniqueUpn: requireBooleanAt(
          record['allowUniqueUpn'],
          `${field}.allowUniqueUpn`,
          fail,
        ),
      };
      // Absent and `null` are the same decision — "read the description the
      // chain already found" — and canonical JSON round-trips an absent
      // optional as neither, so both have to be accepted here.
      const property = record['descriptionProperty'];
      if (property !== undefined && property !== null) {
        component.descriptionProperty = readPropertyRef(
          property,
          `${field}.descriptionProperty`,
        );
      }
      return component;
    }
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
    applyIcDisciplineRule?: boolean;
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
  // Absent is the reading a profile written before the rule existed needs, and
  // it is the reading the engine gives an absent flag: off. Stated, it is
  // stored as stated — a validator does not decide a site's rules for it.
  const applyIcDisciplineRule = record['applyIcDisciplineRule'];
  if (applyIcDisciplineRule !== undefined) {
    resolver.applyIcDisciplineRule = requireBooleanAt(
      applyIcDisciplineRule,
      `${field}.applyIcDisciplineRule`,
      fail,
    );
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
    propertyMappings: PropertyMappingsInput;
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

/* ------------------------------------------------------------ SiteProfileV2 */

/**
 * Reading a `SiteProfileV2` back, and lifting a stored V1 rather than refusing
 * it (RELEASE-1.0-PLAN "SiteProfileV2", gate 13 "no silent decision loss").
 *
 * The version discriminator is the whole read strategy. A row written before
 * the consolidation carries no `formatVersion`; it is read as a V1 by the
 * function above and lifted by `migrateSiteProfileV1`, so every revision a
 * project has ever stored stays readable and nothing has to be rewritten on
 * upgrade. A row that says `formatVersion: 2` is read section by section here.
 *
 * A lifted V1 arrives with no hierarchy, no role graph and no rules -- which is
 * the truth about it: those sections were never in the profile table. The
 * desktop's one-time merge is what joins them back on from the `config` table,
 * and it does that by writing a NEW revision, so the old one stays exactly as
 * the build that wrote it left it.
 */

const LADDER_SOURCES = [
  'manual',
  'explicit-model',
  'mel-parent',
  'profile-lookup',
  'flow-family',
  'family-role',
  'learned-description',
  'prior-ssm',
  'model-tree',
] as const satisfies ReadonlyArray<LadderSourceKind>;

const MISSING_VALUE_POLICIES = [
  'unassigned-group',
  'review',
  'provisional-root',
] as const satisfies ReadonlyArray<HierarchyLevelConfig['missingValuePolicy']>;

const LEVEL_SORTS = ['label', 'key'] as const satisfies ReadonlyArray<
  HierarchyLevelConfig['sort']
>;

const ASSIGNMENT_SCOPES = [
  'source-model',
  'logical-source',
  'filename-pattern',
] as const satisfies ReadonlyArray<SourceAssignmentScope>;

const RESOLVER_KINDS = [
  'model-property',
  'tag-segment',
  'source-assignment',
  'system-field',
  'composite',
  'mel-lookup',
  'manual',
] as const satisfies ReadonlyArray<AttributeResolverInput['kind']>;

const SYSTEM_FIELDS = ['systemKey', 'systemDescription', 'systemLabel'] as const;

const AUTHORITIES = ['model', 'mel', 'manual', 'learned'] as const satisfies ReadonlyArray<
  AuthorityRule['authority']
>;

function readEach<T>(
  value: unknown,
  field: string,
  read: (item: unknown, at: string) => T,
): ReadonlyArray<T> {
  return requireArrayAt(value, field, fail).map((item, index) =>
    read(item, `${field}[${index}]`),
  );
}

/** An absent list section means "this site stated none", never "unreadable". */
function readOptionalEach<T>(
  value: unknown,
  field: string,
  read: (item: unknown, at: string) => T,
): ReadonlyArray<T> {
  return value === undefined ? [] : readEach(value, field, read);
}

/**
 * The SSM Audit section: a list of rule ids, or nothing.
 *
 * Ids are not checked against the rulebook. A profile written against a newer
 * rulebook than this build carries names this build has never heard of, and
 * refusing to open the project over one would be a worse answer than ignoring
 * it -- which is what the audit itself does with an id it does not know.
 */
function readSsmAuditConfig(value: unknown): SsmAuditConfig {
  if (value === undefined) {
    return { disabledRuleIds: [] };
  }
  const record = requireRecordAt(value, 'profile.ssmAudit', fail);
  return {
    disabledRuleIds: readOptionalEach(
      record['disabledRuleIds'],
      'profile.ssmAudit.disabledRuleIds',
      (item, at) => requireFilledStringAt(item, at, fail),
    ),
  };
}

function readPropertyRefOrNull(value: unknown, field: string): PropertyRef | null {
  return value === undefined || value === null ? null : readPropertyRef(value, field);
}

/**
 * One level, in either spelling of its key attribute (P0-6).
 *
 * `attributeKey` is what screen 6 and every project file written before 1.0
 * call it; `keyAttributeKey` is the engine's name. Both are accepted and the
 * value is returned in the spelling it arrived in, because this is a validator
 * and rewriting a site's file into a spelling nobody asked for is not its job --
 * `migrateHierarchyConfig` is what normalizes on the way into the engine.
 */
function readHierarchyLevel(value: unknown, field: string): HierarchyLevelConfigInput {
  const record = requireRecordAt(value, field, fail);
  const common = {
    levelId: requireFilledStringAt(record['levelId'], `${field}.levelId`, fail),
    displayName: requireFilledStringAt(record['displayName'], `${field}.displayName`, fail),
    boundary: requireBooleanAt(record['boundary'], `${field}.boundary`, fail),
    missingValuePolicy: requireMemberAt(
      record['missingValuePolicy'],
      MISSING_VALUE_POLICIES,
      `${field}.missingValuePolicy`,
      fail,
    ),
    sort: requireMemberAt(record['sort'], LEVEL_SORTS, `${field}.sort`, fail),
  };
  const optional: { displayAttributeKey?: string; boundaryAttributeKey?: string } = {};
  const display = record['displayAttributeKey'];
  if (display !== undefined) {
    optional.displayAttributeKey = requireFilledStringAt(
      display,
      `${field}.displayAttributeKey`,
      fail,
    );
  }
  const boundaryKey = record['boundaryAttributeKey'];
  if (boundaryKey !== undefined) {
    optional.boundaryAttributeKey = requireFilledStringAt(
      boundaryKey,
      `${field}.boundaryAttributeKey`,
      fail,
    );
  }

  if (record['keyAttributeKey'] !== undefined) {
    return {
      ...common,
      ...optional,
      keyAttributeKey: requireFilledStringAt(
        record['keyAttributeKey'],
        `${field}.keyAttributeKey`,
        fail,
      ),
    };
  }
  return {
    ...common,
    ...optional,
    attributeKey: requireFilledStringAt(record['attributeKey'], `${field}.attributeKey`, fail),
  };
}

function readAttributeResolver(value: unknown, field: string): AttributeResolverInput {
  const record = requireRecordAt(value, field, fail);
  const kind = requireMemberAt(record['kind'], RESOLVER_KINDS, `${field}.kind`, fail);
  switch (kind) {
    case 'model-property':
      return { kind, chain: readPropertyChain(record['chain'], `${field}.chain`) };
    case 'tag-segment':
      return {
        kind,
        segment: requireMemberAt(record['segment'], SEGMENT_NAMES, `${field}.segment`, fail),
      };
    case 'source-assignment':
      return { kind, key: requireFilledStringAt(record['key'], `${field}.key`, fail) };
    case 'system-field':
      return {
        kind,
        field: requireMemberAt(record['field'], SYSTEM_FIELDS, `${field}.field`, fail),
      };
    case 'composite':
      return {
        kind,
        template: requireFilledStringAt(record['template'], `${field}.template`, fail),
      };
    case 'mel-lookup':
      return {
        kind,
        joinBy: requireMemberAt(
          record['joinBy'],
          ['equipmentTag'] as const,
          `${field}.joinBy`,
          fail,
        ),
        returnField: requireFilledStringAt(
          record['returnField'],
          `${field}.returnField`,
          fail,
        ),
      };
    case 'manual':
      return {
        kind,
        assignments: readEach(record['assignments'], `${field}.assignments`, (item, at) => {
          const entry = requireRecordAt(item, at, fail);
          return {
            assetId: requireFilledStringAt(entry['assetId'], `${at}.assetId`, fail),
            value: requireStringAt(entry['value'], `${at}.value`, fail),
          };
        }),
      };
    default: {
      const exhaustive: never = kind;
      return fail(`${field}.kind`, `unhandled resolver ${String(exhaustive)}`);
    }
  }
}

function readSourceAssignments(value: unknown, field: string): SourceAssignmentsInput {
  const record = requireRecordAt(value, field, fail);
  const assignments: {
    building?: string;
    nativeDiscipline?: string;
    custom?: ReadonlyArray<ProfileMapEntry>;
  } = {};
  const building = optionalStringAt(record['building'], `${field}.building`, fail);
  if (building !== undefined) {
    assignments.building = building;
  }
  const discipline = optionalStringAt(
    record['nativeDiscipline'],
    `${field}.nativeDiscipline`,
    fail,
  );
  if (discipline !== undefined) {
    assignments.nativeDiscipline = discipline;
  }
  if (record['custom'] !== undefined) {
    assignments.custom = readEach(record['custom'], `${field}.custom`, (item, at) => {
      const entry = requireRecordAt(item, at, fail);
      return {
        key: requireFilledStringAt(entry['key'], `${at}.key`, fail),
        value: requireStringAt(entry['value'], `${at}.value`, fail),
      };
    });
  }
  return assignments;
}

function readIdentityConfig(value: unknown, field: string): ProfileIdentityConfig {
  if (value === undefined) {
    return emptyIdentityConfig();
  }
  const record = requireRecordAt(value, field, fail);
  const config: {
    tagNormalization: ReadonlyArray<NormalizationStep>;
    aliases: ReadonlyArray<TagAlias>;
    fuzzyMaxDistance?: number;
  } = {
    tagNormalization: readOptionalEach(
      record['tagNormalization'],
      `${field}.tagNormalization`,
      readNormalizationStep,
    ),
    aliases: readOptionalEach(record['aliases'], `${field}.aliases`, (item, at) => {
      const entry = requireRecordAt(item, at, fail);
      return {
        from: requireFilledStringAt(entry['from'], `${at}.from`, fail),
        to: requireFilledStringAt(entry['to'], `${at}.to`, fail),
      };
    }),
  };
  const distance = record['fuzzyMaxDistance'];
  if (distance !== undefined) {
    config.fuzzyMaxDistance = requireIntegerAt(distance, `${field}.fuzzyMaxDistance`, fail);
  }
  return config;
}

function readParentPair(value: unknown, field: string): ParentPair {
  const record = requireRecordAt(value, field, fail);
  return {
    childTag: requireFilledStringAt(record['childTag'], `${field}.childTag`, fail),
    parentTag: requireFilledStringAt(record['parentTag'], `${field}.parentTag`, fail),
  };
}

/**
 * Validates an untyped value as a `SiteProfileV2`, lifting a stored V1.
 *
 * @throws ProjectStoreError `invalid-profile`, naming the field that failed.
 */
export function validateSiteProfileV2(value: unknown): SiteProfileV2 {
  const record = requireRecordAt(value, 'profile', fail);
  if (record['formatVersion'] === undefined) {
    // Everything a project stored before the consolidation. Read as what it is,
    // then lifted -- never refused, and never rewritten in place.
    return migrateSiteProfileV1(validateSiteProfile(value));
  }
  const formatVersion = requireIntegerAt(record['formatVersion'], 'profile.formatVersion', fail);
  if (formatVersion !== 2) {
    fail(
      'profile.formatVersion',
      `this build reads site profiles at format version 2, got ${String(formatVersion)}`,
    );
  }

  // The V1 half is read by the function that has always read it, so the two
  // cannot disagree about what a mapping or a filter set is.
  const v1 = validateSiteProfile(record);

  return migrateSiteProfileV1(v1, {
    hierarchy: {
      levels: readOptionalEach(
        requireRecordAt(record['hierarchy'] ?? {}, 'profile.hierarchy', fail)['levels'],
        'profile.hierarchy.levels',
        readHierarchyLevel,
      ),
    },
    roleGraph: {
      rules: readOptionalEach(
        requireRecordAt(record['roleGraph'] ?? {}, 'profile.roleGraph', fail)['rules'],
        'profile.roleGraph.rules',
        (item, at) => {
          const rule = requireRecordAt(item, at, fail);
          return {
            parentRole: requireFilledStringAt(rule['parentRole'], `${at}.parentRole`, fail),
            childRole: requireFilledStringAt(rule['childRole'], `${at}.childRole`, fail),
          };
        },
      ),
    },
    ladder: {
      tiers: readOptionalEach(
        requireRecordAt(record['ladder'] ?? {}, 'profile.ladder', fail)['tiers'],
        'profile.ladder.tiers',
        (item, at) => requireMemberAt(item, LADDER_SOURCES, at, fail),
      ),
    },
    ssmDisciplineProjection: readOptionalEach(
      record['ssmDisciplineProjection'],
      'profile.ssmDisciplineProjection',
      (item, at) => {
        const entry = requireRecordAt(item, at, fail);
        return {
          from: requireFilledStringAt(entry['from'], `${at}.from`, fail),
          to: requireStringAt(entry['to'], `${at}.to`, fail),
        };
      },
    ),
    parentTagProperty: readPropertyRefOrNull(
      record['parentTagProperty'],
      'profile.parentTagProperty',
    ),
    stableIdProperty: readPropertyRefOrNull(
      record['stableIdProperty'],
      'profile.stableIdProperty',
    ),
    derivedAttributes: readOptionalEach(
      record['derivedAttributes'],
      'profile.derivedAttributes',
      (item, at) => {
        const definition = requireRecordAt(item, at, fail);
        return {
          attributeId: requireFilledStringAt(
            definition['attributeId'],
            `${at}.attributeId`,
            fail,
          ),
          displayName: requireFilledStringAt(
            definition['displayName'],
            `${at}.displayName`,
            fail,
          ),
          resolverChain: readEach(
            definition['resolverChain'],
            `${at}.resolverChain`,
            readAttributeResolver,
          ),
        };
      },
    ),
    sourceAssignments: readOptionalEach(
      record['sourceAssignments'],
      'profile.sourceAssignments',
      (item, at) => {
        const rule = requireRecordAt(item, at, fail);
        return {
          scope: requireMemberAt(rule['scope'], ASSIGNMENT_SCOPES, `${at}.scope`, fail),
          match: requireFilledStringAt(rule['match'], `${at}.match`, fail),
          assign: readSourceAssignments(rule['assign'], `${at}.assign`),
        };
      },
    ),
    identityConfig: readIdentityConfig(record['identityConfig'], 'profile.identityConfig'),
    profileLookup: readOptionalEach(
      record['profileLookup'],
      'profile.profileLookup',
      readParentPair,
    ),
    priorSsm: readOptionalEach(record['priorSsm'], 'profile.priorSsm', readParentPair),
    // A revision written before the SSM Audit gate existed carries no section,
    // and an absent one means every rule is on -- which is what a profile that
    // never mentioned the gate always meant.
    ssmAudit: readSsmAuditConfig(record['ssmAudit']),
    authorityRules: readOptionalEach(
      record['authorityRules'],
      'profile.authorityRules',
      (item, at) => {
        const rule = requireRecordAt(item, at, fail);
        const authority: { field: string; authority: AuthorityRule['authority']; note?: string } =
          {
            field: requireFilledStringAt(rule['field'], `${at}.field`, fail),
            authority: requireMemberAt(
              rule['authority'],
              AUTHORITIES,
              `${at}.authority`,
              fail,
            ),
          };
        const note = optionalStringAt(rule['note'], `${at}.note`, fail);
        if (note !== undefined) {
          authority.note = note;
        }
        return authority;
      },
    ),
    profileTestExamples: readOptionalEach(
      record['profileTestExamples'],
      'profile.profileTestExamples',
      (item, at) => {
        const example = requireRecordAt(item, at, fail);
        return {
          description: requireFilledStringAt(
            example['description'],
            `${at}.description`,
            fail,
          ),
          expectation: requireFilledStringAt(
            example['expectation'],
            `${at}.expectation`,
            fail,
          ),
        };
      },
    ),
  });
}
