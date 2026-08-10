/**
 * P0-1 — one project, many model sources (hard gates 2, 3, 4).
 *
 * > Compiler consumes a ModelUniverse (many ModelSources: sourceId,
 * > displayName, rawFileName, rawSha256, cacheSha256, cache, assignments) — not
 * > one cache. [...] One authoritative asset universe; duplicate tags detected
 * > within one NWD, across NWDs, across source models. Same-basename files
 * > coexist. [...] Federated vs split representations of one site produce
 * > equivalent canonical outputs (provenance differences excepted).
 *
 * ## What is true today, and why that is the bug
 *
 * `CompileProjectInput` (`packages/compiler/src/types.ts`) has one field for
 * the model: `readonly cache: ExtractionCache`. A project is therefore exactly
 * one extraction cache, which means a site that federates its NWDs and a site
 * that keeps them split are two different products, and a second model file is
 * a second project. Every identity in the engine — object ids, source-model
 * names, selection sets — is scoped to that single cache, so there is nothing
 * for a second source's ids to be distinguished *from*.
 *
 * ## The fixtures
 *
 * The Dragon fixture is a federated cache: one file carrying a Mechanical
 * source model and a Controls one. `openDragonSplit` partitions it into two
 * caches whose union is exactly the federated file — same object ids, same
 * InstanceGuids, same properties. That is what makes "federated vs split" a
 * comparison of representations rather than of contents.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { compileProject } from '@matchline/compiler';

import {
  DRAGON_CONTROLS_MODELS,
  DRAGON_MECHANICAL_MODELS,
  HIERARCHY,
  ROLE_GRAPH,
  attempt,
  canonicalOutputs,
  melWorkbook,
  mentionsAll,
  openDragonCache,
  openDragonSplit,
  pending,
  siteProfile,
} from './support.mjs';

/** Milestone 2: "Multi-model domain+storage". */
const MILESTONE = 2;

/** An invented digest. Dragon caches are generated, so nothing real hashes. */
function fakeSha256(seed) {
  return seed.padEnd(64, '0').slice(0, 64).replaceAll(/[^0-9a-f]/g, '0');
}

/** One `ModelSource`, in the shape P0-1 specifies. */
function modelSource(sourceId, displayName, rawFileName, cache) {
  return {
    sourceId,
    displayName,
    rawFileName,
    rawSha256: fakeSha256(sourceId),
    cacheSha256: fakeSha256(`c${sourceId}`),
    cache,
    assignments: {},
  };
}

/** A compile over a ModelUniverse rather than over one cache. */
function compileUniverse(what, sources) {
  return attempt(MILESTONE, what, () =>
    compileProject({
      sources,
      profile: siteProfile(),
      hierarchy: HIERARCHY,
      roleGraph: ROLE_GRAPH,
      melWorkbook: melWorkbook(),
    }),
  );
}

let federated = null;
let mechanical = null;
let controls = null;
let mechanicalTwin = null;

before(() => {
  federated = openDragonCache('multi-federated');
  mechanical = openDragonSplit('multi-mech', DRAGON_MECHANICAL_MODELS, 'Dragon-Mechanical.nwd');
  controls = openDragonSplit('multi-ctrl', DRAGON_CONTROLS_MODELS, 'Dragon-Controls.nwd');
  // The same partition again, as a second registered source: the only way to
  // put one tag on two sources without inventing equipment.
  mechanicalTwin = openDragonSplit('multi-mech-2', DRAGON_MECHANICAL_MODELS, 'Dragon-Mechanical.nwd');
});

after(() => {
  federated?.close();
  mechanical?.close();
  controls?.close();
  mechanicalTwin?.close();
});

test('the split caches partition the federated one exactly', () => {
  // Not a target assertion — a guard on the fixtures. 24 mechanical assets plus
  // 10 controls assets is the federated fixture's own 34.
  const single = (cache) =>
    compileProject({
      cache,
      profile: siteProfile(),
      hierarchy: HIERARCHY,
      roleGraph: ROLE_GRAPH,
      melWorkbook: melWorkbook(),
    });
  assert.equal(single(federated.cache).stats.assetCount, 34);
  assert.equal(single(mechanical.cache).stats.assetCount, 24);
  assert.equal(single(controls.cache).stats.assetCount, 10);
});

