/**
 * The assignment precedence, all four tiers of it (RELEASE-1.0-PLAN P0-8,
 * hard gate 6).
 *
 * > Assignment scopes: object property > source-model assignment > logical-file
 * > assignment > confirmed filename-pattern rule > unresolved/review.
 *
 * A synthetic universe rather than Dragon, because the thing being tested is
 * which DOCUMENT an assignment speaks for, and that needs one cache holding two
 * source models with different file names:
 *
 * ```text
 * source `plant` (Plant-Coordination.nwd)
 *   model 1  Dragon-Mechanical.nwc   -> object 1  MECH-1
 *   model 2  Dragon-Controls.nwc     -> object 2  CTRL-1
 *                                       object 3  CTRL-2  (states a Building)
 * ```
 */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { AssetCatalogConfigError, buildAssetCatalog } from '../dist/index.js';
import { openExtractionCache } from '../../model-schema/dist/index.js';

import { makeTempDirectory, NO_FILTERS, writeSyntheticCache } from './support.mjs';

const TAG = { category: 'Item', name: 'Tag' };
const MAPPINGS = { equipmentTag: TAG, building: { category: 'Site', name: 'Building' } };

let directory = '';
const opened = [];
let plant = null;

before(() => {
  directory = makeTempDirectory('assignment-rules');
  const path = join(directory, 'plant.sqlite');
  writeSyntheticCache(path, {
    sourceModels: [
      { id: 1, fileName: 'Dragon-Mechanical.nwc', displayName: 'Mechanical' },
      { id: 2, fileName: 'Dragon-Controls.nwc', displayName: 'Controls' },
    ],
    objects: [
      { id: 1, sourceModelId: 1, displayName: 'MECH-1' },
      { id: 2, sourceModelId: 2, displayName: 'CTRL-1' },
      { id: 3, sourceModelId: 2, displayName: 'CTRL-2' },
    ],
    properties: [
      { objectId: 1, category: 'Item', name: 'Tag', valueText: 'MECH-1' },
      { objectId: 2, category: 'Item', name: 'Tag', valueText: 'CTRL-1' },
      { objectId: 3, category: 'Item', name: 'Tag', valueText: 'CTRL-2' },
      // The one object whose building the MODEL states. Every rule below tries
      // to assign it something else and must lose.
      { objectId: 3, category: 'Site', name: 'Building', valueText: 'STATED-BY-MODEL' },
    ],
  });
  plant = openExtractionCache(path);
  opened.push(plant);
});

after(() => {
  for (const cache of opened) {
    cache.close();
  }
  rmSync(directory, { recursive: true, force: true });
});

/** The universe under one profile plus a rule list. */
function build(rules, assignments) {
  const source = { sourceId: 'plant', cache: plant };
  return buildAssetCatalog(
    [assignments === undefined ? source : { ...source, assignments }],
    MAPPINGS,
    NO_FILTERS,
    rules,
  );
}

/** `tag -> [building, scope, match]` per asset. */
function shape(catalog) {
  return catalog.assets.map((asset) => [
    asset.canonicalTag,
    asset.building,
    asset.provenance.building?.scope ?? asset.provenance.building?.origin,
    asset.provenance.building?.match,
  ]);
}

/* --------------------------------------------------------- the four tiers */

test('a source-model rule assigns the model it names and no other', () => {
  const catalog = build([
    { scope: 'source-model', match: 'Dragon-Controls.nwc', assign: { building: 'D2' } },
  ]);
  assert.deepEqual(shape(catalog), [
    ['MECH-1', undefined, undefined, undefined],
    ['CTRL-1', 'D2', 'source-model', 'Dragon-Controls.nwc'],
    ['CTRL-2', 'STATED-BY-MODEL', 'model-property', undefined],
  ]);
});

test('a logical-source rule assigns every document of the source it names', () => {
  const catalog = build([{ scope: 'logical-source', match: 'plant', assign: { building: 'D9' } }]);
  assert.deepEqual(shape(catalog), [
    ['MECH-1', 'D9', 'logical-source', 'plant'],
    ['CTRL-1', 'D9', 'logical-source', 'plant'],
    ['CTRL-2', 'STATED-BY-MODEL', 'model-property', undefined],
  ]);
});

