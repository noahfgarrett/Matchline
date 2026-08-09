import type { ExtoAsset, ItemMasterTrainingRow, WbsTrainingRow } from '../dist/index.js';

/**
 * The invented Dragon site's EXTO-layer fixtures, typed here rather than written
 * inline in the .mjs tests so the input the tests rely on cannot drift out of
 * what the exported interfaces actually allow.
 *
 * Every count below is hand-chosen so the 0.9 gate can be checked on both sides
 * and exactly on it. Nothing is derived from a real project.
 */

/**
 * The Standardized Item Master Template's names — the legal VF vocabulary.
 * `VF_MECH_CHILLER` is listed but never used by a registry row, which is what
 * makes it a vocabulary rather than a summary of the registry.
 */
export const DRAGON_VF_VOCABULARY: ReadonlyArray<string> = [
  'VF_IC_RIO',
  'VF_MECH_AHU',
  'VF_MECH_FAN',
  'VF_MECH_PUMP',
  'VF_MECH_CHILLER',
  'VF_EL_MV_GEAR',
];

function registryRows(
  count: number,
  prefix: string,
  row: Omit<ItemMasterTrainingRow, 'equipmentId'>,
): ReadonlyArray<ItemMasterTrainingRow> {
  return Array.from({ length: count }, (_unused, index) => ({
    ...row,
    equipmentId: `${prefix}-${String(index + 1).padStart(2, '0')}`,
  }));
}

/**
 * A prior Dragon EXTO registry export.
 *
 * The shape of the learned table this produces, key by key:
 *
 * | rung        | key                                          | votes                       | confidence |
 * | ----------- | -------------------------------------------- | --------------------------- | ---------- |
 * | class       | mechanical / ahu / 001                       | AHU x10                     | 1.0        |
 * | class       | mechanical / mtr / 001                       | FAN x8, PUMP x2             | 0.8        |
 * | class       | mechanical / pmp / 002                       | PUMP x9, FAN x1             | 0.9        |
 * | class       | i&c / rio / 650                              | CA_NB_IC_RIO x10 -> VF x10  | 1.0        |
 * | class       | electrical / swg / 002                       | CA_NB_EL_MV_GEAR x10 -> VF  | 1.0        |
 * | description | mechanical / 001 / "air"                     | AHU x10                     | 1.0        |
 * | description | mechanical / 001 / "supply"                  | FAN x8                      | 1.0        |
 * | description | mechanical / 001 / "booster"                 | PUMP x2                     | 1.0        |
 * | description | mechanical / 003 / "chilled"                 | PUMP x5                     | 1.0        |
 * | description | mechanical / 002 / "screening"               | PUMP x9, FAN x1             | 0.9        |
 * | description | i&c / 650 / "remote"                         | VF_IC_RIO x10               | 1.0        |
 * | description | electrical / 002 / "medium"                  | VF_EL_MV_GEAR x10           | 1.0        |
 *
 * Plus three audited rows and one row with no UPN, none of which are learned.
 */
