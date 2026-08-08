import { EVIDENCE_TIER, type SystemResolution } from '@matchline/domain';

import type { GeneratedMelAsset } from '../dist/index.js';

/**
 * Assets from the invented Dragon site, typed here rather than written inline
 * in the .mjs tests so that the input the tests rely on cannot drift out of
 * what `GeneratedMelAsset` actually allows.
 *
 * The list is deliberately out of export order, and deliberately awkward: a
 * leading-zero system key, a duplicated tag, an asset whose system never
 * resolved, an asset whose system resolved to a label but no key, and one row
 * with nothing optional filled in at all.
 */

function dragonSystem(
  systemKey: string,
  systemLabel: string,
  systemDescription: string,
): SystemResolution {
  return {
    systemKey,
    systemDescription,
    systemLabel,
    systemEvidence: [
      {
        sourceFile: 'Dragon-MECH.nwd',
        sourceRef: { kind: 'model-object', objectId: '4021' },
        propertyOrColumn: 'System Name',
        rule: 'tag-segment:system',
        fallbackRung: 1,
      },
    ],
    systemConfidenceTier: EVIDENCE_TIER.MODEL,
    systemConflictStatus: 'AGREED',
  };
}

/** `001` — the key whose leading zeros must survive to the sheet. */
export const DRAGON_AIR_HANDLING: SystemResolution = dragonSystem(
  '001',
  'Dragon Air Handling',
  'Air handling for the Dragon process hall',
);

/** `002` — sorts after `001` by code unit. */
export const DRAGON_POWER: SystemResolution = dragonSystem(
  '002',
  'Dragon Power Distribution',
  'LV distribution to the Dragon annex',
);

/**
 * A resolution that produced a label but never a key. Its rows belong with the
 * unresolved block at the bottom of the sheet, not at the top under a blank.
 */
export const DRAGON_KEYLESS: SystemResolution = {
  systemKey: '',
  systemLabel: 'Dragon Utilities (unassigned)',
  systemEvidence: [],
  systemConfidenceTier: EVIDENCE_TIER.INFERRED,
  systemConflictStatus: 'UNRESOLVED',
};

/** The awkward set, in an order no export should preserve. */
export const DRAGON_ASSETS: ReadonlyArray<GeneratedMelAsset> = [
  {
    canonicalTag: 'EPB002-01-01',
    description: 'Annex panelboard',
    equipmentType: 'Panelboard',
    building: 'D-200',
    nativeDiscipline: 'ELEC',
    ssmDiscipline: 'Electrical',
    system: DRAGON_POWER,
    systemParentTag: 'ESB002-01',
    dependencyTags: ['ESB002-01'],
    sourceModelFile: 'Dragon-ELEC.nwd',
    modelObjectIds: [7],
    inclusionStatus: 'MODEL_CONFIRMED',
    parentEvidence: 'tag-family: EPB002-01-01 under ESB002-01',
    reviewStatus: 'ACCEPTED',
    modelRevisionSha256: 'b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a1',
  },
  {
    /* No system at all: the resolver never reached this one. */
    canonicalTag: 'FCU-SPARE-07',
    description: 'Spare fan coil unit',
    equipmentType: 'Fan Coil Unit',
    building: 'D-100',
    nativeDiscipline: 'MECH',
    ssmDiscipline: 'Mechanical',
    sourceModelFile: 'Dragon-MECH.nwd',
    modelObjectIds: [9, 10, 88],
    inclusionStatus: 'MODEL_ONLY',
    reviewStatus: 'UNREVIEWED',
  },
  {
    canonicalTag: 'MAH001-10-02',
    description: 'Secondary air handler',
    equipmentType: 'Air Handling Unit',
    building: 'D-100',
    nativeDiscipline: 'MECH',
    ssmDiscipline: 'Mechanical',
    system: DRAGON_AIR_HANDLING,
    dependencyTags: ['EPB002-01-01', 'CHW001-01-01'],
    sourceModelFile: 'Dragon-MECH.nwd',
    modelObjectIds: [12, 3, 101],
    inclusionStatus: 'MODEL_CONFIRMED',
    reviewStatus: 'UNREVIEWED',
    modelRevisionSha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
  },
  {
    /* First half of a duplicated model tag. Both objects are kept, never
       merged, and the pair must always emit in this order. */
    canonicalTag: 'MAH001-10-01',
    description: 'Primary air handler',
    system: DRAGON_AIR_HANDLING,
    sourceModelFile: 'Dragon-MECH.nwd',
    modelObjectIds: [4021],
    inclusionStatus: 'DUPLICATE_MODEL_TAG',
  },
  {
    /* Second half. Nothing optional beyond the model pointer is filled in, so
       every other column has to come out empty rather than 'undefined'. */
    canonicalTag: 'MAH001-10-01',
    system: DRAGON_AIR_HANDLING,
    sourceModelFile: 'Dragon-MECH-REV-B.nwd',
    modelObjectIds: [5150],
    inclusionStatus: 'DUPLICATE_MODEL_TAG',
  },
  {
    canonicalTag: 'CHW001-01-01',
    description: 'Chilled water pump',
    system: DRAGON_KEYLESS,
    sourceModelFile: 'Dragon-MECH.nwd',
    modelObjectIds: [64],
    inclusionStatus: 'MODEL_CONFIRMED',
  },
];

