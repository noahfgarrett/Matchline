/**
 * Dragon-site flow fixtures (DECISIONS.md #6: all invented data is Dragon).
 *
 * Typed here rather than written inline in the .mjs tests so an observation
 * list or enrichment map the tests lean on cannot drift out of what the types
 * actually allow.
 */
import type { ConnectivityObservation, Provenance } from '@matchline/domain';
import type { IdentityAsset, IdentityConfig } from '@matchline/identity';

import type { FlowEnrichment } from '../dist/index.js';

const EASYPOWER_FILE = 'Dragon-EasyPower.xlsx';
const CABLE_FILE = 'Dragon-CableSchedule.xlsx';
const PMD_FILE = 'Dragon-PMD.xlsx';

function at(sourceFile: string, sheet: string, row: number): Provenance {
  return { sourceFile, sourceRef: { kind: 'sheet-row', sheet, row } };
}

function easyPowerFeed(fromTag: string, toTag: string, row: number): ConnectivityObservation {
  return {
    kind: 'feed',
    fromTag,
    toTag,
    sourceKind: 'easypower',
    relationshipType: 'POWERS',
    provenance: at(EASYPOWER_FILE, 'OneLine', row),
  };
}

function cableFeed(
  fromTag: string,
  toTag: string,
  via: string,
  row: number,
): ConnectivityObservation {
  return {
    kind: 'feed',
    fromTag,
    toTag,
    via,
    sourceKind: 'cable-schedule',
    relationshipType: 'WIRED_TO',
    provenance: at(CABLE_FILE, 'Cables', row),
  };
}

function pmdRelation(panelTag: string, instrumentTag: string, row: number): ConnectivityObservation {
  return {
    kind: 'pmd-relation',
    fromTag: panelTag,
    toTag: instrumentTag,
    sourceKind: 'pmd',
    relationshipType: 'CONTROLS',
    provenance: at(PMD_FILE, 'Points', row),
  };
}

/** The model-first universe for the Dragon electrical scenario. */
export const DRAGON_ASSETS: ReadonlyArray<IdentityAsset> = [
  { assetId: 'asset-0001', canonicalTag: 'UTL001-00-01' },
  { assetId: 'asset-0002', canonicalTag: 'SWG001-10-01' },
  { assetId: 'asset-0003', canonicalTag: 'PNL001-10-01' },
  { assetId: 'asset-0004', canonicalTag: 'VFD001-10-01' },
  { assetId: 'asset-0005', canonicalTag: 'TIT603-20-04' },
];

/** The cable schedule calls the panel `PANEL-1`; the site said what that means. */
export const DRAGON_ALIASES: IdentityConfig = {
  aliases: new Map([['PANEL-1', 'PNL001-10-01']]),
};

/**
 * The mixed scenario: a confirmed chain, an unknown bus in the middle of it,
 * parallel cables, an aliased second spelling, and two PMD instruments of which
 * only one is in the model.
 *
 * Utility -> switchgear -> panel -> unknown bus -> VFD, with the panel also
 * feeding the VFD directly under its alias, so the VFD is genuinely multi-fed.
 */
export const DRAGON_OBSERVATIONS: ReadonlyArray<ConnectivityObservation> = [
  easyPowerFeed('UTL001-00-01', 'SWG001-10-01', 2),
  cableFeed('SWG001-10-01', 'PNL001-10-01', 'C-1001', 2),
  cableFeed('SWG001-10-01', 'PNL001-10-01', 'C-1002', 3),
  cableFeed('PNL001-10-01', 'BUS-UNKNOWN-01', 'C-1003', 4),
  cableFeed('BUS-UNKNOWN-01', 'VFD001-10-01', 'C-1004', 5),
  cableFeed('PANEL-1', 'VFD001-10-01', 'C-1005', 6),
  pmdRelation('PNL001-10-01', 'PIT001-10-09', 2),
  pmdRelation('PNL001-10-01', 'TIT603-20-04', 3),
];