test('one federated source and two split sources compile to equivalent canonical outputs', () => {
  const asOne = compileUniverse(
    'compileProject accepts a ModelUniverse (`sources`) instead of a single `cache`',
    [modelSource('dragon-federated', 'Dragon Coordination', 'Dragon-Coordination.nwd', federated.cache)],
  );
  const asTwo = compileUniverse('compileProject accepts several model sources in one project', [
    modelSource('dragon-mechanical', 'Dragon Mechanical', 'Dragon-Mechanical.nwd', mechanical.cache),
    modelSource('dragon-controls', 'Dragon Controls', 'Dragon-Controls.nwd', controls.cache),
  ]);

  const one = canonicalOutputs(asOne);
  const two = canonicalOutputs(asTwo);

  assert.deepEqual(two.tags, one.tags, 'the asset universe is the site, not the file layout');
  assert.deepEqual(two.systems, one.systems, 'every asset resolves to the same system either way');
  assert.deepEqual(
    two.parents,
    one.parents,
    'a structural chain that crosses two source models is the same chain in one file',
  );
  assert.deepEqual(two.dependencies, one.dependencies, 'dependencies do not depend on file layout');
});

test('the federated/split equivalence covers the cross-discipline chain specifically', () => {
  // The MAH -> PLC nesting is the whole point: in the split representation the
  // parent and the child live in different files, so a compiler that scoped
  // families to a cache would silently root the PLC.
  const asTwo = compileUniverse('compileProject accepts several model sources in one project', [
    modelSource('dragon-mechanical', 'Dragon Mechanical', 'Dragon-Mechanical.nwd', mechanical.cache),
    modelSource('dragon-controls', 'Dragon Controls', 'Dragon-Controls.nwd', controls.cache),
  ]);
  assert.ok(
    canonicalOutputs(asTwo).parents.includes('PLC001-10-01 -> MAH001-10-01'),
    pending(MILESTONE, 'a family spanning two sources still nests across them'),
  );
});

test('two sources with the same basename coexist', () => {
  // Hard gate 4. Sites really do ship `Level 1.nwc` from four consultants;
  // keying anything on the file name loses three of them.
  const shared = 'Dragon-Area.nwd';
  const project = compileUniverse('two model sources with one basename both register', [
    modelSource('dragon-area-mech', 'Dragon Area (Mechanical)', shared, mechanical.cache),
    modelSource('dragon-area-ctrl', 'Dragon Area (Controls)', shared, controls.cache),
  ]);

  assert.equal(
    project.stats.assetCount,
    34,
    pending(MILESTONE, 'neither same-basename source is dropped or overwritten by the other'),
  );
  const tags = canonicalOutputs(project).tags;
  assert.ok(tags.includes('MAH001-10-01'), 'the mechanical source contributed its assets');
  assert.ok(tags.includes('PLC001-10-01'), 'the controls source contributed its assets');
  assert.equal(
    project.stats.duplicateTagCount,
    0,
    'two different areas that share a file name share no tags',
  );
});

test('a tag carried by two sources is a duplicate review item naming both sources', () => {
  const project = compileUniverse('duplicate tags are detected across sources, not only within one', [
    modelSource('dragon-mech-a', 'Dragon Mechanical (rev A)', 'Dragon-Mechanical.nwd', mechanical.cache),
    modelSource('dragon-mech-b', 'Dragon Mechanical (rev B)', 'Dragon-Mechanical.nwd', mechanicalTwin.cache),
  ]);

  assert.ok(
    project.stats.duplicateTagCount > 0,
    pending(MILESTONE, 'one tag registered by two sources counts as a duplicate'),
  );

  const duplicates = project.reviewItems.filter(
    (item) => item.kind === 'duplicate-model-tag' && item.canonicalTag === 'MAH001-10-01',
  );
  assert.equal(
    duplicates.length,
    1,
    pending(MILESTONE, 'a tag on two sources raises exactly one duplicate-model-tag review item'),
  );
  assert.ok(
    mentionsAll(duplicates[0], ['dragon-mech-a', 'dragon-mech-b']),
    pending(MILESTONE, 'the duplicate review item names BOTH sources — an object id alone cannot be navigated to'),
  );

  // Never merged (§9.3): both readings survive as separate assets.
  assert.ok(
    project.catalog.assets.filter((asset) => asset.canonicalTag === 'MAH001-10-01').length >= 2,
    'a duplicate tag is reported, never resolved by discarding one side',
  );
});
