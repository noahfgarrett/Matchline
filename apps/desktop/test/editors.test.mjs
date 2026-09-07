import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import {
  DRAGON_SOURCE_MODEL_IDS,
  writeDragonFixtureSubset,
} from '@matchline/model-schema/fixtures/dragon';
import { writeWorkbook } from '@matchline/spreadsheet-import';

import { createProjectService } from '../dist/electron/services/project-session.js';
import { draftProfileSchema, profilePackageSchema } from '../dist/shared/schemas.js';

/**
 * The three editors owed from M4c (gate rows 5, 6 and 7), at the service and
 * wire level.
 *
 * Each of the three sections has travelled in the profile and been honoured by
 * the compiler since M4b; what this file proves is the other half — that a
 * decision made in an editor survives the whole round trip: draft → published
 * `SiteProfileV2` → stored revision → exported package v2 → imported draft.
 * A section that reaches the engine but cannot be written down, or that is
 * written down and narrowed on the way back, is not a shipped feature.
 *
 * ## The universe
 *
 * Two caches rather than one, because per-source overrides and source-model
 * assignment rules are both meaningless on a single file. `writeDragonFixtureSubset`
 * partitions Dragon by source model, so the mechanical cache holds
 * `Dragon-Mechanical.nwc` (51 objects, 24 tagged) and the controls cache holds
 * `Dragon-Controls.nwc` plus its appended `Dragon-Controls-PLC.nwc` (25 objects,
 * 10 tagged).
 */

const MECHANICAL_OBJECTS = 51;
const CONTROLS_OBJECTS = 25;

let workDir = '';
let mechanicalCache = '';
let controlsCache = '';
let melPath = '';
let userDataDir = '';

const MECHANICAL_SOURCE = 'model:dragon-mechanical.matchline-cache';
const CONTROLS_SOURCE = 'model:dragon-controls.matchline-cache';

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'matchline-editors-'));
  userDataDir = join(workDir, 'userData');
  mechanicalCache = join(workDir, 'Dragon-Mechanical.matchline-cache');
  controlsCache = join(workDir, 'Dragon-Controls.matchline-cache');
  melPath = join(workDir, 'Dragon-MEL.xlsx');

  writeDragonFixtureSubset(mechanicalCache, {
    sourceModels: [DRAGON_SOURCE_MODEL_IDS.mechanical],
    inputFileName: 'Dragon-Mechanical.nwd',
  });
  writeDragonFixtureSubset(controlsCache, {
    sourceModels: [DRAGON_SOURCE_MODEL_IDS.controls, DRAGON_SOURCE_MODEL_IDS.controlsPlc],
    inputFileName: 'Dragon-Controls.nwd',
  });

  writeFileSync(
    melPath,
    writeWorkbook([
      {
        name: 'MEL',
        aoa: [
          ['Equipment Tag', 'UPN', 'System Description'],
          ['MAH001-10-01', '001', 'Mechanical Dry Air Handling'],
          ['MAH002-10-01', '002', 'Mechanical Hot Water'],
          ['TIT603-10-01', '603', 'Temperature Instrumentation'],
        ],
      },
    ]),
  );
});

after(() => {
  if (workDir !== '') {
    rmSync(workDir, { recursive: true, force: true });
  }
});

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

