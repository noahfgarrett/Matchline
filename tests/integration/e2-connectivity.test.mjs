/**
 * End-to-end proof of PRODUCT.md §19 Phase 3's exit criteria: one flowing
 * pipeline over a temp-dir Dragon cache, from raw extraction through an
 * invented EasyPower/Cable Schedule/PMD workbook to the Electrical Flow
 * projection.
 *
 * Phase 3 exit criteria (docs/PRODUCT.md §19):
 *   - Source-to-load flow is complete for test fixtures
 *   - Model metadata enriches matched nodes
 *   - Unmatched nodes remain visible
 *   - No source-only item silently becomes model-authoritative
 *
 * ## Import mechanism
 *
 * As of this file's writing, `npm install` at the repo root has symlinked
 * every package this pipeline needs -- `@matchline/model-schema`,
 * `@matchline/spreadsheet-import`, `@matchline/asset-catalog`,
 * `@matchline/identity`, `@matchline/connectivity-import` and
 * `@matchline/electrical-flow` -- into the root `node_modules/@matchline/`,
 * and `package-lock.json` carries an entry for each. Unlike
 * `e1-pipeline.test.mjs` (written against an older `npm ci`), none of them
 * need the `dist/`-path fallback: every import below resolves by package name.
 *
 * This is a plain `.mjs` file, not TypeScript: `PropertyMappings` and
 * `AssetFilterConfig` are compile-time-only shapes, so the object literals
 * below are shaped to match them by hand rather than imported.
 *
 * ## The invented Dragon connectivity workbook
 *
 * One workbook, three sheets, built in-memory with `writeWorkbook` (no fixture
 * file on disk). Every tag below is deliberately chosen against the Dragon
 * fixture's real equipment (`packages/model-schema/src/fixtures/dragon.ts`):
 *
 * - `SWBD-1` -- the feed root. Not a model tag: a switchgear bus the Dragon
 *   model never modeled. Stays FLOW_ONLY, and is the only node with feeds and
 *   no `fedBy`, so it is the walk's one root.
 * - `PLC001-10-01`, `VFD001-10-01`, `TIT603-10-01` -- real Dragon tags, spelled
 *   exactly as the model has them. Resolve at the `exact` tier.
 * - `MAH001-10-01-A` -- never spelled this way in the model. It extends the
 *   real canonical tag `MAH001-10-01` past a `-`, which no other Dragon tag
 *   does, so it resolves at the `suffix-unambiguous` tier -- the "below exact"
 *   match the coordinator asked for. Used consistently everywhere the asset
 *   is referenced, so its flow node's `identityTier` stays `suffix-unambiguous`
 *   rather than being pulled back to `exact` by a second, exact-spelled
 *   observation.
 * - `UNKNOWN-PANEL-99` -- a feed tag with no relationship to any Dragon tag,
 *   fuzzy or otherwise. Stays FLOW_ONLY with zero candidates.
 * - `TIT603-1O-01` -- a one-character typo of `TIT603-10-01` (letter `O` for
 *   digit `0`), Levenshtein distance 1 from it and distance >= 2 from every
 *   other Dragon tag. Appears only in the PMD sheet, so it lands PMD_ONLY, and
 *   because it is within the identity index's default fuzzy distance (2) it
 *   raises a `fuzzy-identity` review item naming `TIT603-10-01` as a
 *   candidate -- proposed, never auto-matched (PRODUCT.md §9.2).
 * - `PMD-INST-999` -- a PMD instrument with no resemblance to any Dragon tag
 *   at all, not even fuzzily. Stays PMD_ONLY with no candidates and raises no
 *   review item, which is what "a PMD instrument not in the model" should
 *   look like when the record is simply unrelated rather than a near miss.
 *
 * Two Cable Schedule rows between `VFD001-10-01` and `MAH001-10-01-A`
 * (`C-101`, `C-102`) are the parallel-cable pair: two observations, two edges,
 * one multi-fed node (§10: "two parallel cables ... make their load multi-fed
 * once, not twice").
 *
 * Every sheet's headers are chosen from `headers.ts`'s *exact* rungs
 * (`Starting Source`/`ID Name`; `Panel (From)`/`Load Name (To)`/`Cable Tag`;
 * `Panel`/`Instrument Tag`) so `importConnectivityWorkbook` detects every
 * sheet at `exact-headers` confidence with no override needed -- this file
 * does not fight detection, it exercises the plain path through it.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { before } from 'node:test';

import { openExtractionCache } from '@matchline/model-schema';
import { writeDragonFixture } from '@matchline/model-schema/fixtures/dragon';
import { writeWorkbook } from '@matchline/spreadsheet-import';
import { buildAssetCatalog } from '@matchline/asset-catalog';
import { buildIdentityIndex, resolveTag } from '@matchline/identity';
import { importConnectivityWorkbook } from '@matchline/connectivity-import';
import {
  buildElectricalFlowFromIndex,
  SOURCE_ONLY_NODE_PREFIX,
  walkSourceToLoad,
} from '@matchline/electrical-flow';

/** Same Dragon mapping `e1-pipeline.test.mjs` uses: tag/description/type/building. */
const MAPPINGS = {
  equipmentTag: { category: 'Dragon Data', name: 'Tag' },
  description: { category: 'Dragon Data', name: 'Manufacturer' },
  equipmentType: { category: 'Item', name: 'Type' },
  building: { category: 'Dragon Data', name: 'Building' },
};

