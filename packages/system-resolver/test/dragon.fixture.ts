/**
 * Dragon-site resolver fixtures (DECISIONS.md #6: all invented data is Dragon).
 *
 * Typed here rather than written inline in the .mjs tests so a config or MEL
 * row the tests lean on cannot drift out of what the domain types allow.
 */
import type { SystemResolverConfig, TagAnatomyConfig } from '@matchline/domain';

import type { ManualAssignments, MelCatalogRow, ResolverSubject } from '../dist/index.js';

/** Builds a subject property bag from `[category, name, value]` triples. */
export function props(
  entries: ReadonlyArray<readonly [string, string, string]>,
): ReadonlyMap<string, ReadonlyMap<string, string>> {
  const byCategory = new Map<string, Map<string, string>>();
  for (const [category, name, value] of entries) {
    let names = byCategory.get(category);
    if (names === undefined) {
      names = new Map<string, string>();
      byCategory.set(category, names);
    }
    names.set(name, value);
  }
  return byCategory;
}

/** The Dragon convention: `MAH001-10-01` -> MAH / 001 / 10 / 01. */
export const DRAGON_ANATOMY: TagAnatomyConfig = {
  separators: ['-'],
  segments: {
    role: { kind: 'alphaPrefix', token: 0 },
    system: { kind: 'digitSuffix', token: 0 },
    unit: { kind: 'token', token: 1 },
    instance: { kind: 'token', token: 2 },
  },
  familyKeyTemplate: '{system}-{token:1}-{token:2}',
};

/** The §5.4 air handler, with nothing but its tag. */
export const MAH001: ResolverSubject = {
  assetId: 'dragon-0001',
  canonicalTag: 'MAH001-10-01',
  sourceFile: 'Dragon-Mechanical.nwd',
  objectId: '41201',
  properties: props([['Item', 'Name', 'MAH001-10-01']]),
};

/** The §5.6 disagreement: the model says 002, the tag and the MEL say 001. */
export const MAH001_MODEL_SAYS_002: ResolverSubject = {
  assetId: 'dragon-0002',
  canonicalTag: 'MAH001-10-01',
  sourceFile: 'Dragon-Mechanical.nwd',
  objectId: '41202',
  properties: props([
    ['Item', 'Name', 'MAH001-10-01'],
    ['Dragon', 'UPN', '002'],
    ['Dragon', 'Area', 'B1'],
  ]),
};

/** A field written `UPN-001`, for the §5.5 stripPrefix safeguard. */
export const PLC001_PREFIXED: ResolverSubject = {
  assetId: 'dragon-0003',
  canonicalTag: 'PLC001-10-01',
  properties: props([['Dragon', 'UPN', 'UPN-001']]),
};

/** A field written `1`, for the §5.5 alias and padStart safeguards. */
export const VFD001_UNPADDED: ResolverSubject = {
  assetId: 'dragon-0004',
  canonicalTag: 'VFD001-10-01',
  properties: props([['Dragon', 'UPN', '  1  ']]),
};

/** An instrument in a different system, for family/determinism coverage. */
export const TIT603: ResolverSubject = {
  assetId: 'dragon-0005',
  canonicalTag: 'TIT603-20-04',
  properties: props([['Dragon', 'UPN', '603']]),
};

/** A tag the Dragon anatomy cannot segment at all. */
export const UNTAGGED: ResolverSubject = {
  assetId: 'dragon-0006',
  canonicalTag: 'SPARE',
  properties: props([]),
};

/** The §5.4 MEL: one system, described once. */
export const DRAGON_MEL: ReadonlyArray<MelCatalogRow> = [
  {
    equipmentTag: 'MAH001-10-01',
    systemKey: '001',
    systemDescription: 'Mechanical Dry Air Handling',
    sourceFile: 'Dragon-MEL.xlsx',
    sheet: 'MEL',
    row: 2,
  },
  {
    equipmentTag: 'TIT603-20-04',
    systemKey: '603',
    systemDescription: 'Process Temperature',
    sourceFile: 'Dragon-MEL.xlsx',
    sheet: 'MEL',
    row: 3,
  },
];

