/**
 * End-to-end proof of PRODUCT.md §19 Phase 2's exit criteria: one flowing
 * pipeline over a temp-dir Dragon cache, from raw extraction all the way to a
 * generated, re-readable canonical MEL workbook.
 *
 * Phase 2 exit criteria (docs/PRODUCT.md §19):
 *   - Matchline can generate a credible MEL from model data
 *   - `MAH001-10-01` can derive System Key `001` through a site rule
 *   - A model UPN can join to MEL System Description
 *   - A user can select one direct System column instead
 *   - Every system value has provenance
 *   - Conflicts are visible, not silently overwritten
 *
 * ## Import mechanism (see coordinator's task brief)
 *
 * `@matchline/domain`, `@matchline/model-schema`, `@matchline/spreadsheet-import`
 * and `@matchline/tag-anatomy` resolve by package name: `npm install` has
 * symlinked them into the root `node_modules/@matchline/`.
 *
 * `@matchline/asset-catalog`, `@matchline/system-resolver` and
 * `@matchline/mel-export` do NOT resolve by name -- `node_modules/@matchline/`
 * has no symlink for any of the three, and `package-lock.json` at the repo
 * root has no entry for them at all (`grep -c` on the three names returns 0).
 * They are newer workspace packages that `npm install`/`npm ci` was never
 * re-run against, so their names are simply absent from the lockfile-driven
 * link set. This is a real gap, reported rather than hacked around: this file
 * imports those three by built `dist/` path instead, which is the same
 * fallback every existing in-package test suite already uses for its sibling
 * workspaces (e.g. `packages/asset-catalog/test/support.mjs` importing
 * `../../model-schema/dist/...`). Re-running `npm install` at the repo root
 * would fix the by-name path and is left to the coordinator, since it rewrites
 * the tracked `package-lock.json` -- outside this task's file scope.
 *
 * This is a plain `.mjs` file, not TypeScript: the domain/system-resolver
 * config shapes (`PropertyMappings`, `TagAnatomyConfig`, `SystemResolverConfig`,
 * ...) are compile-time-only, so object literals here are shaped to match them
 * by hand rather than imported.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { writeDragonFixture } from '@matchline/model-schema/fixtures/dragon';
import { openExtractionCache } from '@matchline/model-schema';
import {
  readMappedTable,
  readWorkbook,
  sheetAoa,
} from '@matchline/spreadsheet-import';
import { applyAnatomy } from '@matchline/tag-anatomy';

import { buildAssetCatalog } from '../../packages/asset-catalog/dist/index.js';
import {
  buildSystemCatalog,
  resolveSubject,
  resolveSystems,
} from '../../packages/system-resolver/dist/index.js';
import {
  CANONICAL_MEL_HEADERS,
  writeCanonicalMelWorkbook,
} from '../../packages/mel-export/dist/index.js';

/**
 * Dragon's real tag anatomy (mirrors the site-resolver package's own
 * `test/dragon.fixture.ts`, `DRAGON_ANATOMY`): `MAH001-10-01` -> role `MAH`,
 * system `001`, unit `10`, instance `01`.
 */
const DRAGON_ANATOMY = {
  separators: ['-'],
  segments: {
    role: { kind: 'alphaPrefix', token: 0 },
    system: { kind: 'digitSuffix', token: 0 },
    unit: { kind: 'token', token: 1 },
    instance: { kind: 'token', token: 2 },
  },
  familyKeyTemplate: '{system}-{token:1}-{token:2}',
};

/**
 * Dragon has no property literally named "Description"; `Dragon Data >
 * Manufacturer` is mapped onto the `description` role instead, so step 1's
 * assertion is genuinely reading a model property through the mapping rather
 * than a field that happens to already be named right.
 */
const MAPPINGS = {
  equipmentTag: { category: 'Dragon Data', name: 'Tag' },
  description: { category: 'Dragon Data', name: 'Manufacturer' },
  equipmentType: { category: 'Item', name: 'Type' },
  building: { category: 'Dragon Data', name: 'Building' },
};

/** Mechanical only, so the universe is exactly the MAH/TIT tags from §5.4. */
const FILTERS = {
  requireTagProperty: true,
  collapseComponents: false,
  includedSourceModelFiles: ['Dragon-Mechanical.nwc'],
};

