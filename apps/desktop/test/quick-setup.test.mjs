import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import {
  DRAGON_SOURCE_MODEL_IDS,
  writeDragonFixtureSubset,
} from '@matchline/model-schema/fixtures/dragon';
import { writeRevitShapedFixture } from '@matchline/model-schema/fixtures/revit';
import { writeWorkbook } from '@matchline/spreadsheet-import';

import { starterProfile } from '../dist/shared/starter-profile.js';
import { createProjectService } from '../dist/electron/services/project-session.js';

/**
 * The Quick Setup path, headless, over the two-cache Dragon project
 * (RELEASE-1.0-PLAN "One-hour UX").
 *
 * The GUI walk is the CDP pass; this is the part of it that can be asserted.
 * It runs the same main-process service the Quick Setup screens call, in the
 * same order they call it — suggest, accept, suggest again — and then asks the
 * two questions that decide whether the path is real:
 *
 * 1. **Does accepting every suggestion produce a publishable profile?** If the
 *    fast path leaves a draft that cannot be saved, it is a demo.
 * 2. **Does that profile compile?** A profile that saves and then fails at
 *    screen 8 has moved the problem, not solved it.
 *
 * It also pins the rule the whole path rests on: *nothing is written until a
 * person accepts*. `setup:suggest` is called first and the draft is checked to
 * be untouched afterwards.
 */

let workDir = '';
let mechanicalCache = '';
let controlsCache = '';
let melPath = '';
let userDataDir = '';
let projectSeq = 0;

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'matchline-quick-'));
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

async function newQuickProject() {
  projectSeq += 1;
  const service = createProjectService({ userDataDir, appVersion: '1.0.0' });
  service.create(join(workDir, `Quick${String(projectSeq)}.matchline`), `Quick ${String(projectSeq)}`);
  await service.addSources([mechanicalCache, controlsCache, melPath]);
  return service;
}

/**
 * Step 1 of the path: accept the top candidate of every strong field.
 *
 * The same patch `QuickSetup.tsx` builds, in the same shape: a mapped field
 * becomes the first rung of its chain, and a field with no standard slot becomes
 * a one-rung derived attribute.
 */
function acceptFields(service, suggestions) {
  const draft = service.draftState().draft;
  const mappings = { ...draft.propertyMappings };
  const derived = [...draft.derivedAttributes];
  let parentTagProperty = draft.parentTagProperty;
  let stableIdProperty = draft.stableIdProperty;

  for (const field of suggestions.fields) {
    const candidate = field.candidates[0];
    if (candidate === undefined || field.confidence !== 'strong') {
      continue;
    }
    switch (field.target.kind) {
      case 'mapped-field':
        mappings[field.target.field] = {
          chain: [candidate.property, ...mappings[field.target.field].chain],
          bySource: mappings[field.target.field].bySource,
        };
        break;
      case 'parent-tag':
        parentTagProperty = candidate.property;
        break;
      case 'stable-id':
        stableIdProperty = candidate.property;
        break;
      case 'derived-attribute':
        derived.push({
          attributeId: field.target.attributeId,
          displayName: field.label,
          resolverChain: [{ kind: 'model-property', chain: [candidate.property] }],
        });
        break;
      default:
        throw new Error(`unhandled target ${JSON.stringify(field.target)}`);
    }
  }

  return service.updateDraft({
    propertyMappings: mappings,
    derivedAttributes: derived,
    parentTagProperty,
    stableIdProperty,
  });
}

test('suggestions are computed without touching the draft', async () => {
  const service = await newQuickProject();
  try {
    const before = JSON.stringify(service.draftState().draft);
    const suggestions = service.quickSetupSuggestions();

    assert.equal(suggestions.ready, true);
    assert.equal(suggestions.objectCount, 76, 'both caches, as one universe');
    assert.equal(suggestions.sourceCount, 2);
    assert.ok(suggestions.fields.length > 0);

    assert.equal(
      JSON.stringify(service.draftState().draft),
      before,
      'nothing is published, ever, by asking what Matchline would suggest',
    );
  } finally {
    service.close();
  }
});