/** Both Dragon disciplines: the chain below needs mechanical (MAH/TIT) and controls (PLC/VFD) tags alike. */
const FILTERS = {
  requireTagProperty: true,
  collapseComponents: false,
};

/* ---- the invented workbook's tags ---- */

const FEED_ROOT_TAG = 'SWBD-1';
/** Never spelled exactly in the model; extends `MAH001-10-01` past a `-`. */
const SUFFIX_TAG = 'MAH001-10-01-A';
const UNKNOWN_FEED_TAG = 'UNKNOWN-PANEL-99';
/** One-character typo of the real `TIT603-10-01`: distance 1, everything else >= 2. */
const FUZZY_PMD_TAG = 'TIT603-1O-01';
const UNKNOWN_PMD_TAG = 'PMD-INST-999';

function buildConnectivityWorkbookBytes() {
  const easyPowerSheet = {
    name: 'EasyPower',
    aoa: [
      ['Starting Source', 'ID Name'],
      [FEED_ROOT_TAG, 'PLC001-10-01'],
      ['PLC001-10-01', 'VFD001-10-01'],
      ['VFD001-10-01', UNKNOWN_FEED_TAG],
      [SUFFIX_TAG, 'TIT603-10-01'],
    ],
  };
  const cableSheet = {
    name: 'Cable Schedule',
    aoa: [
      ['Panel (From)', 'Load Name (To)', 'Cable Tag'],
      ['VFD001-10-01', SUFFIX_TAG, 'C-101'],
      ['VFD001-10-01', SUFFIX_TAG, 'C-102'],
    ],
  };
  const pmdSheet = {
    name: 'PMD',
    aoa: [
      ['Panel', 'Instrument Tag'],
      [SUFFIX_TAG, FUZZY_PMD_TAG],
      [SUFFIX_TAG, UNKNOWN_PMD_TAG],
    ],
  };
  return writeWorkbook([easyPowerSheet, cableSheet, pmdSheet]);
}

/**
 * One full pipeline run, self-contained: temp-dir Dragon cache -> asset
 * catalog -> identity index -> connectivity import -> Electrical Flow. Used
 * both for the shared fixture (`before`) and for test 6's from-scratch rebuild.
 */
