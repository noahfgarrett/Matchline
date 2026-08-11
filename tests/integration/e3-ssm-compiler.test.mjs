/**
 * End-to-end proof of PRODUCT.md §19 Phase 4's exit criteria through
 * `@matchline/compiler`'s single entry point, `compileProject`.
 *
 * Phase 4 exit criteria (docs/PRODUCT.md §19):
 *   - RIO cross-System relationship becomes a dependency
 *   - MAH/PLC/VFD/TIT family resolves within one system
 *   - Native and SSM disciplines remain separate
 *   - No structural relationship crosses an enabled boundary
 *   - Rebuilds are deterministic
 *
 * ## Import mechanism
 *
 * `@matchline/compiler` is a real workspace package: `npm install` at the repo
 * root symlinked it into `node_modules/@matchline/compiler`, and
 * `package-lock.json` carries an entry for it, so it resolves by package name
 * exactly like `e1-pipeline.test.mjs` and `e2-connectivity.test.mjs` do for
 * their packages. `packages/compiler/package.json`'s `main` points at
 * `dist/index.js`, which is why `npm run build` (or the compiler workspace's
 * own `npm test`, which builds first) must have run before this file can
 * import it.
 *
 * ## The fixture technique
 *
 * `packages/compiler/test/support.mjs` grows the shared Dragon cache
 * (`@matchline/model-schema/fixtures/dragon`'s `writeDragonFixture`) with a
 * hand-written `augmentDragonCache` that inserts extra objects/properties
 * directly through `node:sqlite`, because two of the scenarios below need
 * model shapes the shared fixture does not have (a cross-system panel/RIO
 * pair, a same-system four-role family). That helper is `support.mjs`'s own
 * -- not exported by any package -- so it is replicated here, trimmed to what
 * this file needs, rather than reached into across the file-scope boundary.
 * `writeDragonFixture` itself is used untouched.
 *
 * ## The one Dragon project this file compiles
 *
 * Nine tagged objects are added to the 34-asset base Dragon universe (43
 * total), each earning its keep against one exit criterion:
 *
 * - `PNL603-10-01` (System 603) / `RIO603-10-01` (System 650) -- PRODUCT.md
 *   §2.5's own example, verbatim: same family key (both tags carry `603` as
 *   their embedded digit run, even though the RIO's true System, read from the
 *   model's own UPN, is 650), a taught `PNL -> RIO` pairing, and a real feed
 *   between them. The strongest structural evidence there is, crossing the
 *   one boundary the fold exists to catch.
 * - `MAH005-10-01` / `PLC005-10-01` / `VFD005-10-01` / `TIT005-10-01` -- one
 *   family (`005-10-01`), one System (`005`), one building (`D1`), fed in a
 *   straight chain. Unlike the base fixture's own MAH/PLC/VFD/TIT, whose TIT
 *   sits in a different System (603) from its MAH/PLC/VFD (001) and therefore
 *   never nests under them, this quartet is built so the whole role chain
 *   resolves as real structural parents within one boundary.
 * - `IOC090-10-01` -- carries `Dragon Data > Service` = `I&C`, the property
 *   `nativeDiscipline` is mapped from. With an `ssmDisciplineProjection`
 *   rewriting `I&C` to `Mechanical`, this is the one asset whose native and
 *   SSM disciplines are stated to differ on purpose.
 * - `AHU080-10-01` / `DMP080-10-01` -- share System `080` and a description
 *   (`Dragon Data > Manufacturer`) spelled exactly like their own tag, so a
 *   learned rule set trained to recognize `ahu#-#-#` / `dmp#-#-#` classifies
 *   them. No connectivity, no role graph rule and no manual decision relates
 *   them -- the learned rung is the only evidence that could ever nest DMP
 *   under AHU, which is what makes "proposal grade never nests" a real test
 *   rather than a vacuous one.
 *
 * No MEL workbook is supplied: every System Key below is read straight off
 * the model's own `Dragon Data > UPN`, so nothing here depends on a MEL join,
 * and the System Resolver's key chain is one rung -- `model-field` -- exactly
 * like `packages/compiler/test/support.mjs`'s own `RIO_RESOLVER`, applied to
 * the whole project rather than only to the RIO pair. That is deliberate: a
 * `tag-segment` rung would read the RIO's tag as System 603 while the model
 * says 650, which is a manufactured conflict, not the scenario PRODUCT.md
 * §2.5 describes ("a RIO whose tag reads 603 while the model says 650").
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { after, before } from 'node:test';

import { compileProject } from '@matchline/compiler';
import { migrateSiteProfileV1 } from '@matchline/domain';
import { openExtractionCache } from '@matchline/model-schema';
import { writeDragonFixture } from '@matchline/model-schema/fixtures/dragon';
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

/** `MAH005-10-01` -> role `MAH`, system `005`, unit `10`, instance `01`. */
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