/** Model metadata for two of the matched assets, plus one nobody observed. */
export const DRAGON_ENRICHMENT: ReadonlyMap<string, FlowEnrichment> = new Map([
  [
    'asset-0003',
    {
      description: 'Dragon 480V distribution panel',
      equipmentType: 'Panelboard',
      building: 'Dragon Utilities',
      nativeDiscipline: 'Electrical',
      systemKey: '001',
      systemLabel: 'Dragon Main Air',
      sourceModelFile: 'Dragon-Electrical.nwd',
    },
  ],
  ['asset-0004', { description: 'Dragon compressor drive', equipmentType: 'VFD' }],
  ['asset-9999', { description: 'An asset nothing in the flow mentions' }],
]);

/** One asset, two spellings, stated as feeding itself. */
export const SELF_LOOP_ASSETS: ReadonlyArray<IdentityAsset> = [
  { assetId: 'asset-0003', canonicalTag: 'PNL001-10-01' },
];

export const SELF_LOOP_OBSERVATIONS: ReadonlyArray<ConnectivityObservation> = [
  cableFeed('PANEL-1', 'PNL001-10-01', 'C-9001', 9),
];

/** The same collapse, stated by the PMD rather than the cable schedule. */
export const PMD_SELF_LOOP_OBSERVATIONS: ReadonlyArray<ConnectivityObservation> = [
  pmdRelation('PANEL-1', 'PNL001-10-01', 9),
];

/** A three-node ring feed: real, and reported without being pruned. */
export const RING_OBSERVATIONS: ReadonlyArray<ConnectivityObservation> = [
  cableFeed('RING-A', 'RING-B', 'C-2001', 2),
  cableFeed('RING-B', 'RING-C', 'C-2002', 3),
  cableFeed('RING-C', 'RING-A', 'C-2003', 4),
];

/**
 * A ring with a chord: one component holding several distinct simple cycles.
 *
 * `A -> B -> C -> D -> A` plus `C -> A`, so the component is all four nodes but
 * the shortest loop through the smallest of them is only three.
 */
export const CHORDED_RING_OBSERVATIONS: ReadonlyArray<ConnectivityObservation> = [
  cableFeed('RING-A', 'RING-B', 'C-2101', 2),
  cableFeed('RING-B', 'RING-C', 'C-2102', 3),
  cableFeed('RING-C', 'RING-D', 'C-2103', 4),
  cableFeed('RING-D', 'RING-A', 'C-2104', 5),
  cableFeed('RING-C', 'RING-A', 'C-2105', 6),
];

/** Two rings that share nothing: two components, two loops to report. */
export const TWO_RINGS_OBSERVATIONS: ReadonlyArray<ConnectivityObservation> = [
  cableFeed('RING-A', 'RING-B', 'C-2201', 2),
  cableFeed('RING-B', 'RING-C', 'C-2202', 3),
  cableFeed('RING-C', 'RING-A', 'C-2203', 4),
  cableFeed('RING-X', 'RING-Y', 'C-2204', 5),
  cableFeed('RING-Y', 'RING-X', 'C-2205', 6),
];

/**
 * A tag the cable schedule and the PMD both mention.
 *
 * `JB001-10-05` is fed by an unknown source and also carries an instrument, so
 * it is the case where FLOW_ONLY and PMD_ONLY both look applicable.
 */
export const MIXED_APPEARANCE_OBSERVATIONS: ReadonlyArray<ConnectivityObservation> = [
  cableFeed('SRC001-10-01', 'JB001-10-05', 'C-3001', 2),
  pmdRelation('JB001-10-05', 'PIT001-10-09', 2),
];

/** A universe close enough to one spelling for fuzzy to propose, never to decide. */
export const FUZZY_ASSETS: ReadonlyArray<IdentityAsset> = [
  { assetId: 'asset-0003', canonicalTag: 'PNL001-10-01' },
  { assetId: 'asset-0004', canonicalTag: 'VFD001-10-01' },
];

export const FUZZY_OBSERVATIONS: ReadonlyArray<ConnectivityObservation> = [
  cableFeed('PNL001-10-01', 'VFD001-10-02', 'C-4001', 2),
];
