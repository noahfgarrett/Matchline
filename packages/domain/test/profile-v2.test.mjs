/**
 * `SiteProfileV2`: one versioned profile, and the lift off the split brain
 * (RELEASE-1.0-PLAN "SiteProfileV2").
 *
 * The migration is the load-bearing half. Every profile a site has already
 * stored is a V1 whose hierarchy, role graph, ladder, projection and parent-tag
 * property lived somewhere else, and "v1 imports migrate, never refused" only
 * holds if the join between the two halves loses nothing.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  emptyIdentityConfig,
  isSiteProfileV2,
  migrateAttributeResolver,
  migrateDerivedAttributes,
  migrateSiteProfileV1,
  migrateSourceAssignmentRules,
  migrateSourceAssignments,
} from '../dist/index.js';

const TAG = { category: 'Dragon Data', name: 'Tag' };
const BUILDING = { category: 'Dragon Data', name: 'Building' };
const ASSET_NUMBER = { category: 'Dragon Data', name: 'Asset Number' };

/** A Dragon profile exactly as a build before SiteProfileV2 published one. */
const V1 = {
  profileId: 'dragon',
  name: 'Dragon',
  version: 3,
  propertyMappings: { equipmentTag: TAG, building: BUILDING },
  assetFilters: { requireTagProperty: true, collapseComponents: false },
  tagAnatomy: {
    separators: ['-'],
    segments: { role: { kind: 'alphaPrefix', token: 0 } },
    familyKeyTemplate: '{system}-{token:1}-{token:2}',
  },
};

test('a migrated profile announces format version 2', () => {
  const v2 = migrateSiteProfileV1(V1);
  assert.equal(v2.formatVersion, 2);
  assert.ok(isSiteProfileV2(v2));
  assert.ok(!isSiteProfileV2(V1));
});

test('migration carries every V1 section across unchanged', () => {
  const v2 = migrateSiteProfileV1(V1);
  assert.equal(v2.profileId, 'dragon');
  assert.equal(v2.name, 'Dragon');
  assert.deepEqual(v2.propertyMappings, V1.propertyMappings);
  assert.deepEqual(v2.assetFilters, V1.assetFilters);
  assert.deepEqual(v2.tagAnatomy, V1.tagAnatomy);
});

test('migration is not a republication: the version is carried, never bumped', () => {
  assert.equal(migrateSiteProfileV1(V1).version, 3);
});

test('a section the V1 profile never taught stays absent rather than empty', () => {
  // "No anatomy" and "an anatomy that matches nothing" are different states and
  // the engine behaves differently in them.
  const v2 = migrateSiteProfileV1({ ...V1, tagAnatomy: undefined });
  assert.ok(!('tagAnatomy' in v2));
  assert.ok(!('systemResolver' in v2));
});

test('the sections a V1 profile could not carry join it on migration', () => {
  const v2 = migrateSiteProfileV1(V1, {
    hierarchy: { levels: [{ levelId: 'building', displayName: 'Building', attributeKey: 'building', boundary: true, missingValuePolicy: 'unassigned-group', sort: 'label' }] },
    roleGraph: { rules: [{ parentRole: 'MAH', childRole: 'PLC' }] },
    ssmDisciplineProjection: [{ from: 'I&C', to: 'Mechanical' }],
    parentTagProperty: { category: 'Dragon Data', name: 'Parent Tag' },
    stableIdProperty: ASSET_NUMBER,
  });
  assert.equal(v2.hierarchy.levels.length, 1);
  assert.deepEqual(v2.roleGraph.rules, [{ parentRole: 'MAH', childRole: 'PLC' }]);
  assert.deepEqual(v2.ssmDisciplineProjection, [{ from: 'I&C', to: 'Mechanical' }]);
  assert.deepEqual(v2.stableIdProperty, ASSET_NUMBER);
});

test('the defaults change nothing: no levels, the standard ladder, empty everywhere else', () => {
  const v2 = migrateSiteProfileV1(V1);
  // Inventing a level stack here would file a site's equipment somewhere nobody
  // chose; the ladder default IS the walk order the compiler already used.
  assert.deepEqual(v2.hierarchy, { levels: [] });
  assert.equal(v2.ladder.tiers[0], 'manual');
  assert.equal(v2.ladder.tiers.length, 8);
  assert.deepEqual(v2.roleGraph, { rules: [] });
  assert.deepEqual(v2.derivedAttributes, []);
  assert.deepEqual(v2.sourceAssignments, []);
  assert.deepEqual(v2.profileLookup, []);
  assert.deepEqual(v2.priorSsm, []);
  assert.deepEqual(v2.authorityRules, []);
  assert.deepEqual(v2.profileTestExamples, []);
  assert.deepEqual(v2.identityConfig, emptyIdentityConfig());
  assert.equal(v2.parentTagProperty, null);
  assert.equal(v2.stableIdProperty, null);
});

test('a migrated profile survives a JSON round-trip with nothing lost', () => {
  // A profile is stored in a JSON column and crosses IPC. A `Map` anywhere in it
  // would stringify to `{}` and take a site's decisions with it.
  const v2 = migrateSiteProfileV1(V1, {
    derivedAttributes: [
      {
        attributeId: 'turnover-package',
        displayName: 'Turnover Package',
        resolverChain: [{ kind: 'manual', assignments: [{ assetId: 'a1', value: 'TP-1' }] }],
      },
    ],
    sourceAssignments: [
      {
        scope: 'logical-source',
        match: 'dragon-mechanical',
        assign: { building: 'D1', custom: [{ key: 'area', value: 'North' }] },
      },
    ],
    identityConfig: {
      tagNormalization: [{ kind: 'uppercase' }],
      aliases: [{ from: 'MAH-001', to: 'MAH001-10-01' }],
    },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(v2)), v2);
});

test('a manual resolver rung becomes the map the evaluator reads, first pair winning', () => {
  const resolver = migrateAttributeResolver({
    kind: 'manual',
    assignments: [
      { assetId: 'a1', value: 'first' },
      { assetId: 'a1', value: 'second' },
    ],
  });
  assert.equal(resolver.assignments.get('a1'), 'first');
});

test('every resolver rung but manual is already the engine shape and passes through', () => {
  const rung = { kind: 'model-property', chain: [BUILDING] };
  assert.equal(migrateAttributeResolver(rung), rung);
});

test('a derived registry migrates rung by rung', () => {
  const [definition] = migrateDerivedAttributes([
    {
      attributeId: 'area',
      displayName: 'Area',
      resolverChain: [
        { kind: 'model-property', chain: [BUILDING] },
        { kind: 'manual', assignments: [{ assetId: 'a1', value: 'North' }] },
      ],
    },
  ]);
  assert.equal(definition.attributeId, 'area');
  assert.equal(definition.resolverChain.length, 2);
  assert.equal(definition.resolverChain[1].assignments.get('a1'), 'North');
});

test('a blank assignment is dropped rather than assigned to a whole file', () => {
  assert.deepEqual(migrateSourceAssignments({ building: '', nativeDiscipline: 'Mechanical' }), {
    nativeDiscipline: 'Mechanical',
  });
});

test('custom assignments become a map, in the order the profile wrote them', () => {
  const rules = migrateSourceAssignmentRules([
    {
      scope: 'filename-pattern',
      match: 'Dragon-*.nwc',
      assign: { custom: [{ key: 'area', value: '$1' }] },
    },
  ]);
  assert.equal(rules[0].scope, 'filename-pattern');
  assert.equal(rules[0].assign.custom.get('area'), '$1');
});