test('the whole path: accept everything, publish, compile', async () => {
  const service = await newQuickProject();
  try {
    /* --- step 1: which property is which ------------------------------- */
    const first = service.quickSetupSuggestions();
    const tagField = first.fields.find(
      (field) => field.target.kind === 'mapped-field' && field.target.field === 'equipmentTag',
    );
    assert.equal(tagField.confidence, 'strong');
    assert.deepEqual(tagField.candidates[0].property, { category: 'Dragon Data', name: 'Tag' });

    let draft = acceptFields(service, first);
    assert.deepEqual(draft.propertyMappings.equipmentTag.chain, [
      { category: 'Dragon Data', name: 'Tag' },
    ]);
    assert.ok(
      draft.derivedAttributes.some((entry) => entry.attributeId === 'manufacturer'),
      'a field with no standard slot became a derived attribute (P0-7)',
    );

    // The impact is real the moment the tag is accepted, which is what the
    // right-hand column of the screen shows.
    const impact = service.assetPreview();
    assert.equal(impact.state, 'ready');
    assert.equal(impact.finalAssetCount, 34);

    /* --- step 2: the tag anatomy ---------------------------------------- */
    const second = service.quickSetupSuggestions();
    assert.ok(second.anatomy !== null, 'inferred from the tags step 1 made readable');
    assert.equal(second.anatomy.coverage, 1);
    draft = service.updateDraft({ tagAnatomy: second.anatomy.anatomy });
    assert.equal(draft.tagAnatomy.segments.length, 4);

    /* --- step 3: a System Resolver starter template ---------------------- */
    const third = service.quickSetupSuggestions();
    const tagAndMel = third.resolverTemplates.find(
      (template) => template.templateId === 'tag-and-mel',
    );
    assert.equal(tagAndMel.available, true, 'the anatomy and the MEL are both here now');

    const templatePreview = service.resolverTemplatePreview(tagAndMel.resolver);
    assert.equal(templatePreview.state, 'ready');
    assert.equal(templatePreview.resolvedCount, 34);
    assert.equal(templatePreview.distinctSystemCount, 3);
    assert.equal(
      service.draftState().draft.systemResolver.keyChain.length,
      0,
      'previewing a template does not write it',
    );

    draft = service.updateDraft({ systemResolver: tagAndMel.resolver });

    /* --- step 4: what counts as equipment -------------------------------- */
    const fourth = service.quickSetupSuggestions();
    const byClass = new Map(fourth.classes.map((entry) => [entry.className, entry]));
    assert.equal(byClass.get('Equipment').proposal, 'include');
    assert.equal(byClass.get('Equipment').taggedCount, 34);
    assert.equal(byClass.get('Solid').proposal, 'exclude');
    assert.equal(byClass.get('Solid').taggedCount, 0);

    draft = service.updateDraft({
      assetFilters: {
        ...draft.assetFilters,
        includedClasses: fourth.classes
          .filter((entry) => entry.proposal === 'include')
          .map((entry) => entry.className)
          .sort(),
        excludedClasses: fourth.classes
          .filter((entry) => entry.proposal === 'exclude')
          .map((entry) => entry.className)
          .sort(),
      },
    });

    /* --- step 5: the level stack ----------------------------------------- */
    const fifth = service.quickSetupSuggestions();
    assert.deepEqual(
      fifth.hierarchy.levels.map((level) => [level.displayName, level.boundary]),
      [
        ['Building', true],
        ['SSM Discipline', false],
        ['System', true],
      ],
      'the P0-5 preset, sent from main so the screen never restates it',
    );
    draft = service.updateDraft({ hierarchy: fifth.hierarchy });

    /* --- and the two questions that matter -------------------------------- */
    const saved = service.saveProfile('quick setup');
    assert.equal(saved.revision, 1, 'the draft is publishable');

    const compiled = await service.compile();
    assert.equal(compiled.state, 'done', 'and it compiles');
    assert.equal(compiled.summary.assetCount, 34);
    assert.equal(compiled.summary.resolvedSystemCount, 34);
    assert.equal(compiled.summary.missingSystemCount, 0);
  } finally {
    service.close();
  }
});

test('every available starter template compiles this project', async () => {
  const service = await newQuickProject();
  try {
    acceptFields(service, service.quickSetupSuggestions());
    const inferred = service.quickSetupSuggestions().anatomy;
    service.updateDraft({ tagAnatomy: inferred.anatomy });

    const templates = service.quickSetupSuggestions().resolverTemplates;
    assert.equal(templates.length, 7);

    for (const template of templates) {
      if (!template.available) {
        assert.notEqual(template.unavailableReason, '', `${template.templateId} explains itself`);
        continue;
      }
      service.updateDraft({ systemResolver: template.resolver });
      const compiled = await service.compile();
      assert.equal(
        compiled.state,
        'done',
        `${template.templateId} produced a profile that does not compile`,
      );
    }
  } finally {
    service.close();
  }
});