/** The tag order {@link DRAGON_ASSETS} must export in. */
export const DRAGON_EXPORT_TAG_ORDER: ReadonlyArray<string> = [
  'MAH001-10-01',
  'MAH001-10-01',
  'MAH001-10-02',
  'EPB002-01-01',
  'CHW001-01-01',
  'FCU-SPARE-07',
];

/**
 * The Dragon site's existing MEL, as a reader would hand it over: records under
 * the site's own column names, not §12.1's.
 *
 * Every case §12.3 has to survive is in here — an exact agreement, a
 * description the MEL words differently, a tag the site spells without its
 * leading zeros (accepted alias), a leading-zero mismatch on the UPN, an MEL
 * row for equipment Matchline never saw, a row with no tag at all, and a row
 * that simply has no UPN column value.
 */
export const DRAGON_EXISTING_MEL_ROWS: ReadonlyArray<Readonly<Record<string, string>>> = [
  {
    tag: 'MAH001-10-01',
    description: 'Primary air handler',
    upn: '001',
    system: 'Dragon Air Handling',
  },
  {
    /* Padded, because a real MEL cell is. Trimmed on both sides before matching. */
    tag: '  MAH001-10-02  ',
    description: 'Secondary air handling unit',
    upn: '001',
    system: 'Dragon Air Handling',
  },
  {
    /* The site's own spelling; only an accepted alias joins it. */
    tag: 'EPB002-1-1',
    description: 'Annex panelboard',
    upn: '2',
    system: 'Dragon Power Distribution',
  },
  {
    /* MEL_ONLY: discrepancy evidence, never an asset (§9.3). */
    tag: 'BLR001-01-01',
    description: 'Package boiler',
    upn: '004',
    system: 'Dragon Steam',
  },
  {
    /* No tag: unmatchable, and inventing a key would manufacture a discrepancy. */
    tag: '   ',
    description: 'Row the site never finished',
    upn: '001',
    system: 'Dragon Air Handling',
  },
  {
    /* No `upn` key at all: absent reads as blank, and Matchline's is blank too. */
    tag: 'CHW001-01-01',
    description: '',
    system: 'Dragon Utilities (unassigned)',
  },
];

/** The site's spelling → the canonical tag, as an accepted alias would record it. */
export const DRAGON_MEL_ALIASES: ReadonlyMap<string, string> = new Map([
  ['EPB002-1-1', 'EPB002-01-01'],
]);

/* ---- revision A → revision B ---- */

function revisionAsset(
  canonicalTag: string,
  systemKey: string,
  overrides: Partial<GeneratedMelAsset> = {},
): GeneratedMelAsset {
  return {
    canonicalTag,
    description: `Dragon ${canonicalTag}`,
    equipmentType: 'Equipment',
    building: 'D-100',
    nativeDiscipline: 'MECH',
    ssmDiscipline: 'Mechanical',
    system: dragonSystem(systemKey, `Dragon System ${systemKey}`, `System ${systemKey}`),
    sourceModelFile: 'Dragon-REV-A.nwd',
    modelObjectIds: [1],
    inclusionStatus: 'MODEL_CONFIRMED',
    reviewStatus: 'UNREVIEWED',
    ...overrides,
  };
}

/**
 * Revision A of the Dragon register.
 *
 * A and B differ by exactly one instance of each §12.4 category, and by nothing
 * else — every other field of every other asset is identical, so a category
 * that fires twice is a bug rather than a fixture accident.
 */