/** A messier MEL: repeats, a whitespace alias, a rival key, and junk rows. */
export const MESSY_MEL: ReadonlyArray<MelCatalogRow> = [
  { systemKey: '001', systemDescription: 'Mechanical Dry Air Handling', sheet: 'MEL', row: 2 },
  { systemKey: '001', systemDescription: 'Mech Dry Air Handling', sheet: 'MEL', row: 3 },
  { systemKey: ' 001', systemDescription: '  Mechanical Dry Air Handling  ', sheet: 'MEL', row: 4 },
  { systemKey: '001', sheet: 'MEL', row: 5 },
  { systemKey: '1', systemDescription: 'Utility Water', sheet: 'MEL', row: 6 },
  { systemKey: '   ', systemDescription: 'Nothing At All', sheet: 'MEL', row: 7 },
  { equipmentTag: 'MAH001-10-01', systemDescription: 'Orphan Description', sheet: 'MEL', row: 8 },
];

/**
 * A MEL that writes the system unpadded, the way a site's Excel export does
 * when the column was ever a number.
 */
export const UNPADDED_MEL: ReadonlyArray<MelCatalogRow> = [
  {
    equipmentTag: 'VFD001-10-01',
    systemKey: '1',
    systemDescription: 'Utility Water',
    sourceFile: 'Dragon-MEL.xlsx',
    sheet: 'MEL',
    row: 2,
  },
];

/** The same MEL having ALSO grown a padded `001` -- two genuinely distinct systems. */
export const COLLIDING_MEL: ReadonlyArray<MelCatalogRow> = [
  ...UNPADDED_MEL,
  {
    systemKey: '001',
    systemDescription: 'Mechanical Dry Air Handling',
    sourceFile: 'Dragon-MEL.xlsx',
    sheet: 'MEL',
    row: 3,
  },
];

/** §5.4: the tag names the system, the MEL supplies the description. */
export const TAG_THEN_MEL: SystemResolverConfig = {
  keyChain: [{ kind: 'tag-segment', segment: 'system' }],
  descriptionChain: [{ kind: 'mel-lookup', joinBy: 'systemKey', returnField: 'systemDescription' }],
  normalization: [],
  conflictPolicy: 'review',
};

/** §5.6: three rungs that can disagree. */
export const THREE_RUNG_KEY: SystemResolverConfig = {
  keyChain: [
    { kind: 'model-field', property: { category: 'Dragon', name: 'UPN' } },
    { kind: 'tag-segment', segment: 'system' },
    { kind: 'mel-lookup', joinBy: 'equipmentTag', returnField: 'systemKey' },
  ],
  descriptionChain: [{ kind: 'mel-lookup', joinBy: 'systemKey', returnField: 'systemDescription' }],
  normalization: [],
  conflictPolicy: 'review',
};

/** The same chain, with the profile explicitly saying "order decides". */
export const THREE_RUNG_KEY_PRECEDENCE: SystemResolverConfig = {
  ...THREE_RUNG_KEY,
  conflictPolicy: 'precedence',
};

/** The same chain with a `manual` rung sitting last -- position must not matter. */
export const THREE_RUNG_KEY_MANUAL_LAST: SystemResolverConfig = {
  ...THREE_RUNG_KEY,
  keyChain: [...THREE_RUNG_KEY.keyChain, { kind: 'manual' }],
};

/** §5.5: `UPN-001` -> `001`, stated as a profile step. */
export const STRIP_PREFIX_CONFIG: SystemResolverConfig = {
  keyChain: [{ kind: 'model-field', property: { category: 'Dragon', name: 'UPN' } }],
  descriptionChain: [],
  normalization: [{ kind: 'stripPrefix', prefix: 'UPN-' }],
  conflictPolicy: 'review',
};

/** §5.5: `1` -> `001` by explicit alias. */
export const ALIAS_CONFIG: SystemResolverConfig = {
  keyChain: [{ kind: 'model-field', property: { category: 'Dragon', name: 'UPN' } }],
  descriptionChain: [],
  normalization: [{ kind: 'alias', from: '1', to: '001' }],
  conflictPolicy: 'review',
};

/** §5.5: `1` -> `001` by explicit left-pad. */
export const PAD_CONFIG: SystemResolverConfig = {
  keyChain: [{ kind: 'model-field', property: { category: 'Dragon', name: 'UPN' } }],
  descriptionChain: [],
  normalization: [{ kind: 'padStart', length: 3, fill: '0' }],
  conflictPolicy: 'review',
};

/** No transforms at all: whatever the source wrote is what the key is. */
export const NO_NORMALIZATION: SystemResolverConfig = {
  keyChain: [{ kind: 'model-field', property: { category: 'Dragon', name: 'UPN' } }],
  descriptionChain: [],
  normalization: [],
  conflictPolicy: 'review',
};