/** One invented MEL row per §5.4: the tag names the system, the MEL names it. */
const DRAGON_MEL = [
  {
    equipmentTag: 'MAH001-10-01',
    systemKey: '001',
    systemDescription: 'Mechanical Dry Air Handling',
    sourceFile: 'Dragon-MEL.xlsx',
    sheet: 'MEL',
    row: 2,
  },
];

/** §5.4: the tag names the system, the MEL supplies the description. */
const TAG_THEN_MEL = {
  keyChain: [{ kind: 'tag-segment', segment: 'system' }],
  descriptionChain: [
    { kind: 'mel-lookup', joinBy: 'systemKey', returnField: 'systemDescription' },
  ],
  normalization: [],
  conflictPolicy: 'review',
};

/** §5.6: three rungs that can disagree -- model field, tag, MEL tag-join. */
const THREE_RUNG_KEY = {
  keyChain: [
    { kind: 'model-field', property: { category: 'Dragon Data', name: 'UPN' } },
    { kind: 'tag-segment', segment: 'system' },
    { kind: 'mel-lookup', joinBy: 'equipmentTag', returnField: 'systemKey' },
  ],
  descriptionChain: [
    { kind: 'mel-lookup', joinBy: 'systemKey', returnField: 'systemDescription' },
  ],
  normalization: [],
  conflictPolicy: 'review',
};

/**
 * Reads every property of an asset's owned objects into the nested
 * category -> name -> value bag `ResolverSubject.properties` wants.
 *
 * `asset-catalog`'s `ModelAsset` only carries the handful of fields a site
 * mapped (tag, description, ...); it deliberately does not expose the raw
 * property bag (`packages/asset-catalog/src/catalog.ts`, "model-first" doc
 * comment). Wiring a resolved asset back into a resolver subject with
 * arbitrary model-field rungs (`Dragon Data > UPN` for direct-column and
 * model-field configs below) therefore means re-reading the cache -- this is
 * exactly the seam a real coordinator sits on, so it is done here rather than
 * asked of either package.
 */
function readSubjectProperties(cache, objectIds) {
  const properties = new Map();
  for (const objectId of objectIds) {
    for (const property of cache.propertiesOf(objectId)) {
      if (property.valueText === null) continue;
      const value = property.valueText.trim();
      if (value.length === 0) continue;
      let byName = properties.get(property.category);
      if (byName === undefined) {
        byName = new Map();
        properties.set(property.category, byName);
      }
      // First non-blank reading wins, matching asset-catalog's own rule.
      if (!byName.has(property.name)) {
        byName.set(property.name, value);
      }
    }
  }
  return properties;
}

/** A `ResolverSubject` built from one catalog asset plus its raw properties. */
function subjectOf(cache, asset) {
  return {
    assetId: asset.assetId,
    canonicalTag: asset.canonicalTag,
    properties: readSubjectProperties(cache, asset.objectIds),
    sourceFile: 'Dragon-Mechanical.nwc',
    objectId: String(asset.objectIds[0]),
  };
}

/** A property-bag clone with one `(category, name)` pair overridden. */
function withOverriddenProperty(properties, category, name, value) {
  const clone = new Map();
  for (const [cat, names] of properties) {
    clone.set(cat, new Map(names));
  }
  let byName = clone.get(category);
  if (byName === undefined) {
    byName = new Map();
    clone.set(category, byName);
  }
  byName.set(name, value);
  return clone;
}

let directory = '';
let cache = null;
let assets = [];
let subjectsByTag = new Map();

before(() => {
  directory = mkdtempSync(join(tmpdir(), 'matchline-e1-pipeline-'));
  const cachePath = join(directory, 'dragon.sqlite');
  writeDragonFixture(cachePath);
  cache = openExtractionCache(cachePath);

  const catalog = buildAssetCatalog(cache, MAPPINGS, FILTERS);
  assets = catalog.assets;

  for (const asset of assets) {
    subjectsByTag.set(asset.canonicalTag, subjectOf(cache, asset));
  }
});

after(() => {
  cache?.close();
  rmSync(directory, { recursive: true, force: true });
});

