import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import {
  DRAGON_SOURCE_MODEL_IDS,
  writeDragonFixtureSubset,
} from '@matchline/model-schema/fixtures/dragon';
import { writeWorkbook } from '@matchline/spreadsheet-import';

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
    assert.equal(templates.length, 6);

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