function buildPipeline() {
  const directory = mkdtempSync(join(tmpdir(), 'matchline-e2-connectivity-'));
  try {
    const cachePath = join(directory, 'dragon.sqlite');
    writeDragonFixture(cachePath);
    const cache = openExtractionCache(cachePath);
    let catalog;
    try {
      catalog = buildAssetCatalog(cache, MAPPINGS, FILTERS);
    } finally {
      cache.close();
    }

    const identityAssets = catalog.assets.map((asset) => ({
      assetId: asset.assetId,
      canonicalTag: asset.canonicalTag,
    }));
    const index = buildIdentityIndex(identityAssets);

    const bytes = buildConnectivityWorkbookBytes();
    const report = importConnectivityWorkbook(bytes, 'Dragon-Connectivity.xlsx');

    const enrichment = new Map(
      catalog.assets.map((asset) => [
        asset.assetId,
        {
          ...(asset.description === undefined ? {} : { description: asset.description }),
          ...(asset.equipmentType === undefined ? {} : { equipmentType: asset.equipmentType }),
          ...(asset.building === undefined ? {} : { building: asset.building }),
        },
      ]),
    );

    const flow = buildElectricalFlowFromIndex(report.observations, index, enrichment);

    return { catalog, index, report, enrichment, flow };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function assetIdFor(catalog, canonicalTag) {
  const asset = catalog.assets.find((candidate) => candidate.canonicalTag === canonicalTag);
  assert.ok(asset, `${canonicalTag} should exist in the Dragon catalog`);
  return asset.assetId;
}

let pipeline;

before(() => {
  pipeline = buildPipeline();
});

test('1. source-to-load flow is complete: the walk from the root reaches every model-confirmed node, and edge/node counts match the hand-computed workbook', () => {
  const { catalog, report, flow } = pipeline;

  // Sanity on the import itself, before trusting anything built from it: every
  // sheet detected and nothing was skipped as a bad row.
  assert.deepEqual(report.unknownSheets, [], 'every sheet should have been recognized');
  assert.ok(
    report.sheets.every((sheet) => sheet.status === 'imported'),
    'every sheet should have imported, none left `not-imported`',
  );
  // 4 EasyPower rows + 2 Cable Schedule rows + 2 PMD rows.
  assert.equal(report.observations.length, 8);

  const plcId = assetIdFor(catalog, 'PLC001-10-01');
  const vfdId = assetIdFor(catalog, 'VFD001-10-01');
  const mahId = assetIdFor(catalog, 'MAH001-10-01');
  const titId = assetIdFor(catalog, 'TIT603-10-01');
  const rootId = `${SOURCE_ONLY_NODE_PREFIX}${FEED_ROOT_TAG}`;
  const unknownFeedId = `${SOURCE_ONLY_NODE_PREFIX}${UNKNOWN_FEED_TAG}`;

  assert.deepEqual(flow.roots, [rootId], 'SWBD-1 is the only node with feeds and no fedBy');

  const visits = [...walkSourceToLoad(flow, rootId)];
  // root, PLC, VFD, MAH (via suffix tier), TIT (leaf), UNKNOWN-PANEL-99 (leaf).
  assert.equal(visits.length, 6);
  const depthByNode = new Map(visits.map((visit) => [visit.node.nodeId, visit.depth]));
  assert.equal(depthByNode.get(rootId), 0);
  assert.equal(depthByNode.get(plcId), 1, 'PLC001-10-01 is one feed hop from the root');
  assert.equal(depthByNode.get(vfdId), 2, 'VFD001-10-01 is fed by the PLC');
  assert.equal(depthByNode.get(mahId), 3, 'MAH001-10-01 is fed by the VFD (via the suffix-tier spelling)');
  assert.equal(depthByNode.get(unknownFeedId), 3, 'the unknown feed tag is also one hop off the VFD');
  assert.equal(depthByNode.get(titId), 4, 'TIT603-10-01 is fed by MAH001-10-01');

  // Hand-computed: 6 feed rows + 2 PMD rows = 8 edges, none of them self-loops.
  assert.equal(flow.stats.edgeCount, 8);
  assert.equal(flow.stats.nodeCount, 8);
  assert.equal(flow.stats.modelConfirmedCount, 4);
  assert.equal(
    flow.stats.multiFeedNodeCount,
    1,
    'the two parallel cables (C-101, C-102) into MAH001-10-01 multi-feed it once, not twice',
  );

  for (const assetId of [plcId, vfdId, mahId, titId]) {
    assert.equal(flow.nodes.get(assetId)?.matchStatus, 'model-confirmed');
  }
});

test('2. model metadata enriches matched nodes: a FlowEnrichment map built from catalog assets survives onto the resolved node', () => {
  const { catalog, flow } = pipeline;
  const mahAsset = catalog.assets.find((candidate) => candidate.canonicalTag === 'MAH001-10-01');
  assert.ok(mahAsset);
  assert.equal(mahAsset.building, 'D1');

  const node = flow.nodes.get(mahAsset.assetId);
  assert.ok(node, 'MAH001-10-01 should be a flow node');
  assert.ok(node.enrichment, 'a matched node whose asset is in the enrichment map should carry it');
  assert.equal(node.enrichment.description, mahAsset.description);
  assert.equal(node.enrichment.building, mahAsset.building);
});

test('3. unmatched nodes remain visible: the unknown feed tag is flow-only, the unknown PMD instrument is pmd-only, and both carry no assetId', () => {
  const { flow } = pipeline;

  const unknownFeedNode = flow.nodes.get(`${SOURCE_ONLY_NODE_PREFIX}${UNKNOWN_FEED_TAG}`);
  assert.ok(unknownFeedNode, 'the unknown feed tag should still be a node');
  assert.equal(unknownFeedNode.matchStatus, 'flow-only');
  assert.equal(unknownFeedNode.assetId, undefined);

  const unknownPmdNode = flow.nodes.get(`${SOURCE_ONLY_NODE_PREFIX}${UNKNOWN_PMD_TAG}`);
  assert.ok(unknownPmdNode, 'the unknown PMD instrument should still be a node');
  assert.equal(unknownPmdNode.matchStatus, 'pmd-only');
  assert.equal(unknownPmdNode.assetId, undefined);
});

test('4. no source-only item silently becomes model-authoritative: source-only nodes carry no assetId, and building the flow leaves the asset catalog untouched', () => {
  const { catalog, index, report, enrichment, flow } = pipeline;

  const assetCountBefore = catalog.assets.length;
  // Build the projection again from the same inputs: if this mutated the
  // catalog in any way, the count taken before and after would diverge.
  buildElectricalFlowFromIndex(report.observations, index, enrichment);
  assert.equal(catalog.assets.length, assetCountBefore, 'the asset catalog must not change size from a flow build');

  let sourceOnlyNodeCount = 0;
  for (const node of flow.nodes.values()) {
    if (node.matchStatus === 'model-confirmed') {
      continue;
    }
    sourceOnlyNodeCount += 1;
    assert.equal(node.assetId, undefined, `${node.tag} (${node.matchStatus}) must carry no assetId`);
  }
  // UNKNOWN-PANEL-99, TIT603-1O-01, PMD-INST-999, and the SWBD-1 root.
  assert.equal(sourceOnlyNodeCount, 4);
});

test('5. identity tiers engaged: the below-exact match resolves at suffix-unambiguous, and a fuzzy candidate raises a review item rather than a match', () => {
  const { catalog, index, flow } = pipeline;
  const mahAsset = catalog.assets.find((candidate) => candidate.canonicalTag === 'MAH001-10-01');
  const titAsset = catalog.assets.find((candidate) => candidate.canonicalTag === 'TIT603-10-01');
  assert.ok(mahAsset);
  assert.ok(titAsset);

  const suffixOutcome = resolveTag(index, SUFFIX_TAG);
  assert.equal(suffixOutcome.status, 'matched');
  assert.equal(suffixOutcome.tier, 'suffix-unambiguous');
  assert.equal(suffixOutcome.assetId, mahAsset.assetId);

  const mahNode = flow.nodes.get(mahAsset.assetId);
  assert.equal(
    mahNode?.identityTier,
    'suffix-unambiguous',
    'the flow node should carry the same tier the identity layer resolved',
  );

  const fuzzyOutcome = resolveTag(index, FUZZY_PMD_TAG);
  assert.equal(fuzzyOutcome.status, 'unmatched', 'fuzzy identity must never auto-match');
  assert.ok(fuzzyOutcome.candidates.length > 0, 'the one-letter typo should be within the default fuzzy distance');
  assert.ok(fuzzyOutcome.candidates.every((candidate) => candidate.tier === 'fuzzy-proposal'));
  assert.ok(
    fuzzyOutcome.candidates.some((candidate) => candidate.assetId === titAsset.assetId),
    'TIT603-10-01 should be among the proposed candidates',
  );

  const fuzzyReviewItem = flow.reviewItems.find(
    (item) => item.kind === 'fuzzy-identity' && item.evidenceTag === FUZZY_PMD_TAG,
  );
  assert.ok(fuzzyReviewItem, 'the fuzzy proposal must surface as a review item, not silently resolve');
});

test('6. determinism: rebuilding the whole pipeline from scratch twice produces the same flow stats and the same node ids', () => {
  const first = buildPipeline();
  const second = buildPipeline();

  assert.deepEqual(first.flow.stats, second.flow.stats);
  assert.deepEqual([...first.flow.nodes.keys()].sort(), [...second.flow.nodes.keys()].sort());
});