/**
 * One rung: the model's own UPN. No `tag-segment` rung -- see the file header
 * on why the RIO scenario needs the model to be the sole authority for System.
 */
const SYSTEM_RESOLVER = {
  keyChain: [{ kind: 'model-field', property: { category: 'Dragon Data', name: 'UPN' } }],
  descriptionChain: [],
  normalization: [],
  conflictPolicy: 'review',
};

/** Base MAH->PLC->VFD plus VFD->TIT (closing the family chain) and PNL->RIO. */
const ROLE_GRAPH = {
  rules: [
    { parentRole: 'MAH', childRole: 'PLC' },
    { parentRole: 'PLC', childRole: 'VFD' },
    { parentRole: 'VFD', childRole: 'TIT' },
    { parentRole: 'PNL', childRole: 'RIO' },
  ],
};

/** Building then System, both hard boundaries -- PRODUCT.md §2.5's own example. */
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
 * The E3 site's whole rule set, as one `SiteProfileV2`.
 *
 * Built through the published migration rather than written out longhand: this
 * is the same lift every stored V1 profile takes, so an integration test cannot
 * accidentally prove the pipeline against a profile shape only it can make.
 */
function siteProfile() {
  return migrateSiteProfileV1(
    {
      profileId: 'dragon-e3',
      name: 'Dragon E3',
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
 * Appends invented objects to a written Dragon cache, replicated from
 * `packages/compiler/test/support.mjs`'s helper of the same name (see the file
 * header). `writeDragonFixture` stays untouched; only this test's own copy of
 * the cache grows.
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
      /** The building layer of one discipline model, by its display name. */
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

      /**
       * One tagged piece of equipment: Tag, Building, UPN, and optionally
       * Service (nativeDiscipline) and Manufacturer (description).
       */
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
 * The nine assets this file's scenarios need, added to the base Dragon cache.
 * See the file header for what each one proves.
 */
function addE3Fixtures(context) {
  const controlsD1 = context.layerId('D1', SOURCE_MODEL_CONTROLS);
  const mechanicalD1 = context.layerId('D1', SOURCE_MODEL_MECHANICAL);

  // --- §2.5: the panel/RIO pair, siblings under D1 controls -----------------
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

  // --- the MAH/PLC/VFD/TIT family, one System, one building -----------------
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

  // --- the discipline-projection asset ---------------------------------------
  context.addEquipment({
    sourceModelId: SOURCE_MODEL_CONTROLS,
    parentId: controlsD1,
    depth: 2,
    tag: 'IOC090-10-01',
    upn: '090',
    building: 'D1',
    service: 'I&C',
  });

  // --- the learned-rule pair: description spelled like the tag itself -------
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
}

/**
 * A temp-dir Dragon cache, base fixture plus {@link addE3Fixtures}. The caller
 * closes it and removes the directory through the returned `close`.
 */
function openE3Cache(label) {
  const directory = mkdtempSync(join(tmpdir(), `matchline-e3-${label}-`));
  const path = join(directory, 'dragon.sqlite');
  writeDragonFixture(path);
  augmentDragonCache(path, addE3Fixtures);
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
 * One EasyPower sheet, seven rows: the MAH->PLC->VFD->TIT family chain and the
 * §2.5 panel->RIO feed. Headers are the exact `Starting Source`/`ID Name` rung
 * so detection needs no override.
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
      ],
    },
  ]);
}

const CONNECTIVITY_SOURCE_FILE = 'Dragon-E3-Connectivity.xlsx';

function connectivityWorkbooks() {
  return [{ bytes: connectivityWorkbookBytes(), sourceFile: CONNECTIVITY_SOURCE_FILE }];
}