test('a filename-pattern rule assigns the documents it matches, and $1 is the capture', () => {
  const catalog = build([
    {
      scope: 'filename-pattern',
      match: 'Dragon-*.nwc',
      assign: { building: 'Building $1' },
    },
  ]);
  assert.deepEqual(shape(catalog), [
    ['MECH-1', 'Building Mechanical', 'filename-pattern', 'Dragon-*.nwc'],
    ['CTRL-1', 'Building Controls', 'filename-pattern', 'Dragon-*.nwc'],
    ['CTRL-2', 'STATED-BY-MODEL', 'model-property', undefined],
  ]);
});

test('a filename-pattern rule that matches nothing assigns nothing', () => {
  const catalog = build([
    { scope: 'filename-pattern', match: 'Other-*.nwc', assign: { building: 'X' } },
  ]);
  assert.deepEqual(
    catalog.assets.map((asset) => asset.building),
    [undefined, undefined, 'STATED-BY-MODEL'],
  );
});

/* ------------------------------------------------------------- precedence */

test('an object property outranks every rule, at every scope', () => {
  // The whole reason the tiers are ordered the way they are: the model saying
  // so beats the project saying so about the model.
  const catalog = build(
    [
      { scope: 'source-model', match: 'Dragon-Controls.nwc', assign: { building: 'BY-MODEL' } },
      { scope: 'logical-source', match: 'plant', assign: { building: 'BY-SOURCE' } },
      { scope: 'filename-pattern', match: 'Dragon-*.nwc', assign: { building: 'BY-PATTERN' } },
    ],
    { building: 'BY-DIRECT' },
  );
  const stated = catalog.assets.find((asset) => asset.canonicalTag === 'CTRL-2');
  assert.equal(stated.building, 'STATED-BY-MODEL');
  assert.equal(stated.provenance.building.origin, 'model-property');
});

test('the tiers rank source model, then logical file, then filename pattern', () => {
  const rules = [
    { scope: 'filename-pattern', match: 'Dragon-*.nwc', assign: { building: 'BY-PATTERN' } },
    { scope: 'logical-source', match: 'plant', assign: { building: 'BY-RULE' } },
    { scope: 'source-model', match: 'Dragon-Controls.nwc', assign: { building: 'BY-MODEL' } },
  ];

  // All four tiers in play at once. The rules are written weakest-first on
  // purpose: the answer is the tier's rank, never the list's order.
  const everything = build(rules, { building: 'BY-DIRECT' });
  assert.deepEqual(shape(everything), [
    // No source-model rule names the mechanical file, so the direct assignment
    // on the source answers -- and it outranks the logical-source RULE, which
    // is the same tier said the portable way.
    ['MECH-1', 'BY-DIRECT', 'logical-source', 'plant'],
    ['CTRL-1', 'BY-MODEL', 'source-model', 'Dragon-Controls.nwc'],
    ['CTRL-2', 'STATED-BY-MODEL', 'model-property', undefined],
  ]);

  // Take the direct assignment away and the logical-source rule steps into the
  // same slot; take that away too and the pattern does.
  assert.deepEqual(shape(build(rules))[0], ['MECH-1', 'BY-RULE', 'logical-source', 'plant']);
  assert.deepEqual(shape(build([rules[0]]))[0], [
    'MECH-1',
    'BY-PATTERN',
    'filename-pattern',
    'Dragon-*.nwc',
  ]);
});

test('a stronger tier that states one field does not silence a weaker one on another', () => {
  const catalog = build([
    { scope: 'source-model', match: 'Dragon-Mechanical.nwc', assign: { building: 'D1' } },
    {
      scope: 'filename-pattern',
      match: 'Dragon-*.nwc',
      assign: { nativeDiscipline: '$1' },
    },
  ]);
  const mech = catalog.assets.find((asset) => asset.canonicalTag === 'MECH-1');
  assert.equal(mech.building, 'D1', 'the source-model rule answered the building');
  assert.equal(mech.nativeDiscipline, 'Mechanical', 'and the pattern still answered the discipline');
  assert.equal(mech.provenance.building.scope, 'source-model');
  assert.equal(mech.provenance.nativeDiscipline.scope, 'filename-pattern');
});

test('within one tier the first matching rule wins, so the list order decides', () => {
  const catalog = build([
    { scope: 'filename-pattern', match: 'Dragon-*.nwc', assign: { building: 'FIRST' } },
    { scope: 'filename-pattern', match: '*-Mechanical.nwc', assign: { building: 'SECOND' } },
  ]);
  assert.equal(catalog.assets[0].building, 'FIRST');

  const reversed = build([
    { scope: 'filename-pattern', match: '*-Mechanical.nwc', assign: { building: 'SECOND' } },
    { scope: 'filename-pattern', match: 'Dragon-*.nwc', assign: { building: 'FIRST' } },
  ]);
  assert.equal(reversed.assets[0].building, 'SECOND', 'and nothing else about the rule decides it');
});

