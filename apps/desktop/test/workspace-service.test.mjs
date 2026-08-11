import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { after, before } from 'node:test';

import { writeDragonFixture } from '@matchline/model-schema/fixtures/dragon';
import { readWorkbook, sheetAoa, writeWorkbook } from '@matchline/spreadsheet-import';

import { createProjectService } from '../dist/electron/services/project-session.js';

/**
 * The whole round-3 flow, headless: screens 6-9 configured through the same
 * main-process service the IPC handlers call, compiled, corrected by hand,
 * recompiled, reviewed, and exported.
 *
 * This is the test the GUI walk cannot be. A screenshot proves a panel renders;
 * this proves the numbers in it. Every expectation below is derived from the
 * Dragon generator plus the fixtures this file adds, not from a recorded run.
 *
 * ## The fixture
 *
 * Base Dragon is 34 tagged assets across two buildings (D1/D2) and three
 * systems (001, 002, 603) — see `project-service.test.mjs` for that derivation.
 * This file appends the PRODUCT.md §2.5 pair to building D1:
 *
 * - `PNL603-10-01`, UPN 603, Service `I&C`
 * - `RIO603-10-01`, UPN **650**, Service `I&C`
 *
 * with an EasyPower edge PNL603 → RIO603 and a role rule PNL parents RIO. The
 * discipline projection maps `I&C` → `Electrical`, so both agree at the SSM
 * Discipline boundary and differ only at System — which is exactly the case
 * §2.5 names: the flow keeps the feed, and the SSM hierarchy demotes the panel
 * to a dependency of the RIO.
 *
 * 34 + 2 = 36 assets.
 */

const DRAGON_ASSET_COUNT = 36;

const PNL = 'tag:PNL603-10-01';
const RIO = 'tag:RIO603-10-01';

/**
 * Two air handlers in one building and one system.
 *
 * The other half of P0-4: a manual parent that crosses nothing is kept, so this
 * pair is what a *moved parent* looks like in the register — and what the
 * revision diff below compares two compiles over.
 */
const MAH_PARENT = 'tag:MAH001-10-01';
const MAH_CHILD = 'tag:MAH001-10-02';

/* ------------------------------------------------------- profile sections */

/** Dragon's real anatomy: `MAH001-10-01` -> MAH / 001 / 10 / 01. */
const DRAGON_ANATOMY = {
  separators: ['-'],
  ignoredSuffixes: [],
  segments: [
    { segment: 'role', extractor: { kind: 'alphaPrefix', token: 0 } },
    { segment: 'system', extractor: { kind: 'digitSuffix', token: 0 } },
    { segment: 'unit', extractor: { kind: 'token', token: 1 } },
    { segment: 'instance', extractor: { kind: 'token', token: 2 } },
  ],
  familyKeyTemplate: '{system}-{token:1}-{token:2}',
  localFamilyTemplate: '',
};

/**
 * Systems come from the model's own UPN, not from the tag segment.
 *
 * Load-bearing for this file: `RIO603-10-01`'s tag says 603 and its UPN says
 * 650. Resolving from the tag would put the panel and the RIO in one system and
 * there would be no boundary to cross.
 */
const DRAGON_RESOLVER = {
  keyChain: [{ kind: 'model-field', property: { category: 'Dragon Data', name: 'UPN' } }],
  descriptionChain: [
    { kind: 'mel-lookup', joinBy: 'systemKey', returnField: 'systemDescription' },
  ],
  normalization: [{ kind: 'trim' }],
  conflictPolicy: 'review',
  labelTemplate: '',
};

const PROPERTY_MAPPINGS = {
  equipmentTag: { category: 'Dragon Data', name: 'Tag' },
  description: { category: 'Dragon Data', name: 'Manufacturer' },
  equipmentType: { category: 'Item', name: 'Type' },
  building: { category: 'Dragon Data', name: 'Building' },
  nativeDiscipline: { category: 'Dragon Data', name: 'Service' },
};

const ASSET_FILTERS = {
  includedClasses: [],
  excludedClasses: [],
  requireTagProperty: true,
  acceptedTagPatterns: [],
  selectionSetNames: [],
  includedSourceModelFiles: [],
  collapseComponents: false,
  separatelyCommissionableClasses: [],
};

/* ----------------------------------------------------------- cache fixture */

const SOURCE_MODEL_CONTROLS = 2;

/**
 * Appends the §2.5 pair to a written Dragon cache.
 *
 * Same technique as `tests/integration/e3-ssm-compiler.test.mjs`: the helper is
 * that file's own local one rather than an exported API, so it is replicated
 * here for the two objects this file needs.
 */