/* ------------------------------------------------------------- learned --- */

/**
 * Classifies `AHU080-10-01` / `DMP080-10-01` by their own tag-shaped
 * description (`Dragon Data > Manufacturer`, masked: `ahu#-#-#` / `dmp#-#-#`).
 * `DMP`'s grade is `proposal` on purpose: this rule set must never be able to
 * write hierarchy, only propose it (DECISIONS.md #3).
 */
function learnedRuleSet() {
  return {
    version: 1,
    classification: [
      { discipline: '', pattern: 'ahu#-#-#', class: 'AHU', confidence: 1, sampleCount: 12 },
      { discipline: '', pattern: 'dmp#-#-#', class: 'DMP', confidence: 1, sampleCount: 12 },
    ],
    roleGates: [
      {
        class: 'AHU',
        asParent: 12,
        asChild: 0,
        parentRate: 1,
        isChildOnly: false,
        isParentCapable: true,
      },
      {
        class: 'DMP',
        asParent: 0,
        asChild: 12,
        parentRate: 0,
        isChildOnly: true,
        isParentCapable: false,
      },
    ],
    affinities: [{ childClass: 'DMP', parentClass: 'AHU', observations: 4 }],
    grades: [{ class: 'DMP', predicted: 8, correct: 4, precision: 0.5, grade: 'proposal' }],
    trainedFrom: { rowCount: 12, label: 'dragon-e3-fixture' },
  };
}

/** The full input every scenario below starts from. */
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
const MAH = idOf('MAH005-10-01');
const PLC = idOf('PLC005-10-01');
const VFD = idOf('VFD005-10-01');
const TIT = idOf('TIT005-10-01');
const IOC = idOf('IOC090-10-01');
const AHU = idOf('AHU080-10-01');
const DMP = idOf('DMP080-10-01');

/* ------------------------------------------------------------------------ */

let handle = null;
let project = null;

before(() => {
  handle = openE3Cache('main');
  project = compileProject(mainInput(handle.cache));
});

after(() => {
  handle?.close();
});

test('sanity: 34 base assets plus the 9 this file adds, no duplicate tags', () => {
  assert.equal(project.stats.assetCount, 43);
  assert.equal(project.stats.duplicateTagCount, 0);
  assert.deepEqual(project.catalog.reviewItems, []);
});

test('1. a RIO cross-System relationship becomes a dependency (PRODUCT.md §2.5, verbatim)', () => {
  // The panel and the RIO resolve to the systems the example names.
  assert.equal(project.systems.bySubject.get(PANEL).resolution.systemKey, '603');
  assert.equal(project.systems.bySubject.get(RIO).resolution.systemKey, '650');

  // Same family key, taught PNL->RIO pairing, a real feed: the claim exists
  // before the fold gets anywhere near it.
  const claim = project.claims.structural.find((entry) => entry.subjectAssetId === RIO);
  assert.ok(claim, 'the feed must have produced a nesting claim for the fold to demote');
  assert.equal(claim.targetAssetId, PANEL);
  assert.equal(claim.ladderSource, 'flow-family');
  assert.equal(claim.kind, 'structural-parent');

  // The boundary fold demotes it: count >= 1, and specifically this one.
  assert.ok(project.snapshot.stats.demotedToDependencyCount >= 1);

  const rio = project.snapshot.nodes.get(RIO);
  assert.equal(rio.parent.status, 'root');
  assert.equal(rio.parent.parentAssetId, null);
  assert.deepEqual(rio.parent.demotedFrom, { parentAssetId: PANEL, boundaryLevelId: 'system' });

  // "The relationship remains real": the panel is listed as a dependency, not
  // deleted.
  assert.ok(
    rio.dependencies.some((dependency) => dependency.parentAssetId === PANEL),
    'the panel must be listed in the RIO dependencies',
  );

  // The RIO roots in System 650; the panel stays in 603 with nothing nested
  // under it.
  assert.equal(project.tree.levels.length > 0, true);
  const panelSubject = project.compileSubjects.find((subject) => subject.assetId === PANEL);
  const rioSubject = project.compileSubjects.find((subject) => subject.assetId === RIO);
  assert.equal(panelSubject.attributes.get('systemKey'), '603');
  assert.equal(rioSubject.attributes.get('systemKey'), '650');

  // Electrical Flow is a projection of the documents, never boundary-folded:
  // the panel -> RIO edge is still there.
  const edge = project.flow.edges.find(
    (candidate) => candidate.fromNodeId === PANEL && candidate.toNodeId === RIO,
  );
  assert.ok(edge, 'the panel -> RIO feed must survive in the Electrical Flow projection');
  assert.equal(edge.relationshipType, 'POWERS');
});