test('1. buildAssetCatalog produces a nonempty model-first asset universe with a known tag populated from model properties', () => {
  assert.ok(assets.length > 0, 'the Dragon mechanical model should yield at least one asset');

  const mah001 = assets.find((asset) => asset.canonicalTag === 'MAH001-10-01');
  assert.ok(mah001, 'MAH001-10-01 should exist in the catalog');
  assert.equal(mah001.building, 'D1', 'building should come from Dragon Data > Building');
  assert.equal(
    typeof mah001.description,
    'string',
    'description should be populated from Dragon Data > Manufacturer',
  );
  assert.ok(mah001.description.length > 0, 'description should not be blank');
  assert.equal(mah001.status, 'MODEL_CONFIRMED');
});

test('2. tag anatomy derives System Key 001 for MAH001-10-01 via a tag-segment rung', () => {
  const anatomyResult = applyAnatomy(DRAGON_ANATOMY, 'MAH001-10-01');
  assert.equal(anatomyResult.matched, true);
  assert.equal(anatomyResult.segments.system, '001');

  const subject = subjectsByTag.get('MAH001-10-01');
  assert.ok(subject, 'MAH001-10-01 subject should have been built from the catalog asset');

  const tagOnlyConfig = {
    keyChain: [{ kind: 'tag-segment', segment: 'system' }],
    descriptionChain: [],
    normalization: [],
    conflictPolicy: 'review',
  };
  const resolved = resolveSubject(subject, tagOnlyConfig, { anatomy: DRAGON_ANATOMY });
  assert.equal(resolved.agreement, 'single-source');
  assert.equal(resolved.resolution?.systemKey, '001');
  assert.equal(resolved.keyClaim?.component, 'tag-segment');
  assert.equal(resolved.keyClaim?.rungIndex, 0);
});

test('3. MEL lookup joins the resolved System Key to an invented MEL row for description and label', () => {
  const { catalog: systemCatalog, reviewItems: catalogReviewItems } = buildSystemCatalog(DRAGON_MEL);
  assert.deepEqual(catalogReviewItems, [], 'a single-row MEL should raise no catalog conflicts');
  assert.equal(systemCatalog.get('001')?.description, 'Mechanical Dry Air Handling');

  const subject = subjectsByTag.get('MAH001-10-01');
  const resolved = resolveSubject(subject, TAG_THEN_MEL, {
    anatomy: DRAGON_ANATOMY,
    catalog: systemCatalog,
    melRows: DRAGON_MEL,
  });

  assert.equal(resolved.resolution?.systemKey, '001');
  assert.equal(resolved.resolution?.systemDescription, 'Mechanical Dry Air Handling');
  assert.equal(resolved.resolution?.systemLabel, '001 Mechanical Dry Air Handling');
});

test('4. direct-column mode resolves System Key standalone from a model property', () => {
  const subject = subjectsByTag.get('MAH001-10-01');
  const directColumnConfig = {
    keyChain: [{ kind: 'direct-column', property: { category: 'Dragon Data', name: 'UPN' } }],
    descriptionChain: [],
    normalization: [],
    conflictPolicy: 'review',
  };
  // No anatomy, no catalog, no MEL rows in context: direct-column must stand
  // entirely on its own, which is the point of the mode.
  const resolved = resolveSubject(subject, directColumnConfig, {});
  assert.equal(resolved.resolution?.systemKey, '001');
  assert.equal(resolved.keyClaim?.component, 'direct-column');
  assert.equal(resolved.agreement, 'single-source');
});

test('5. every resolved system value carries provenance naming its component kind and rung', () => {
  const { catalog: systemCatalog } = buildSystemCatalog(DRAGON_MEL);
  const subject = subjectsByTag.get('MAH001-10-01');
  const resolved = resolveSubject(subject, TAG_THEN_MEL, {
    anatomy: DRAGON_ANATOMY,
    catalog: systemCatalog,
    melRows: DRAGON_MEL,
  });

  assert.ok(resolved.resolution);
  assert.ok(resolved.resolution.systemEvidence.length > 0);
  for (const provenance of resolved.resolution.systemEvidence) {
    // `systemResolver.<keyChain|descriptionChain>[<rungIndex>].<component-kind>`
    assert.match(provenance.rule ?? '', /^systemResolver\.(keyChain|descriptionChain)\[\d+\]\.[a-z][a-z-]*$/);
    assert.ok(Number.isInteger(provenance.fallbackRung) && provenance.fallbackRung >= 1);
    assert.ok(provenance.sourceRef.kind === 'model-object' || provenance.sourceRef.kind === 'sheet-row');
  }
});

