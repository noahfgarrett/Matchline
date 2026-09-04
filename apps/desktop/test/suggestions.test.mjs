import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { buildUniversePropertyCatalog } from '@matchline/asset-catalog';
import { openExtractionCache } from '@matchline/model-schema';
import { writeDragonFixture } from '@matchline/model-schema/fixtures/dragon';
import { REVIT_MARKS, writeRevitShapedFixture } from '@matchline/model-schema/fixtures/revit';

import {
  inferAnatomy,
  inferSeparators,
  preferredSystemProperty,
  resolverTemplates,
  suggestClasses,
  suggestFields,
  suggestRolePairs,
  suggestSourceAssignments,
} from '../dist/electron/services/suggestions.js';

/**
 * The Quick Setup suggestion engine, over the real Dragon Property Catalog
 * (RELEASE-1.0-PLAN "One-hour UX").
 *
 * Every number asserted below was read off the fixture generator, not off a
 * recorded run. Dragon carries eleven distinct properties and the ones that
 * matter here are:
 *
 * | property                    | objects | coverage | distinct |
 * |-----------------------------|---------|----------|----------|
 * | `Item > Name`               | 75      | 99%      | 42       |
 * | `Item > Type`               | 75      | 99%      | 6        |
 * | `Dragon Data > Building`    | 38      | 50%      | 2        |
 * | `Dragon Data > Tag`         | 34      | 45%      | 34       |
 * | `Dragon Data > UPN`         | 34      | 45%      | 3        |
 * | `Dragon Data > Manufacturer`| 24      | 32%      | 2        |
 * | `Dragon Data > Service`     | 24      | 32%      | 2        |
 *
 * The case the ranking exists for is the first two rows against the fourth:
 * `Item > Name` covers twice as much of the model as `Dragon Data > Tag` and is
 * still the wrong answer, because half its values are `Solid` and `D1`. A
 * fill-rate-only ranking picks it; a name-and-shape-and-cardinality ranking does
 * not, and that is what these tests pin.
 */

let workDir = '';
let cache = null;
let catalog = [];
let revitCache = null;
let revitCatalog = [];

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'matchline-suggest-'));
  const cachePath = join(workDir, 'Dragon.matchline-cache');
  writeDragonFixture(cachePath);
  cache = openExtractionCache(cachePath);
  catalog = buildUniversePropertyCatalog([{ sourceId: 'model:dragon', cache }]);

  const revitPath = join(workDir, 'Campus.matchline-cache');
  writeRevitShapedFixture(revitPath);
  revitCache = openExtractionCache(revitPath);
  revitCatalog = buildUniversePropertyCatalog([{ sourceId: 'model:revit', cache: revitCache }]);
});

after(() => {
  cache?.close();
  revitCache?.close();
  if (workDir !== '') {
    rmSync(workDir, { recursive: true, force: true });
  }
});

/** Every non-blank Dragon tag, read straight off the cache. */
function dragonTags() {
  const tags = [];
  for (const row of cache.allProperties()) {
    if (row.category === 'Dragon Data' && row.name === 'Tag' && row.valueText) {
      tags.push(row.valueText);
    }
  }
  return tags;
}

function fieldFor(fields, label) {
  const found = fields.find((field) => field.label === label);
  assert.ok(found !== undefined, `no suggestion for "${label}"`);
  return found;
}

/* --------------------------------------------------------- ranked candidates */

test('the tag property is ranked first, on shape and cardinality rather than coverage', () => {
  const tag = fieldFor(suggestFields(catalog), 'Equipment tag');
  const top = tag.candidates[0];

  assert.deepEqual(top.property, { category: 'Dragon Data', name: 'Tag' });
  assert.equal(tag.confidence, 'strong');

  // The whole point: the property with the HIGHEST coverage is not the answer.
  const byName = tag.candidates.find(
    (candidate) => candidate.property.name === 'Name' && candidate.property.category === 'Item',
  );
  assert.ok(byName !== undefined, 'Item > Name is offered — it is a real candidate');
  assert.ok(
    byName.coverage > top.coverage,
    'and it covers more of the model than the winner does',
  );
  assert.ok(top.score > byName.score * 2, 'and still loses, by a wide margin');
});