test('2. the MAH/PLC/VFD/TIT family resolves within one system: the exact parent chain', () => {
  // All four in System 005, all four in D1: nothing here should ever reach
  // the boundary fold.
  for (const assetId of [MAH, PLC, VFD, TIT]) {
    const subject = project.compileSubjects.find((candidate) => candidate.assetId === assetId);
    assert.equal(subject.attributes.get('systemKey'), '005');
    assert.equal(subject.attributes.get('building'), 'D1');
  }

  const mah = project.snapshot.nodes.get(MAH);
  const plc = project.snapshot.nodes.get(PLC);
  const vfd = project.snapshot.nodes.get(VFD);
  const tit = project.snapshot.nodes.get(TIT);

  assert.equal(mah.parent.status, 'root', 'nothing feeds MAH005-10-01');

  assert.equal(plc.parent.status, 'resolved');
  assert.equal(plc.parent.parentAssetId, MAH);
  assert.equal(plc.parent.ladderSource, 'flow-family');

  assert.equal(vfd.parent.status, 'resolved');
  assert.equal(vfd.parent.parentAssetId, PLC);
  assert.equal(vfd.parent.ladderSource, 'flow-family');

  assert.equal(tit.parent.status, 'resolved');
  assert.equal(tit.parent.parentAssetId, VFD);
  assert.equal(tit.parent.ladderSource, 'flow-family');

  // The chain cost no demotions: only the RIO crosses a boundary in this
  // project.
  assert.equal(project.snapshot.stats.demotedToDependencyCount, 1);
});

test('3. native and SSM disciplines remain separate for a projected asset', () => {
  const subject = project.compileSubjects.find((candidate) => candidate.assetId === IOC);
  assert.ok(subject, 'IOC090-10-01 should be a compile subject');
  assert.equal(subject.attributes.get('nativeDiscipline'), 'I&C');
  assert.equal(subject.attributes.get('ssmDiscipline'), 'Mechanical');
  assert.notEqual(
    subject.attributes.get('nativeDiscipline'),
    subject.attributes.get('ssmDiscipline'),
  );

  const row = project.generatedMel.rows.find((entry) => entry.equipmentTag === 'IOC090-10-01');
  assert.ok(row, 'IOC090-10-01 should have a generated MEL row');
  assert.equal(row.nativeDiscipline, 'I&C');
  assert.equal(row.ssmDiscipline, 'Mechanical');
  assert.notEqual(row.nativeDiscipline, row.ssmDiscipline);

  // And in the generated workbook's own bytes, not just the JS row objects.
  const workbook = readWorkbook(project.generatedMel.workbookBytes);
  const sheet = workbook.getSheet('MEL');
  assert.ok(sheet);
  const { aoa } = sheetAoa(sheet);
  const headers = aoa[0];
  const tagCol = headers.indexOf('Equipment Tag');
  const nativeCol = headers.indexOf('Native Discipline');
  const ssmCol = headers.indexOf('SSM Discipline');
  assert.ok(tagCol >= 0 && nativeCol >= 0 && ssmCol >= 0);

  const iocRow = aoa.find((candidate) => candidate[tagCol] === 'IOC090-10-01');
  assert.ok(iocRow, 'IOC090-10-01 should have a row in the generated workbook');
  assert.equal(iocRow[nativeCol], 'I&C');
  assert.equal(iocRow[ssmCol], 'Mechanical');
  assert.notEqual(iocRow[nativeCol], iocRow[ssmCol]);
});