function addBoundaryPair(path) {
  const db = new DatabaseSync(path);
  try {
    db.exec('BEGIN');

    const insertObject = db.prepare(
      'INSERT INTO objects (id, source_model_id, parent_id, path_index, depth, display_name, class_name, ' +
        'instance_guid, authoring_id, bbox_min_x, bbox_min_y, bbox_min_z, bbox_max_x, bbox_max_y, bbox_max_z) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL)',
    );
    const insertProperty = db.prepare(
      'INSERT INTO properties (object_id, category, category_internal, name, name_internal, value_text, value_type) ' +
        'VALUES (?, ?, ?, ?, ?, ?, ?)',
    );

    let nextId = db.prepare('SELECT MAX(id) AS id FROM objects').get().id + 1;

    const layer = db
      .prepare('SELECT id FROM objects WHERE display_name = ? AND source_model_id = ? AND depth = 1')
      .get('D1', SOURCE_MODEL_CONTROLS);

    const nextPathIndex = (parentId) =>
      (db
        .prepare('SELECT MAX(path_index) AS slot FROM objects WHERE parent_id = ?')
        .get(parentId).slot ?? -1) + 1;

    const addProperty = (objectId, category, name, value) => {
      insertProperty.run(
        objectId,
        category,
        category.toLowerCase().replaceAll(' ', '_'),
        name,
        name.toLowerCase().replaceAll(' ', '_'),
        value,
        'DisplayString',
      );
    };

    const addEquipment = ({ tag, upn }) => {
      const id = nextId;
      nextId += 1;
      insertObject.run(
        id,
        SOURCE_MODEL_CONTROLS,
        layer.id,
        nextPathIndex(layer.id),
        2,
        tag,
        'Equipment',
        `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
      );
      addProperty(id, 'Item', 'Name', tag);
      addProperty(id, 'Item', 'Type', 'Equipment');
      addProperty(id, 'Dragon Data', 'Tag', tag);
      addProperty(id, 'Dragon Data', 'Building', 'D1');
      addProperty(id, 'Dragon Data', 'UPN', upn);
      addProperty(id, 'Dragon Data', 'Service', 'I&C');
      addProperty(id, 'Dragon Data', 'Manufacturer', `${tag} unit`);
    };

    addEquipment({ tag: 'PNL603-10-01', upn: '603' });
    addEquipment({ tag: 'RIO603-10-01', upn: '650' });

    const count = db.prepare('SELECT COUNT(*) AS total FROM objects').get().total;
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(String(count), 'object_count');
    db.exec('COMMIT');
  } finally {
    db.close();
  }
}

/* ---------------------------------------------------------------- workbooks */

/** Invented, written at test time: real MELs are client data. */
function melBytes() {
  return writeWorkbook([
    {
      name: 'MEL',
      aoa: [
        ['Equipment Tag', 'UPN', 'System Description'],
        ['MAH001-10-01', '001', 'Mechanical Dry Air Handling'],
        ['MAH002-10-01', '002', 'Mechanical Hot Water'],
        ['TIT603-10-01', '603', 'Temperature Instrumentation'],
        ['PNL603-10-01', '603', 'Control Panels'],
        ['RIO603-10-01', '650', 'Remote IO'],
      ],
    },
  ]);
}

function easyPowerBytes() {
  return writeWorkbook([
    {
      name: 'EasyPower',
      aoa: [
        ['Starting Source', 'ID Name'],
        ['PNL603-10-01', 'RIO603-10-01'],
      ],
    },
  ]);
}

/**
 * A finished SSM to learn nesting from: 12 rows where every `VFD` sits under a
 * `PLC` of the same system. Enough predictions for the 85%/10 grading gate to
 * have something to say either way.
 */
function priorSsmBytes() {
  const rows = [['Equipment Tag', 'Description', 'Closest Parent', 'UPN', 'Discipline']];
  for (let index = 1; index <= 6; index += 1) {
    const suffix = String(index).padStart(2, '0');
    rows.push([`PLC900-90-${suffix}`, 'Programmable Logic Controller', '', '900', 'I&C']);
    rows.push([
      `VFD900-90-${suffix}`,
      'Variable Frequency Drive',
      `PLC900-90-${suffix}`,
      '900',
      'I&C',
    ]);
  }
  return writeWorkbook([{ name: 'SSM', aoa: rows }]);
}

/**
 * An item-master registry: 9 rows of one master and 1 of another for the same
 * key, which is exactly the 0.9 gate — assigned, not proposed.
 */
function registryBytes() {
  const rows = [
    ['Equipment ID', 'Discipline', 'UPN', 'Equipment Classification', 'Item Master Unique Identifier'],
  ];
  for (let index = 0; index < 9; index += 1) {
    rows.push([`REG-${String(index)}`, 'Electrical', '603', 'Equipment', 'VF_PANEL_MAIN']);
  }
  rows.push(['REG-9', 'Electrical', '603', 'Equipment', 'VF_PANEL_OTHER']);
  return writeWorkbook([{ name: 'Registry', aoa: rows }]);
}

/** A site's own MEL layout: a title row, then headers using its own spellings. */
function templateBytes() {
  return writeWorkbook([
    {
      name: 'Site Template',
      aoa: [['Dragon Site Export'], ['UPN', 'Tag', 'Description', 'Building']],
    },
  ]);
}

/* -------------------------------------------------------------- the fixture */

let workDir = '';
let cachePath = '';
let projectPath = '';
let userDataDir = '';
let melPath = '';
let easyPowerPath = '';
let priorSsmPath = '';
let registryPath = '';
let templatePath = '';

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'matchline-workspace-'));
  cachePath = join(workDir, 'Dragon.matchline-cache');
  projectPath = join(workDir, 'Dragon.matchline');
  userDataDir = join(workDir, 'userData');
  melPath = join(workDir, 'Dragon-MEL.xlsx');
  easyPowerPath = join(workDir, 'Dragon-EasyPower.xlsx');
  priorSsmPath = join(workDir, 'Dragon-Prior-SSM.xlsx');
  registryPath = join(workDir, 'Dragon-Registry.xlsx');
  templatePath = join(workDir, 'Dragon-Template.xlsx');

  writeDragonFixture(cachePath);
  addBoundaryPair(cachePath);

  writeFileSync(melPath, melBytes());
  writeFileSync(easyPowerPath, easyPowerBytes());
  writeFileSync(priorSsmPath, priorSsmBytes());
  writeFileSync(registryPath, registryBytes());
  writeFileSync(templatePath, templateBytes());
});

after(() => {
  if (workDir !== '') {
    rmSync(workDir, { recursive: true, force: true });
  }
});

function newService() {
  return createProjectService({ userDataDir, appVersion: '0.5.0' });
}

/** Screens 1-7, exactly as the wizard writes them. */
async function configureThroughScreen7(service) {
  service.create(projectPath, 'Dragon');
  await service.addSources([cachePath, melPath, easyPowerPath]);
  service.updateDraft({
    propertyMappings: PROPERTY_MAPPINGS,
    assetFilters: ASSET_FILTERS,
    tagAnatomy: DRAGON_ANATOMY,
    systemResolver: DRAGON_RESOLVER,
  });
  service.updateDraft({
    roleGraph: { rules: [{ parentRole: 'PNL', childRole: 'RIO' }] },
    ssmDisciplineProjection: [{ from: 'I&C', to: 'Electrical' }],
  });
}

/* ========================================================== the flow ==== */

test('screens 6-9 and the workspace, over the Dragon fixture', async (t) => {
  const service = newService();
  t.after(() => {
    service.close();
  });

  await t.test('screen 6 opens on the standard commissioning stack', () => {
    service.create(projectPath, 'Dragon');
    // Screen 6 reads the PROFILE now: the level stack is a section of the site's
    // rule set, not a row in the project's configuration table (SiteProfileV2).
    const config = service.draftState().draft;

    assert.deepEqual(
      config.hierarchy.levels.map((level) => level.attributeKey),
      ['building', 'ssmDiscipline', 'systemKey'],
      'the default preset is Building / SSM Discipline / System',
    );
    assert.deepEqual(
      config.hierarchy.levels.map((level) => level.boundary),
      [true, false, true],
      'P0-5: Building and System are structural, SSM Discipline is a grouping only — ' +
        'a startup family crosses disciplines and must not be cut into four roots',
    );
    assert.equal(
      config.hierarchy.levels[2].displayAttributeKey,
      'systemLabel',
      'P0-6: the System level is keyed on the System Key and labelled by the words',
    );
    assert.deepEqual(config.roleGraph.rules, []);
    assert.equal(config.parentTagProperty, null);
    assert.deepEqual(config.ssmDisciplineProjection, []);
    assert.equal(config.ladder.tiers.length, 8, 'every ladder rung starts enabled');
    assert.equal(config.ladder.tiers[0], 'manual', 'a human decision is the strongest rung');

    // Every level attribute the menu offers is one the compiler populates.
    const attributes = service.attributeChoices();
    assert.ok(attributes.length >= 9);
    for (const choice of attributes) {
      assert.ok(choice.label.length > 0, `${choice.attributeKey} has a plain-language name`);
      assert.ok(choice.example.length > 0, `${choice.attributeKey} has an example`);
      assert.equal(choice.distinctValueCount, null, 'nothing compiled yet, so no counts');
    }

    service.close();
  });

  await t.test('a profile write survives closing and reopening the project', async () => {
    const first = newService();
    first.create(join(workDir, 'Reopen.matchline'), 'Reopen');
    first.updateDraft({
      propertyMappings: PROPERTY_MAPPINGS,
      roleGraph: { rules: [{ parentRole: 'PNL', childRole: 'RIO' }] },
    });
    // A section only reaches the file when the profile is published: a draft is
    // in memory until somebody saves it.
    first.saveProfile('screen 7');
    first.close();

    const second = newService();
    await second.open(join(workDir, 'Reopen.matchline'));
    assert.deepEqual(second.draftState().draft.roleGraph.rules, [
      { parentRole: 'PNL', childRole: 'RIO' },
    ]);
    second.close();
  });

  await t.test('a level spelled the engine\'s way is read, lifted and kept (P0-6)', async () => {
    // A profile package or a config written against `HierarchyLevelConfig`
    // names the grouping attribute `keyAttributeKey`; screen 6 and the project
    // file call the same field `attributeKey`. Refusing either spelling would
    // lose a project's levels, so the read lifts one onto the other.
    const path = join(workDir, 'KeySpelling.matchline');
    const first = newService();
    first.create(path, 'Key spelling');
    first.updateDraft({
      propertyMappings: PROPERTY_MAPPINGS,
      hierarchy: {
        levels: [
          {
            levelId: 'system',
            displayName: 'System',
            keyAttributeKey: 'systemKey',
            displayAttributeKey: 'systemLabel',
            boundary: true,
            missingValuePolicy: 'unassigned-group',
            sort: 'key',
          },
        ],
      },
    });
    first.saveProfile('engine spelling');
    first.close();

    const second = newService();
    await second.open(path);
    const [level] = second.draftState().draft.hierarchy.levels;
    assert.equal(level.attributeKey, 'systemKey', 'the key survived the round trip');
    assert.equal(level.displayAttributeKey, 'systemLabel', 'and so did the display attribute');
    second.close();
  });

  await t.test('screen 7 offers the roles and disciplines the model really has', async () => {
    rmSync(projectPath, { force: true });
    await configureThroughScreen7(service);

    assert.deepEqual(
      service.roleValues(),
      ['MAH', 'PLC', 'PNL', 'RIO', 'TIT', 'VFD'],
      'roles come from the taught anatomy, not from guessing at the tag text',
    );
    assert.deepEqual(service.disciplineValues(), ['Chilled Water', 'Hot Water', 'I&C']);
  });

  await t.test('screen 7 trains nesting rules and grades itself', () => {
    const summary = service.trainLearnedRules('nesting', priorSsmPath);
    assert.equal(summary.kind, 'nesting');
    assert.equal(summary.label, 'Dragon-Prior-SSM.xlsx');
    assert.equal(summary.rowCount, 12, 'six PLC/VFD pairs');
    assert.ok(summary.classCount >= 2, 'PLC and VFD descriptions are two classes');
    assert.equal(summary.claimGradeCount + summary.proposalGradeCount, summary.grades.length);
    for (const grade of summary.grades) {
      assert.ok(grade.precision >= 0 && grade.precision <= 1);
      assert.ok(grade.correct <= grade.predicted);
      assert.ok(
        grade.grade === 'claim' ? grade.predicted >= 10 : true,
        'claim grade needs at least 10 predictions (DECISIONS.md #3)',
      );
    }

    const stored = service.learnedSummaries();
    assert.equal(stored.length, 1);
    assert.equal(stored[0].kind, 'nesting');
    assert.equal(stored[0].rowCount, 12);
  });

  await t.test('screen 7 trains item masters at the 0.9 gate', () => {
    const summary = service.trainLearnedRules('item-master', registryPath);
    assert.equal(summary.kind, 'item-master');
    assert.equal(summary.rowCount, 10);
    assert.equal(summary.suspectRowCount, 0);
    assert.equal(summary.gateCount, 1, 'one key reached 9/10 = exactly the gate');
    assert.equal(service.learnedSummaries().length, 2);
  });

  await t.test('a workbook with no parent column is refused, not half-learned', () => {
    const badPath = join(workDir, 'No-Parent.xlsx');
    writeFileSync(
      badPath,
      writeWorkbook([{ name: 'Sheet1', aoa: [['Equipment Tag', 'Description'], ['A-1', 'thing']] }]),
    );
    assert.throws(
      () => service.trainLearnedRules('nesting', badPath),
      /no parent column/,
      'training refuses rather than guessing which column is the parent',
    );
  });

  /* ------------------------------------------------------------ screen 8 */

  await t.test('screen 8 compiles the project and reports the §2.5 demotion', async () => {
    const status = await service.compile();
    assert.equal(status.state, 'done', status.state === 'failed' ? status.reason : '');

    const summary = status.summary;
    assert.equal(summary.compileId, 1);
    assert.equal(summary.profileRevision, 1, 'the draft was saved so the compile has a revision');
    assert.equal(summary.assetCount, DRAGON_ASSET_COUNT);
    assert.equal(summary.duplicateTagCount, 0);
    assert.equal(summary.resolvedSystemCount, DRAGON_ASSET_COUNT);
    assert.equal(summary.missingSystemCount, 0);
    assert.equal(summary.generatedMelRowCount, DRAGON_ASSET_COUNT);

    // The panel feeds the RIO: two flow nodes, both matched to model assets.
    assert.equal(summary.flowNodeCount, 2);
    assert.equal(summary.modelConfirmedCount, 2);
    assert.equal(summary.flowOnlyCount, 0);
    assert.equal(summary.pmdOnlyCount, 0);
    assert.equal(summary.multiFeedNodeCount, 0);

    // The one thing this fixture exists to prove.
    assert.equal(summary.demotionCount, 1, 'exactly one cross-boundary demotion');
    assert.equal(summary.cycleCount, 0);
    assert.equal(summary.rootCount, DRAGON_ASSET_COUNT, 'the demoted RIO is a root of System 650');
  });

  await t.test('the demotion drill-down names the level that broke the parent', () => {
    const page = service.compileIssues('demotions', 0, 50);
    assert.equal(page.total, 1);
    assert.equal(page.rows[0].title, 'RIO603-10-01');
    assert.match(page.rows[0].detail, /PNL603-10-01 became a dependency/);
    assert.match(page.rows[0].detail, /System differs/);
    assert.equal(page.rows[0].badge, 'System');
  });

  await t.test('every drill-down list answers in its own shape', () => {
    const kinds = [
      'assets',
      'flow-nodes',
      'demotions',
      'duplicate-tags',
      'ambiguous-parents',
      'cycles',
      'missing-systems',
      'system-conflicts',
      'unresolved-parents',
      'review-items',
    ];
    for (const kind of kinds) {
      const page = service.compileIssues(kind, 0, 5);
      assert.ok(page.total >= 0, `${kind} reports a total`);
      assert.ok(page.rows.length <= 5, `${kind} respects the page size`);
      for (const row of page.rows) {
        assert.ok(row.id.length > 0, `${kind} rows are addressable`);
        assert.ok(row.title.length > 0, `${kind} rows say what they are about`);
      }
    }

    assert.equal(service.compileIssues('assets', 0, 500).total, DRAGON_ASSET_COUNT);
    assert.equal(
      service.compileIssues('assets', 30, 500).rows.length,
      DRAGON_ASSET_COUNT - 30,
      'the offset is a real offset',
    );
  });

  await t.test('the level menu now knows how many values each attribute has', () => {
    const attributes = service.attributeChoices();
    const buildings = attributes.find((choice) => choice.attributeKey === 'building');
    assert.equal(buildings.distinctValueCount, 2, 'D1 and D2');
    const systems = attributes.find((choice) => choice.attributeKey === 'systemKey');
    assert.equal(systems.distinctValueCount, 4, '001, 002, 603 and the RIO’s 650');
  });

  /* ----------------------------------------------------------- the tree */

  await t.test('the SSM tree pages children of one node at a time', () => {
    const root = service.treeChildren('', 0, 100);
    assert.equal(root.total, 2, 'two buildings at the top level');
    assert.deepEqual(
      root.rows.map((row) => row.label),
      ['D1', 'D2'],
    );
    assert.ok(root.rows.every((row) => row.kind === 'level'));
    assert.equal(root.rows[0].detail, 'Building');

    const d1 = service.treeChildren(root.rows[0].nodeKey, 0, 100);
    assert.ok(d1.total > 0, 'D1 has SSM Discipline groups under it');
    assert.ok(d1.rows.every((row) => row.kind === 'level'));
    assert.ok(
      d1.rows.some((row) => row.label === 'Electrical'),
      'the I&C -> Electrical projection is what the level is named by',
    );
  });

  await t.test('search finds equipment by tag without walking the tree', () => {
    const hits = service.treeSearch('RIO603', 20);
    assert.equal(hits.length, 1);
    assert.equal(hits[0].assetId, RIO);
    assert.equal(hits[0].kind, 'asset');
    assert.equal(hits[0].demoted, true, 'the RIO carries the demotion badge');
    assert.equal(hits[0].overridden, false);
    assert.equal(hits[0].dependencyCount, 2, 'the panel is both a feed and a demoted parent');

    assert.deepEqual(service.treeSearch('   ', 20), [], 'a blank search matches nothing');
    assert.equal(service.treeSearch('MAH', 3).length, 3, 'the limit is respected');
  });

  await t.test('a reparent preview warns before anything is written', () => {
    const across = service.reparentPreview(RIO, PNL);
    // Allowed, because the override is worth recording and the dependency it
    // produces is a real relationship. What it is not, since P0-4, is a nesting
    // — and the sentence has to say so before the drag is written.
    assert.equal(across.allowed, true);
    assert.equal(across.wouldDemote, true);
    assert.equal(across.boundaryLevelId, 'system');
    assert.match(across.explanation, /650 against 603/);
    assert.match(across.explanation, /becomes a dependency/);

    const inside = service.reparentPreview(MAH_CHILD, MAH_PARENT);
    assert.equal(inside.allowed, true);
    assert.equal(inside.wouldDemote, false);
    assert.equal(inside.boundaryLevelId, '');
    assert.match(inside.explanation, /nests cleanly/);

    const asRoot = service.reparentPreview(RIO, null);
    assert.equal(asRoot.allowed, true);
    assert.match(asRoot.explanation, /becomes a root/);

    const itself = service.reparentPreview(RIO, RIO);
    assert.equal(itself.allowed, false);
    assert.match(itself.explanation, /cannot be its own parent/);

    const unknown = service.reparentPreview('tag:NOT-A-THING', PNL);
    assert.equal(unknown.allowed, false);
  });

  await t.test('a drag across a boundary is recorded, and the fold still applies (P0-4)', async () => {
    const overrides = service.setRelationshipOverride(RIO, PNL, 'One panel, one skid.');
    assert.equal(overrides.length, 1);
    assert.equal(overrides[0].childTag, 'RIO603-10-01');
    assert.equal(overrides[0].parentTag, 'PNL603-10-01');
    assert.equal(overrides[0].note, 'One panel, one skid.');

    const status = await service.compile();
    assert.equal(status.state, 'done', status.state === 'failed' ? status.reason : '');
    assert.equal(status.summary.compileId, 2);

    // P0-4: the manual claim wins the ladder and is then folded like any other
    // winner. The System boundary is enabled and the two disagree at it, so the
    // panel is a dependency and the RIO stays a root of System 650.
    assert.equal(status.summary.demotionCount, 1);
    assert.equal(status.summary.rootCount, DRAGON_ASSET_COUNT);

    const hits = service.treeSearch('RIO603', 5);
    assert.equal(hits[0].overridden, false, 'no manual parent survived the fold');
    assert.equal(hits[0].demoted, true);
    assert.equal(hits[0].parentStatus, 'root');

    const panel = service.treeSearch('PNL603', 5)[0];
    assert.equal(panel.childCount, 0, 'nothing nests across the System boundary');

    // And the person is told, by name, which decision the boundary refused.
    const crossing = service
      .reviewPage('manual-boundary-demotion', 0, 10)
      .rows.find((row) => row.detail.includes('RIO603-10-01'));
    assert.ok(crossing, 'the refused manual parent is a visible review item');
    assert.ok(crossing.detail.includes('PNL603-10-01'), 'and it names the parent that was chosen');
  });

  await t.test('a drag inside the boundaries nests, and removing it is the undo', async () => {
    assert.equal(service.removeRelationshipOverride(RIO), true);
    assert.deepEqual(service.listRelationshipOverrides(), []);

    const status = await service.compile();
    assert.equal(status.state, 'done');
    assert.equal(
      status.summary.demotionCount,
      1,
      'the demotion was never the override’s doing: the cable schedule proposes the same parent',
    );
    assert.equal(
      service.reviewPage('manual-boundary-demotion', 0, 10).total,
      0,
      'with no manual decision to refuse, there is nothing to explain',
    );

    // The other half of §11.5, which P0-4 leaves untouched — and the parent move
    // the revision-diff test below compares two compiles over.
    service.setRelationshipOverride(MAH_CHILD, MAH_PARENT, 'One air handling train.');
    assert.equal((await service.compile()).state, 'done');
    const child = service.treeSearch('MAH001-10-02', 5)[0];
    assert.equal(child.overridden, true, 'nothing is crossed, so the stated parent is the parent');
    assert.equal(child.demoted, false);
  });

  /* ---------------------------------------------------------- the flow */

  await t.test('Electrical Flow keeps the feed the SSM hierarchy demoted', () => {
    const roots = service.flowRoots(0, 50);
    assert.equal(roots.total, 1);
    assert.equal(roots.rows[0].tag, 'PNL603-10-01');
    assert.equal(roots.rows[0].reachableCount, 2);

    const walk = service.flowWalk(roots.rows[0].nodeId, 0, 50);
    assert.equal(walk.total, 2);
    assert.deepEqual(
      walk.rows.map((row) => row.tag),
      ['PNL603-10-01', 'RIO603-10-01'],
    );
    assert.equal(walk.rows[0].depth, 0);
    assert.equal(walk.rows[1].depth, 1, 'the RIO is one feed below the panel');
    assert.equal(walk.rows[1].fedByCount, 1);
    assert.equal(walk.rows[1].multiFed, false);
    assert.equal(walk.rows[1].building, 'D1');
    assert.equal(walk.rows[1].systemLabel, '650 Remote IO', 'enriched from the MEL description');
    assert.ok(walk.rows.every((row) => row.matchStatus === 'model-confirmed'));

    assert.equal(service.flowWalk('tag:NOT-A-NODE', 0, 50).total, 0);
  });

  /* -------------------------------------------------------- the review */

  await t.test('review keys survive SQLite, which truncates a string at a NUL', () => {
    const rows = service.reviewPage('', 0, 500).rows;
    assert.ok(rows.length > 0);

    const keys = new Set();
    for (const row of rows) {
      // `@matchline/ssm-compiler`'s reviewKey used to join its fields with NUL,
      // and node:sqlite stores such a string truncated at the first one — every
      // item of a kind would collapse onto one row and one decision would
      // decide them all. The engine joins with U+241F now; this is the assertion
      // that the whole round trip, engine to store to wire, still holds.
      for (const character of row.reviewKey) {
        assert.ok(
          character.codePointAt(0) > 0x1f,
          `${row.reviewKey} carries a control character`,
        );
      }
      assert.equal(keys.has(row.reviewKey), false, 'the keys stay injective');
      keys.add(row.reviewKey);
    }
  });

  await t.test('review decisions are recorded and shown against the item', async () => {
    const before = service.reviewPage('', 0, 100);
    assert.ok(before.total > 0, 'the compile left something to decide');
    assert.equal(before.undecidedCount, before.total);
    assert.ok(before.kinds.length > 0);
    for (const row of before.rows) {
      assert.ok(row.reviewKey.length > 0);
      assert.ok(row.summary.length > 0);
      assert.equal(row.decision, null);
    }

    const target = before.rows[0];
    assert.equal(service.recordDecision(target.reviewKey, 'accepted', 'Checked on site.'), true);

    const after = service.reviewPage('', 0, 100);
    assert.equal(after.total, before.total, 'a decision keeps the item, it does not delete it');
    assert.equal(after.undecidedCount, before.undecidedCount - 1);
    const decided = after.rows.find((row) => row.reviewKey === target.reviewKey);
    assert.equal(decided.decision, 'accepted');
    assert.equal(decided.note, 'Checked on site.');
    assert.ok(decided.decidedAt.length > 0);

    const filtered = service.reviewPage(target.kind, 0, 100);
    assert.ok(filtered.total <= after.total);
    assert.ok(filtered.rows.every((row) => row.kind === target.kind));

    // The next compile carries the decision through: it is stored against the
    // review key, not against a compile.
    assert.equal((await service.compile()).state, 'done');
    assert.equal(service.reviewPage('', 0, 100).undecidedCount, before.undecidedCount - 1);
  });

  /* ------------------------------------------------------- the exports */

  await t.test('the generated MEL is a parseable workbook with the right rows', () => {
    const target = join(workDir, 'out-generated.xlsx');
    const result = service.exportGeneratedMel(target);
    assert.equal(result.written, true);
    assert.ok(result.byteSize > 0);
    assert.match(result.note, /36 rows/);

    const workbook = readWorkbook(readFileSync(target));
    const { aoa } = sheetAoa(workbook.getSheet(workbook.sheetNames[0]));
    assert.equal(aoa.length, DRAGON_ASSET_COUNT + 1, 'a header row plus one row per asset');

    const header = aoa[0];
    const tagColumn = header.indexOf('Equipment Tag');
    const keyColumn = header.indexOf('System Key');
    const disciplineColumn = header.indexOf('SSM Discipline');
    const parentColumn = header.indexOf('System Parent Equipment Tag');
    assert.ok(tagColumn >= 0 && keyColumn >= 0 && disciplineColumn >= 0 && parentColumn >= 0);

    const rio = aoa.find((row) => row[tagColumn] === 'RIO603-10-01');
    assert.ok(rio, 'the RIO has a row');
    assert.equal(rio[keyColumn], '650', 'the model UPN, not the tag segment');
    assert.equal(rio[disciplineColumn], 'Electrical', 'the I&C -> Electrical projection landed');
    assert.equal(
      rio[parentColumn],
      '',
      'P0-4: a cross-boundary manual parent is not printed as a System Parent',
    );
    const dependencyColumn = header.indexOf('Dependencies');
    assert.ok(rio[dependencyColumn].includes('PNL603-10-01'), 'it is printed as a dependency');

    const mahChild = aoa.find((row) => row[tagColumn] === 'MAH001-10-02');
    assert.equal(
      mahChild[parentColumn],
      'MAH001-10-01',
      'a manual parent inside the boundaries is exported as the parent',
    );

    const mah = aoa.find((row) => row[tagColumn] === 'MAH001-10-01');
    assert.equal(mah[keyColumn], '001', "'001' survives as text, not as the number 1");

    // Byte-stable: the same compile exports identically twice.
    const second = join(workDir, 'out-generated-2.xlsx');
    service.exportGeneratedMel(second);
    assert.deepEqual(readFileSync(target), readFileSync(second));
  });

  await t.test('the site template is analyzed and filled on its own columns', () => {
    const analysis = service.analyzeTemplate(templatePath);
    assert.equal(analysis.headerRow, 1, 'the one-cell title row is skipped');
    assert.deepEqual(
      analysis.columns.map((column) => column.header),
      ['UPN', 'Tag', 'Description', 'Building'],
    );
    assert.deepEqual(
      analysis.columns.map((column) => column.suggestedField),
      ['systemKey', 'equipmentTag', 'equipmentDescription', 'building'],
    );
    assert.equal(analysis.columns[3].match, 'exact', 'Building is a §12.1 header verbatim');
    assert.ok(analysis.fieldChoices.includes('blank'));

    const target = join(workDir, 'out-template.xlsx');
    const result = service.exportTemplateMel(
      target,
      analysis.columns.map((column) => ({
        templateColumn: column.header,
        field: column.suggestedField === '' ? 'blank' : column.suggestedField,
      })),
    );
    assert.equal(result.written, true);

    const { aoa } = sheetAoa(readWorkbook(readFileSync(target)).getSheet('MEL'));
    assert.deepEqual(aoa[0], ['UPN', 'Tag', 'Description', 'Building']);
    const rio = aoa.find((row) => row[1] === 'RIO603-10-01');
    assert.ok(rio);
    assert.equal(rio[0], '650');
    assert.equal(rio[2], 'RIO603-10-01 unit');
    assert.equal(rio[3], 'D1');

    assert.throws(
      () => service.exportTemplateMel(target, [{ templateColumn: 'UPN', field: 'nonsense' }]),
      /does not know these fields/,
      'a stale binding is refused with the field named',
    );
  });

  await t.test('EXTO writes the Rev21 sheet, with the trained item master', () => {
    const target = join(workDir, 'out-exto.xlsx');
    const result = service.exportExto(target);
    assert.equal(result.written, true);
    assert.match(result.note, /No P6 schedule is loaded/);
    assert.match(
      result.note,
      /1 item master filled \(0 from the model, 1 learned\)/,
      'the note says which source filled the column, not merely how many',
    );
    assert.match(
      result.note,
      /No WBS table has been trained and no model property is mapped/,
      'and admits the column it could not fill at all',
    );
    assert.match(result.note, /Matchline.s own Rev21 columns/, 'no template is captured here');

    const { aoa } = sheetAoa(readWorkbook(readFileSync(target)).getSheet('Exto SSM'));
    // Row 0 is the blank spacer the Rev21 sheet starts with.
    const header = aoa[1];
    const idColumn = header.indexOf('Equipment ID');
    const upnColumn = header.indexOf('UPN');
    const parentColumn = header.indexOf('Closest Parent');
    const masterColumn = header.indexOf('Item Master Unique Identifier');
    assert.ok(idColumn >= 0 && upnColumn >= 0 && parentColumn >= 0 && masterColumn >= 0);

    const panel = aoa.find((row) => row[idColumn] === 'PNL603-10-01');
    assert.ok(panel, 'the panel has a row');
    assert.equal(panel[upnColumn], '603');
    assert.equal(
      panel[masterColumn],
      'VF_PANEL_MAIN',
      'the 9/10 key cleared the 0.9 gate and was printed',
    );

    const rio = aoa.find((row) => row[idColumn] === 'RIO603-10-01');
    assert.equal(rio[upnColumn], '650');
    assert.equal(
      rio[parentColumn],
      '650 Remote IO',
      'P0-4: nothing nests across the System boundary, so the RIO is a root and its ' +
        'Closest Parent is its own system',
    );

    const mahChild = aoa.find((row) => row[idColumn] === 'MAH001-10-02');
    assert.equal(
      mahChild[parentColumn],
      'MAH001-10-01',
      'the manual parent that crossed nothing is what the register hands over',
    );

    const untrained = aoa.find((row) => row[idColumn] === 'MAH001-10-01');
    assert.equal(untrained[masterColumn], '', 'nothing was learned for it, so the cell is blank');
  });

  await t.test('the predecessor matrix carries the boundary dependency', async () => {
    // Drop the air-handler override: it is the one manual parent that actually
    // nests, so removing it is a real parent move for the revision diff below.
    // The 603 -> 650 predecessor edge comes from the boundary demotion and is
    // there either way.
    service.removeRelationshipOverride(MAH_CHILD);
    assert.equal((await service.compile()).state, 'done');

    const target = join(workDir, 'out-predecessors.xlsx');
    const result = service.exportPredecessors(target);
    assert.equal(result.written, true);
    assert.match(result.note, /systems/);

    const { aoa } = sheetAoa(readWorkbook(readFileSync(target)).getSheet('Predecessors'));
    assert.deepEqual(aoa[0], ['System Key', 'Predecessor System Keys']);

    const row650 = aoa.find((row) => row[0] === '650');
    assert.ok(row650, 'System 650 is in the matrix');
    assert.equal(row650[1], '603', 'the panel’s system starts up before the RIO’s');

    const row001 = aoa.find((row) => row[0] === '001');
    assert.ok(row001, "System '001' round-trips with its leading zero intact");
  });

  await t.test('the revision diff compares two stored compiles', () => {
    const history = service.compileHistory();
    assert.ok(history.length >= 2);
    assert.ok(
      history.every((entry) => entry.diffable),
      'every compile this build wrote stored the register it produced',
    );
    assert.equal(history[0].compileId > history[1].compileId, true, 'newest first');
    assert.equal(history[0].assetCount, DRAGON_ASSET_COUNT);

    // The compile before this one had the air handler's manual parent applied;
    // this one does not, so MAH001-10-02's parent moved back.
    const target = join(workDir, 'out-diff.xlsx');
    const result = service.exportRevisionDiff(target, history[1].compileId);
    assert.equal(result.written, true);

    const workbook = readWorkbook(readFileSync(target));
    assert.equal(workbook.sheetNames[0], 'Summary');
    const { aoa } = sheetAoa(workbook.getSheet('Summary'));
    const countOf = (category) => {
      const row = aoa.find((candidate) => candidate[0] === category);
      return row ? Number(row[1]) : null;
    };
    assert.equal(countOf('Added Assets'), 0);
    assert.equal(countOf('Removed Assets'), 0);
    assert.equal(
      countOf('Moved Parents'),
      1,
      'MAH001-10-02 moved out from under MAH001-10-01',
    );

    const failure = service.exportRevisionDiff(target, 9999);
    assert.equal(failure.written, false);
    assert.match(failure.reason, /did not store the register/);
  });

  /* ------------------------------------------------------------ screen 9 */

  await t.test('screen 9 lists what the profile says', () => {
    const sections = service.profileSections();
    const byName = new Map(sections.map((section) => [section.name, section]));

    assert.equal(byName.get('Model property mappings').configured, true);
    assert.match(byName.get('Model property mappings').detail, /Dragon Data > Tag/);
    assert.equal(byName.get('Tag anatomy').configured, true);
    assert.equal(byName.get('Hierarchy Composer').configured, true);
    assert.equal(
      byName.get('Hierarchy Composer').detail,
      'Building / SSM Discipline / System.',
    );
    assert.equal(byName.get('Structural boundaries').configured, true);
    assert.equal(byName.get('Role and relationship graph').configured, true);
    assert.equal(byName.get('SSM discipline rules').configured, true);
    assert.match(byName.get('SSM discipline rules').detail, /I&C → Electrical/);
    assert.equal(
      byName.get('Explicit model relationships').configured,
      false,
      'no parent-tag property was mapped, and the row says so rather than lying',
    );
  });

  await t.test('a profile package round-trips every section', () => {
    const target = join(workDir, 'dragon.matchline-profile.json');
    const result = service.exportProfilePackage(target);
    assert.equal(result.written, true);
    assert.ok(existsSync(target));

    const written = JSON.parse(readFileSync(target, 'utf8'));
    assert.equal(written.formatVersion, 2);
    assert.equal(written.appVersion, '0.5.0');
    assert.equal(written.draft, undefined, 'one versioned profile, not a draft/config pair');
    assert.equal(written.config, undefined);
    assert.deepEqual(written.profile.roleGraph.rules, [{ parentRole: 'PNL', childRole: 'RIO' }]);
    assert.deepEqual(written.profile.propertyMappings.equipmentTag, {
      category: 'Dragon Data',
      name: 'Tag',
    });
    // §13.3: a package is decisions only.
    const text = readFileSync(target, 'utf8');
    assert.equal(text.includes('Dragon.matchline-cache'), false, 'no source file names');
    assert.equal(text.includes(workDir), false, 'no directories');

    // Import into a second, empty project.
    const other = newService();
    try {
      const otherPath = join(workDir, 'Other.matchline');
      other.create(otherPath, 'Other Site');
      assert.deepEqual(other.draftState().draft.roleGraph.rules, []);

      const imported = other.importProfilePackage(target);
      assert.equal(imported.draft.name, 'Other Site', 'the project keeps its own identity');
      assert.deepEqual(imported.draft.tagAnatomy.segments, DRAGON_ANATOMY.segments);
      assert.deepEqual(imported.draft.roleGraph.rules, [{ parentRole: 'PNL', childRole: 'RIO' }]);
      assert.deepEqual(imported.draft.ssmDisciplineProjection, [
        { from: 'I&C', to: 'Electrical' },
      ]);
      assert.equal(other.compileStatus().state, 'never-run', 'nothing is compiled against it yet');
    } finally {
      other.close();
    }
  });

  await t.test('a file that is not a profile package is refused with a reason', () => {
    assert.throws(
      () => service.importProfilePackage(melPath),
      /not readable as JSON|not a Matchline profile package/,
    );
  });
});

/* ==================================================== refusals and gaps ==== */

test('the workspace refuses to answer before anything is compiled', () => {
  const service = newService();
  try {
    const path = join(workDir, 'Fresh.matchline');
    service.create(path, 'Fresh');

    assert.equal(service.compileStatus().state, 'never-run');
    for (const call of [
      () => service.treeChildren('', 0, 10),
      () => service.treeSearch('MAH', 10),
      () => service.flowRoots(0, 10),
      () => service.reviewPage('', 0, 10),
      () => service.exportGeneratedMel(join(workDir, 'never.xlsx')),
    ]) {
      assert.throws(call, /Nothing has been compiled yet/);
    }
  } finally {
    service.close();
  }
});

test('a compile with no model fails with something a person can act on', async () => {
  const service = newService();
  try {
    service.create(join(workDir, 'NoModel.matchline'), 'No Model');
    const status = await service.compile();
    assert.equal(status.state, 'failed');
    assert.match(status.reason, /model extraction cache/);
    assert.equal(service.compileStatus().state, 'never-run', 'a refusal is not a failed compile');
  } finally {
    service.close();
  }
});

/* ============================== the configuration travels with the file ==== */

/**
 * Every section screens 6-7 configure, each set to something not its default.
 *
 * A draft patch now, not a config patch: these are the site's rules, and since
 * SiteProfileV2 they are stored as profile revisions rather than as `config`
 * rows. `propertyMappings` rides along because a profile has to be publishable
 * to be saved at all.
 */
const FULL_PROFILE_PATCH = {
  propertyMappings: PROPERTY_MAPPINGS,
  hierarchy: {
    levels: [
      {
        levelId: 'system',
        displayName: 'System',
        attributeKey: 'systemKey',
        boundary: true,
        missingValuePolicy: 'unassigned-group',
        sort: 'key',
      },
      {
        levelId: 'building',
        displayName: 'Building',
        attributeKey: 'building',
        boundary: false,
        missingValuePolicy: 'review',
        sort: 'label',
      },
    ],
  },
  roleGraph: { rules: [{ parentRole: 'PNL', childRole: 'RIO' }] },
  ladder: { tiers: ['manual', 'flow-family'] },
  ssmDisciplineProjection: [{ from: 'I&C', to: 'Electrical' }],
  parentTagProperty: { category: 'Dragon Data', name: 'Parent Tag' },
  // The two sections schema v6 added: the site's own attribute registry (P0-7)
  // and its assignment rules (P0-8). Both travel with the project file for the
  // same reason the five above do.
  derivedAttributes: [
    {
      attributeId: 'turnover-package',
      displayName: 'Turnover Package',
      resolverChain: [
        { kind: 'model-property', chain: [{ category: 'Dragon Data', name: 'Package' }] },
        { kind: 'tag-segment', segment: 'unit' },
      ],
    },
  ],
  sourceAssignments: [
    {
      scope: 'filename-pattern',
      match: 'Dragon-*.nwc',
      assign: { building: '', nativeDiscipline: '$1', custom: [{ key: 'zone', value: 'Z-$1' }] },
    },
  ],
};

/**
 * The scenario the old design lost: schema v1 kept these five sections in the
 * app's machine-local state file keyed by project path, so a `.matchline` that
 * was renamed, moved to another folder, or copied to another machine reopened
 * on the wizard defaults with no warning. Schema v2's `config` table is what
 * makes the file self-contained, and this is the test that says so.
 *
 * The reader deliberately runs on a *different* userData directory, so nothing
 * machine-local can be quietly supplying the answer.
 */
test('a moved project file carries its whole configuration with it', async () => {
  const originalPath = join(workDir, 'Portable.matchline');
  const movedDir = join(workDir, 'somewhere-else');
  const movedPath = join(movedDir, 'Renamed-By-The-User.matchline');

  const writer = newService();
  let configured;
  try {
    writer.create(originalPath, 'Portable');
    configured = writer.updateDraft(FULL_PROFILE_PATCH);
    assert.deepEqual(configured.ladder.tiers, ['manual', 'flow-family']);
    writer.saveProfile('portable');
  } finally {
    writer.close();
  }

  mkdirSync(movedDir, { recursive: true });
  renameSync(originalPath, movedPath);

  const reader = createProjectService({
    userDataDir: join(workDir, 'other-machine'),
    appVersion: '0.6.0',
  });
  try {
    const { project, notice } = await reader.open(movedPath);
    assert.equal(project.path, movedPath);
    assert.equal(notice.migration, null, 'the file was already current');
    assert.equal(notice.adoptedAppStateConfig, false, 'nothing machine-local was involved');
    // Every section the writer set, read back off a file on a different machine.
    // Compared section by section rather than whole: the rehydrated draft also
    // carries the defaults for mappings nobody set, and "the file remembered
    // what I configured" is the claim, not "the object is byte-identical".
    for (const section of [
      'hierarchy',
      'roleGraph',
      'ladder',
      'ssmDisciplineProjection',
      'parentTagProperty',
      'derivedAttributes',
      'sourceAssignments',
    ]) {
      assert.deepEqual(
        reader.draftState().draft[section],
        configured[section],
        `${section} came back off the file`,
      );
    }
  } finally {
    reader.close();
  }
});

/**
 * P0-7: "Composer selects them."
 *
 * A derived attribute a level cannot be pointed at is a registry nobody can
 * use, so the Composer's menu has to be the built-in keys AND whatever the
 * project defines — in one list, addressable the same way.
 */
test('the level-attribute menu offers the project’s derived attributes beside the built-ins', () => {
  const service = newService();
  try {
    service.create(join(workDir, 'Derived.matchline'), 'Derived');

    const builtInOnly = service.attributeChoices();
    assert.equal(
      builtInOnly.some((choice) => choice.attributeKey === 'turnover-package'),
      false,
      'a new project defines none',
    );

    service.updateDraft({ derivedAttributes: FULL_PROFILE_PATCH.derivedAttributes });
    const choices = service.attributeChoices();
    assert.equal(
      choices.length,
      builtInOnly.length + 1,
      'the built-ins are still all there — a derived attribute adds, it never replaces',
    );

    const derived = choices.at(-1);
    assert.equal(derived.attributeKey, 'turnover-package');
    assert.equal(derived.label, 'Turnover Package', 'the display name is what a person reads');
    assert.ok(
      derived.example.includes('Dragon Data > Package'),
      'and the menu says where it comes from, not merely that it is derived',
    );
    assert.equal(derived.distinctValueCount, null, 'nothing compiled yet, so no count');
  } finally {
    service.close();
  }
});

test('an imported profile package is written into the project, not just held', async () => {
  const packagePath = join(workDir, 'portable.matchline-profile.json');
  const targetPath = join(workDir, 'Imported.matchline');

  const exporter = newService();
  try {
    exporter.create(join(workDir, 'Exporter.matchline'), 'Exporter');
    exporter.updateDraft({ ...FULL_PROFILE_PATCH, tagAnatomy: DRAGON_ANATOMY });
    assert.equal(exporter.exportProfilePackage(packagePath).written, true);
  } finally {
    exporter.close();
  }

  const importer = newService();
  try {
    importer.create(targetPath, 'Imported');
    const imported = importer.importProfilePackage(packagePath);
    assert.deepEqual(imported.draft.ladder.tiers, ['manual', 'flow-family']);
    // An import replaces the draft in memory; publishing is what puts it on disk.
    importer.saveProfile('imported');
  } finally {
    importer.close();
  }

  const reopened = newService();
  try {
    await reopened.open(targetPath);
    assert.deepEqual(
      reopened.draftState().draft.parentTagProperty,
      { category: 'Dragon Data', name: 'Parent Tag' },
      'the import landed in a profile revision, so it survived the close',
    );
  } finally {
    reopened.close();
  }
});

/**
 * The one-way move out of the app-state file, for projects configured by a
 * build that had nowhere else to put it.
 */
test('a config left in the app-state file is copied into the project once', async () => {
  const projectPathHere = join(workDir, 'Legacy.matchline');
  const legacyUserData = join(workDir, 'legacy-userdata');

  const creator = createProjectService({ userDataDir: legacyUserData, appVersion: '0.6.0' });
  try {
    creator.create(projectPathHere, 'Legacy');
  } finally {
    creator.close();
  }

  // Exactly what an older build's state file looked like: recents, the hash
  // index, and the screens 6-7 sections keyed by project path.
  const statePath = join(legacyUserData, 'app-state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  const legacyConfig = {
    hierarchy: FULL_PROFILE_PATCH.hierarchy,
    roleGraph: FULL_PROFILE_PATCH.roleGraph,
    ladder: FULL_PROFILE_PATCH.ladder,
    ssmDisciplineProjection: FULL_PROFILE_PATCH.ssmDisciplineProjection,
    parentTagProperty: FULL_PROFILE_PATCH.parentTagProperty,
  };
  /** The same sections as the profile carries them once the merge has run. */
  const asProfileSections = (draft) => ({
    hierarchy: draft.hierarchy,
    roleGraph: draft.roleGraph,
    ladder: draft.ladder,
    ssmDisciplineProjection: draft.ssmDisciplineProjection,
    parentTagProperty: draft.parentTagProperty,
  });
  state.projectConfigs = { [projectPathHere]: legacyConfig };
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

  const first = createProjectService({ userDataDir: legacyUserData, appVersion: '0.6.0' });
  try {
    const { notice } = await first.open(projectPathHere);
    assert.equal(notice.adoptedAppStateConfig, true, 'the copy is reported, not silent');
    // Not merged into a stored revision yet: this project never picked an
    // equipment tag property, so there is no publishable profile to write the
    // sections into. They are live in the draft and the rows stay where they
    // are, to be moved on the open after somebody completes screen 3 — deferring
    // is the honest answer, and destroying them would not be.
    assert.equal(notice.mergedLegacyConfig, false);
    // The legacy entry predates EXTO template capture, the derived attribute
    // registry (P0-7) and the assignment rules (P0-8), so it carries no key for
    // any of them. An absent key means "none captured, none defined", and the
    // schema's defaults are what say so — an older entry must still be adoptable.
    assert.deepEqual(first.config(), { extoTemplate: null }, 'only the project’s own layout');
    // The sections themselves went where they belong: into the profile.
    assert.deepEqual(asProfileSections(first.draftState().draft), legacyConfig);
  } finally {
    first.close();
  }

  // One-way: the state file no longer holds it, so there is only ever one copy.
  const after = JSON.parse(readFileSync(statePath, 'utf8'));
  assert.equal('projectConfigs' in after, false, 'the last entry took the key with it');
  assert.ok(Array.isArray(after.recentProjects), 'recents and the hash index stay');
  assert.ok(after.sourcePaths !== undefined);

  const second = createProjectService({ userDataDir: legacyUserData, appVersion: '0.6.0' });
  try {
    const { notice } = await second.open(projectPathHere);
    assert.equal(notice.adoptedAppStateConfig, false, 'there is nothing left to adopt');
    assert.equal(notice.mergedLegacyConfig, false, 'and nothing left to merge either');
    assert.deepEqual(
      asProfileSections(second.draftState().draft),
      legacyConfig,
      'and the project answers on its own now',
    );
  } finally {
    second.close();
  }
});

/**
 * The config→profile move, on a project that has a profile to move them into.
 *
 * A project written before SiteProfileV2 keeps the hierarchy, the role graph,
 * the ladder, the projection and the parent-tag property in its `config` table.
 * Opening it once moves them into a NEW profile revision — a revision, so the
 * one the last compile ran against is untouched — and only then clears the rows.
 */
test('a pre-v2 project moves its config sections into a new profile revision', async () => {
  const projectPathHere = join(workDir, 'PreV2.matchline');
  const userData = join(workDir, 'prev2-userdata');

  const creator = createProjectService({ userDataDir: userData, appVersion: '0.6.0' });
  try {
    creator.create(projectPathHere, 'Pre V2');
    // A publishable profile, saved the way a 0.8.1 build would have.
    creator.updateDraft({ propertyMappings: PROPERTY_MAPPINGS, tagAnatomy: DRAGON_ANATOMY });
    creator.saveProfile('as 0.8.1 wrote it');
  } finally {
    creator.close();
  }

  // The config table as that build left it: the five sections beside the profile.
  const statePath = join(userData, 'app-state.json');
  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  state.projectConfigs = {
    [projectPathHere]: {
      hierarchy: FULL_PROFILE_PATCH.hierarchy,
      roleGraph: FULL_PROFILE_PATCH.roleGraph,
      ladder: FULL_PROFILE_PATCH.ladder,
      ssmDisciplineProjection: FULL_PROFILE_PATCH.ssmDisciplineProjection,
      parentTagProperty: FULL_PROFILE_PATCH.parentTagProperty,
    },
  };
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);

  const opener = createProjectService({ userDataDir: userData, appVersion: '0.6.0' });
  let revisionAfterMerge = null;
  try {
    const { notice, project } = await opener.open(projectPathHere);
    assert.equal(notice.mergedLegacyConfig, true, 'the move is reported, not silent');
    const { draft } = opener.draftState();
    assert.deepEqual(draft.hierarchy, FULL_PROFILE_PATCH.hierarchy);
    assert.deepEqual(draft.ladder, FULL_PROFILE_PATCH.ladder);
    assert.deepEqual(draft.parentTagProperty, FULL_PROFILE_PATCH.parentTagProperty);
    assert.deepEqual(
      draft.propertyMappings.equipmentTag,
      PROPERTY_MAPPINGS.equipmentTag,
      'and the profile it merged into is still the profile',
    );
    revisionAfterMerge = project.savedRevision;
    assert.equal(revisionAfterMerge, 2, 'a new revision — the first one is untouched');
    // Only the project's own configuration is left in the table.
    assert.deepEqual(opener.config(), { extoTemplate: null });
  } finally {
    opener.close();
  }

  // Once is once: reopening finds nothing left to move and writes no revision.
  const again = createProjectService({ userDataDir: userData, appVersion: '0.6.0' });
  try {
    const { notice, project } = await again.open(projectPathHere);
    assert.equal(notice.mergedLegacyConfig, false);
    assert.equal(project.savedRevision, revisionAfterMerge, 'no second revision was written');
    assert.deepEqual(again.draftState().draft.hierarchy, FULL_PROFILE_PATCH.hierarchy);
  } finally {
    again.close();
  }
});

/**
 * The other half of the same migration: a package a 0.8.1 build exported.
 *
 * "v1 imports migrate, never refused" (RELEASE-1.0-PLAN). Written here as bytes
 * rather than produced by an API, because the shape being tested is one no
 * current code path can still write — which is exactly why it has to be pinned.
 */
test('a v1 profile package written by an older build imports and migrates', () => {
  const packagePath = join(workDir, 'legacy.matchline-profile.json');
  writeFileSync(
    packagePath,
    `${JSON.stringify(
      {
        formatVersion: 1,
        exportedAt: '2026-08-01T09:00:00.000Z',
        appVersion: '0.8.1',
        draft: {
          profileId: 'legacy-site',
          name: 'Legacy Site',
          version: 3,
          propertyMappings: {
            equipmentTag: { category: 'Dragon Data', name: 'Tag' },
            description: null,
            equipmentType: null,
            building: { category: 'Dragon Data', name: 'Building' },
            nativeDiscipline: null,
          },
          assetFilters: {
            includedClasses: [],
            excludedClasses: [],
            requireTagProperty: true,
            acceptedTagPatterns: [],
            selectionSetNames: [],
            includedSourceModelFiles: [],
            collapseComponents: false,
            separatelyCommissionableClasses: [],
          },
          tagAnatomy: {
            separators: ['-'],
            ignoredSuffixes: [],
            segments: [{ segment: 'role', extractor: { kind: 'alphaPrefix', token: 0 } }],
            familyKeyTemplate: '{system}-{token:1}-{token:2}',
            localFamilyTemplate: '',
          },
          systemResolver: {
            keyChain: [{ kind: 'tag-segment', segment: 'system' }],
            descriptionChain: [],
            normalization: [],
            conflictPolicy: 'review',
            labelTemplate: '',
          },
        },
        config: {
          hierarchy: FULL_PROFILE_PATCH.hierarchy,
          roleGraph: FULL_PROFILE_PATCH.roleGraph,
          ladder: FULL_PROFILE_PATCH.ladder,
          ssmDisciplineProjection: FULL_PROFILE_PATCH.ssmDisciplineProjection,
          parentTagProperty: FULL_PROFILE_PATCH.parentTagProperty,
        },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  const service = newService();
  try {
    service.create(join(workDir, 'ImportsV1.matchline'), 'Imports V1');
    const { draft } = service.importProfilePackage(packagePath);

    // The draft's own four sections.
    assert.deepEqual(draft.propertyMappings.equipmentTag, {
      category: 'Dragon Data',
      name: 'Tag',
    });
    assert.equal(draft.tagAnatomy.familyKeyTemplate, '{system}-{token:1}-{token:2}');
    // And the five that were in the config half, now sections of one profile.
    assert.deepEqual(draft.hierarchy, FULL_PROFILE_PATCH.hierarchy);
    assert.deepEqual(draft.roleGraph, FULL_PROFILE_PATCH.roleGraph);
    assert.deepEqual(draft.ladder, FULL_PROFILE_PATCH.ladder);
    assert.deepEqual(draft.ssmDisciplineProjection, FULL_PROFILE_PATCH.ssmDisciplineProjection);
    assert.deepEqual(draft.parentTagProperty, FULL_PROFILE_PATCH.parentTagProperty);
    // Sections a v1 package could not carry are present and empty, not missing.
    assert.deepEqual(draft.sourceAssignments, []);
    assert.deepEqual(draft.profileTestExamples, []);
    assert.equal(draft.stableIdProperty, null);

    // And it is publishable, which is the point of migrating rather than refusing.
    assert.ok(service.saveProfile('imported from a v1 package').revision > 0);
  } finally {
    service.close();
  }
});

test('a connectivity source whose file has gone is named, not skipped', async () => {
  const service = newService();
  try {
    const path = join(workDir, 'Missing.matchline');
    const movedPath = join(workDir, 'Moved-EasyPower.xlsx');
    writeFileSync(movedPath, easyPowerBytes());

    service.create(path, 'Missing');
    await service.addSources([cachePath, movedPath]);
    service.updateDraft({
      propertyMappings: PROPERTY_MAPPINGS,
      assetFilters: ASSET_FILTERS,
      tagAnatomy: DRAGON_ANATOMY,
      systemResolver: DRAGON_RESOLVER,
    });
    rmSync(movedPath);

    const status = await service.compile();
    assert.equal(status.state, 'failed');
    assert.match(status.reason, /Moved-EasyPower\.xlsx/);
    assert.match(status.reason, /cannot read/);
  } finally {
    service.close();
  }
});