test('6. a model/tag/MEL disagreement raises a system-conflict review item with both claims retained', () => {
  const realSubject = subjectsByTag.get('MAH001-10-01');
  assert.ok(realSubject, 'MAH001-10-01 subject should exist');

  // Craft the §5.6 disagreement: the model field is overridden to say '002'
  // while the tag segment and the MEL both still say '001'.
  const conflictSubject = {
    ...realSubject,
    properties: withOverriddenProperty(realSubject.properties, 'Dragon Data', 'UPN', '002'),
  };

  const { catalog: systemCatalog } = buildSystemCatalog(DRAGON_MEL);
  const resolved = resolveSubject(conflictSubject, THREE_RUNG_KEY, {
    anatomy: DRAGON_ANATOMY,
    catalog: systemCatalog,
    melRows: DRAGON_MEL,
  });

  assert.equal(resolved.agreement, 'conflict');
  // A conflict still resolves -- to the first chain rung's claim ('002', the
  // model field) -- because `conflictPolicy: 'review'` means "raise it for a
  // person", not "refuse to produce an answer". `systemConflictStatus`
  // carries the disagreement forward; nothing is silently overwritten because
  // every claim, including the ones that lost, survives on the review item.
  assert.ok(resolved.resolution);
  assert.equal(resolved.resolution.systemKey, '002');
  assert.equal(resolved.resolution.systemConflictStatus, 'CONFLICTING');
  assert.equal(resolved.reviewItems.length, 1);

  const [reviewItem] = resolved.reviewItems;
  assert.equal(reviewItem.kind, 'system-conflict');
  assert.equal(reviewItem.assetId, conflictSubject.assetId);

  const proposedValues = reviewItem.claims.map((claim) => claim.proposedValue);
  assert.ok(proposedValues.includes('002'), 'the model-field claim of 002 must be retained');
  assert.ok(proposedValues.includes('001'), 'the tag-segment/MEL claim of 001 must be retained');
  assert.equal(reviewItem.claims.length, 3, 'every key-chain rung yielded a claim, winner or not');
});

test('7. generated MEL round-trips MAH001-10-01 with System Key 001 as text, §12.1 headers, and byte-stable writes', () => {
  const { catalog: systemCatalog } = buildSystemCatalog(DRAGON_MEL);
  const resolveResult = resolveSystems([...subjectsByTag.values()], TAG_THEN_MEL, {
    anatomy: DRAGON_ANATOMY,
    catalog: systemCatalog,
    melRows: DRAGON_MEL,
  });

  const generatedAssets = assets.map((asset) => {
    const subjectResolution = resolveResult.bySubject.get(asset.assetId);
    const resolution = subjectResolution?.resolution ?? undefined;
    return {
      canonicalTag: asset.canonicalTag,
      description: asset.description,
      equipmentType: asset.equipmentType,
      building: asset.building,
      ...(resolution === undefined ? {} : { system: resolution }),
      sourceModelFile: 'Dragon-Mechanical.nwc',
      modelObjectIds: asset.objectIds,
      inclusionStatus: asset.status,
    };
  });

  const bytesFirst = writeCanonicalMelWorkbook(generatedAssets);
  const bytesSecond = writeCanonicalMelWorkbook(generatedAssets);
  assert.deepEqual(
    Buffer.from(bytesFirst),
    Buffer.from(bytesSecond),
    'two writes over the same assets must be byte-identical',
  );

  const workbook = readWorkbook(bytesFirst);
  const sheet = workbook.getSheet('MEL');
  assert.ok(sheet, 'the workbook should contain the MEL sheet');
  const { aoa } = sheetAoa(sheet);

  assert.deepEqual(aoa[0], CANONICAL_MEL_HEADERS, 'the header row must match the §12.1 contract exactly');

  const table = readMappedTable(
    aoa,
    { equipmentTag: 'Equipment Tag', systemKey: 'System Key' },
    { headerRow: 0 },
  );
  const row = table.rows.find((candidate) => candidate.equipmentTag === 'MAH001-10-01');
  assert.ok(row, 'MAH001-10-01 should have a row in the generated MEL');
  assert.equal(row.systemKey, '001', 'the leading zero must survive the write/read round trip as text');
});
