import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateSiteProfileV1 } from '@matchline/domain';
import { openExtractionCache } from '@matchline/model-schema';
import {
  SCALE_ANATOMY,
  SCALE_PROPERTIES,
  SCALE_ROLE_GRAPH,
  writeScaleFixture,
} from '@matchline/model-schema/fixtures/scale';

/**
 * The scale universe, and the one profile compiled over it.
 *
 * Four caches, disjoint unit codes, one profile that maps every field the
 * fixture writes. Everything here is invented (see the fixture's own header);
 * the only thing that is real is the size.
 */

/**
 * Four files, two building units each, 1,250 families of four roles per unit.
 *
 * 4 x 2 x 1250 x 4 = 40,000 assets; each with six untagged solids and twenty
 * property rows, plus two rows per solid: 280,012 objects and 1,280,000
 * property rows across the universe. Those are the RELEASE-1.0-PLAN floors
 * (>=250k objects, >=40k assets, >=1M property rows) with the margin that comes
 * from choosing round numbers rather than the minimum that passes.
 */
export const SCALE_UNIVERSE = [
  { file: 'SITE-A.nwd', unitCodes: ['10', '11'] },
  { file: 'SITE-B.nwd', unitCodes: ['20', '21'] },
  { file: 'SITE-C.nwd', unitCodes: ['30', '31'] },
  { file: 'SITE-D.nwd', unitCodes: ['40', '41'] },
];

const PER_FILE = {
  familiesPerUnit: 1250,
  componentsPerAsset: 6,
  propertiesPerAsset: 20,
};

/** The floors this suite exists to clear. */
export const SCALE_FLOORS = {
  objectCount: 250_000,
  assetCount: 40_000,
  propertyCount: 1_000_000,
};

/** Building then system, both hard boundaries — the standard shape. */
const HIERARCHY = {
  levels: [
    {
      levelId: 'building',
      displayName: 'Building',
      attributeKey: 'building',
      boundary: true,
      missingValuePolicy: 'unassigned-group',
      sort: 'label',
    },
    {
      levelId: 'system',
      displayName: 'System',
      attributeKey: 'systemKey',
      boundary: true,
      missingValuePolicy: 'unassigned-group',
      sort: 'key',
    },
  ],
};

/**
 * The Site Profile the scale universe compiles under.
 *
 * Built through `migrateSiteProfileV1` for the same reason the Dragon fixture
 * is: it exercises the lift every stored profile goes through, so this cannot
 * drift into a shape only the scale suite can produce.
 */
export function scaleProfile() {
  return migrateSiteProfileV1(
    {
      profileId: 'scale',
      name: 'Scale',
      version: 1,
      propertyMappings: {
        equipmentTag: SCALE_PROPERTIES.equipmentTag,
        description: SCALE_PROPERTIES.description,
        equipmentType: SCALE_PROPERTIES.equipmentType,
        building: SCALE_PROPERTIES.building,
        nativeDiscipline: SCALE_PROPERTIES.nativeDiscipline,
      },
      assetFilters: { requireTagProperty: true, collapseComponents: false },
      tagAnatomy: SCALE_ANATOMY,
      // The model states the system; nothing else is consulted, so forty
      // thousand assets resolve without forty thousand conflicts.
      systemResolver: {
        keyChain: [{ kind: 'model-field', property: SCALE_PROPERTIES.systemKey }],
        descriptionChain: [],
        normalization: [],
        conflictPolicy: 'review',
      },
    },
    { hierarchy: HIERARCHY, roleGraph: SCALE_ROLE_GRAPH },
  );
}

/**
 * Writes the four caches into a temp directory and opens them.
 *
 * The caller closes everything through `close`, so a run leaves no
 * quarter-of-a-gigabyte of fixtures behind.
 */
export function openScaleUniverse() {
  const directory = mkdtempSync(join(tmpdir(), 'matchline-scale-'));
  const sources = [];
  const totals = { objectCount: 0, assetCount: 0, propertyCount: 0, byteSize: 0 };
  const startedAt = Date.now();

  for (const [index, spec] of SCALE_UNIVERSE.entries()) {
    const path = join(directory, `site-${String(index)}.sqlite`);
    const counts = writeScaleFixture(path, {
      inputFileName: spec.file,
      unitCodes: spec.unitCodes,
      ...PER_FILE,
    });
    totals.objectCount += counts.objectCount;
    totals.assetCount += counts.assetCount;
    totals.propertyCount += counts.propertyCount;
    totals.byteSize += statSync(path).size;
    sources.push({
      sourceId: `model:${spec.file.toLowerCase()}`,
      cache: openExtractionCache(path),
      displayName: spec.file,
      rawFileName: spec.file,
    });
  }

  return {
    sources,
    totals,
    writeMs: Date.now() - startedAt,
    close() {
      for (const source of sources) {
        source.cache.close();
      }
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/**
 * A compiled project reduced to what determinism actually claims.
 *
 * A `deepStrictEqual` of two forty-thousand-asset projects would hold both in
 * memory at once and compare several million nodes to say one thing. This says
 * the same thing in a few kilobytes: every asset's identity and where the
 * ladder put it, the byte-identical generated MEL, and every stage's headline
 * count. Two compiles that agree on all three agree.
 */
export function fingerprintOf(project) {
  const parents = [];
  for (const asset of project.catalog.assets) {
    const node = project.snapshot.nodes.get(asset.assetId);
    parents.push(
      [
        asset.assetId,
        asset.canonicalTag,
        asset.sourceId,
        node?.parent.status ?? '',
        node?.parent.status === 'resolved' ? node.parent.parentAssetId : '',
        node?.parent.ladderSource ?? '',
      ].join('|'),
    );
  }
  return {
    assetCount: project.catalog.assets.length,
    parents: hashOf(parents.join('\n')),
    generatedMel: hashOf(project.generatedMel.workbookBytes),
    stats: JSON.stringify(project.stats),
  };
}

/** A content hash, so a mismatch prints two short strings rather than two novels. */
function hashOf(value) {
  return createHash('sha256').update(value).digest('hex');
}