export const DRAGON_REGISTRY: ReadonlyArray<ItemMasterTrainingRow> = [
  /* An unambiguous class: ten air handlers, one master. */
  ...registryRows(10, 'DRG-AHU', {
    discipline: 'Mechanical',
    systemKey: '001',
    equipmentClass: 'AHU',
    description: 'Air handling unit',
    itemMaster: 'VF_MECH_AHU',
  }),
  /* A class the registry disagreed about (8/10 = 0.8, below the gate) whose two
     halves each carry an unambiguous description. This is the pair that proves
     the donor's rung order: the class rung proposes, the description rung
     assigns. */
  ...registryRows(8, 'DRG-MTR-FAN', {
    discipline: 'Mechanical',
    systemKey: '001',
    equipmentClass: 'MTR',
    description: 'Supply fan motor',
    itemMaster: 'VF_MECH_FAN',
  }),
  ...registryRows(2, 'DRG-MTR-PMP', {
    discipline: 'Mechanical',
    systemKey: '001',
    equipmentClass: 'MTR',
    description: 'Booster pump motor',
    itemMaster: 'VF_MECH_PUMP',
  }),
  /* Exactly on the gate: 9/10 = 0.9, which the donor admits. */
  ...registryRows(9, 'DRG-PMP', {
    discipline: 'Mechanical',
    systemKey: '002',
    equipmentClass: 'PMP',
    description: 'Screening pump',
    itemMaster: 'VF_MECH_PUMP',
  }),
  ...registryRows(1, 'DRG-PMP-ODD', {
    discipline: 'Mechanical',
    systemKey: '002',
    equipmentClass: 'PMP',
    description: 'Screening pump',
    itemMaster: 'VF_MECH_FAN',
  }),
  /* Legacy CA_* names that the template can place: they must be learned as
     their VF equivalents, not as themselves. */
  ...registryRows(10, 'DRG-RIO', {
    discipline: 'I&C',
    systemKey: '650',
    equipmentClass: 'RIO',
    description: 'Remote IO panel',
    itemMaster: 'CA_NB_IC_RIO',
  }),
  /* Electrical gear on electrical equipment: not suspect, and learned. */
  ...registryRows(10, 'DRG-SWG', {
    discipline: 'Electrical',
    systemKey: '002',
    equipmentClass: 'SWG',
    description: 'Medium voltage switchgear',
    itemMaster: 'CA_NB_EL_MV_GEAR',
  }),
  /* Description-rung-only rows: this registry never classified them. */
  ...registryRows(5, 'DRG-CHW', {
    discipline: 'Mechanical',
    systemKey: '003',
    description: 'Chilled water pump',
    itemMaster: 'VF_MECH_PUMP',
  }),
  /* Three audited rows, one of each reason. */
  {
    equipmentId: 'DRG-X-PLACEHOLDER',
    discipline: 'Mechanical',
    systemKey: '001',
    equipmentClass: 'XV',
    description: 'Isolation valve',
    itemMaster: 'VF_Blank',
  },
  {
    equipmentId: 'DRG-X-GEAR',
    discipline: 'UPW',
    systemKey: '004',
    equipmentClass: 'PMP',
    description: 'Makeup pump',
    itemMaster: 'CA_NB_EL_MV_GEAR',
  },
  {
    equipmentId: 'DRG-X-NOMASTER',
    discipline: 'Electrical',
    systemKey: '002',
    equipmentClass: 'SWB',
    description: 'Switchboard',
    itemMaster: '',
  },
  /* No UPN: nothing can ever look this up, so nothing learns it. */
  {
    equipmentId: 'DRG-X-NOUPN',
    discipline: 'Mechanical',
    systemKey: '',
    equipmentClass: 'PMP',
    description: 'Unscoped pump',
    itemMaster: 'VF_MECH_PUMP',
  },
];

/**
 * Assets to look up against the trained table.
 *
 * One per outcome the union can produce, plus the rung-order case.
 */
export const DRAGON_LOOKUPS: ReadonlyArray<ExtoAsset> = [
  /* Class rung, unambiguous. */
  {
    canonicalTag: 'MAH001-10-01',
    ssmDiscipline: 'Mechanical',
    equipmentClass: 'AHU',
    systemKey: '001',
    description: 'Air handling unit 01',
  },
  /* Class rung below the gate, description rung above it: the description rung
     assigns, exactly as the donor's candidate order does. */
  {
    canonicalTag: 'MTR001-10-03',
    ssmDiscipline: 'Mechanical',
    equipmentClass: 'MTR',
    systemKey: '001',
    description: 'Supply fan motor 03',
  },
  /* Class rung below the gate and no description to fall back on: a proposal. */
  {
    canonicalTag: 'MTR001-10-04',
    ssmDiscipline: 'Mechanical',
    equipmentClass: 'MTR',
    systemKey: '001',
  },
  /* Exactly on the gate. */
  {
    canonicalTag: 'PMP002-01-01',
    ssmDiscipline: 'Mechanical',
    equipmentClass: 'PMP',
    systemKey: '002',
    description: 'Screening pump 01',
  },
  /* Description rung only — the registry never classified system 003. */
  {
    canonicalTag: 'CHW003-01-01',
    ssmDiscipline: 'Mechanical',
    systemKey: '003',
    description: 'Chilled water pump 01',
  },
  /* A system the registry never covered. */
  {
    canonicalTag: 'TK010-01-01',
    ssmDiscipline: 'Mechanical',
    equipmentClass: 'TK',
    systemKey: '010',
    description: 'Buffer tank',
  },
  /* No system key at all: the resolver never reached this one. */
  {
    canonicalTag: 'FCU-SPARE-07',
    ssmDiscipline: 'Mechanical',
    equipmentClass: 'FCU',
    description: 'Spare fan coil unit',
  },
];