/** A full trail: strip, uppercase, pad, alias -- every step recorded. */
export const FULL_TRAIL: SystemResolverConfig = {
  keyChain: [{ kind: 'model-field', property: { category: 'Dragon', name: 'UPN' } }],
  descriptionChain: [],
  normalization: [
    { kind: 'trim' },
    { kind: 'stripPrefix', prefix: 'UPN-' },
    { kind: 'uppercase' },
    { kind: 'padStart', length: 3, fill: '0' },
    { kind: 'alias', from: '001', to: '001' },
  ],
  conflictPolicy: 'review',
};

/** A `mel-lookup` on systemKey with no rung above it to supply the key. */
export const KEY_JOIN_FIRST: SystemResolverConfig = {
  keyChain: [{ kind: 'mel-lookup', joinBy: 'systemKey', returnField: 'systemKey' }],
  descriptionChain: [],
  normalization: [],
  conflictPolicy: 'review',
};

/** The same lookup, this time with the tag segment resolving the key first. */
export const KEY_JOIN_AFTER_TAG: SystemResolverConfig = {
  keyChain: [
    { kind: 'tag-segment', segment: 'system' },
    { kind: 'mel-lookup', joinBy: 'systemKey', returnField: 'systemKey' },
  ],
  descriptionChain: [],
  normalization: [],
  conflictPolicy: 'review',
};

/** §5.5 + §5.3: the model says `1`, the profile pads, and the MEL must still be found. */
export const PAD_THEN_MEL: SystemResolverConfig = {
  keyChain: [{ kind: 'model-field', property: { category: 'Dragon', name: 'UPN' } }],
  descriptionChain: [{ kind: 'mel-lookup', joinBy: 'systemKey', returnField: 'systemDescription' }],
  normalization: [{ kind: 'padStart', length: 3, fill: '0' }],
  conflictPolicy: 'review',
};

/** The same padding profile, with the MEL corroborating the key it joined on. */
export const PAD_KEY_CORROBORATION: SystemResolverConfig = {
  keyChain: [
    { kind: 'model-field', property: { category: 'Dragon', name: 'UPN' } },
    { kind: 'mel-lookup', joinBy: 'systemKey', returnField: 'systemKey' },
  ],
  descriptionChain: [],
  normalization: [{ kind: 'padStart', length: 3, fill: '0' }],
  conflictPolicy: 'review',
};

/** `{Area}-{SystemCode}` from §5.2: one model property, one tag segment. */
export const COMPOSITE_CONFIG: SystemResolverConfig = {
  keyChain: [{ kind: 'composite', template: '{prop:Dragon.Area}-{segment:system}' }],
  descriptionChain: [],
  normalization: [],
  conflictPolicy: 'review',
};

/** A composite naming a property the subject does not carry. */
export const COMPOSITE_MISSING_INPUT: SystemResolverConfig = {
  keyChain: [{ kind: 'composite', template: '{prop:Dragon.Building}-{segment:system}' }],
  descriptionChain: [],
  normalization: [],
  conflictPolicy: 'review',
};

/** A composite that is really a profile constant. */
export const COMPOSITE_LITERAL: SystemResolverConfig = {
  keyChain: [{ kind: 'composite', template: 'UNASSIGNED' }],
  descriptionChain: [],
  normalization: [],
  conflictPolicy: 'review',
};

/** A composite of model properties only: no derived input to drag the tier down. */
export const COMPOSITE_PROPS_ONLY: SystemResolverConfig = {
  keyChain: [{ kind: 'composite', template: '{prop:Dragon.Area}-{prop:Dragon.UPN}' }],
  descriptionChain: [],
  normalization: [],
  conflictPolicy: 'review',
};

/** A `direct-column` chain: the user pointed at one field and called it System. */
export const DIRECT_COLUMN: SystemResolverConfig = {
  keyChain: [{ kind: 'direct-column', property: { category: 'Dragon', name: 'UPN' } }],
  descriptionChain: [],
  normalization: [],
  conflictPolicy: 'review',
};

/** A site whose label is punctuated its own way. */
export const CUSTOM_LABEL: SystemResolverConfig = {
  ...TAG_THEN_MEL,
  labelTemplate: '{systemKey} / {systemDescription}',
};

/** Noah reassigned the disputed air handler by hand. */
export const MANUAL_650: ManualAssignments = new Map([
  ['dragon-0002', { systemKey: '650', note: 'field walkdown 2026-08-07' }],
]);

/** A manual description with no manual key: the human fills one gap only. */
export const MANUAL_DESCRIPTION_ONLY: ManualAssignments = new Map([
  ['dragon-0001', { systemDescription: 'Dry Air, North Bay' }],
]);