/* ------------------------------------------------------------- determinism */

test('the same universe and the same rules produce the same catalog twice', () => {
  const rules = [
    { scope: 'source-model', match: 'Dragon-Controls.nwc', assign: { building: 'D2' } },
    {
      scope: 'filename-pattern',
      match: 'Dragon-*.nwc',
      assign: { nativeDiscipline: '$1', custom: new Map([['zone', 'Z-$1']]) },
    },
  ];
  const first = build(rules);
  const second = build(rules);
  const flatten = (catalog) =>
    catalog.assets.map((asset) => [
      asset.canonicalTag,
      asset.building,
      asset.nativeDiscipline,
      [...asset.assignedAttributes],
    ]);
  assert.deepEqual(flatten(second), flatten(first));
});

/* ------------------------------------------------------- custom attributes */

test('custom assignments land on the asset with the rule that assigned them', () => {
  const catalog = build([
    {
      scope: 'filename-pattern',
      match: 'Dragon-*.nwc',
      assign: { custom: new Map([['zone', 'Z-$1'], ['owner', 'Cx']]) },
    },
  ]);
  const mech = catalog.assets.find((asset) => asset.canonicalTag === 'MECH-1');
  assert.deepEqual(
    [...mech.assignedAttributes],
    [
      ['owner', 'Cx'],
      ['zone', 'Z-Mechanical'],
    ],
    'key order ascending, so two runs list them the same way',
  );
  assert.equal(mech.assignedAttributeProvenance.get('zone').scope, 'filename-pattern');
  assert.equal(mech.assignedAttributeProvenance.get('zone').match, 'Dragon-*.nwc');
});

test('custom assignments are per document, not per source', () => {
  // The reason they had to stop being a per-source constant: one cache holds
  // several source models, and a rule speaks for one of them.
  const catalog = build([
    {
      scope: 'source-model',
      match: 'Dragon-Controls.nwc',
      assign: { custom: new Map([['zone', 'CONTROLS']]) },
    },
  ]);
  assert.deepEqual(
    catalog.assets.map((asset) => [asset.canonicalTag, [...asset.assignedAttributes]]),
    [
      ['MECH-1', []],
      ['CTRL-1', [['zone', 'CONTROLS']]],
      ['CTRL-2', [['zone', 'CONTROLS']]],
    ],
  );
});

/* ------------------------------------------------------------ blanks, typos */

test('a rule that assigns a blank assigns nothing, and the tier below answers', () => {
  const catalog = build([
    { scope: 'source-model', match: 'Dragon-Mechanical.nwc', assign: { building: '   ' } },
    { scope: 'filename-pattern', match: 'Dragon-*.nwc', assign: { building: 'BY-PATTERN' } },
  ]);
  assert.equal(catalog.assets[0].building, 'BY-PATTERN');
});

test('a capture that covers nothing leaves a $1-only value blank rather than empty', () => {
  const catalog = build([
    { scope: 'filename-pattern', match: 'Dragon-Mechanical.nwc*', assign: { building: '$1' } },
  ]);
  const mech = catalog.assets[0];
  assert.equal(mech.building, undefined, 'a blank is not a value, however it became blank');
  assert.equal('building' in mech, false);
});

test('a filename pattern with no star, or with two, is refused rather than run', () => {
  for (const match of ['Dragon-Mechanical.nwc', 'Dragon-*-*.nwc']) {
    let failure = null;
    try {
      build([{ scope: 'filename-pattern', match, assign: { building: 'X' } }]);
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof AssetCatalogConfigError, `${match} was accepted`);
    assert.equal(failure.reason.kind, 'invalid-assignment-pattern');
    assert.equal(failure.reason.ruleIndex, 0);
    assert.equal(failure.reason.pattern, match);
  }
});

test('an exact-match scope is exact: no star is read out of it', () => {
  const catalog = build([
    { scope: 'source-model', match: 'Dragon-*.nwc', assign: { building: 'X' } },
  ]);
  assert.deepEqual(
    catalog.assets.map((asset) => asset.building),
    [undefined, undefined, 'STATED-BY-MODEL'],
    'a source-model rule names one file name, not a shape of them',
  );
});