/**
 * The Dragon register, as the EXTO sheet must print it.
 *
 * Deliberately out of export order and deliberately awkward: a leading-zero UPN,
 * a root with a System Name, a root without one, dependencies listed backwards,
 * an asset with nothing optional filled in, a legacy CA_* master, and a
 * duplicated tag whose two rows must always emit in this order.
 */
export const DRAGON_REGISTER: ReadonlyArray<ExtoAsset> = [
  {
    /* The one asset with every optional field stated, so the widened column map
       can be checked in both directions against the one below it. */
    canonicalTag: 'EPB002-01-01',
    ssmDiscipline: 'Electrical',
    equipmentClass: 'EPB',
    systemKey: '002',
    systemLabel: '002  Dragon Power Distribution',
    structuralParentTag: 'SWG002-01',
    dependencyTags: ['SWG002-01'],
    itemMaster: 'CA_NB_EL_MV_GEAR',
    milestoneLabel: 'L2-M1-0602 - UPN 002 MV Energization',
    description: 'Annex panelboard',
    building: 'D1',
    level: '1',
    grid: 'K-12',
    wbs: '1811',
    manufacturer: 'Dragonworks',
    modelNumber: 'DW-4160',
  },
  {
    /* No system at all. Sorts to the bottom, under a blank UPN. */
    canonicalTag: 'FCU-SPARE-07',
    ssmDiscipline: 'Mechanical',
    equipmentClass: 'FCU',
    description: 'Spare fan coil unit',
  },
  {
    /* Dependencies listed backwards: the cell must not depend on input order. */
    canonicalTag: 'MAH001-10-02',
    ssmDiscipline: 'Mechanical',
    equipmentClass: 'AHU',
    systemKey: '001',
    systemLabel: '001  Dragon Air Handling',
    dependencyTags: ['EPB002-01-01', 'CHW001-01-01'],
    itemMaster: 'VF_MECH_AHU',
    description: 'Secondary air handler',
  },
  {
    /* First half of a duplicated model tag. Both objects are kept, never
       merged, and the pair must always emit in this order. */
    canonicalTag: 'MAH001-10-01',
    systemKey: '001',
    systemLabel: '001  Dragon Air Handling',
    itemMaster: 'VF_MECH_AHU',
    description: 'Primary air handler',
  },
  {
    /* Second half. Nothing optional beyond the tag and the system is filled in,
       so every other column has to come out blank or 'N/A', never 'undefined'. */
    canonicalTag: 'MAH001-10-01',
    systemKey: '001',
    systemLabel: '001  Dragon Air Handling',
  },
  {
    /* A root with no System Name to stand in for a parent: 'N/A' either way. */
    canonicalTag: 'CHW001-01-01',
    ssmDiscipline: 'Mechanical',
    equipmentClass: 'PMP',
    systemKey: '001',
    structuralParentTag: 'MAH001-10-02',
    itemMaster: 'VF_MECH_PUMP',
    description: 'Chilled water pump',
  },
  {
    canonicalTag: 'TK010-01-01',
    ssmDiscipline: 'Mechanical',
    equipmentClass: 'TK',
    systemKey: '010',
    description: 'Buffer tank',
  },
];

/** The Equipment ID order {@link DRAGON_REGISTER} must export in. */
export const DRAGON_REGISTER_ID_ORDER: ReadonlyArray<string> = [
  'CHW001-01-01',
  'MAH001-10-01',
  'MAH001-10-01',
  'MAH001-10-02',
  'EPB002-01-01',
  'TK010-01-01',
  'FCU-SPARE-07',
];

/**
 * A larger synthetic register: 500 Dragon-shaped assets across ten systems,
 * built from a counter so the set is identical on every run and every machine.
 */
