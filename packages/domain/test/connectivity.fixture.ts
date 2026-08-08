import type { ConnectivityObservation } from '@matchline/domain';

/**
 * One connectivity observation of every kind and every source.
 *
 * Type-checked so a shape change has to be made deliberately: a `via` that
 * stopped behaving like an optional field under exactOptionalPropertyTypes, or
 * a source kind that lost its place in the union, stops this compiling.
 */

/** EasyPower states the switchboard powers the pump, and names the cable. */
export const DRAGON_EASYPOWER_FEED: ConnectivityObservation = {
  kind: 'feed',
  fromTag: 'DRG-SWB-01',
  toTag: 'DRG-P-1201A',
  via: 'C-1201A',
  sourceKind: 'easypower',
  relationshipType: 'POWERS',
  provenance: {
    sourceFile: 'dragon-easypower.xlsx',
    sourceRef: { kind: 'sheet-row', sheet: 'Buses', row: 214 },
    propertyOrColumn: 'Downstream Equipment',
    rule: 'connectivity.fromEasyPowerBus',
    inputRevision: 'B',
  },
};

/** The cable schedule states the same feed without naming a conductor. */
export const DRAGON_CABLE_FEED: ConnectivityObservation = {
  kind: 'feed',
  fromTag: 'DRG-SWB-01',
  toTag: 'DRG-P-1201B',
  sourceKind: 'cable-schedule',
  relationshipType: 'WIRED_TO',
  provenance: {
    sourceFile: 'dragon-cable-schedule.xlsx',
    sourceRef: { kind: 'sheet-row', sheet: 'Cables', row: 77 },
    propertyOrColumn: 'To Equipment',
    rule: 'connectivity.fromCableSchedule',
  },
};

/** PMD states which panel an instrument terminates into. */
export const DRAGON_PMD_RELATION: ConnectivityObservation = {
  kind: 'pmd-relation',
  fromTag: 'PLC603-20-01',
  toTag: 'TIT603-20-04',
  sourceKind: 'pmd',
  relationshipType: 'CONTROLS',
  provenance: {
    sourceFile: 'dragon-pmd.xlsx',
    sourceRef: { kind: 'sheet-row', sheet: 'Points', row: 1908 },
    propertyOrColumn: 'Panel',
    rule: 'connectivity.fromPmdPoint',
  },
};

export const DRAGON_CONNECTIVITY: ReadonlyArray<ConnectivityObservation> = [
  DRAGON_EASYPOWER_FEED,
  DRAGON_CABLE_FEED,
  DRAGON_PMD_RELATION,
];