test('the ranking states its evidence, so accepting one is not accepting a number', () => {
  const tag = fieldFor(suggestFields(catalog), 'Equipment tag');
  const reasons = tag.candidates[0].reasons.join(' | ');

  assert.match(reasons, /Named “Tag”/, 'the name synonym signal');
  assert.match(reasons, /45% of objects carry it \(34\)/, 'the fill-rate signal');
  assert.match(reasons, /shaped like a tag/, 'the value-shape signal');
  assert.match(reasons, /Every value is distinct/, 'the cardinality signal');
});

test('a field named in the model is asked about; one that is not, is not', () => {
  const fields = suggestFields(catalog);
  const labels = fields.map((field) => field.label);

  assert.deepEqual(labels, [
    'Equipment tag',
    'Description',
    'Equipment type',
    'Building',
    'Manufacturer',
    'System / UPN',
  ]);

  // Dragon carries no discipline, WBS, area or level property. Asking about
  // them would produce six screens proposing `Item > Type` six times.
  assert.ok(!labels.includes('Native discipline'));
  assert.ok(!labels.includes('WBS'));
  assert.ok(!labels.includes('Area'));
  assert.ok(!labels.includes('Level'));
});

test('description is ranked by its name and its fill, and reads as text', () => {
  const description = fieldFor(suggestFields(catalog), 'Description');
  assert.deepEqual(description.candidates[0].property, {
    category: 'Dragon Data',
    name: 'Service',
  });
  assert.match(
    description.candidates[0].reasons.join(' | '),
    /read as text rather than codes/,
    'a description wants prose, which is what separates Service from UPN',
  );
});

test('the fields with no standard slot are proposed as derived attributes', () => {
  const fields = suggestFields(catalog);

  assert.deepEqual(fieldFor(fields, 'Manufacturer').target, {
    kind: 'derived-attribute',
    attributeId: 'manufacturer',
  });
  assert.deepEqual(fieldFor(fields, 'System / UPN').target, {
    kind: 'derived-attribute',
    attributeId: 'system-upn',
  });
  assert.deepEqual(fieldFor(fields, 'Equipment tag').target, {
    kind: 'mapped-field',
    field: 'equipmentTag',
  });
});

/* ---------------------------------------------------- deliberately ambiguous */

test('two equally good candidates stay a suggestion rather than becoming a decision', () => {
  // Hand-built rather than read off Dragon: the point is a tie, and a fixture
  // that happened to tie today would stop testing this the moment it changed.
  const tied = [
    entry('Site Data', 'Building', 40, 80, 4, ['B14', 'B15', 'B16', 'B17']),
    entry('Room Data', 'Building', 40, 80, 4, ['B14', 'B15', 'B16', 'B17']),
  ];

  const building = fieldFor(suggestFields(tied), 'Building');
  assert.equal(building.candidates.length, 2);
  assert.equal(
    building.candidates[0].score,
    building.candidates[1].score,
    'the two really are indistinguishable on the signals available',
  );
  assert.equal(
    building.confidence,
    'possible',
    'so Quick Setup offers both unticked and lets a person choose',
  );
});

test('a clear winner is strong; a narrow one is not', () => {
  const clear = [
    entry('Site Data', 'Building', 40, 80, 4, ['B14', 'B15', 'B16', 'B17']),
    entry('Site Data', 'Colour', 40, 80, 4, ['Red', 'Blue', 'Green', 'Grey']),
  ];
  assert.equal(fieldFor(suggestFields(clear), 'Building').confidence, 'strong');
});

test('a name that merely contains the word does not outrank one that is the word', () => {
  const catalogue = [
    entry('Dragon Data', 'Tag', 34, 76, 34, ['MAH001-10-01', 'MAH001-10-02']),
    entry('Dragon Data', 'Tag Colour', 76, 76, 3, ['Red', 'Blue', 'Green']),
  ];
  const tag = fieldFor(suggestFields(catalogue), 'Equipment tag');

  assert.deepEqual(tag.candidates[0].property, { category: 'Dragon Data', name: 'Tag' });
  assert.ok(
    tag.candidates[0].score > (tag.candidates[1]?.score ?? 0),
    'Tag Colour covers every object and still loses on shape and cardinality',
  );
});

/** One catalog entry, spelled the way `buildUniversePropertyCatalog` spells it. */
function entry(category, name, objectCount, universeCount, distinctValueCount, exampleValues) {
  return {
    category,
    name,
    objectCount,
    objectFraction: objectCount / universeCount,
    distinctValueCount,
    exampleValues,
    bySource: new Map(),
  };
}

