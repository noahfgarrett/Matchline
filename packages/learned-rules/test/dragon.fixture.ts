/**
 * Dragon-site learned-rules fixtures (DECISIONS.md #6: all invented data is
 * Dragon). Every row here is fabricated; none of it comes from a real site.
 *
 * Typed here rather than written inline in the .mjs tests so a training row or
 * an asset the tests lean on cannot drift out of what the types allow.
 *
 * The main finished-SSM fixture is 40 rows over two systems and is
 * hand-verified in `train.test.mjs`:
 *
 *   10 units, 4 rows each: MAH (air handler), VFD, PLC, TIT
 *   units 01-05 -> system SYS-10, units 06-10 -> system SYS-20
 *   VFD nests under its unit's MAH   (10 links)
 *   TIT nests under its unit's VFD   (10 links)
 *   PLC nests under MAH in units 01-06 and under VFD in units 07-10 -- the
 *   deliberately inconsistent class, which must self-grade at 6/10 and stay a
 *   proposal while TIT grades 10/10 and earns the claim.
 */
import type { NestingAsset, TrainingRow } from '../dist/index.js';

const UNIT_COUNT = 10;
const UNITS_PER_SYSTEM = 5;
/** Units 01-06 hang their PLC off the air handler; 07-10 off the drive. */
const PLC_UNDER_MAH_THROUGH = 6;

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

function systemOf(unit: number): string {
  return unit <= UNITS_PER_SYSTEM ? 'SYS-10' : 'SYS-20';
}

function blockOf(unit: number): string {
  return unit <= UNITS_PER_SYSTEM ? '10' : '20';
}

/** `MAH001-10-01`, `TIT007-20-07`, ... */
export function dragonTag(family: string, unit: number): string {
  return `${family}${pad(unit, 3)}-${blockOf(unit)}-${pad(unit, 2)}`;
}

const DISCIPLINE: Readonly<Record<string, string>> = {
  MAH: 'Mechanical',
  VFD: 'Electrical',
  PLC: 'Electrical',
  TIT: 'Instrumentation',
};

const DESCRIPTION: Readonly<Record<string, string>> = {
  MAH: 'AIR HANDLING UNIT',
  VFD: 'VARIABLE FREQUENCY DRIVE',
  PLC: 'PROGRAMMABLE LOGIC CONTROLLER',
  TIT: 'TEMPERATURE TRANSMITTER',
};

function dragonRow(family: string, unit: number, parentFamily: string | null): TrainingRow {
  const base = {
    equipmentTag: dragonTag(family, unit),
    description: `${DESCRIPTION[family] ?? family} ${pad(unit, 3)}`,
    systemKey: systemOf(unit),
    discipline: DISCIPLINE[family] ?? '',
  };
  return parentFamily === null ? base : { ...base, parentTag: dragonTag(parentFamily, unit) };
}

function buildDragonRows(): TrainingRow[] {
  const rows: TrainingRow[] = [];
  for (let unit = 1; unit <= UNIT_COUNT; unit++) {
    rows.push(dragonRow('MAH', unit, null));
    rows.push(dragonRow('VFD', unit, 'MAH'));
    rows.push(dragonRow('PLC', unit, unit <= PLC_UNDER_MAH_THROUGH ? 'MAH' : 'VFD'));
    rows.push(dragonRow('TIT', unit, 'VFD'));
  }
  return rows;
}

/** The finished Dragon SSM the rules train from: 40 rows, 30 parent links. */
export const DRAGON_TRAINING_ROWS: ReadonlyArray<TrainingRow> = buildDragonRows();

/** The same rows in a different order -- training must not notice. */
export const DRAGON_TRAINING_ROWS_REORDERED: ReadonlyArray<TrainingRow> = [
  ...DRAGON_TRAINING_ROWS,
].reverse();

/* ---- assets to apply the rules to ---- */