export const DRAGON_REVISION_A: ReadonlyArray<GeneratedMelAsset> = [
  /* Description changes in B. */
  revisionAsset('MAH001-10-01', '001', { description: 'Primary air handler' }),
  /* Loses CHW001-01-01 and gains PMP003-01-01 as dependencies in B. */
  revisionAsset('MAH001-10-02', '001', {
    dependencyTags: ['CHW001-01-01', 'EPB002-01-01'],
  }),
  /* Parent moves in B; its System Key does not. */
  revisionAsset('PLC001-10-01', '001', { systemParentTag: 'MAH001-10-01' }),
  /* Renamed in B — only a hint can say so. */
  revisionAsset('VFD001-10-01', '001', { systemParentTag: 'PLC001-10-01' }),
  /* SSM discipline changes in B: a hierarchy level, not a native fact. */
  revisionAsset('TIT001-10-01', '001', { systemParentTag: 'PLC001-10-01' }),
  /* System Key changes in B; its parent does not. */
  revisionAsset('CHW001-01-01', '001', { systemParentTag: 'MAH001-10-02' }),
  /* Building changes in B: the other hierarchy level. */
  revisionAsset('EPB002-01-01', '002', { building: 'D-200', ssmDiscipline: 'Electrical' }),
  /* Single here; duplicated in B. */
  revisionAsset('ESB002-01', '002', { ssmDiscipline: 'Electrical' }),
  /* Gone in B. */
  revisionAsset('FCU-SPARE-09', '001'),
];

/** Revision B: one of every §12.4 change, and nothing else. */
export const DRAGON_REVISION_B: ReadonlyArray<GeneratedMelAsset> = [
  revisionAsset('MAH001-10-01', '001', { description: 'Primary air handling unit' }),
  revisionAsset('MAH001-10-02', '001', {
    dependencyTags: ['EPB002-01-01', 'PMP003-01-01'],
  }),
  revisionAsset('PLC001-10-01', '001', { systemParentTag: 'MAH001-10-02' }),
  revisionAsset('VFD001-10-01A', '001', {
    description: 'Dragon VFD001-10-01',
    systemParentTag: 'PLC001-10-01',
  }),
  revisionAsset('TIT001-10-01', '001', {
    systemParentTag: 'PLC001-10-01',
    ssmDiscipline: 'Instrumentation',
  }),
  revisionAsset('CHW001-01-01', '002', { systemParentTag: 'MAH001-10-02' }),
  revisionAsset('EPB002-01-01', '002', { building: 'D-300', ssmDiscipline: 'Electrical' }),
  revisionAsset('ESB002-01', '002', {
    ssmDiscipline: 'Electrical',
    inclusionStatus: 'DUPLICATE_MODEL_TAG',
  }),
  revisionAsset('ESB002-01', '002', {
    ssmDiscipline: 'Electrical',
    inclusionStatus: 'DUPLICATE_MODEL_TAG',
    modelObjectIds: [2],
  }),
  /* New in B. */
  revisionAsset('PMP003-01-01', '003'),
];

/** The rename B claims: without it, VFD is one removal and one addition. */
export const DRAGON_RENAME_HINT: ReadonlyMap<string, string> = new Map([
  ['VFD001-10-01', 'VFD001-10-01A'],
]);

/**
 * A larger synthetic set: 500 Dragon-shaped assets across ten systems, built
 * from a counter so the set is identical on every run and every machine.
 */
export function syntheticDragonAssets(count: number): ReadonlyArray<GeneratedMelAsset> {
  const assets: GeneratedMelAsset[] = [];
  for (let i = 0; i < count; i++) {
    const systemNumber = (i % 10) + 1;
    const systemKey = String(systemNumber).padStart(3, '0');
    assets.push({
      canonicalTag: `MAH${systemKey}-${String(i).padStart(3, '0')}-01`,
      description: `Synthetic Dragon asset ${i}`,
      equipmentType: 'Air Handling Unit',
      building: `D-${String(systemNumber)}00`,
      nativeDiscipline: 'MECH',
      ssmDiscipline: 'Mechanical',
      system: dragonSystem(systemKey, `Dragon System ${systemKey}`, `Synthetic system ${systemKey}`),
      dependencyTags: [`EPB${systemKey}-01-01`],
      sourceModelFile: 'Dragon-MECH.nwd',
      modelObjectIds: [i * 3 + 2, i * 3 + 1],
      inclusionStatus: 'MODEL_CONFIRMED',
      reviewStatus: 'UNREVIEWED',
    });
  }
  return assets;
}