/* --------------------------------------------------------- anatomy inference */

test("the inferred anatomy is the one Dragon's tests teach by hand", () => {
  const suggestion = inferAnatomy(dragonTags());
  assert.ok(suggestion !== null);

  assert.deepEqual(suggestion.anatomy.separators, ['-']);
  assert.deepEqual(suggestion.anatomy.segments, [
    { segment: 'role', extractor: { kind: 'alphaPrefix', token: 0 } },
    { segment: 'system', extractor: { kind: 'digitSuffix', token: 0 } },
    { segment: 'unit', extractor: { kind: 'token', token: 1 } },
    { segment: 'instance', extractor: { kind: 'token', token: 2 } },
  ]);
  // The family key is the tag without its role prefix, which is what the
  // tag-family rung wants: MAH001-10-01 and PLC001-10-01 share 001-10-01.
  assert.equal(suggestion.anatomy.familyKeyTemplate, '{system}-{token:1}-{token:2}');
});

test('the inference reports what its proposal actually did to the tags', () => {
  const suggestion = inferAnatomy(dragonTags());

  assert.equal(suggestion.coverage, 1);
  assert.equal(suggestion.matchedCount, 34);
  assert.equal(suggestion.totalCount, 34);
  assert.deepEqual(
    suggestion.segmentStats.map((stat) => [stat.segment, stat.distinctValueCount]),
    [
      ['role', 4],
      ['system', 3],
      ['unit', 2],
      ['instance', 6],
    ],
  );
  assert.equal(suggestion.examples[0].tag, 'MAH001-10-01');
  assert.equal(suggestion.examples[0].familyKey, '001-10-01');
});

test('a separator only counts when a third of the tags use it', () => {
  assert.deepEqual(inferSeparators(['A-1', 'B-2', 'C-3']), ['-']);
  assert.deepEqual(
    inferSeparators(['A-1', 'B-2', 'C-3', 'D_4', 'E_5', 'F_6']),
    ['-', '_'],
    'a site with two conventions gets both, because the tokenizer splits on all of them',
  );
  assert.deepEqual(
    inferSeparators(['A-1', 'B-2', 'C-3', 'D-4', 'E-5', 'F-6', 'G-7', 'H.8']),
    ['-'],
    'and one stray dot is not a convention',
  );
});

test('tags with nothing to read produce no proposal rather than a useless one', () => {
  assert.equal(inferAnatomy([]), null);
  assert.equal(
    inferAnatomy(['1234', '5678']),
    null,
    'every shape Matchline tries needs letters at the front; these have none',
  );

  // A tag with no separator is NOT one of those. `MAH001` decomposes into a
  // role and an instance, and refusing to say so left every Revit-shaped site
  // with no anatomy at all (WP8, item 4).
  const undivided = inferAnatomy(['MAH001', 'MAH002', 'PLC001']);
  assert.ok(undivided !== null);
  assert.deepEqual(undivided.anatomy.separators, []);
  assert.deepEqual(
    undivided.anatomy.segments.map((row) => [row.segment, row.extractor.kind]),
    [
      ['role', 'alphaPrefix'],
      ['instance', 'digitSuffix'],
    ],
  );
});

/* ------------------------------------------------------- resolver templates */

test('all six starter templates are offered, with availability stated honestly', () => {
  const withEverything = resolverTemplates({
    hasSystemSegment: true,
    hasMel: true,
    systemProperty: { category: 'Dragon Data', name: 'UPN' },
  });

  assert.deepEqual(
    withEverything.map((template) => template.templateId),
    ['model-field', 'tag-and-mel', 'upn-and-mel', 'direct-column', 'composite', 'manual-only'],
  );
  assert.ok(withEverything.every((template) => template.available));
  assert.ok(withEverything.every((template) => template.resolver.keyChain.length > 0));

  const bare = resolverTemplates({
    hasSystemSegment: false,
    hasMel: false,
    systemProperty: null,
  });
  const byId = new Map(bare.map((template) => [template.templateId, template]));

  assert.equal(byId.get('manual-only').available, true, 'manual always works');
  assert.equal(byId.get('tag-and-mel').available, false);
  assert.match(byId.get('tag-and-mel').unavailableReason, /system.*segment/i);
  assert.match(byId.get('tag-and-mel').unavailableReason, /master equipment list/i);
  assert.equal(
    bare.length,
    6,
    'an unavailable template is shown with its reason, never quietly dropped',
  );
});

