import type {
  AssetFilterConfig,
  NormalizationStep,
  SiteProfile,
  SystemResolverConfig,
  TagAnatomyConfig,
} from '@matchline/domain';

/**
 * The Dragon site's profile, as the setup wizard would publish it.
 *
 * This file exists to be type-checked: it is the proof that every E1 profile
 * section can actually be filled in, that the optional sections behave like
 * optionals under exactOptionalPropertyTypes, and that a section can be left
 * out entirely without the profile becoming unconstructible.
 */

/** `MAH001-10-01` -> role `MAH`, system `001`, family `001-10-01`. */
export const DRAGON_ANATOMY: TagAnatomyConfig = {
  separators: ['-'],
  ignoredSuffixes: ['-SPARE'],
  segments: {
    role: { kind: 'alphaPrefix', token: 0 },
    system: { kind: 'digitSuffix', token: 0 },
    unit: { kind: 'token', token: 1 },
    instance: { kind: 'token', token: 2 },
  },
  familyKeyTemplate: '{system}-{token:1}-{token:2}',
  localFamilyTemplate: '{tokens:1-2}',
};

/** Every normalization step, in the order the Dragon profile applies them. */
export const DRAGON_NORMALIZATION: ReadonlyArray<NormalizationStep> = [
  { kind: 'trim' },
  { kind: 'uppercase' },
  { kind: 'stripPrefix', prefix: 'UPN-' },
  { kind: 'padStart', length: 3, fill: '0' },
  { kind: 'alias', from: '1', to: '001' },
];

/** Every resolution component kind, so none of them is unconstructible. */
export const DRAGON_RESOLVER: SystemResolverConfig = {
  keyChain: [
    { kind: 'model-field', property: { category: 'Dragon Data', name: 'UPN' } },
    { kind: 'tag-segment', segment: 'system' },
    { kind: 'direct-column', property: { category: 'MEL', name: 'UPN' } },
    { kind: 'mel-lookup', joinBy: 'equipmentTag', returnField: 'systemKey' },
    { kind: 'composite', template: '{Building}-{system}' },
    { kind: 'manual' },
  ],
  descriptionChain: [
    { kind: 'mel-lookup', joinBy: 'systemKey', returnField: 'systemDescription' },
    { kind: 'model-field', property: { category: 'Dragon Data', name: 'Service' } },
  ],
  normalization: DRAGON_NORMALIZATION,
  conflictPolicy: 'review',
  labelTemplate: '{systemKey} {systemDescription}',
};

export const DRAGON_FILTERS: AssetFilterConfig = {
  includedClasses: ['Equipment'],
  excludedClasses: ['Solid', 'Terminal'],
  requireTagProperty: true,
  acceptedTagPatterns: ['AAA###-##-##'],
  selectionSetNames: ['Air Handling', 'PLC Panels'],
  includedSourceModelFiles: ['Dragon-Mechanical.nwc', 'Dragon-Controls.nwc'],
  collapseComponents: true,
  separatelyCommissionableClasses: ['Module'],
};

export const DRAGON_PROFILE: SiteProfile = {
  profileId: 'dragon',
  name: 'Dragon Coordination',
  version: 3,
  propertyMappings: {
    equipmentTag: { category: 'Dragon Data', name: 'Tag' },
    description: { category: 'Item', name: 'Name' },
    equipmentType: { category: 'Item', name: 'Type' },
    building: { category: 'Dragon Data', name: 'Building' },
    nativeDiscipline: { category: 'Dragon Data', name: 'Discipline' },
  },
  assetFilters: DRAGON_FILTERS,
  tagAnatomy: DRAGON_ANATOMY,
  systemResolver: DRAGON_RESOLVER,
};

/**
 * The smallest profile the types allow: one property mapping, the two filter
 * decisions a site cannot inherit, and no taught rules yet. This is what a
 * half-finished wizard run has to be able to save.
 */
export const DRAGON_MINIMAL_PROFILE: SiteProfile = {
  profileId: 'dragon-draft',
  name: 'Dragon Coordination (draft)',
  version: 1,
  propertyMappings: {
    equipmentTag: { category: 'Dragon Data', name: 'Tag' },
  },
  assetFilters: {
    requireTagProperty: false,
    collapseComponents: false,
  },
};