test('a project with no model says so rather than suggesting nothing quietly', () => {
  const service = createProjectService({ userDataDir, appVersion: '1.0.0' });
  try {
    service.create(join(workDir, 'Empty.matchline'), 'Empty');
    const suggestions = service.quickSetupSuggestions();

    assert.equal(suggestions.ready, false);
    assert.match(suggestions.blockedReason, /Add a model on screen 1/);
    assert.deepEqual(suggestions.fields, []);
    assert.equal(suggestions.anatomy, null);
    assert.equal(
      suggestions.hierarchy.levels.length,
      3,
      'the level preset is not read out of the model, so it is still offered',
    );
  } finally {
    service.close();
  }
});

test('Quick Setup and the numbered screens edit one draft, not two', async () => {
  const service = await newQuickProject();
  try {
    acceptFields(service, service.quickSetupSuggestions());

    // What screen 3 would render, read back through the same service the
    // wizard's `profile:draft` channel calls.
    const draft = service.draftState().draft;
    assert.deepEqual(draft.propertyMappings.equipmentTag.chain, [
      { category: 'Dragon Data', name: 'Tag' },
    ]);
    assert.deepEqual(draft.propertyMappings.building.chain, [
      { category: 'Dragon Data', name: 'Building' },
    ]);

    // And an edit made the "advanced" way lands in the same place — here, a
    // fallback rung appended to the chain Quick Setup started.
    const edited = service.updateDraft({
      propertyMappings: {
        ...draft.propertyMappings,
        equipmentTag: {
          chain: [...draft.propertyMappings.equipmentTag.chain, { category: 'Item', name: 'Name' }],
          bySource: [],
        },
      },
    });
    assert.equal(edited.propertyMappings.equipmentTag.chain.length, 2);
  } finally {
    service.close();
  }
});

/* ======================================= the Revit-shaped project (WP8, B3) */

/**
 * The same path over a model the engine was not written for.
 *
 * This is the audit's blocker B3 stated as a test. B3 is: with the shipped
 * default profile, Building and System are hard boundaries, nothing states
 * either, and every asset becomes a root under `(unassigned)` while the compile
 * reports success. The Dragon walk above cannot catch it — Dragon states both.
 *
 * So: take a Revit federation with no building property anywhere, accept every
 * suggestion the way the screens do, and ask the one question that decides
 * whether the fast path produced a register or a flat list.
 */

let revitCache = '';

before(() => {
  revitCache = join(workDir, 'Campus.matchline-cache');
  writeRevitShapedFixture(revitCache);
});

async function newRevitProject() {
  projectSeq += 1;
  const service = createProjectService({ userDataDir, appVersion: '1.0.0' });
  service.create(
    join(workDir, `Revit${String(projectSeq)}.matchline`),
    `Revit ${String(projectSeq)}`,
  );
  await service.addSources([revitCache]);
  return service;
}

/** Every Quick Setup step, accepted in the order the screens run them. */
function acceptEverything(service) {
  // Step 1 — fields, plus the starter rule set the screen merges with them.
  const fields = service.quickSetupSuggestions();
  service.updateDraft(starterProfile());
  acceptFields(service, fields);

  // Step 2 — the tag shape.
  const anatomy = service.quickSetupSuggestions().anatomy;
  if (anatomy !== null) {
    service.updateDraft({ tagAnatomy: anatomy.anatomy });
  }

  // Step 3 — the first available resolver template, which is what the screen
  // pre-selects.
  const templates = service.quickSetupSuggestions().resolverTemplates;
  const template = templates.find((entry) => entry.available);
  service.updateDraft({ systemResolver: template.resolver });

  // Step 4 — the class lists.
  const classes = service.quickSetupSuggestions().classes;
  service.updateDraft({
    assetFilters: {
      ...service.draftState().draft.assetFilters,
      includedClasses: classes
        .filter((entry) => entry.proposal === 'include')
        .map((entry) => entry.className)
        .sort(),
      excludedClasses: classes
        .filter((entry) => entry.proposal === 'exclude')
        .map((entry) => entry.className)
        .sort(),
    },
  });

  // Step 5 — the file-name rules.
  const assignments = service.quickSetupSuggestions().sourceAssignments;
  service.updateDraft({
    sourceAssignments: [
      ...service.draftState().draft.sourceAssignments,
      ...assignments.map((entry) => entry.rule),
    ],
  });

  // Step 6 — the role pairings, through the starter profile, which is the only
  // way a role rule ever enters a draft here.
  const rolePairs = service.quickSetupSuggestions().rolePairs;
  service.updateDraft(
    starterProfile(
      rolePairs.map((pair) => ({ parentRole: pair.parentRole, childRole: pair.childRole })),
    ),
  );

  // Step 7 — the stack, with the boundary flags this project earned.
  const last = service.quickSetupSuggestions();
  service.updateDraft({ hierarchy: last.hierarchy });
  return last;
}

