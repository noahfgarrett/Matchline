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
