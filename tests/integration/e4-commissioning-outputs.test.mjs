/**
 * End-to-end proof that the E4 commissioning outputs compose over a real
 * compiled Dragon project: `@matchline/scheduling` (P6 ingestion, the
 * milestone ladder, sequencing, the predecessor matrix), `@matchline/exto-export`
 * (item masters, the Rev21 register) and `@matchline/mel-export`'s three
 * further outputs (site-template MEL, existing-MEL comparison, revision diff).
 *
 * ## Import mechanism
 *
 * Same as `e3-ssm-compiler.test.mjs`: every package here is a real workspace
 * package, symlinked into `node_modules` by `npm install` at the repo root and
 * resolved by name, exactly like the other integration tests. `npm run build`
 * (or each workspace's own `npm test`) must have run first so `dist/` exists.
 *
 * ## The fixture technique
 *
 * `packages/compiler/test/support.mjs`'s `augmentDragonCache` -- a hand-written
 * helper that inserts extra objects/properties directly through `node:sqlite`
 * -- is replicated here exactly as `e3-ssm-compiler.test.mjs` replicates it,
 * because it is that file's own local helper, not exported by any package.
 * `writeDragonFixture` itself is used untouched.
 *
 * ## The one Dragon project this file compiles (tests 1-5)
 *
 * `e3-ssm-compiler.test.mjs`'s own nine additions are carried over verbatim --
 * including the PNL603/RIO603 cross-system pair PRODUCT.md §2.5 names, which
 * this file's predecessor-matrix test (3) needs -- plus one more quartet,
 * `MAH006-10-01`/`PLC006-10-01`/`VFD006-10-01`/`TIT006-10-01`: the same
 * MAH->PLC->VFD->TIT feed shape as the e3 quartet, in System `006` rather than
 * `005`, so the sequencing test (2) has two independent, already-resolved
 * chains to number in opposite polarities without inventing a second kind of
 * evidence.
 *
 * 43 (the e3 project) + 4 = 47 assets.
 *
 * ## The revision pair (test 6)
 *
 * A second, smaller pair of Dragon caches -- unrelated to the 47-asset project
 * above -- built fresh per revision so the diff has exactly four deliberate
 * changes and nothing else: an added asset, a removed asset, a changed
 * description, and a parent move from a manual override applied only on the
 * second revision.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { after, before } from 'node:test';

import { compileProject } from '@matchline/compiler';
import { migrateSiteProfileV1 } from '@matchline/domain';
import {
  DEFAULT_EXTO_SHEET_NAME,
  EXTO_HEADER_ROW_INDEX,
  assignItemMasters,
  buildExtoRows,
  trainItemMasterTable,
  writeExtoWorkbook,
} from '@matchline/exto-export';
import {
  analyzeTemplate,
  compareWithExistingMel,
  diffMelRevisions,
  writeDiffWorkbook,
  writeTemplateMel,
} from '@matchline/mel-export';
import { openExtractionCache } from '@matchline/model-schema';
import { writeDragonFixture } from '@matchline/model-schema/fixtures/dragon';
import {
  assignMilestones,
  buildPredecessorMatrix,
  computeSequence,
  readP6ActivitySheet,
  writePredecessorWorkbook,
} from '@matchline/scheduling';
import { readWorkbook, sheetAoa, writeWorkbook } from '@matchline/spreadsheet-import';

/* ------------------------------------------------------- the universe --- */

/**
 * The `sourceId` this file's one extraction cache is registered under.
 *
 * `compileProject` takes a model universe rather than a cache (P0-1); a project
 * built from one file is a universe of one, and this is that file's id. It is a
 * project-assigned identity, not a file name -- P0-1's hard gate 4 is precisely
 * that two sources may share a basename.
 */
const MODEL_SOURCE_ID = 'dragon';

/* ------------------------------------------------------------- anatomy --- */

/** `MAH005-10-01` -> role `MAH`, system `005`, unit `10`, instance `01`. Verbatim from e3. */
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

const PROPERTY_MAPPINGS = {
  equipmentTag: { category: 'Dragon Data', name: 'Tag' },
  description: { category: 'Dragon Data', name: 'Manufacturer' },
  equipmentType: { category: 'Item', name: 'Type' },
  building: { category: 'Dragon Data', name: 'Building' },
  nativeDiscipline: { category: 'Dragon Data', name: 'Service' },
};

const ASSET_FILTERS = { requireTagProperty: true, collapseComponents: false };

/** One rung: the model's own UPN. Verbatim from e3. */
const SYSTEM_RESOLVER = {
  keyChain: [{ kind: 'model-field', property: { category: 'Dragon Data', name: 'UPN' } }],
  descriptionChain: [],
  normalization: [],
  conflictPolicy: 'review',
};

/** Base MAH->PLC->VFD plus VFD->TIT, and PNL->RIO. Verbatim from e3. */
const ROLE_GRAPH = {
  rules: [
    { parentRole: 'MAH', childRole: 'PLC' },
    { parentRole: 'PLC', childRole: 'VFD' },
    { parentRole: 'VFD', childRole: 'TIT' },
    { parentRole: 'PNL', childRole: 'RIO' },
  ],
};

/** Building then System, both hard boundaries. Verbatim from e3. */
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
 * The E4 site's whole rule set, as one `SiteProfileV2`.
 *
 * Built through the published migration rather than written out longhand: this
 * is the same lift every stored V1 profile takes, so an integration test cannot
 * accidentally prove the pipeline against a profile shape only it can make.
 */
function siteProfile() {
  return migrateSiteProfileV1(
    {
      profileId: 'dragon-e4',
      name: 'Dragon E4',
      version: 1,
      propertyMappings: PROPERTY_MAPPINGS,
      assetFilters: ASSET_FILTERS,
      tagAnatomy: DRAGON_ANATOMY,
      systemResolver: SYSTEM_RESOLVER,
    },
    {
      hierarchy: HIERARCHY,
      roleGraph: ROLE_GRAPH,
      ssmDisciplineProjection: [{ from: 'I&C', to: 'Mechanical' }],
    },
  );
}

/** `tag:<canonicalTag>` -- `asset-catalog`'s id for an unduplicated tag. */
function idOf(tag) {
  return `tag:${tag}`;
}