function assetOf(family: string, unit: number, systemKey = systemOf(unit)): NestingAsset {
  return {
    assetId: `asset-${dragonTag(family, unit)}`,
    tag: dragonTag(family, unit),
    description: `${DESCRIPTION[family] ?? family} ${pad(unit, 3)}`,
    discipline: DISCIPLINE[family] ?? '',
    systemKey,
  };
}

function buildDragonAssets(): NestingAsset[] {
  const assets: NestingAsset[] = [];
  for (let unit = 1; unit <= UNIT_COUNT; unit++) {
    for (const family of ['MAH', 'VFD', 'PLC', 'TIT']) assets.push(assetOf(family, unit));
  }
  return assets;
}

/** The compiled Dragon asset universe: the same 40 tags, no parents asserted. */
export const DRAGON_ASSETS: ReadonlyArray<NestingAsset> = buildDragonAssets();

/** Asset id of a Dragon tag, for readable assertions. */
export function dragonAssetId(family: string, unit: number): string {
  return `asset-${dragonTag(family, unit)}`;
}

/**
 * A PLC rack: its tag literally extends `PLC001-10-01` at a separator, by four
 * substantive characters. Its description is deliberately unknown to the
 * learned table -- containment must not need a class.
 */
export const RACK_ASSET: NestingAsset = {
  assetId: 'asset-PLC001-10-01-RACK',
  tag: 'PLC001-10-01-RACK',
  description: 'CONTROL PANEL RACK 001',
  discipline: 'Electrical',
  systemKey: 'SYS-10',
};

/**
 * A letter-suffixed sibling of `TIT001-10-01`. DECISIONS.md keeps
 * letter-suffixed identities distinct: `-A` is a second transmitter, never a
 * child of the bare tag.
 */
export const SIBLING_ASSET: NestingAsset = {
  assetId: 'asset-TIT001-10-01-A',
  tag: 'TIT001-10-01-A',
  description: 'TEMPERATURE TRANSMITTER 001',
  discipline: 'Instrumentation',
  systemKey: 'SYS-10',
};

/** The unit-01 TIT relocated to a system of its own: no peers, no proposal. */
export const OTHER_SYSTEM_TIT: NestingAsset = assetOf('TIT', 1, 'SYS-99');

/** An asset with no system at all -- no partition, so no defensible peer set. */
export const SYSTEMLESS_TIT: NestingAsset = {
  assetId: 'asset-TIT001-10-01-nosys',
  tag: 'TIT001-10-01',
  description: 'TEMPERATURE TRANSMITTER 001',
  discipline: 'Instrumentation',
};

/** One TIT and one MAH: parent-capable, but the pair was never observed. */
export const NO_AFFINITY_ASSETS: ReadonlyArray<NestingAsset> = [
  assetOf('MAH', 1),
  assetOf('TIT', 1),
];

/* ---- classification-confidence fixtures ---- */

function transmitterRow(family: string, unit: number): TrainingRow {
  return {
    equipmentTag: `${family}${pad(unit, 3)}-10-${pad(unit, 2)}`,
    description: `TEMPERATURE TRANSMITTER ${pad(unit, 3)}`,
    systemKey: 'SYS-10',
    discipline: 'Instrumentation',
  };
}

function transmitterRows(titCount: number, ttCount: number): TrainingRow[] {
  const rows: TrainingRow[] = [];
  for (let unit = 1; unit <= titCount; unit++) rows.push(transmitterRow('TIT', unit));
  for (let unit = 1; unit <= ttCount; unit++) rows.push(transmitterRow('TT', titCount + unit));
  return rows;
}

/** One masked pattern, two role labels, 3:2 -- 0.6 confidence, under the gate. */
export const SPLIT_CLASS_ROWS: ReadonlyArray<TrainingRow> = transmitterRows(3, 2);

/** The same split at 9:1 -- exactly 0.9, which the gate admits. */
export const BORDERLINE_CLASS_ROWS: ReadonlyArray<TrainingRow> = transmitterRows(9, 1);