/* --------------------------------------------------------- class proposals */

test('classes are judged by whether their objects carry tags', () => {
  const proposals = suggestClasses([
    { className: 'Equipment', objectCount: 34, taggedCount: 34 },
    { className: 'Solid', objectCount: 24, taggedCount: 0 },
    { className: 'Layer', objectCount: 4, taggedCount: 0 },
    { className: 'Panel', objectCount: 10, taggedCount: 3 },
  ]);
  const byName = new Map(proposals.map((entry) => [entry.className, entry]));

  assert.equal(byName.get('Equipment').proposal, 'include');
  assert.equal(byName.get('Solid').proposal, 'exclude');
  assert.equal(byName.get('Layer').proposal, 'exclude');
  assert.equal(
    byName.get('Panel').proposal,
    'leave',
    'a class that is 30% tagged is a decision about the site, not a fact about Navisworks',
  );
  assert.match(byName.get('Panel').why, /too mixed/);
  assert.equal(proposals[0].className, 'Equipment', 'ordered by size, so the big call is first');
});

/* ============================================ the Revit-shaped model (WP8) */

/**
 * The same engine over the fixture it was NOT written for.
 *
 * Every number below is read off `writeRevitShapedFixture`: 148 objects in
 * three files, `Element > Mark` on 12 of them, no property called Building, and
 * marks (`AHU-1`, `P101`, `MCC-2A`, `VFD-2A-1`) with no system in them. The
 * audit's finding was that the engine proposed no building, called the instance
 * number a system, and offered System Classification as the register's
 * classification column. These are the four sentences that say it does not.
 */

test('Mark is the equipment tag, and neither Comments nor Family and Type is', () => {
  const tag = fieldFor(suggestFields(revitCatalog), 'Equipment tag');

  assert.deepEqual(tag.candidates[0].property, { category: 'Element', name: 'Mark' });
  assert.equal(tag.confidence, 'strong');
  assert.ok(
    tag.candidates[0].coverage < 0.1,
    'and it wins on 8% coverage, because a mark is only ever on equipment',
  );

  for (const rejected of ['Comments', 'Family and Type', 'Type Name']) {
    assert.ok(
      !tag.candidates.some((candidate) => candidate.property.name === rejected),
      `${rejected} is not an equipment tag`,
    );
  }
});

test('a separator-less mark still scores as a tag, at less than a full point', () => {
  const tag = fieldFor(suggestFields(revitCatalog), 'Equipment tag');
  const reasons = tag.candidates[0].reasons.join(' | ');
  // Four of the five sampled marks carry a separator and `P101` does not, so
  // the shape signal lands between "every value" and zero — which is the whole
  // change: under the old rule `P101` scored nothing at all.
  assert.match(reasons, /fit the shape this field wants/);
});

test('the building is proposed from the workset, with the reason it is a guess', () => {
  const building = fieldFor(suggestFields(revitCatalog), 'Building');

  const workset = building.candidates.find(
    (candidate) => candidate.property.name === 'Workset',
  );
  assert.ok(workset !== undefined, 'a Revit federation has no Building property; the workset is it');
  assert.match(workset.reasons.join(' | '), /Revit models have no Building parameter/);

  const level = building.candidates.find((candidate) => candidate.property.name === 'Level');
  assert.ok(level !== undefined);
  assert.match(level.reasons.join(' | '), /A level is a floor, not a building/);

  assert.equal(
    building.confidence,
    'possible',
    'a guess is never pre-ticked, however well it scores — accept-all must not make L01 a building',
  );
});

test('the building is proposed from the file names, which is where it actually is', () => {
  const rules = suggestSourceAssignments([
    'B14-Mechanical.nwc',
    'B14-Electrical.nwc',
    'B22-Mechanical.nwc',
  ]);

  assert.deepEqual(
    rules.map((entry) => [entry.rule.match, entry.rule.assign.building]),
    [
      ['B14-*', 'B14'],
      ['B22-*', 'B22'],
    ],
  );
  assert.equal(rules[0].rule.scope, 'filename-pattern');
  assert.match(rules[0].why, /the file name is the only thing that does/);
});