test('the Revit path: a building nobody stated, read off the file names', async () => {
  const service = await newRevitProject();
  try {
    const first = service.quickSetupSuggestions();

    const building = first.fields.find(
      (field) => field.target.kind === 'mapped-field' && field.target.field === 'building',
    );
    assert.equal(
      building.confidence,
      'possible',
      'Workset and Level are guesses, so accept-all leaves the building unmapped',
    );

    assert.deepEqual(
      first.sourceAssignments.map((entry) => [
        entry.rule.match,
        entry.rule.assign.building,
        entry.matchedFileCount,
        entry.matchedObjectCount,
      ]),
      [
        ['B14-*', 'B14', 3, 140],
        ['B22-*', 'B22', 1, 40],
      ],
    );

    // Before the tag is accepted there are no assets, and the projection says
    // so rather than reporting a site with nothing missing.
    assert.equal(first.hierarchyProjection.state, 'blocked');

    const last = acceptEverything(service);

    assert.equal(last.hierarchyProjection.state, 'ready');
    assert.deepEqual(
      last.hierarchyProjection.levels.map((level) => [
        level.displayName,
        level.distinctValueCount,
        level.assetsWithoutValue,
      ]),
      [
        ['Building', 2, 0],
        ['SSM Discipline', 1, 12],
        ['System', 8, 0],
      ],
      'two buildings, nobody without one, and eight systems — none of it stated by a property; ' +
        'the one discipline is I&C, which only the controls package states',
    );
    assert.deepEqual(
      last.hierarchy.levels.map((level) => [level.displayName, level.boundary]),
      [
        ['Building', true],
        ['SSM Discipline', false],
        ['System', true],
      ],
      'both boundaries survive, because this project can state both',
    );
    assert.deepEqual(
      last.hierarchyNotes.map((note) => [note.levelId, note.kept]),
      [
        ['building', true],
        ['system', true],
      ],
    );
    assert.match(last.hierarchyNotes[0].note, /Building stays structural/);
  } finally {
    service.close();
  }
});

test('the anatomy and the resolver agree that the system is not in the mark', async () => {
  const service = await newRevitProject();
  try {
    acceptFields(service, service.quickSetupSuggestions());
    const second = service.quickSetupSuggestions();

    assert.deepEqual(second.anatomy.anatomy.segments, [
      { segment: 'role', extractor: { kind: 'alphaPrefix', token: 0 } },
    ]);
    service.updateDraft({ tagAnatomy: second.anatomy.anatomy });

    const templates = service.quickSetupSuggestions().resolverTemplates;
    const byId = new Map(templates.map((template) => [template.templateId, template]));

    assert.equal(
      byId.get('tag-and-mel').available,
      false,
      'no system segment was taught, so the tag cannot be asked for one',
    );
    assert.match(byId.get('tag-and-mel').unavailableReason, /system.*segment/i);
    assert.equal(byId.get('composite').available, false);

    const modelField = byId.get('model-field');
    assert.equal(modelField.available, true);
    assert.deepEqual(modelField.resolver.keyChain, [
      { kind: 'model-field', property: { category: 'Element', name: 'System Name' } },
    ]);
  } finally {
    service.close();
  }
});

/**
 * The approved-UPN rung, proposed over the fixture's own marks.
 *
 * The federation is half and half — the MEP packages write `AHU-1` and `P101`,
 * the controls package writes `MAH101-01` and `TIT101-01` — which is what a
 * site part-way onto the standard looks like. (`P101` and its two siblings
 * happen to spell an approved UPN as well, which is why nine rather than six of
 * the eighteen read.) Quick Setup does not pretend otherwise: at half the tags
 * the rung is offered with the real number in the reason, and filtered to the
 * package that IS on the standard it is offered for real, with what it would
 * resolve stated in assets.
 */