export function syntheticDragonRegister(count: number): ReadonlyArray<ExtoAsset> {
  const assets: ExtoAsset[] = [];
  for (let i = 0; i < count; i++) {
    const systemNumber = (i % 10) + 1;
    const systemKey = String(systemNumber).padStart(3, '0');
    assets.push({
      canonicalTag: `MAH${systemKey}-${String(i).padStart(3, '0')}-01`,
      ssmDiscipline: 'Mechanical',
      equipmentClass: 'AHU',
      systemKey,
      systemLabel: `${systemKey}  Dragon System ${systemKey}`,
      structuralParentTag: `SWG${systemKey}-01`,
      dependencyTags: [`EPB${systemKey}-01-01`],
      itemMaster: 'VF_MECH_AHU',
      milestoneLabel: `L2-M1-${systemKey}0 - UPN ${systemKey} Energization`,
      description: `Synthetic Dragon asset ${i}`,
    });
  }
  return assets;
}

/* -------------------------------------------------------------------------- */
/* The WBS table                                                               */
/* -------------------------------------------------------------------------- */

function wbsRows(count: number, systemKey: string, wbs: string): ReadonlyArray<WbsTrainingRow> {
  return Array.from({ length: count }, () => ({ systemKey, wbs }));
}

/**
 * A prior Dragon registry, as the WBS layer reads it.
 *
 * Chosen so the gate can be checked on both sides and exactly on it:
 *
 * | UPN   | votes                  | confidence | outcome              |
 * | ----- | ---------------------- | ---------- | -------------------- |
 * | `001` | `1810` x10             | 1.0        | assigned             |
 * | `002` | `1811` x9, `1899` x1   | 0.9        | assigned, on the gate|
 * | `003` | `1812` x7, `1898` x3   | 0.7        | proposal             |
 * | `007` | `0110` x4              | 1.0        | assigned, leading 0  |
 *
 * `'007'`/`'0110'` are the pair that matters most: a key and a code that both
 * begin with a zero, so any accidental number round-trip shows up as a changed
 * value rather than as a passing test.
 */
export const DRAGON_WBS_REGISTRY: ReadonlyArray<WbsTrainingRow> = [
  ...wbsRows(10, '001', '1810'),
  ...wbsRows(9, '002', '1811'),
  ...wbsRows(1, '002', '1899'),
  ...wbsRows(7, '003', '1812'),
  ...wbsRows(3, '003', '1898'),
  ...wbsRows(4, '007', '0110'),
  /* Neither of these can teach anything: no key to file under, no code to file. */
  { systemKey: '', wbs: '1813' },
  { systemKey: '008', wbs: '' },
];

/* -------------------------------------------------------------------------- */
/* The captured template                                                       */
/* -------------------------------------------------------------------------- */

/**
 * An invented site's registry header row, for capture.
 *
 * Deliberately unlike the generic map in every way that has to survive: a
 * different width, headers on row 0 with no spacer above them, the recognised
 * columns in a different order and at different positions, two spelled in a
 * different case, and four columns Matchline has never heard of — including
 * `'Dragon Wrangler Email'`, which stands in for the contact columns a real
 * registry carries and must come out of every export empty.
 */
export const DRAGON_TEMPLATE_HEADERS: ReadonlyArray<string> = [
  'Dragon Upload Reference', // 0  invented
  'Building', // 1
  'UPN', // 2
  'wbs', // 3  case-folded match
  'System Name', // 4
  'Equipment ID', // 5
  'Dragon Wrangler Email', // 6  invented — must never be written to
  'Closest Parent', // 7
  '  Discipline  ', // 8  space-padded match
  'Item Master Unique Identifier', // 9
  'Scale Count', // 10 invented
  'Equipment Classification', // 11
  'Dependencies', // 12
  'Hoard Valuation', // 13 invented
];

/** The invented headers that must never receive a value. */
export const DRAGON_TEMPLATE_UNMATCHED: ReadonlyArray<string> = [
  'Dragon Upload Reference',
  'Dragon Wrangler Email',
  'Scale Count',
  'Hoard Valuation',
];