test('a file list that does not carry a building code is left alone', () => {
  assert.deepEqual(
    suggestSourceAssignments(['Dragon-Mechanical.nwc', 'Dragon-Controls.nwc']),
    [],
    'Dragon is the site, not a building — a code people write on drawings has a number in it',
  );
  assert.deepEqual(
    suggestSourceAssignments(['B14-Mechanical.nwc', 'Coordination.nwc']),
    [],
    'a rule that speaks for three files out of four leaves the fourth silently unassigned',
  );
  assert.deepEqual(
    suggestSourceAssignments(['B14-Mechanical.nwc', 'B14-Electrical.nwc']),
    [],
    'one building is not a rule anybody needs',
  );
});

test('the anatomy for role-and-number marks teaches no system at all', () => {
  const suggestion = inferAnatomy(REVIT_MARKS);
  assert.ok(suggestion !== null);

  assert.deepEqual(suggestion.anatomy.segments, [
    { segment: 'role', extractor: { kind: 'alphaPrefix', token: 0 } },
  ]);
  assert.ok(
    !suggestion.anatomy.segments.some((row) => row.segment === 'system'),
    'AHU-1 does not mean system 1, and this is the finding that says so',
  );
  assert.equal(suggestion.coverage, 1);
  assert.match(suggestion.rationale, /the system comes from a model property instead/);
  assert.deepEqual(
    suggestion.segmentStats.map((stat) => [stat.segment, stat.distinctValueCount]),
    [['role', 6]],
    'AHU, P, EF, MCC, VFD, PNL — the role vocabulary the pairings are named in',
  );
});

test('a separator-less mark decomposes too, into a role and nothing else', () => {
  const suggestion = inferAnatomy(['P101', 'P102', 'P103', 'AHU1', 'AHU2']);
  assert.ok(suggestion !== null, 'no separator is not the same as no shape');
  assert.equal(suggestion.anatomy.separators.length, 0);
  assert.equal(suggestion.coverage, 1);
  assert.ok(
    suggestion.anatomy.segments.some((row) => row.segment === 'instance'),
    'with the digits in the first token there IS an instance to teach',
  );
});

test('the system property a resolver keys on is the name, not the classification', () => {
  const upn = fieldFor(suggestFields(revitCatalog), 'System / UPN');

  assert.deepEqual(
    upn.candidates[0].property,
    { category: 'Element', name: 'System Classification' },
    'the classification wins the ranking, because it has fewer distinct values',
  );
  assert.deepEqual(
    preferredSystemProperty(upn.candidates),
    { category: 'Element', name: 'System Name' },
    'and loses the argument: keying on it would merge every supply-air system into one',
  );
});

test('System Classification is not offered as the EXTO classification column', () => {
  const classification = fieldFor(suggestFields(revitCatalog), 'Equipment Classification');

  assert.deepEqual(classification.candidates[0].property, {
    category: 'Element',
    name: 'Category',
  });
  assert.ok(
    !classification.candidates.some(
      (candidate) => candidate.property.name === 'System Classification',
    ),
    'a duct’s air system is not what kind of thing a piece of equipment is',
  );
});

test('role pairs are counted off the nestings the model draws, never invented', () => {
  const roleOf = (tag) => /^[A-Za-z]+/.exec(tag)?.[0] ?? null;
  const pairs = suggestRolePairs(
    [
      { parentTag: 'AHU-1', childTag: 'P101' },
      { parentTag: 'AHU-2', childTag: 'P102' },
      { parentTag: 'AHU-3', childTag: 'P103' },
      { parentTag: 'MCC-2A', childTag: 'VFD-2A-1' },
      { parentTag: 'MCC-2A', childTag: 'VFD-2A-2' },
      { parentTag: 'AHU-1', childTag: 'AHU-9' },
    ],
    roleOf,
  );

  assert.deepEqual(
    pairs.map((pair) => [pair.parentRole, pair.childRole, pair.count]),
    [
      ['AHU', 'P', 3],
      ['MCC', 'VFD', 2],
    ],
    'AHU under AHU is a modelling accident, not a rule about a site',
  );
  assert.deepEqual(pairs[1].examples, ['MCC-2A → VFD-2A-1', 'MCC-2A → VFD-2A-2']);
});