test('the approved-UPN rung is proposed for the package whose marks carry one', async () => {
  const service = await newRevitProject();
  try {
    acceptFields(service, service.quickSetupSuggestions());

    const mixed = service
      .quickSetupSuggestions()
      .resolverTemplates.find((entry) => entry.templateId === 'exto-approved-list');
    assert.equal(
      mixed.available,
      false,
      'nine marks in eighteen carry an approved UPN, which is not most of a site',
    );
    assert.match(mixed.unavailableReason, /9 of 18 tags carry exactly one approved Exto UPN/);

    // Filtered to the controls package, every mark carries one.
    const { draft } = service.draftState();
    service.updateDraft({
      assetFilters: { ...draft.assetFilters, includedSourceModelFiles: ['B14-Controls.nwc'] },
    });

    const controls = service
      .quickSetupSuggestions()
      .resolverTemplates.find((entry) => entry.templateId === 'exto-approved-list');
    assert.equal(controls.available, true);
    assert.deepEqual(controls.resolver.keyChain, [{ kind: 'upn-from-tag' }]);
    assert.deepEqual(controls.resolver.descriptionChain, [
      { kind: 'exto-system-name', allowUniqueUpn: true, descriptionProperty: null },
    ]);
    assert.equal(controls.resolver.applyIcDisciplineRule, true);
    assert.match(controls.impact, /6 of 6 assets get an approved System Name/);

    // And it is not a promise: accepting it resolves those six for real.
    service.updateDraft({ systemResolver: controls.resolver });
    const preview = service.resolverTemplatePreview(controls.resolver);
    assert.equal(preview.state, 'ready');
    assert.equal(preview.resolvedCount, 6);
    assert.deepEqual(
      [...new Set(preview.samples.map((sample) => sample.systemLabel))].sort(),
      ['101  Cleanroom Makeup Air System', '102  Cleanroom Recirculation Air System'],
      'the approved spelling, not a description anybody wrote next to it',
    );
    assert.deepEqual(preview.extoSystemName, {
      exactCount: 0,
      uniqueUpnCount: 6,
      mismatchCount: 0,
      unknownCount: 0,
    });
  } finally {
    service.close();
  }
});

test('accepting everything on a Revit model nests equipment and publishes', async () => {
  const service = await newRevitProject();
  try {
    const last = acceptEverything(service);
    assert.deepEqual(
      last.rolePairs.map((pair) => [pair.parentRole, pair.childRole, pair.count]),
      [
        ['AHU', 'P', 3],
        ['MCC', 'VFD', 2],
        ['LCP', 'TIT', 1],
        ['PLC', 'LCP', 1],
      ],
      'the controls package draws its own two pairings, and they are the weakest',
    );
    assert.deepEqual(service.draftState().draft.roleGraph.rules, [
      { parentRole: 'AHU', childRole: 'P' },
      { parentRole: 'MCC', childRole: 'VFD' },
      { parentRole: 'LCP', childRole: 'TIT' },
      { parentRole: 'PLC', childRole: 'LCP' },
    ]);
    assert.deepEqual(
      service.draftState().draft.identityConfig.tagNormalization,
      [{ kind: 'trim' }, { kind: 'unicodeFold' }, { kind: 'uppercase' }],
      'the starter profile, merged on the way through',
    );
    assert.ok(service.draftState().draft.ladder.tiers.includes('mel-parent'));

    const saved = service.saveProfile('quick setup');
    assert.equal(saved.revision, 1, 'the draft is publishable');

    const compiled = await service.compile();
    assert.equal(compiled.state, 'done');
    assert.equal(compiled.summary.assetCount, 18);
    assert.equal(compiled.summary.missingSystemCount, 0);

    const completeness = compiled.summary.completeness;
    assert.ok(
      completeness.assetsNested > 0,
      'the acceptance criterion for B3 on real-shaped data: something nests',
    );
    assert.equal(
      completeness.assetsNested,
      7,
      'three pumps in their air handlers, two drives in an MCC, and the controls stack of two',
    );

    for (const level of completeness.levels) {
      if (!level.boundary) {
        continue;
      }
      assert.notEqual(
        level.assetsWithoutValue,
        completeness.assetCount,
        `${level.displayName} is a boundary nobody can state — every asset would be a root`,
      );
      assert.equal(level.blocksNesting, false);
    }
  } finally {
    service.close();
  }
});

test('a project that never enters Quick Setup gets no starter rule set', async () => {
  const service = await newRevitProject();
  try {
    const draft = service.draftState().draft;
    assert.deepEqual(
      draft.identityConfig.tagNormalization,
      [{ kind: 'unicodeFold' }],
      'the one step a new draft has always had, and no more',
    );
    assert.deepEqual(draft.roleGraph.rules, []);
    assert.deepEqual(draft.sourceAssignments, []);
  } finally {
    service.close();
  }
});