/* ---- grading fixtures ---- */

const GRADE_SYSTEM = 'SYS-90';

function gradeTag(family: string, unit: number): string {
  return `${family}${pad(unit, 3)}-90-${pad(unit, 2)}`;
}

function gradeRow(family: string, unit: number, parentFamily: string | null): TrainingRow {
  const base = {
    equipmentTag: gradeTag(family, unit),
    description: `${family} ASSEMBLY ${pad(unit, 3)}`,
    systemKey: GRADE_SYSTEM,
    discipline: 'Mechanical',
  };
  return parentFamily === null ? base : { ...base, parentTag: gradeTag(parentFamily, unit) };
}

/**
 * A precision dial.
 *
 * Every unit holds a sensor (`SEN`). `hubUnits` of them nest under the unit's
 * hub (`HUB`), the rest under a junction box (`BOX`). BOX never parents enough
 * equipment to clear the parent-capable gate, so the policy always predicts
 * HUB -- which makes the measured precision exactly `hubUnits / (hubUnits +
 * boxUnits)` when the box units also carry a hub, and drops the box units out
 * of the prediction count entirely when they do not.
 */
function gradingRows(hubUnits: number, boxUnits: number, boxUnitsHaveHub: boolean): TrainingRow[] {
  const rows: TrainingRow[] = [];
  for (let unit = 1; unit <= hubUnits; unit++) {
    rows.push(gradeRow('HUB', unit, null));
    rows.push(gradeRow('SEN', unit, 'HUB'));
  }
  for (let unit = hubUnits + 1; unit <= hubUnits + boxUnits; unit++) {
    if (boxUnitsHaveHub) rows.push(gradeRow('HUB', unit, null));
    rows.push(gradeRow('BOX', unit, null));
    rows.push(gradeRow('SEN', unit, 'BOX'));
  }
  return rows;
}

/** 17 of 20 right: exactly 0.85, which earns the claim. */
export const GRADE_AT_THRESHOLD_ROWS: ReadonlyArray<TrainingRow> = gradingRows(17, 3, true);

/** 16 of 20 right: 0.80, one row short of the claim. */
export const GRADE_BELOW_THRESHOLD_ROWS: ReadonlyArray<TrainingRow> = gradingRows(16, 4, true);

/**
 * 12 sightings but only 8 predictions, all correct. Perfect precision on too
 * few calls is still a proposal -- the box units have no hub of their own, so
 * every out-of-unit hub ties and the policy refuses to pick.
 */
export const GRADE_TOO_FEW_PREDICTIONS_ROWS: ReadonlyArray<TrainingRow> = gradingRows(8, 4, false);

/* ---- affinity-threshold fixtures ---- */

function affinityRows(observations: number): TrainingRow[] {
  const rows: TrainingRow[] = [];
  for (let unit = 1; unit <= observations; unit++) {
    rows.push({
      equipmentTag: `HUB${pad(unit, 3)}-80-${pad(unit, 2)}`,
      description: `HUB ASSEMBLY ${pad(unit, 3)}`,
      systemKey: 'SYS-80',
      discipline: 'Mechanical',
    });
    rows.push({
      equipmentTag: `SEN${pad(unit, 3)}-80-${pad(unit, 2)}`,
      description: `SENSOR ASSEMBLY ${pad(unit, 3)}`,
      systemKey: 'SYS-80',
      discipline: 'Mechanical',
      parentTag: `HUB${pad(unit, 3)}-80-${pad(unit, 2)}`,
    });
  }
  return rows;
}

/** Two sightings of SEN-under-HUB: a coincidence, not a rule. */
export const TWO_OBSERVATION_ROWS: ReadonlyArray<TrainingRow> = affinityRows(2);

/** Three sightings: the donor's bar for calling it a pairing rule. */
export const THREE_OBSERVATION_ROWS: ReadonlyArray<TrainingRow> = affinityRows(3);