const DRAGON_RESOLVER = {
  keyChain: [{ kind: 'tag-segment', segment: 'system' }],
  descriptionChain: [
    { kind: 'mel-lookup', joinBy: 'systemKey', returnField: 'systemDescription' },
  ],
  normalization: [{ kind: 'trim' }],
  conflictPolicy: 'review',
  labelTemplate: '',
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

function newService() {
  return createProjectService({ userDataDir, appVersion: '1.0.0' });
}

/** A project with both caches and the MEL, on the given file name. */
async function openTwoCacheProject(name) {
  const service = newService();
  service.create(join(workDir, `${name}.matchline`), name);
  await service.addSources([mechanicalCache, controlsCache, melPath]);
  return service;
}

test('a new draft folds unicode by default, so a pasted tag still matches', async () => {
  const service = await openTwoCacheProject('UnicodeFold');
  try {
    const draft = service.updateDraft({});
    assert.deepEqual(
      draft.identityConfig.tagNormalization,
      [{ kind: 'unicodeFold' }],
      'an en dash and a hyphen are not two different tags on any site',
    );
  } finally {
    service.close();
  }
});

/* ========================================================= gate row 5: chains */

test('a mapping is a chain with per-source overrides, all the way through', async () => {
  const service = await openTwoCacheProject('Chains');
  try {
    // The building is stated by `Dragon Data > Building` everywhere; the
    // controls model is told to read `Controls Data > Loop` instead, which it
    // really does carry. An override REPLACES, so the controls assets take
    // their building from Loop and not from Building.
    const draft = service.updateDraft({
      propertyMappings: {
        equipmentTag: {
          chain: [
            { category: 'Dragon Data', name: 'Tag' },
            { category: 'Item', name: 'Name' },
          ],
          bySource: [],
        },
        description: { chain: [{ category: 'Dragon Data', name: 'Manufacturer' }], bySource: [] },
        equipmentType: { chain: [], bySource: [] },
        building: {
          chain: [{ category: 'Dragon Data', name: 'Building' }],
          bySource: [
            { sourceId: CONTROLS_SOURCE, chain: [{ category: 'Controls Data', name: 'Loop' }] },
          ],
        },
        nativeDiscipline: { chain: [], bySource: [] },
        wbs: { chain: [], bySource: [] },
        itemMaster: { chain: [], bySource: [] },
        equipmentClassification: { chain: [], bySource: [] },
      },
      assetFilters: ASSET_FILTERS,
      tagAnatomy: DRAGON_ANATOMY,
      systemResolver: DRAGON_RESOLVER,
    });

    assert.equal(draft.propertyMappings.equipmentTag.chain.length, 2);
    assert.equal(draft.propertyMappings.building.bySource.length, 1);

    // The engine honours it: a controls asset's building is a loop name.
    const preview = service.assetPreview();
    assert.equal(preview.state, 'ready');
    const buildings = new Set(preview.samples.map((asset) => asset.building));
    assert.ok(buildings.size > 0);

    const revision = service.saveProfile('chains');
    assert.equal(revision.revision, 1);

    // Round-trip 1: the stored revision, rehydrated.
    const projectPath = service.current().path;
    service.close();

    const reopened = newService();
    try {
      const opened = await reopened.open(projectPath, false);
      assert.equal(opened.outcome, 'opened');
      const restored = reopened.draftState().draft;

      assert.deepEqual(restored.propertyMappings.equipmentTag.chain, [
        { category: 'Dragon Data', name: 'Tag' },
        { category: 'Item', name: 'Name' },
      ]);
      assert.deepEqual(restored.propertyMappings.building.bySource, [
        { sourceId: CONTROLS_SOURCE, chain: [{ category: 'Controls Data', name: 'Loop' }] },
      ]);

      // Round-trip 2: the exported package v2, and back into a new project.
      const packagePath = join(workDir, 'chains.matchline-profile.json');
      assert.equal(reopened.exportProfilePackage(packagePath).written, true);

      const parsed = profilePackageSchema.parse(
        JSON.parse(readFileSync(packagePath, 'utf8')),
      );
      assert.deepEqual(parsed.profile.propertyMappings.building.bySource, [
        { sourceId: CONTROLS_SOURCE, chain: [{ category: 'Controls Data', name: 'Loop' }] },
      ]);

      const importer = newService();
      try {
        importer.create(join(workDir, 'ChainsImported.matchline'), 'Chains Imported');
        const imported = importer.importProfilePackage(packagePath).draft;
        assert.deepEqual(
          imported.propertyMappings.equipmentTag.chain,
          restored.propertyMappings.equipmentTag.chain,
          'a chain survives export and import unchanged',
        );
        assert.deepEqual(
          imported.propertyMappings.building.bySource,
          restored.propertyMappings.building.bySource,
        );
      } finally {
        importer.close();
      }
    } finally {
      reopened.close();
    }
  } finally {
    service.close();
  }
});

test('a mapping written the old way still works, and lifts to a one-rung chain', async () => {
  const service = await openTwoCacheProject('LiftsOldDrafts');
  try {
    // Exactly what every build before this round wrote, and what a hand-edited
    // profile still writes. It must not be refused and must not be lost.
    const draft = service.updateDraft({
      propertyMappings: {
        equipmentTag: { category: 'Dragon Data', name: 'Tag' },
        description: null,
        equipmentType: null,
        building: { category: 'Dragon Data', name: 'Building' },
        nativeDiscipline: null,
      },
      assetFilters: ASSET_FILTERS,
    });

    assert.deepEqual(draft.propertyMappings.equipmentTag, {
      chain: [{ category: 'Dragon Data', name: 'Tag' }],
      bySource: [],
    });
    assert.deepEqual(
      draft.propertyMappings.description,
      { chain: [], bySource: [] },
      'a null mapping becomes the empty chain, which means the same thing',
    );
    assert.equal(service.assetPreview().state, 'ready', 'and the engine reads it');
  } finally {
    service.close();
  }
});

test('the wire schema lifts every older spelling of a mapping', () => {
  const lifted = draftProfileSchema.parse({
    profileId: 'old',
    name: 'Old',
    version: 1,
    propertyMappings: {
      equipmentTag: { category: 'Dragon Data', name: 'Tag' },
      description: null,
      equipmentType: null,
      building: null,
      nativeDiscipline: null,
      // wbs, itemMaster and equipmentClassification absent entirely: a draft
      // written before those three fields existed has no key for them.
    },
    assetFilters: ASSET_FILTERS,
    tagAnatomy: DRAGON_ANATOMY,
    systemResolver: DRAGON_RESOLVER,
  });

  assert.deepEqual(lifted.propertyMappings.equipmentTag, {
    chain: [{ category: 'Dragon Data', name: 'Tag' }],
    bySource: [],
  });
  assert.deepEqual(lifted.propertyMappings.wbs, { chain: [], bySource: [] });
});

/* ================================== the PropertyPicker regression (M4c bug) */

test('a mapping the loaded model does not carry is kept, not silently cleared', async () => {
  const service = await openTwoCacheProject('MappedButAbsent');
  try {
    const absent = { category: 'Legacy Data', name: 'Asset Number' };

    service.updateDraft({
      propertyMappings: {
        equipmentTag: { chain: [{ category: 'Dragon Data', name: 'Tag' }], bySource: [] },
        description: { chain: [absent], bySource: [] },
        equipmentType: { chain: [], bySource: [] },
        building: { chain: [], bySource: [] },
        nativeDiscipline: { chain: [], bySource: [] },
        wbs: { chain: [], bySource: [] },
        itemMaster: { chain: [], bySource: [] },
        equipmentClassification: { chain: [], bySource: [] },
      },
      assetFilters: ASSET_FILTERS,
      stableIdProperty: absent,
    });

    // Nothing in the catalog carries it — this is the state the picker used to
    // render as "Not mapped".
    const page = service.propertyPage({
      offset: 0,
      limit: 500,
      sortBy: 'coverage',
      descending: true,
      search: '',
    });
    assert.ok(
      !page.rows.some((row) => row.category === absent.category && row.name === absent.name),
      'the property really is absent from the loaded sources',
    );

    // An unrelated edit — the kind of interaction that used to erase it.
    service.updateDraft({ assetFilters: { ...ASSET_FILTERS, collapseComponents: true } });
    let draft = service.draftState().draft;
    assert.deepEqual(draft.propertyMappings.description.chain, [absent]);
    assert.deepEqual(draft.stableIdProperty, absent);

    // Editing a DIFFERENT mapping must not touch it either.
    service.updateDraft({
      propertyMappings: {
        ...draft.propertyMappings,
        building: { chain: [{ category: 'Dragon Data', name: 'Building' }], bySource: [] },
      },
    });
    draft = service.draftState().draft;
    assert.deepEqual(draft.propertyMappings.description.chain, [absent]);

    // And it survives being published and read back, because a profile outlives
    // any one model.
    service.updateDraft({ tagAnatomy: DRAGON_ANATOMY, systemResolver: DRAGON_RESOLVER });
    service.saveProfile('absent mapping kept');
    const projectPath = service.current().path;
    service.close();

    const reopened = newService();
    try {
      await reopened.open(projectPath, false);
      const restored = reopened.draftState().draft;
      assert.deepEqual(restored.propertyMappings.description.chain, [absent]);
      assert.deepEqual(restored.stableIdProperty, absent);
    } finally {
      reopened.close();
    }
  } finally {
    service.close();
  }
});

/* ================== the approved Exto vocabulary, through the draft (layer 2) */

/**
 * The two approved-list rungs and the I&C flag, stored and read back.
 *
 * A rung the wizard can build and the store cannot keep is a rung nobody can
 * use twice, so the round-trip is the test that matters: draft → published
 * revision → reopened project, with `descriptionProperty: null` surviving as a
 * decision rather than collapsing into an absent key on the way through.
 */
const APPROVED_LIST_RESOLVER = {
  keyChain: [{ kind: 'upn-from-tag' }, { kind: 'tag-segment', segment: 'system' }],
  descriptionChain: [
    { kind: 'exto-system-name', allowUniqueUpn: true, descriptionProperty: null },
    {
      kind: 'exto-system-name',
      allowUniqueUpn: false,
      descriptionProperty: { category: 'Dragon Data', name: 'System' },
    },
    { kind: 'mel-lookup', joinBy: 'systemKey', returnField: 'systemDescription' },
  ],
  normalization: [{ kind: 'trim' }],
  conflictPolicy: 'review',
  labelTemplate: '',
  applyIcDisciplineRule: true,
};

test('the approved-list rungs and the I&C flag round-trip through a revision', async () => {
  const service = await openTwoCacheProject('ApprovedList');
  try {
    teachDragon(service);
    service.updateDraft({ systemResolver: APPROVED_LIST_RESOLVER });

    assert.deepEqual(
      service.draftState().draft.systemResolver,
      APPROVED_LIST_RESOLVER,
      'the draft keeps what the editor built',
    );

    service.saveProfile('approved list');
    const projectPath = service.current().path;
    service.close();

    const reopened = newService();
    try {
      await reopened.open(projectPath, false);
      assert.deepEqual(
        reopened.draftState().draft.systemResolver,
        APPROVED_LIST_RESOLVER,
        'and so does the revision it was published as',
      );
    } finally {
      reopened.close();
    }
  } finally {
    service.close();
  }
});

test('a draft written before the I&C rule existed reads back with it off', () => {
  const lifted = draftProfileSchema.parse({
    profileId: 'old',
    name: 'Old',
    version: 1,
    propertyMappings: { equipmentTag: { category: 'Dragon Data', name: 'Tag' } },
    assetFilters: ASSET_FILTERS,
    tagAnatomy: DRAGON_ANATOMY,
    systemResolver: DRAGON_RESOLVER,
  });

  assert.equal(
    lifted.systemResolver.applyIcDisciplineRule,
    false,
    'a rule that moves assets between systems does not switch itself on under a published site',
  );
});

/* ============================== gate row 7: the derived-attribute registry */

test('a derived attribute previews over the real universe before it is saved', async () => {
  const service = await openTwoCacheProject('Derived');
  try {
    teachDragon(service);

    const preview = service.derivedPreview({
      attributeId: 'turnover-package',
      displayName: 'Turnover Package',
      resolverChain: [
        // Nothing carries this, so the first rung answers for nobody and the
        // second one answers for everybody — which is what a fallback IS.
        { kind: 'model-property', chain: [{ category: 'Dragon Data', name: 'Package' }] },
        { kind: 'tag-segment', segment: 'unit' },
      ],
    });

    assert.equal(preview.state, 'ready');
    assert.equal(preview.assetCount, 34);
    assert.equal(preview.resolvedCount, 34);
    assert.equal(preview.coverage, 1);
    assert.equal(preview.distinctValueCount, 2, 'the unit segment is 10 or 20');

    assert.equal(preview.rungUsage[0].wonCount, 0, 'the missing property answered for nobody');
    assert.equal(preview.rungUsage[0].claimCount, 0);
    assert.equal(preview.rungUsage[1].wonCount, 34, 'the tag segment answered for everybody');
    assert.match(preview.rungUsage[1].label, /Tag segment "unit"/);
    assert.equal(preview.samples[0].value, '10');
    assert.deepEqual(preview.unresolvedExamples, []);
  } finally {
    service.close();
  }
});

test('missing stays missing: a chain nothing answers leaves the field off', async () => {
  const service = await openTwoCacheProject('DerivedMissing');
  try {
    teachDragon(service);

    const preview = service.derivedPreview({
      attributeId: 'nowhere',
      displayName: 'Nowhere',
      resolverChain: [
        { kind: 'model-property', chain: [{ category: 'Nothing', name: 'At All' }] },
      ],
    });

    assert.equal(preview.state, 'ready');
    assert.equal(preview.resolvedCount, 0);
    assert.equal(preview.coverage, 0);
    assert.equal(preview.distinctValueCount, 0, 'no default value was invented');
    assert.ok(preview.unresolvedExamples.length > 0, 'and the assets without one are named');
  } finally {
    service.close();
  }
});

test('an empty chain is blocked rather than reported as zero coverage', async () => {
  const service = await openTwoCacheProject('DerivedEmpty');
  try {
    teachDragon(service);
    const preview = service.derivedPreview({
      attributeId: 'unfinished',
      displayName: 'Unfinished',
      resolverChain: [],
    });
    assert.equal(preview.state, 'blocked');
    assert.match(preview.reason, /Add at least one source/);
  } finally {
    service.close();
  }
});

test('a system-field rung reads what the System Resolver settled on', async () => {
  const service = await openTwoCacheProject('DerivedSystem');
  try {
    teachDragon(service);
    const preview = service.derivedPreview({
      attributeId: 'system-label',
      displayName: 'System label',
      resolverChain: [{ kind: 'system-field', field: 'systemKey' }],
    });

    assert.equal(preview.state, 'ready');
    assert.equal(preview.resolvedCount, 34);
    assert.equal(preview.distinctValueCount, 3, 'Dragon has three systems: 001, 002 and 603');
  } finally {
    service.close();
  }
});

test('a derived attribute round-trips through the draft, the profile and a package', async () => {
  const service = await openTwoCacheProject('DerivedRoundTrip');
  try {
    teachDragon(service);
    const definition = {
      attributeId: 'turnover-package',
      displayName: 'Turnover Package',
      resolverChain: [
        { kind: 'model-property', chain: [{ category: 'Dragon Data', name: 'UPN' }] },
        { kind: 'tag-segment', segment: 'unit' },
        { kind: 'source-assignment', key: 'package' },
        { kind: 'composite', template: '{segment:system}-{segment:unit}' },
        { kind: 'manual', assignments: [{ assetId: 'tag:MAH001-10-01', value: 'P1' }] },
      ],
    };
    service.updateDraft({ derivedAttributes: [definition] });
    service.saveProfile('derived');

    // The Composer offers it beside the built-ins — the reason it exists.
    assert.ok(
      service.attributeChoices().some((choice) => choice.attributeKey === 'turnover-package'),
    );

    const packagePath = join(workDir, 'derived.matchline-profile.json');
    assert.equal(service.exportProfilePackage(packagePath).written, true);

    const importer = newService();
    try {
      importer.create(join(workDir, 'DerivedImported.matchline'), 'Derived Imported');
      const imported = importer.importProfilePackage(packagePath).draft;
      assert.deepEqual(
        imported.derivedAttributes,
        [definition],
        'every rung kind survives, the hand-assigned table included',
      );
    } finally {
      importer.close();
    }
  } finally {
    service.close();
  }
});

/* ============================ gate row 6: the source-assignment rules editor */

test('a filename-pattern rule reports which documents it hits, and what $1 became', async () => {
  const service = await openTwoCacheProject('Assignments');
  try {
    const preview = service.assignmentPreview({
      scope: 'filename-pattern',
      match: 'Dragon-*.nwc',
      assign: { building: '', nativeDiscipline: '$1', custom: [] },
    });

    assert.equal(preview.state, 'ready');
    assert.equal(preview.universeObjectCount, MECHANICAL_OBJECTS + CONTROLS_OBJECTS);

    const byFile = new Map(
      preview.matches.map((match) => [match.sourceModelFile, match]),
    );
    assert.deepEqual(
      [...byFile.keys()].sort(),
      ['Dragon-Controls-PLC.nwc', 'Dragon-Controls.nwc', 'Dragon-Mechanical.nwc'],
      'the pattern reaches every source model, appended ones included',
    );
    assert.equal(byFile.get('Dragon-Mechanical.nwc').capture, 'Mechanical');
    assert.equal(byFile.get('Dragon-Controls.nwc').capture, 'Controls');

    // `assigned` expands `$1` against the FIRST match, and matches are walked in
    // source-id order — `model:dragon-controls…` before `model:dragon-mechanical…`
    // — so the value shown is the controls one. Showing a value rather than the
    // pattern is the point; which document it came from is stated in the table
    // beside it.
    assert.deepEqual(preview.assigned, [{ field: 'Discipline', value: 'Controls' }]);
    assert.equal(preview.matches[0].sourceId, CONTROLS_SOURCE);
  } finally {
    service.close();
  }
});

test('a rule that matches nothing says so, and names what it could have matched', async () => {
  const service = await openTwoCacheProject('AssignmentsMiss');
  try {
    const preview = service.assignmentPreview({
      scope: 'filename-pattern',
      match: 'Dragon-*.nwd',
      assign: { building: 'B14', nativeDiscipline: '', custom: [] },
    });

    assert.equal(preview.state, 'ready');
    assert.equal(preview.matches.length, 0);
    assert.equal(preview.matchedObjectCount, 0);
    assert.equal(preview.problem, '', 'a miss is a typo, not a refusal');
    assert.ok(preview.candidates.includes('Dragon-Mechanical.nwc'));
  } finally {
    service.close();
  }
});

test('a pattern the engine would refuse is refused here, in the same words', async () => {
  const service = await openTwoCacheProject('AssignmentsBadPattern');
  try {
    const two = service.assignmentPreview({
      scope: 'filename-pattern',
      match: 'Dragon-*-*.nwc',
      assign: { building: 'B14', nativeDiscipline: '', custom: [] },
    });
    assert.equal(two.state, 'ready');
    assert.match(two.problem, /exactly one \*/);

    const none = service.assignmentPreview({
      scope: 'filename-pattern',
      match: 'Dragon.nwc',
      assign: { building: 'B14', nativeDiscipline: '', custom: [] },
    });
    assert.match(none.problem, /exactly one \*/);
  } finally {
    service.close();
  }
});

test('the three scopes match at three different strengths', async () => {
  const service = await openTwoCacheProject('AssignmentScopes');
  try {
    const bySourceModel = service.assignmentPreview({
      scope: 'source-model',
      match: 'Dragon-Mechanical.nwc',
      assign: { building: 'B14', nativeDiscipline: '', custom: [] },
    });
    assert.equal(bySourceModel.matches.length, 1);
    assert.equal(bySourceModel.matchedObjectCount, MECHANICAL_OBJECTS);

    const bySource = service.assignmentPreview({
      scope: 'logical-source',
      match: CONTROLS_SOURCE,
      assign: { building: 'B15', nativeDiscipline: '', custom: [] },
    });
    assert.equal(
      bySource.matchedObjectCount,
      CONTROLS_OBJECTS,
      'a logical source is the whole file, appended models included',
    );

    const byName = service.assignmentPreview({
      scope: 'logical-source',
      match: 'Dragon-Controls.nwc',
      assign: { building: 'B15', nativeDiscipline: '', custom: [] },
    });
    assert.equal(byName.matches.length, 0, 'a logical source is never named by a file name');
  } finally {
    service.close();
  }
});

test('an assignment rule round-trips, and its custom key feeds a derived attribute', async () => {
  const service = await openTwoCacheProject('AssignmentRoundTrip');
  try {
    teachDragon(service);
    const rule = {
      scope: 'filename-pattern',
      match: 'Dragon-*.nwc',
      assign: {
        building: '',
        nativeDiscipline: '$1',
        custom: [{ key: 'package', value: 'PKG-$1' }],
      },
    };
    service.updateDraft({
      sourceAssignments: [rule],
      derivedAttributes: [
        {
          attributeId: 'turnover-package',
          displayName: 'Turnover Package',
          resolverChain: [{ kind: 'source-assignment', key: 'package' }],
        },
      ],
    });

    service.saveProfile('assignments');
    const packagePath = join(workDir, 'assignments.matchline-profile.json');
    assert.equal(service.exportProfilePackage(packagePath).written, true);

    const importer = newService();
    try {
      importer.create(join(workDir, 'AssignImported.matchline'), 'Assign Imported');
      const imported = importer.importProfilePackage(packagePath).draft;
      assert.deepEqual(imported.sourceAssignments, [rule]);
    } finally {
      importer.close();
    }

    // And the compile honours both, which is what the two sections are for.
    const compiled = await service.compile();
    assert.equal(compiled.state, 'done');
  } finally {
    service.close();
  }
});

/** Screens 3-5, taught the way the Dragon fixture wants them. */
function teachDragon(service) {
  service.updateDraft({
    propertyMappings: {
      equipmentTag: { chain: [{ category: 'Dragon Data', name: 'Tag' }], bySource: [] },
      description: { chain: [{ category: 'Dragon Data', name: 'Manufacturer' }], bySource: [] },
      equipmentType: { chain: [{ category: 'Item', name: 'Type' }], bySource: [] },
      building: { chain: [{ category: 'Dragon Data', name: 'Building' }], bySource: [] },
      nativeDiscipline: { chain: [], bySource: [] },
      wbs: { chain: [], bySource: [] },
      itemMaster: { chain: [], bySource: [] },
      equipmentClassification: { chain: [], bySource: [] },
    },
    assetFilters: ASSET_FILTERS,
    tagAnatomy: DRAGON_ANATOMY,
    systemResolver: DRAGON_RESOLVER,
  });
}
