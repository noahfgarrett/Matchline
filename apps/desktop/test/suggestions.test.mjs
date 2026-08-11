import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { buildUniversePropertyCatalog } from '@matchline/asset-catalog';
import { openExtractionCache } from '@matchline/model-schema';
import { writeDragonFixture } from '@matchline/model-schema/fixtures/dragon';

import {
  inferAnatomy,
  inferSeparators,
  resolverTemplates,
  suggestClasses,
  suggestFields,
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

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'matchline-suggest-'));
  const cachePath = join(workDir, 'Dragon.matchline-cache');
  writeDragonFixture(cachePath);
  cache = openExtractionCache(cachePath);
  catalog = buildUniversePropertyCatalog([{ sourceId: 'model:dragon', cache }]);
});

after(() => {
  cache?.close();
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

test('tags with nothing to split on produce no proposal rather than a useless one', () => {
  assert.equal(inferAnatomy(['MAH001', 'MAH002', 'PLC001']), null);
  assert.equal(inferAnatomy([]), null);
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