test('4. no structural relationship crosses an enabled boundary: a sweep over every resolved node', () => {
  const boundaryLevelIds = HIERARCHY.levels.filter((level) => level.boundary).map(
    (level) => level.levelId,
  );
  assert.deepEqual(boundaryLevelIds, ['building', 'system']);

  let checkedCount = 0;
  for (const node of project.snapshot.nodes.values()) {
    if (node.parent.status !== 'resolved') {
      continue;
    }
    const parentNode = project.snapshot.nodes.get(node.parent.parentAssetId);
    assert.ok(parentNode, `${node.assetId}'s parent ${node.parent.parentAssetId} must itself be a node`);

    for (const levelId of boundaryLevelIds) {
      const childValue = node.levelPath.find((step) => step.levelId === levelId)?.value;
      const parentValue = parentNode.levelPath.find((step) => step.levelId === levelId)?.value;
      assert.equal(
        childValue,
        parentValue,
        `${node.assetId} and its parent ${parentNode.assetId} must agree at boundary '${levelId}'`,
      );
    }
    checkedCount += 1;
  }

  // The chain from test 2 (PLC, VFD, TIT) is exactly what should have been
  // resolved here; the RIO does not appear because it was demoted to a root.
  assert.ok(checkedCount >= 3, 'the sweep must have actually checked something');
  assert.equal(
    project.snapshot.nodes.get(RIO).parent.status,
    'root',
    'the RIO must not appear among resolved parents at all',
  );
});

test('5. learned rules stay honest, and a manual override beats everything', () => {
  const overrideProject = compileProject(
    mainInput(handle.cache, {
      learnedRules: learnedRuleSet(),
      manualRelationshipOverrides: [
        {
          childAssetId: TIT,
          parentAssetId: MAH,
          note: 'Commissioned as one skid; ignore the VFD feed chain.',
        },
      ],
    }),
  );

  // --- proposal-grade learned input: a review item, never a claim ---------
  assert.equal(overrideProject.learnedProposals.length, 1);
  const [proposal] = overrideProject.learnedProposals;
  assert.equal(proposal.childAssetId, DMP);
  assert.equal(proposal.parentAssetId, AHU);
  assert.equal(proposal.grade, 'proposal');
  assert.equal(proposal.rule, 'role-affinity');

  assert.equal(
    overrideProject.claims.structural.some((claim) => claim.ladderSource === 'learned-description'),
    false,
    'a proposal-grade rule must never produce a structural claim',
  );

  const nestingProposal = overrideProject.reviewItems.find(
    (item) => item.kind === 'nesting-proposal' && item.assetId === DMP,
  );
  assert.ok(nestingProposal, 'the proposal-grade rule must reach the review queue');
  assert.equal(nestingProposal.proposedParentId, AHU);

  // DMP was never nested: it is still a root.
  assert.equal(overrideProject.snapshot.nodes.get(DMP).parent.status, 'root');

  // --- manual override: outranks even flow-anchored family evidence -------
  const tit = overrideProject.snapshot.nodes.get(TIT);
  assert.equal(tit.parent.status, 'resolved');
  assert.equal(tit.parent.parentAssetId, MAH);
  assert.equal(tit.parent.ladderSource, 'manual');
  assert.equal(tit.parent.winningClaim.provenance.manualDecision, 'Commissioned as one skid; ignore the VFD feed chain.');

  // The flow-family claim (TIT under VFD) is retained as a losing claim, not
  // discarded.
  assert.ok(
    tit.losingClaims.some(
      (claim) => claim.ladderSource === 'flow-family' && claim.targetAssetId === VFD,
    ),
    'the outranked flow-family claim must still be visible',
  );

  // The decision reaches the generated MEL too.
  const row = overrideProject.generatedMel.rows.find((entry) => entry.equipmentTag === 'TIT005-10-01');
  assert.equal(row.systemParentEquipmentTag, 'MAH005-10-01');
  assert.equal(row.parentEvidence, 'manual');
});

test('6. rebuilds are deterministic: two fresh compiles produce a deep-equal snapshot and byte-identical MEL', () => {
  const first = openE3Cache('determinism-a');
  const second = openE3Cache('determinism-b');
  try {
    const projectA = compileProject(mainInput(first.cache));
    const projectB = compileProject(mainInput(second.cache));

    assert.deepStrictEqual(projectA.snapshot, projectB.snapshot);
    assert.deepEqual(
      Buffer.from(projectA.generatedMel.workbookBytes),
      Buffer.from(projectB.generatedMel.workbookBytes),
    );
    assert.ok(projectA.generatedMel.workbookBytes.length > 0);
  } finally {
    first.close();
    second.close();
  }
});