/* -------------------------------------------------------- cache fixture --- */

const SOURCE_MODEL_MECHANICAL = 1;
const SOURCE_MODEL_CONTROLS = 2;

/**
 * Appends invented objects to a written Dragon cache. Replicated from
 * `packages/compiler/test/support.mjs` / `e3-ssm-compiler.test.mjs`'s own copy
 * of the same helper -- see the file header.
 */
function augmentDragonCache(path, build) {
  const db = new DatabaseSync(path);
  try {
    db.exec('BEGIN');

    const insertObject = db.prepare(
      'INSERT INTO objects (id, source_model_id, parent_id, path_index, depth, display_name, class_name, ' +
        'instance_guid, authoring_id, bbox_min_x, bbox_min_y, bbox_min_z, bbox_max_x, bbox_max_y, bbox_max_z) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL)',
    );
    const insertProperty = db.prepare(
      'INSERT INTO properties (object_id, category, category_internal, name, name_internal, value_text, value_type) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    );

    let nextId = db.prepare('SELECT MAX(id) AS id FROM objects').get().id + 1;

    const nextPathIndex = (parentId) => {
      const query = 'SELECT MAX(path_index) AS slot FROM objects WHERE parent_id';
      const row =
        parentId === null
          ? db.prepare(`${query} IS NULL`).get()
          : db.prepare(`${query} = ?`).get(parentId);
      return (row.slot ?? -1) + 1;
    };

    const context = {
      layerId(displayName, sourceModelId) {
        const row = db
          .prepare(
            'SELECT id FROM objects WHERE display_name = ? AND source_model_id = ? AND depth = 1',
          )
          .get(displayName, sourceModelId);
        return row.id;
      },

      addObject({ sourceModelId, parentId, depth, displayName, className }) {
        const id = nextId;
        nextId += 1;
        insertObject.run(
          id,
          sourceModelId,
          parentId,
          nextPathIndex(parentId),
          depth,
          displayName,
          className,
          `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
          null,
        );
        context.addProperty(id, 'Item', 'Name', displayName);
        context.addProperty(id, 'Item', 'Type', className);
        return id;
      },

      addProperty(objectId, category, name, value) {
        insertProperty.run(
          objectId,
          category,
          category.toLowerCase().replaceAll(' ', '_'),
          name,
          name.toLowerCase().replaceAll(' ', '_'),
          value,
          'DisplayString',
        );
      },

      addEquipment({ sourceModelId, parentId, depth, tag, upn, building, service, manufacturer }) {
        const id = context.addObject({
          sourceModelId,
          parentId,
          depth,
          displayName: tag,
          className: 'Equipment',
        });
        context.addProperty(id, 'Dragon Data', 'Tag', tag);
        context.addProperty(id, 'Dragon Data', 'Building', building);
        context.addProperty(id, 'Dragon Data', 'UPN', upn);
        if (service !== undefined) {
          context.addProperty(id, 'Dragon Data', 'Service', service);
        }
        if (manufacturer !== undefined) {
          context.addProperty(id, 'Dragon Data', 'Manufacturer', manufacturer);
        }
        return id;
      },
    };

    build(context);

    const count = db.prepare('SELECT COUNT(*) AS total FROM objects').get().total;
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(count), 'object_count');
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

/**
 * The e3 project's nine assets, plus one more quartet this file needs: the
 * same MAH->PLC->VFD->TIT feed shape, System `006` rather than `005`, so
 * sequencing (test 2) has a second independent chain to number bottom-up.
 */
function addE4Fixtures(context) {
  const controlsD1 = context.layerId('D1', SOURCE_MODEL_CONTROLS);
  const mechanicalD1 = context.layerId('D1', SOURCE_MODEL_MECHANICAL);

  // --- §2.5: the panel/RIO pair, siblings under D1 controls (from e3) -------
  context.addEquipment({
    sourceModelId: SOURCE_MODEL_CONTROLS,
    parentId: controlsD1,
    depth: 2,
    tag: 'PNL603-10-01',
    upn: '603',
    building: 'D1',
  });
  context.addEquipment({
    sourceModelId: SOURCE_MODEL_CONTROLS,
    parentId: controlsD1,
    depth: 2,
    tag: 'RIO603-10-01',
    upn: '650',
    building: 'D1',
  });

  // --- the MAH/PLC/VFD/TIT family, System 005 (from e3) ----------------------
  context.addEquipment({
    sourceModelId: SOURCE_MODEL_MECHANICAL,
    parentId: mechanicalD1,
    depth: 2,
    tag: 'MAH005-10-01',
    upn: '005',
    building: 'D1',
  });
  context.addEquipment({
    sourceModelId: SOURCE_MODEL_CONTROLS,
    parentId: controlsD1,
    depth: 2,
    tag: 'PLC005-10-01',
    upn: '005',
    building: 'D1',
  });
  context.addEquipment({
    sourceModelId: SOURCE_MODEL_CONTROLS,
    parentId: controlsD1,
    depth: 2,
    tag: 'VFD005-10-01',
    upn: '005',
    building: 'D1',
  });
  context.addEquipment({
    sourceModelId: SOURCE_MODEL_MECHANICAL,
    parentId: mechanicalD1,
    depth: 2,
    tag: 'TIT005-10-01',
    upn: '005',
    building: 'D1',
  });

  // --- the discipline-projection asset (from e3) -----------------------------
  context.addEquipment({
    sourceModelId: SOURCE_MODEL_CONTROLS,
    parentId: controlsD1,
    depth: 2,
    tag: 'IOC090-10-01',
    upn: '090',
    building: 'D1',
    service: 'I&C',
  });

  // --- the learned-rule pair, description spelled like the tag (from e3) ----
  context.addEquipment({
    sourceModelId: SOURCE_MODEL_CONTROLS,
    parentId: controlsD1,
    depth: 2,
    tag: 'AHU080-10-01',
    upn: '080',
    building: 'D1',
    manufacturer: 'AHU080-10-01',
  });
  context.addEquipment({
    sourceModelId: SOURCE_MODEL_CONTROLS,
    parentId: controlsD1,
    depth: 2,
    tag: 'DMP080-10-01',
    upn: '080',
    building: 'D1',
    manufacturer: 'DMP080-10-01',
  });

  // --- this file's own addition: the second quartet, System 006 -------------
  context.addEquipment({
    sourceModelId: SOURCE_MODEL_MECHANICAL,
    parentId: mechanicalD1,
    depth: 2,
    tag: 'MAH006-10-01',
    upn: '006',
    building: 'D1',
  });
  context.addEquipment({
    sourceModelId: SOURCE_MODEL_CONTROLS,
    parentId: controlsD1,
    depth: 2,
    tag: 'PLC006-10-01',
    upn: '006',
    building: 'D1',
  });
  context.addEquipment({
    sourceModelId: SOURCE_MODEL_CONTROLS,
    parentId: controlsD1,
    depth: 2,
    tag: 'VFD006-10-01',
    upn: '006',
    building: 'D1',
  });
  context.addEquipment({
    sourceModelId: SOURCE_MODEL_MECHANICAL,
    parentId: mechanicalD1,
    depth: 2,
    tag: 'TIT006-10-01',
    upn: '006',
    building: 'D1',
  });
}

/** A temp-dir Dragon cache, base fixture plus {@link addE4Fixtures}. */
function openE4Cache(label) {
  const directory = mkdtempSync(join(tmpdir(), `matchline-e4-${label}-`));
  const path = join(directory, 'dragon.sqlite');
  writeDragonFixture(path);
  augmentDragonCache(path, addE4Fixtures);
  const cache = openExtractionCache(path);
  return {
    cache,
    close() {
      cache.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

/* -------------------------------------------------------- connectivity --- */

/**
 * The e3 chain (MAH005->PLC005->VFD005->TIT005, PNL603->RIO603) plus the same
 * shape again for the 006 quartet.
 */
function connectivityWorkbookBytes() {
  return writeWorkbook([
    {
      name: 'EasyPower',
      aoa: [
        ['Starting Source', 'ID Name'],
        ['MAH005-10-01', 'PLC005-10-01'],
        ['PLC005-10-01', 'VFD005-10-01'],
        ['VFD005-10-01', 'TIT005-10-01'],
        ['PNL603-10-01', 'RIO603-10-01'],
        ['MAH006-10-01', 'PLC006-10-01'],
        ['PLC006-10-01', 'VFD006-10-01'],
        ['VFD006-10-01', 'TIT006-10-01'],
      ],
    },
  ]);
}

const CONNECTIVITY_SOURCE_FILE = 'Dragon-E4-Connectivity.xlsx';

function connectivityWorkbooks() {
  return [{ bytes: connectivityWorkbookBytes(), sourceFile: CONNECTIVITY_SOURCE_FILE }];
}

/** The full input the main 47-asset project compiles from. */
function mainInput(cache, overrides = {}) {
  return {
    sources: [{ sourceId: MODEL_SOURCE_ID, cache }],
    profile: siteProfile(),
    connectivityWorkbooks: connectivityWorkbooks(),
    ...overrides,
  };
}

/* ----------------------------------------------------------------- tags --- */

const PANEL = idOf('PNL603-10-01');
const RIO = idOf('RIO603-10-01');
const MAH005 = idOf('MAH005-10-01');
const PLC005 = idOf('PLC005-10-01');
const VFD005 = idOf('VFD005-10-01');
const TIT005 = idOf('TIT005-10-01');
const IOC = idOf('IOC090-10-01');
const AHU = idOf('AHU080-10-01');
const DMP = idOf('DMP080-10-01');
const MAH006 = idOf('MAH006-10-01');
const PLC006 = idOf('PLC006-10-01');
const VFD006 = idOf('VFD006-10-01');
const TIT006 = idOf('TIT006-10-01');

/* ---------------------------------------------------------- mel adapter --- */

/**
 * `CompiledProject` -> `GeneratedMelAsset[]`, the shape `@matchline/mel-export`'s
 * site-template, comparison and revision-diff layers take.
 *
 * `compile.ts`'s own `generatedMelAssetOf` does the same adapting, but it is a
 * private function -- `@matchline/compiler` publishes the *result*
 * (`project.generatedMel.rows`, already flattened to `CanonicalMelRow`), not
 * the intermediate `GeneratedMelAsset`. A caller who wants to run the
 * site-template or revision-diff layers over a compiled project has to write
 * exactly this adapter themselves, from the project's own public fields
 * (`catalog.assets`, `systems.bySubject`, `compileSubjects`, `snapshot.nodes`)
 * -- which is what this function proves composes.
 */
function toGeneratedMelAssets(project) {
  const tagOf = new Map(project.catalog.assets.map((asset) => [asset.assetId, asset.canonicalTag]));
  const subjectOf = new Map(project.compileSubjects.map((subject) => [subject.assetId, subject]));

  return project.catalog.assets.map((asset) => {
    const resolution = project.systems.bySubject.get(asset.assetId)?.resolution ?? null;
    const node = project.snapshot.nodes.get(asset.assetId);
    const ssmDiscipline = subjectOf.get(asset.assetId)?.attributes.get('ssmDiscipline');
    const parentAssetId =
      node !== undefined && node.parent.status === 'resolved' ? node.parent.parentAssetId : null;
    const parentTag = parentAssetId === null ? undefined : tagOf.get(parentAssetId);
    const dependencyTags = [
      ...new Set(
        (node?.dependencies ?? [])
          .map((dependency) => tagOf.get(dependency.parentAssetId))
          .filter((tag) => tag !== undefined),
      ),
    ];

    return {
      canonicalTag: asset.canonicalTag,
      ...(asset.description === undefined ? {} : { description: asset.description }),
      ...(asset.equipmentType === undefined ? {} : { equipmentType: asset.equipmentType }),
      ...(asset.building === undefined ? {} : { building: asset.building }),
      ...(asset.nativeDiscipline === undefined ? {} : { nativeDiscipline: asset.nativeDiscipline }),
      ...(ssmDiscipline === undefined ? {} : { ssmDiscipline }),
      ...(resolution === null ? {} : { system: resolution }),
      ...(parentTag === undefined ? {} : { systemParentTag: parentTag }),
      ...(dependencyTags.length === 0 ? {} : { dependencyTags }),
      modelObjectIds: asset.objectIds,
      inclusionStatus: asset.status,
      ...(node?.parent.ladderSource == null ? {} : { parentEvidence: node.parent.ladderSource }),
    };
  });
}

/* ------------------------------------------------------------------------ */

let handle = null;
let project = null;

before(() => {
  handle = openE4Cache('main');
  project = compileProject(mainInput(handle.cache));
});

after(() => {
  handle?.close();
});

test('sanity: 43 (the e3 project) plus this file\'s own quartet, no duplicate tags', () => {
  assert.equal(project.stats.assetCount, 47);
  assert.equal(project.stats.duplicateTagCount, 0);
  // The RIO demotion (test 3 needs it) is still exactly one boundary crossing.
  assert.equal(project.snapshot.stats.demotedToDependencyCount, 1);
});

/* ============================================================ test 1 ==== */

test('1. P6 -> milestones: an in-test activity sheet, all four rungs hit', () => {
  const workbook = writeWorkbook([
    {
      name: 'Activities',
      aoa: [
        ['Activity ID', 'Activity Name', 'Equipment ID', 'UPN'],
        // rung 1: direct equipment tag.
        ['A100', 'Startup MAH005', 'MAH005-10-01', ''],
        // rung 2: an explicit UPN column, matching IOC090-10-01's System 090.
        ['A200', 'Startup System 090', '', '090'],
        // rung 3: the system read out of the activity NAME, System 080 --
        // matches both AHU080-10-01 and DMP080-10-01.
        ['A300', 'UPN 080 Energization', '', ''],
      ],
    },
  ]);
  const read = readWorkbook(workbook);
  const sheet = sheetAoa(read.getSheet('Activities'));
  const schedule = readP6ActivitySheet(
    sheet,
    { activityId: 'Activity ID', activityName: 'Activity Name', equipmentTag: 'Equipment ID', upn: 'UPN' },
    { sourceFile: 'Dragon-E4-P6.xlsx', sheetName: 'Activities' },
  );
  assert.equal(schedule.stats.activityCount, 3);
  assert.equal(schedule.stats.skippedRowCount, 0);

  // Every compiled asset, left to the ladder. Assets not yet in D1 (building
  // is only stated on assets this file/e3 added) still carry a systemKey.
  const subjectOf = new Map(project.compileSubjects.map((subject) => [subject.assetId, subject]));
  const milestoneAssets = project.catalog.assets.map((asset) => ({
    assetId: asset.assetId,
    canonicalTag: asset.canonicalTag,
    systemKey: subjectOf.get(asset.assetId)?.attributes.get('systemKey'),
    building: subjectOf.get(asset.assetId)?.attributes.get('building'),
  }));

  const ladder = assignMilestones(schedule.activities, milestoneAssets);

  assert.equal(ladder.assignments.length, 47);
  assert.equal(ladder.unmatchedActivities.length, 0, 'every activity must have been used');

  // Hand-verified: MAH005-10-01 (tag) = 1; IOC090-10-01 (UPN column) = 2;
  // AHU080-10-01 + DMP080-10-01 (name pattern, System 080) = 2 at rung 3;
  // everything else (47 - 1 - 1 - 2 = 43) falls to the building-ready default.
  assert.deepEqual(ladder.byRung, { 1: 1, 2: 1, 3: 2, 4: 43 });

  const byAsset = new Map(ladder.assignments.map((assignment) => [assignment.assetId, assignment]));

  const mah005 = byAsset.get(MAH005);
  assert.equal(mah005.rung, 1);
  assert.equal(mah005.activityId, 'A100');

  const ioc = byAsset.get(IOC);
  assert.equal(ioc.rung, 2);
  assert.equal(ioc.activityId, 'A200');

  const ahu = byAsset.get(AHU);
  const dmp = byAsset.get(DMP);
  assert.equal(ahu.rung, 3);
  assert.equal(dmp.rung, 3);
  assert.equal(ahu.activityId, 'A300');
  assert.equal(dmp.activityId, 'A300');

  // A base-fixture asset with no matching activity: rung 4, building-ready.
  const untouched = byAsset.get(idOf('MAH001-10-01'));
  assert.equal(untouched.rung, 4);
  assert.equal(untouched.label, 'OP / Building Ready');
  assert.equal(untouched.building, 'D1');
});

/* ============================================================ test 2 ==== */

test('2. sequencing polarity: Electrical numbers top-down, Mechanical numbers bottom-up', () => {
  const subjectOf = new Map(project.compileSubjects.map((subject) => [subject.assetId, subject]));
  const attrOf = (assetId, key) => subjectOf.get(assetId)?.attributes.get(key);

  // Same (building, systemKey) group as the already-resolved e3 chain --
  // MAH005 -> PLC005 -> VFD005 -> TIT005 -- assigned "Electrical" so this
  // group's polarity is top-down.
  const electrical = [MAH005, PLC005, VFD005, TIT005].map((assetId) => ({
    assetId,
    canonicalTag: attrOf(assetId, 'canonicalTag'),
    discipline: 'Electrical',
    building: attrOf(assetId, 'building'),
    systemKey: attrOf(assetId, 'systemKey'),
  }));
  // The 006 quartet this file added -- MAH006 -> PLC006 -> VFD006 -> TIT006 --
  // assigned "Mechanical" so this group's polarity is bottom-up.
  const mechanical = [MAH006, PLC006, VFD006, TIT006].map((assetId) => ({
    assetId,
    canonicalTag: attrOf(assetId, 'canonicalTag'),
    discipline: 'Mechanical',
    building: attrOf(assetId, 'building'),
    systemKey: attrOf(assetId, 'systemKey'),
  }));

  const result = computeSequence(project.snapshot, [...electrical, ...mechanical]);

  assert.equal(result.unsequencedAssetIds.length, 0);
  assert.equal(result.groups.length, 2);

  const seqOf = new Map(result.sequences.map((entry) => [entry.assetId, entry]));

  // Top-down = pre-order: root first, then each child, matching the real
  // MAH -> PLC -> VFD -> TIT structural chain exactly.
  assert.equal(seqOf.get(MAH005).sequence, 1);
  assert.equal(seqOf.get(PLC005).sequence, 2);
  assert.equal(seqOf.get(VFD005).sequence, 3);
  assert.equal(seqOf.get(TIT005).sequence, 4);
  assert.equal(seqOf.get(MAH005).polarity, 'top-down');

  // Bottom-up = post-order: children before parents, so the leaf (TIT006) is
  // numbered first and the root (MAH006) last.
  assert.equal(seqOf.get(TIT006).sequence, 1);
  assert.equal(seqOf.get(VFD006).sequence, 2);
  assert.equal(seqOf.get(PLC006).sequence, 3);
  assert.equal(seqOf.get(MAH006).sequence, 4);
  assert.equal(seqOf.get(MAH006).polarity, 'bottom-up');

  const electricalGroup = result.groups.find((group) => group.polarity === 'top-down');
  const mechanicalGroup = result.groups.find((group) => group.polarity === 'bottom-up');
  assert.deepEqual(electricalGroup.assetIds, [MAH005, PLC005, VFD005, TIT005]);
  assert.deepEqual(mechanicalGroup.assetIds, [TIT006, VFD006, PLC006, MAH006]);
});

/* ============================================================ test 3 ==== */

test('3. predecessor matrix: the RIO demotion (603 predecessor of 650), leading zeros round-trip', () => {
  const subjectOf = new Map(project.compileSubjects.map((subject) => [subject.assetId, subject]));
  const predecessorAssets = project.catalog.assets.map((asset) => ({
    assetId: asset.assetId,
    canonicalTag: asset.canonicalTag,
    systemKey: subjectOf.get(asset.assetId)?.attributes.get('systemKey'),
  }));

  const matrix = buildPredecessorMatrix(project.snapshot, predecessorAssets);

  const row650 = matrix.rows.find((entry) => entry.systemKey === '650');
  assert.ok(row650, 'System 650 (the RIO) must appear in the matrix');
  assert.deepEqual(row650.predecessorSystemKeys, ['603']);

  const edge = matrix.edges.find((candidate) => candidate.from === '603' && candidate.to === '650');
  assert.ok(edge, 'the 603 -> 650 predecessor edge must exist');
  // Two entries: the RIO's `dependencies` carries the panel both as the real
  // POWERS feed and as the demoted structural parent (compile.ts's own note:
  // "a feeder that also got demoted out of the parent chain is both POWERS
  // and DEPENDENCY"). `buildPredecessorMatrix` reports one evidence row per
  // `ResolvedDependency`, so both surface, identically.
  assert.equal(edge.evidence.length, 2);
  for (const item of edge.evidence) {
    assert.equal(item.kind, 'dependency');
    assert.equal(item.fromTag, 'PNL603-10-01');
    assert.equal(item.toTag, 'RIO603-10-01');
  }

  assert.deepEqual(matrix.cycles, []);
  assert.ok(matrix.order.includes('603') && matrix.order.includes('650'));
  assert.ok(matrix.order.indexOf('603') < matrix.order.indexOf('650'), '603 must start up before 650');

  // Round-trip: a leading-zero system key (System 005, from the e3 quartet)
  // must survive as text, not collapse to the number 5.
  const bytes = writePredecessorWorkbook(matrix);
  const workbook = readWorkbook(bytes);
  const sheet = workbook.getSheet('Predecessors');
  assert.ok(sheet);
  const { aoa } = sheetAoa(sheet);
  assert.deepEqual(aoa[0], ['System Key', 'Predecessor System Keys']);
  const row005 = aoa.find((candidate) => candidate[0] === '005');
  assert.ok(row005, "System '005' must round-trip with its leading zero intact");
});

/* ============================================================ test 4 ==== */

test('4. EXTO export: item masters (assigned and proposal), Rev21 rows, CA_->VF_ normalization', () => {
  // A tiny trained table with one key at 0.9 confidence (exactly the gate,
  // assigned) and one at 0.5 (below the gate, a proposal).
  const trainingRows = [
    // rung A, class 'RTU' / System 090 / Mechanical: 9 CA_NB_RTU_CONTROLLER,
    // 1 CA_NB_RTU_OTHER -> confidence 9/10 = 0.9, assigned.
    ...Array.from({ length: 9 }, (_, index) => ({
      equipmentId: `ASSIGNED-${index}`,
      discipline: 'Mechanical',
      systemKey: '090',
      itemMaster: 'CA_NB_RTU_CONTROLLER',
      equipmentClass: 'RTU',
    })),
    {
      equipmentId: 'ASSIGNED-9',
      discipline: 'Mechanical',
      systemKey: '090',
      itemMaster: 'CA_NB_RTU_OTHER',
      equipmentClass: 'RTU',
    },
    // rung A, class 'CHILLER' / System 001 / Chilled Water: 5/5 split ->
    // confidence 0.5, below the gate -- a proposal, never a guess.
    ...Array.from({ length: 5 }, (_, index) => ({
      equipmentId: `PROPOSAL-A-${index}`,
      discipline: 'Chilled Water',
      systemKey: '001',
      itemMaster: 'VF_CHILLER_PRIMARY',
      equipmentClass: 'CHILLER',
    })),
    ...Array.from({ length: 5 }, (_, index) => ({
      equipmentId: `PROPOSAL-B-${index}`,
      discipline: 'Chilled Water',
      systemKey: '001',
      itemMaster: 'VF_CHILLER_SECONDARY',
      equipmentClass: 'CHILLER',
    })),
  ];
  // Trained with NO vocabulary, so the learned names stay exactly as the
  // registry spelled them (raw `CA_*`) -- `ItemMasterEntry.itemMaster` is
  // "already CA_*->VF_* normalized" only when training itself was given a
  // vocabulary (`normalizeItemMasterName` runs at training time). Training
  // without one lets this test show the normalization happening where a
  // reviewer actually looks for it: the printed EXTO cell, at export time.
  const table = trainItemMasterTable(trainingRows, { label: 'dragon-e4-fixture' });
  assert.equal(table.audit.length, 0, 'no suspect rows in this training set');

  const EXTO_VOCABULARY = ['VF_RTU_CONTROLLER'];

  // IOC090-10-01: ssmDiscipline 'Mechanical' (I&C -> Mechanical projection),
  // System 090 -- lands on the class rung at exactly the 0.9 gate.
  // MAH001-10-01: ssmDiscipline 'Chilled Water' (native, unprojected),
  // System 001 -- the below-gate CHILLER key.
  const itemMasterAssets = [
    { canonicalTag: 'IOC090-10-01', ssmDiscipline: 'Mechanical', systemKey: '090', equipmentClass: 'RTU' },
    { canonicalTag: 'MAH001-10-01', ssmDiscipline: 'Chilled Water', systemKey: '001', equipmentClass: 'CHILLER' },
  ];
  const outcomes = assignItemMasters(table, itemMasterAssets);
  const [iocOutcome, mahOutcome] = outcomes;

  assert.equal(iocOutcome.kind, 'assigned');
  assert.equal(iocOutcome.itemMaster, 'CA_NB_RTU_CONTROLLER');
  assert.equal(iocOutcome.confidence, 0.9);

  assert.equal(mahOutcome.kind, 'proposal');
  assert.deepEqual(mahOutcome.candidates, ['VF_CHILLER_PRIMARY', 'VF_CHILLER_SECONDARY']);
  assert.equal(mahOutcome.confidence, 0.5);

  // Build the Rev21 rows: IOC090 gets its assigned (pre-normalization) item
  // master; MAH001 gets none -- a proposal is never printed as an answer.
  const extoAssets = [
    {
      canonicalTag: 'IOC090-10-01',
      systemKey: '090',
      systemLabel: '090',
      equipmentClass: 'RTU',
      itemMaster: iocOutcome.itemMaster,
    },
    {
      canonicalTag: 'MAH001-10-01',
      systemKey: '001',
      systemLabel: '001',
      equipmentClass: 'CHILLER',
    },
  ];
  const rows = buildExtoRows(extoAssets, { itemMasterVocabulary: EXTO_VOCABULARY });

  const iocRow = rows.find((row) => row.equipmentId === 'IOC090-10-01');
  const mahRow = rows.find((row) => row.equipmentId === 'MAH001-10-01');
  assert.ok(iocRow && mahRow);

  // CA_NB_RTU_CONTROLLER -> VF_RTU_CONTROLLER: visible in the printed cell.
  assert.equal(iocRow.itemMaster, 'VF_RTU_CONTROLLER');
  assert.equal(iocRow.itemMasterNormalization.rule, 'ca-to-vf');
  assert.equal(iocRow.itemMasterNormalization.input, 'CA_NB_RTU_CONTROLLER');

  // Root convention: no structural parent, so Closest Parent falls back to
  // the asset's own System Name.
  assert.equal(iocRow.upn, '090');
  assert.equal(iocRow.closestParent, '090');

  // Below-gate: the cell is genuinely blank, and the proposal is the record
  // of why -- never a guessed cell.
  assert.equal(mahRow.itemMaster, '');
  assert.equal(mahRow.upn, '001');
  assert.equal(mahRow.closestParent, '001');

  // Write and read back: the Rev21 header lands at row index 1 (row 0 is the
  // blank spacer), and the two known rows' cells are exactly what was built.
  const bytes = writeExtoWorkbook(rows);
  const workbook = readWorkbook(bytes);
  const sheet = workbook.getSheet(DEFAULT_EXTO_SHEET_NAME);
  assert.ok(sheet);
  const { aoa } = sheetAoa(sheet);
  const header = aoa[EXTO_HEADER_ROW_INDEX];
  assert.equal(header[6], 'UPN');
  assert.equal(header[10], 'Equipment ID');
  assert.equal(header[15], 'Closest Parent');
  assert.equal(header[26], 'Item Master Unique Identifier');

  const upnCol = header.indexOf('UPN');
  const idCol = header.indexOf('Equipment ID');
  const parentCol = header.indexOf('Closest Parent');
  const itemMasterCol = header.indexOf('Item Master Unique Identifier');

  const iocSheetRow = aoa.find((row) => row[idCol] === 'IOC090-10-01');
  assert.ok(iocSheetRow);
  assert.equal(iocSheetRow[upnCol], '090');
  assert.equal(iocSheetRow[parentCol], '090');
  assert.equal(iocSheetRow[itemMasterCol], 'VF_RTU_CONTROLLER');

  const mahSheetRow = aoa.find((row) => row[idCol] === 'MAH001-10-01');
  assert.ok(mahSheetRow);
  assert.equal(mahSheetRow[upnCol], '001');
  assert.equal(mahSheetRow[itemMasterCol], '');
});

/* ============================================================ test 5 ==== */

test('5. site-template MEL + comparison: mapping, round-trip order, exact comparison stats', () => {
  const generatedMelAssets = toGeneratedMelAssets(project);

  // --- 5a. analyzeTemplate: a title row, then headers with 'UPN'/'Tag' synonyms
  const templateBytes = writeWorkbook([
    {
      name: 'Site Template',
      aoa: [
        ['Dragon Site Export'],
        ['UPN', 'Tag', 'Description', 'Building'],
      ],
    },
  ]);
  const analysis = analyzeTemplate(templateBytes);
  assert.equal(analysis.headerRow, 1, 'the title row is one cell wide and must be skipped');
  assert.equal(analysis.columns.length, 4);
  assert.deepEqual(
    analysis.columns.map((column) => column.header),
    ['UPN', 'Tag', 'Description', 'Building'],
  );
  assert.deepEqual(
    analysis.suggestedMapping.map((column) => (typeof column.field === 'string' ? column.field : column.field.kind)),
    ['systemKey', 'equipmentTag', 'equipmentDescription', 'building'],
  );
  assert.equal(analysis.columns[0].suggestion.match, 'synonym'); // UPN
  assert.equal(analysis.columns[1].suggestion.match, 'synonym'); // Tag
  assert.equal(analysis.columns[2].suggestion.match, 'synonym'); // Description
  assert.equal(analysis.columns[3].suggestion.match, 'exact'); // Building is a §12.1 header verbatim

  // --- 5b. writeTemplateMel: column order preserved on read-back
  const templateMelBytes = writeTemplateMel(generatedMelAssets, analysis.suggestedMapping);
  const templateMel = readWorkbook(templateMelBytes);
  const templateSheet = sheetAoa(templateMel.getSheet(templateMel.sheetNames[0]));
  assert.deepEqual(templateSheet.aoa[0], ['UPN', 'Tag', 'Description', 'Building']);
  const ahuTemplateRow = templateSheet.aoa.find((row) => row[1] === 'AHU080-10-01');
  assert.ok(ahuTemplateRow, 'AHU080-10-01 must have a row in the filled template');
  assert.equal(ahuTemplateRow[0], '080');
  assert.equal(ahuTemplateRow[2], 'AHU080-10-01');
  assert.equal(ahuTemplateRow[3], 'D1');

  // --- 5c. compareWithExistingMel: one agree, one disagree, one MEL-only,
  // one Matchline-only -- a curated three-asset slice so the stats are exact.
  const comparisonAssets = generatedMelAssets.filter((asset) =>
    ['AHU080-10-01', 'DMP080-10-01', 'IOC090-10-01'].includes(asset.canonicalTag),
  );
  assert.equal(comparisonAssets.length, 3);

  const existingMelRows = [
    { tag: 'AHU080-10-01', description: 'AHU080-10-01' }, // agree
    { tag: 'DMP080-10-01', description: 'DMP080-10-01 OLD' }, // disagree
    { tag: 'ZZZ999-10-01', description: 'Not in the model' }, // MEL-only
    // IOC090-10-01 intentionally absent -> Matchline-only
  ];
  const comparison = compareWithExistingMel(
    comparisonAssets,
    existingMelRows,
    [
      { field: 'equipmentTag', melKey: 'tag' },
      { field: 'equipmentDescription', melKey: 'description' },
    ],
  );

  assert.equal(comparison.summary.matchedTagCount, 2);
  assert.equal(comparison.summary.melOnlyTagCount, 1);
  assert.equal(comparison.summary.matchlineOnlyTagCount, 1);
  assert.equal(comparison.summary.comparedFieldCount, 2); // one field x two matched tags
  assert.equal(comparison.summary.agreeCount, 1);
  assert.equal(comparison.summary.disagreeCount, 1);
  assert.equal(comparison.summary.disagreeingTagCount, 1);
  assert.deepEqual(comparison.melOnlyTags, ['ZZZ999-10-01']);
  assert.deepEqual(comparison.matchlineOnlyTags, ['IOC090-10-01']);

  const ahuComparison = comparison.matched.find((entry) => entry.canonicalTag === 'AHU080-10-01');
  assert.equal(ahuComparison.fields[0].agree, true);
  const dmpComparison = comparison.matched.find((entry) => entry.canonicalTag === 'DMP080-10-01');
  assert.equal(dmpComparison.fields[0].agree, false);
  assert.equal(dmpComparison.fields[0].matchlineValue, 'DMP080-10-01');
  assert.equal(dmpComparison.fields[0].melValue, 'DMP080-10-01 OLD');
});

/* ============================================================ test 6 ==== */

/**
 * A revision fixture: the MAH005->PLC005->VFD005->TIT005 chain (unchanged
 * across revisions) plus AHU080-10-01 and, per `variant`, either
 * DMP080-10-01 (revision 1 only -> removed) or MAH007-10-01 (revision 2 only
 * -> added). AHU080's own description differs by variant -> changed.
 */
function addRevisionFixtures(context, variant) {
  const controlsD1 = context.layerId('D1', SOURCE_MODEL_CONTROLS);
  const mechanicalD1 = context.layerId('D1', SOURCE_MODEL_MECHANICAL);

  context.addEquipment({
    sourceModelId: SOURCE_MODEL_MECHANICAL,
    parentId: mechanicalD1,
    depth: 2,
    tag: 'MAH005-10-01',
    upn: '005',
    building: 'D1',
  });
  context.addEquipment({
    sourceModelId: SOURCE_MODEL_CONTROLS,
    parentId: controlsD1,
    depth: 2,
    tag: 'PLC005-10-01',
    upn: '005',
    building: 'D1',
  });
  context.addEquipment({
    sourceModelId: SOURCE_MODEL_CONTROLS,
    parentId: controlsD1,
    depth: 2,
    tag: 'VFD005-10-01',
    upn: '005',
    building: 'D1',
  });
  context.addEquipment({
    sourceModelId: SOURCE_MODEL_MECHANICAL,
    parentId: mechanicalD1,
    depth: 2,
    tag: 'TIT005-10-01',
    upn: '005',
    building: 'D1',
  });

  context.addEquipment({
    sourceModelId: SOURCE_MODEL_CONTROLS,
    parentId: controlsD1,
    depth: 2,
    tag: 'AHU080-10-01',
    upn: '080',
    building: 'D1',
    manufacturer: variant === 'rev1' ? 'AHU080-10-01' : 'AHU080-10-01 Rev2',
  });

  if (variant === 'rev1') {
    context.addEquipment({
      sourceModelId: SOURCE_MODEL_CONTROLS,
      parentId: controlsD1,
      depth: 2,
      tag: 'DMP080-10-01',
      upn: '080',
      building: 'D1',
    });
  } else {
    context.addEquipment({
      sourceModelId: SOURCE_MODEL_MECHANICAL,
      parentId: mechanicalD1,
      depth: 2,
      tag: 'MAH007-10-01',
      upn: '007',
      building: 'D1',
    });
  }
}

function openRevisionCache(label, variant) {
  const directory = mkdtempSync(join(tmpdir(), `matchline-e4-rev-${label}-`));
  const path = join(directory, 'dragon.sqlite');
  writeDragonFixture(path);
  augmentDragonCache(path, (context) => addRevisionFixtures(context, variant));
  const cache = openExtractionCache(path);
  return {
    cache,
    close() {
      cache.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function revisionConnectivityWorkbooks() {
  return [
    {
      bytes: writeWorkbook([
        {
          name: 'EasyPower',
          aoa: [
            ['Starting Source', 'ID Name'],
            ['MAH005-10-01', 'PLC005-10-01'],
            ['PLC005-10-01', 'VFD005-10-01'],
            ['VFD005-10-01', 'TIT005-10-01'],
          ],
        },
      ]),
      sourceFile: 'Dragon-E4-Revision-Connectivity.xlsx',
    },
  ];
}

function revisionInput(cache, overrides = {}) {
  return {
    sources: [{ sourceId: MODEL_SOURCE_ID, cache }],
    profile: siteProfile(),
    connectivityWorkbooks: revisionConnectivityWorkbooks(),
    ...overrides,
  };
}

test('6. revision diff: added, removed, changed description, moved parent; unchanged rerun is all-zero', () => {
  const rev1 = openRevisionCache('rev1', 'rev1');
  const rev2a = openRevisionCache('rev2a', 'rev2');
  const rev2b = openRevisionCache('rev2b', 'rev2');
  try {
    const rev1Project = compileProject(revisionInput(rev1.cache));
    const overrides = [
      {
        childAssetId: TIT005,
        parentAssetId: MAH005,
        note: 'Commissioned as one skid for the revised schedule.',
      },
    ];
    const rev2aProject = compileProject(
      revisionInput(rev2a.cache, { manualRelationshipOverrides: overrides }),
    );
    const rev2bProject = compileProject(
      revisionInput(rev2b.cache, { manualRelationshipOverrides: overrides }),
    );

    // TIT005 really did move: VFD005 (flow-family) in revision 1, MAH005
    // (manual override) in revision 2 -- the same pattern e3 test 5 proves.
    assert.equal(rev1Project.snapshot.nodes.get(TIT005).parent.parentAssetId, VFD005);
    assert.equal(rev2aProject.snapshot.nodes.get(TIT005).parent.parentAssetId, MAH005);

    const previousAssets = toGeneratedMelAssets(rev1Project);
    const currentAssets = toGeneratedMelAssets(rev2aProject);
    const diff = diffMelRevisions(previousAssets, currentAssets);

    assert.equal(diff.added.length, 1);
    assert.equal(diff.added[0].canonicalTag, 'MAH007-10-01');

    assert.equal(diff.removed.length, 1);
    assert.equal(diff.removed[0].canonicalTag, 'DMP080-10-01');

    assert.equal(diff.changedDescriptions.length, 1);
    assert.equal(diff.changedDescriptions[0].canonicalTag, 'AHU080-10-01');
    assert.equal(diff.changedDescriptions[0].before, 'AHU080-10-01');
    assert.equal(diff.changedDescriptions[0].after, 'AHU080-10-01 Rev2');

    assert.equal(diff.movedParents.length, 1);
    assert.equal(diff.movedParents[0].canonicalTag, 'TIT005-10-01');
    assert.equal(diff.movedParents[0].before, 'VFD005-10-01');
    assert.equal(diff.movedParents[0].after, 'MAH005-10-01');

    // Nothing else moved.
    assert.deepEqual(diff.changedTags, []);
    assert.deepEqual(diff.changedSystemDescriptions, []);
    assert.deepEqual(diff.changedSystemKeys, []);
    assert.deepEqual(diff.changedHierarchyLevels, []);
    assert.deepEqual(diff.dependencyChanges.added, []);
    assert.deepEqual(diff.dependencyChanges.removed, []);
    assert.deepEqual(diff.newConflicts, []);

    assert.deepEqual(diff.summary, {
      added: 1,
      removed: 1,
      changedTags: 0,
      changedDescriptions: 1,
      changedSystemDescriptions: 0,
      changedSystemKeys: 0,
      changedHierarchyLevels: 0,
      movedParents: 1,
      dependenciesAdded: 0,
      dependenciesRemoved: 0,
      newConflicts: 0,
    });

    // writeDiffWorkbook: the Summary sheet's counts match the diff exactly,
    // including the zero categories.
    const diffBytes = writeDiffWorkbook(diff);
    const diffWorkbook = readWorkbook(diffBytes);
    const summarySheet = sheetAoa(diffWorkbook.getSheet('Summary'));
    const countOf = (category) => {
      const row = summarySheet.aoa.find((candidate) => candidate[0] === category);
      return row ? Number(row[1]) : null;
    };
    assert.equal(countOf('Added Assets'), diff.summary.added);
    assert.equal(countOf('Removed Assets'), diff.summary.removed);
    assert.equal(countOf('Changed Tags'), diff.summary.changedTags);
    assert.equal(countOf('Changed Descriptions'), diff.summary.changedDescriptions);
    assert.equal(
      countOf('Changed System Descriptions'),
      diff.summary.changedSystemDescriptions,
    );
    assert.equal(countOf('Changed System Keys'), diff.summary.changedSystemKeys);
    assert.equal(countOf('Changed Hierarchy Levels'), diff.summary.changedHierarchyLevels);
    assert.equal(countOf('Moved Parents'), diff.summary.movedParents);
    assert.equal(countOf('Added Dependencies'), diff.summary.dependenciesAdded);
    assert.equal(countOf('Removed Dependencies'), diff.summary.dependenciesRemoved);
    assert.equal(countOf('New Conflicts'), diff.summary.newConflicts);
    // Only the four populated categories get their own sheet, behind Summary.
    assert.deepEqual(diffWorkbook.sheetNames, [
      'Summary',
      'Added Assets',
      'Removed Assets',
      'Changed Descriptions',
      'Moved Parents',
    ]);

    // Unchanged rerun: two fresh caches, same revision-2 fixture, same
    // override -- the diff between them must be all-zero.
    const rerunAssets = toGeneratedMelAssets(rev2bProject);
    const rerunDiff = diffMelRevisions(currentAssets, rerunAssets);
    assert.deepEqual(rerunDiff.added, []);
    assert.deepEqual(rerunDiff.removed, []);
    assert.deepEqual(rerunDiff.changedTags, []);
    assert.deepEqual(rerunDiff.changedDescriptions, []);
    assert.deepEqual(rerunDiff.changedSystemDescriptions, []);
    assert.deepEqual(rerunDiff.changedSystemKeys, []);
    assert.deepEqual(rerunDiff.changedHierarchyLevels, []);
    assert.deepEqual(rerunDiff.movedParents, []);
    assert.deepEqual(rerunDiff.dependencyChanges, { added: [], removed: [] });
    assert.deepEqual(rerunDiff.newConflicts, []);
    assert.deepEqual(rerunDiff.summary, {
      added: 0,
      removed: 0,
      changedTags: 0,
      changedDescriptions: 0,
      changedSystemDescriptions: 0,
      changedSystemKeys: 0,
      changedHierarchyLevels: 0,
      movedParents: 0,
      dependenciesAdded: 0,
      dependenciesRemoved: 0,
      newConflicts: 0,
    });
  } finally {
    rev1.close();
    rev2a.close();
    rev2b.close();
  }
});
