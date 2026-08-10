/**
 * One project, many model sources (RELEASE-1.0-PLAN P0-1).
 *
 * `compileProject` takes a ModelUniverse -- an array of `{sourceId, cache}` --
 * rather than one extraction cache. Four things have to hold for that to be a
 * universe rather than a list, and each has a section below:
 *
 * 1. **Equivalence.** A site that federates its NWDs and a site that keeps them
 *    split are the same site. The Dragon fixture is a federated file carrying a
 *    Mechanical source model and a Controls one, and `writeDragonFixtureSubset`
 *    partitions it into caches whose tagged objects partition it exactly -- same
 *    ids, same InstanceGuids, same properties. So the comparison below is of two
 *    REPRESENTATIONS of one site, not of two sites, and the counts are exact:
 *    24 mechanical assets plus 10 controls assets is the federated file's own 34.
 * 2. **Order independence.** Registering the same two files in the other order
 *    is the same project. The universe is read in `sourceId` order, so a
 *    shuffled input array produces a deep-equal compile.
 * 3. **Identity is per source.** An object id is an extraction ordinal within
 *    one cache. Every per-asset read -- the property bag, the source file, the
 *    model tree -- goes through the asset's own source, and object 3 of one
 *    source is never read as object 3 of another.
 * 4. **Duplicates are universe-wide.** A tag on two sources is a duplicate, it
 *    is reported with the sources that claim it, and neither reading is
 *    discarded (PRODUCT.md §9.3).
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { compileProject } from '../dist/index.js';
import {
  connectivityWorkbooks,
  DRAGON_CONTROLS_MODELS,
  DRAGON_MECHANICAL_MODELS,
  HIERARCHY,
  melWorkbook,
  nestedSkid,
  openDragonCache,
  openDragonSubset,
  ROLE_GRAPH,
  siteProfile,
} from './support.mjs';

/** The full Dragon project, over whatever universe the caller registers. */
function inputFor(sources, overrides = {}) {
  return {
    sources,
    profile: siteProfile(),
    hierarchy: HIERARCHY,
    roleGraph: ROLE_GRAPH,
    melWorkbook: melWorkbook(),
    connectivityWorkbooks: connectivityWorkbooks(),
    ...overrides,
  };
}

/**
 * A compiled project reduced to what two representations of one site must
 * agree on: the asset set by tag, who parents whom, what depends on what, and
 * every asset's system.
 *
 * Provenance is excluded deliberately. A federated compile really did read one
 * file where a split compile read two, and a canonical form that hid that would
 * be lying rather than comparing (P0-1: "provenance differences excepted").
 */
function canonicalOutputs(project) {
  const tagOf = new Map(
    project.catalog.assets.map((asset) => [asset.assetId, asset.canonicalTag]),
  );
  const name = (assetId) => tagOf.get(assetId) ?? assetId;

  const parents = [];
  const dependencies = [];
  for (const [assetId, node] of project.snapshot.nodes) {
    const parent = node.parent.parentAssetId;
    parents.push(`${name(assetId)} -> ${parent === null ? '(root)' : name(parent)}`);
    for (const dependency of node.dependencies) {
      dependencies.push(
        `${name(assetId)} <- ${name(dependency.parentAssetId)} (${dependency.relationshipType})`,
      );
    }
  }

  const systems = [];
  for (const [assetId, resolved] of project.systems.bySubject) {
    systems.push(`${name(assetId)} = ${resolved.resolution?.systemKey ?? '(none)'}`);
  }

  return {
    tags: [...tagOf.values()].sort(),
    parents: parents.sort(),
    dependencies: dependencies.sort(),
    systems: systems.sort(),
  };
}

let federated = null;
let mechanical = null;
let controls = null;
/** The mechanical half again, as a second registered source. */
let mechanicalTwin = null;
/** Two copies of the mechanical half, each carrying the nested skid. */
let skidA = null;
let skidB = null;
/**
 * The controls half, plus one object carrying a MECHANICAL tag.
 *
 * The only way to put one tag on two different files without inventing a second
 * site: `MAH001-10-01` is now claimed by the mechanical model and by this one.
 */
let controlsClash = null;

const MECHANICAL_SUBSET = {
  sourceModels: DRAGON_MECHANICAL_MODELS,
  inputFileName: 'Dragon-Mechanical.nwd',
};
const CONTROLS_SUBSET = {
  sourceModels: DRAGON_CONTROLS_MODELS,
  inputFileName: 'Dragon-Controls.nwd',
};

/** The source model id the Dragon controls objects belong to. */
const CONTROLS_MODEL_ID = DRAGON_CONTROLS_MODELS[0];

before(() => {
  federated = openDragonCache('multi-federated');
  mechanical = openDragonSubset('multi-mech', MECHANICAL_SUBSET);
  controls = openDragonSubset('multi-ctrl', CONTROLS_SUBSET);
  mechanicalTwin = openDragonSubset('multi-mech-2', MECHANICAL_SUBSET);
  skidA = openDragonSubset('multi-skid-a', MECHANICAL_SUBSET, nestedSkid);
  skidB = openDragonSubset('multi-skid-b', MECHANICAL_SUBSET, nestedSkid);
  controlsClash = openDragonSubset('multi-clash', CONTROLS_SUBSET, (context) => {
    context.addEquipment({
      sourceModelId: CONTROLS_MODEL_ID,
      parentId: null,
      depth: 0,
      tag: 'MAH001-10-01',
      className: 'Equipment',
      upn: '001',
      building: 'D1',
      service: 'Controls',
    });
  });
});

after(() => {
  federated?.close();
  mechanical?.close();
  controls?.close();
  mechanicalTwin?.close();
  skidA?.close();
  skidB?.close();
  controlsClash?.close();
});

/* --------------------------------------------------- the fixture guard --- */

test('the split caches partition the federated one exactly', () => {
  // Not an assertion about the compiler -- a guard on the fixtures. Every count
  // below is worked out from these three numbers, so a fixture that stopped
  // partitioning would make the equivalence tests pass for the wrong reason.
  const assetCount = (sources) => compileProject(inputFor(sources)).stats.assetCount;
  assert.equal(assetCount([{ sourceId: 'dragon', cache: federated.cache }]), 34);
  assert.equal(assetCount([{ sourceId: 'dragon', cache: mechanical.cache }]), 24);
  assert.equal(assetCount([{ sourceId: 'dragon', cache: controls.cache }]), 10);
});

/* --------------------------------------------- federated versus split --- */

test('one federated source and two split sources compile to equivalent canonical outputs', () => {
  const asOne = compileProject(inputFor([{ sourceId: 'dragon', cache: federated.cache }]));
  const asTwo = compileProject(
    inputFor([
      { sourceId: 'dragon-mechanical', cache: mechanical.cache },
      { sourceId: 'dragon-controls', cache: controls.cache },
    ]),
  );

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

test('a family spanning two sources nests through the flow, exactly as it does in one file', () => {
  // `MAH001-10-01` is mechanical and `PLC001-10-01` is controls, so in the split
  // representation the parent and the child are in different files. Claims
  // assembly joins on tags and family keys, never on a cache, which is what
  // makes the chain survive the split; a compiler that scoped families to a
  // cache would silently root the PLC.
  const asTwo = compileProject(
    inputFor([
      { sourceId: 'dragon-mechanical', cache: mechanical.cache },
      { sourceId: 'dragon-controls', cache: controls.cache },
    ]),
  );

  const plc = asTwo.snapshot.nodes.get('tag:PLC001-10-01');
  assert.equal(plc.parent.status, 'resolved');
  assert.equal(plc.parent.parentAssetId, 'tag:MAH001-10-01');
  assert.equal(plc.parent.ladderSource, 'flow-family');

  // The two ends really are in different sources, so the chain really did cross.
  const sourceOf = new Map(asTwo.catalog.assets.map((asset) => [asset.assetId, asset.sourceId]));
  assert.equal(sourceOf.get('tag:PLC001-10-01'), 'dragon-controls');
  assert.equal(sourceOf.get('tag:MAH001-10-01'), 'dragon-mechanical');
});

test('the cross-source family nests on the taught role pairing alone, with no connectivity at all', () => {
  // The weaker half of the same claim: strip the workbook and the family+role
  // rung has to carry the crossing on the tags by itself.
  const asTwo = compileProject(
    inputFor(
      [
        { sourceId: 'dragon-mechanical', cache: mechanical.cache },
        { sourceId: 'dragon-controls', cache: controls.cache },
      ],
      { connectivityWorkbooks: undefined },
    ),
  );

  const plc = asTwo.snapshot.nodes.get('tag:PLC001-10-01');
  assert.equal(plc.parent.parentAssetId, 'tag:MAH001-10-01');
  assert.equal(plc.parent.ladderSource, 'family-role');
});

/* ------------------------------------------------- order independence --- */

test('a compile does not depend on the order the sources were registered in', () => {
  const forwards = compileProject(
    inputFor([
      { sourceId: 'dragon-mechanical', cache: mechanical.cache },
      { sourceId: 'dragon-controls', cache: controls.cache },
    ]),
  );
  const backwards = compileProject(
    inputFor([
      { sourceId: 'dragon-controls', cache: controls.cache },
      { sourceId: 'dragon-mechanical', cache: mechanical.cache },
    ]),
  );

  assert.deepEqual(backwards, forwards, 'the whole project, not a summary of it');
  assert.deepEqual(
    [...backwards.generatedMel.workbookBytes],
    [...forwards.generatedMel.workbookBytes],
    'and the exported bytes with it',
  );
});

/* ----------------------------------------------- identity per source --- */

test('the per-source breakdown is published, in source order, and sums to the total', () => {
  const project = compileProject(
    inputFor([
      { sourceId: 'dragon-mechanical', cache: mechanical.cache },
      { sourceId: 'dragon-controls', cache: controls.cache },
    ]),
  );

  assert.equal(project.stats.sourceCount, 2);
  assert.deepEqual(project.stats.assetCountBySource, [
    { sourceId: 'dragon-controls', assetCount: 10 },
    { sourceId: 'dragon-mechanical', assetCount: 24 },
  ]);
  assert.equal(
    project.stats.assetCountBySource.reduce((total, entry) => total + entry.assetCount, 0),
    project.stats.assetCount,
  );
});

test('the property catalog is off unless a caller asks for it', () => {
  // It is one streaming pass per cache for a value nothing downstream reads, so
  // a compile that did not ask does not pay for it.
  const universe = [
    { sourceId: 'dragon-mechanical', cache: mechanical.cache },
    { sourceId: 'dragon-controls', cache: controls.cache },
  ];
  assert.deepEqual(compileProject(inputFor(universe)).propertyCatalog, []);
  assert.deepEqual(
    compileProject(inputFor(universe, { includePropertyCatalog: false })).propertyCatalog,
    [],
  );
  assert.ok(
    compileProject(inputFor(universe, { includePropertyCatalog: true })).propertyCatalog.length > 0,
  );

  // The stats a screen 8 reads are unaffected either way: the per-source
  // breakdown comes off the asset catalog, not off this stage.
  const without = compileProject(inputFor(universe)).stats;
  const with_ = compileProject(inputFor(universe, { includePropertyCatalog: true })).stats;
  assert.equal(without.sourceCount, with_.sourceCount);
  assert.deepEqual(without.assetCountBySource, with_.assetCountBySource);
});

test('the property catalog aggregates the universe and keeps the per-source coverage', () => {
  // P0-1: "Property Catalog aggregates across sources with per-source + overall
  // coverage." 60% overall means something different when one source is at 100%
  // and another at 0%, so neither number is derivable from the other.
  const project = compileProject(
    inputFor(
      [
        { sourceId: 'dragon-mechanical', cache: mechanical.cache },
        { sourceId: 'dragon-controls', cache: controls.cache },
      ],
      { includePropertyCatalog: true },
    ),
  );

  const tag = project.propertyCatalog.find(
    (entry) => entry.category === 'Dragon Data' && entry.name === 'Tag',
  );
  assert.ok(tag !== undefined, 'the mapped tag property is in the catalog');
  assert.deepEqual([...tag.bySource.keys()], ['dragon-controls', 'dragon-mechanical']);
  assert.equal(
    tag.objectCount,
    tag.bySource.get('dragon-controls').objectCount +
      tag.bySource.get('dragon-mechanical').objectCount,
    'the overall count is the sum of the per-source ones',
  );

  // `Dragon Data > Service` is written on mechanical equipment and on nothing in
  // the controls model, which is exactly the shape the per-source split exists
  // to show.
  const service = project.propertyCatalog.find(
    (entry) => entry.category === 'Dragon Data' && entry.name === 'Service',
  );
  assert.ok(service.bySource.get('dragon-mechanical').objectCount > 0);
  assert.equal(service.bySource.get('dragon-controls'), undefined);
});

test('the model tree never suggests a parent from another source', () => {
  // Two registrations of the same file, so every object ordinal exists twice.
  // A walk that climbed one shared `objectId -> assetId` map would resolve
  // object 3 of one source against object 3 of the other and report a nesting
  // no model drew.
  const project = compileProject(
    inputFor([
      { sourceId: 'skid-a', cache: skidA.cache },
      { sourceId: 'skid-b', cache: skidB.cache },
    ]),
  );

  const sourceOf = new Map(project.catalog.assets.map((asset) => [asset.assetId, asset.sourceId]));
  const suggestions = project.compileSubjects.filter(
    (subject) => subject.modelTreeParentId !== undefined,
  );
  assert.ok(suggestions.length > 0, 'the fixture really does nest equipment inside equipment');
  for (const subject of suggestions) {
    assert.equal(
      sourceOf.get(subject.modelTreeParentId),
      sourceOf.get(subject.assetId),
      `${subject.assetId} was placed inside an asset from another source`,
    );
  }

  // And the count is the one-source answer twice, so nothing was lost either.
  const single = compileProject(inputFor([{ sourceId: 'skid-a', cache: skidA.cache }]));
  assert.equal(
    suggestions.length,
    single.compileSubjects.filter((subject) => subject.modelTreeParentId !== undefined).length * 2,
  );
});

test('the property bag of an asset is read from its own source', () => {
  // `Dragon Data > Service` is written on mechanical equipment and on no
  // controls object. If the seam read every asset against one cache, the
  // controls assets would inherit whatever the mechanical object of the same
  // ordinal happened to state.
  const project = compileProject(
    inputFor([
      { sourceId: 'dragon-mechanical', cache: mechanical.cache },
      { sourceId: 'dragon-controls', cache: controls.cache },
    ]),
  );

  const subjectOf = new Map(project.subjects.map((subject) => [subject.assetId, subject]));
  assert.equal(
    subjectOf.get('tag:MAH001-10-01').properties.get('Dragon Data').get('Service'),
    'Chilled Water',
  );
  assert.equal(
    subjectOf.get('tag:PLC001-10-01').properties.get('Dragon Data').has('Service'),
    false,
    'the controls model states no Service, and nothing invents one for it',
  );
  assert.equal(subjectOf.get('tag:MAH001-10-01').sourceFile, 'Dragon-Mechanical.nwc');
  assert.equal(subjectOf.get('tag:PLC001-10-01').sourceFile, 'Dragon-Controls.nwc');
});

/* ----------------------------------------------- same basename, duplicates --- */

test('two sources sharing one file name both contribute their assets', () => {
  // Hard gate 4. Sites really do ship `Level 1.nwc` from four consultants, and
  // keying anything on the file name loses three of them. Both caches below
  // call themselves `Dragon-Area.nwd`.
  const shared = 'Dragon-Area.nwd';
  const project = compileProject(
    inputFor([
      { sourceId: 'area-mech', cache: mechanical.cache, rawFileName: shared },
      { sourceId: 'area-ctrl', cache: controls.cache, rawFileName: shared },
    ]),
  );

  assert.equal(project.stats.assetCount, 34, 'neither source is dropped or overwritten');
  assert.deepEqual(project.stats.assetCountBySource, [
    { sourceId: 'area-ctrl', assetCount: 10 },
    { sourceId: 'area-mech', assetCount: 24 },
  ]);
  assert.equal(
    project.stats.duplicateTagCount,
    0,
    'two different areas that share a file name share no tags',
  );
});

test('one tag on two sources is one duplicate review item naming both, and both readings survive', () => {
  const project = compileProject(
    inputFor([
      { sourceId: 'mech', cache: mechanical.cache },
      { sourceId: 'ctrl', cache: controlsClash.cache },
    ]),
  );

  assert.equal(project.stats.assetCount, 35, 'the clash object is an asset like any other');
  assert.equal(project.stats.duplicateTagCount, 1);

  const duplicates = project.reviewItems.filter((item) => item.kind === 'duplicate-model-tag');
  assert.equal(duplicates.length, 1, 'one tag on two sources is one decision, not two');
  assert.equal(duplicates[0].canonicalTag, 'MAH001-10-01');
  assert.deepEqual(
    duplicates[0].sources.map((source) => source.sourceId),
    ['ctrl', 'mech'],
    'the item names the sources, because an object id alone cannot be navigated to',
  );

  // §9.3: a duplicate is reported, never resolved by discarding one side. Both
  // asset ids name their source, because the tag no longer identifies one thing.
  const claimants = project.catalog.assets.filter(
    (asset) => asset.canonicalTag === 'MAH001-10-01',
  );
  assert.equal(claimants.length, 2);
  assert.deepEqual(
    claimants.map((asset) => asset.assetId).sort(),
    ['tag:MAH001-10-01#ctrl/77', 'tag:MAH001-10-01#mech/3'],
  );
  assert.ok(claimants.every((asset) => asset.status === 'DUPLICATE_MODEL_TAG'));
});

test('a tag duplicated across sources writes two distinguishable MEL rows', () => {
  const project = compileProject(
    inputFor([
      { sourceId: 'mech', cache: mechanical.cache },
      { sourceId: 'ctrl', cache: controlsClash.cache },
    ]),
  );

  const rows = project.generatedMel.rows.filter((row) => row.equipmentTag === 'MAH001-10-01');
  assert.equal(rows.length, 2, 'neither reading is merged away on the way to the MEL');
  assert.ok(rows.every((row) => row.inclusionStatus === 'DUPLICATE_MODEL_TAG'));
  assert.deepEqual(
    rows.map((row) => `${row.sourceModel}#${row.modelObjectId}`).sort(),
    ['Dragon-Controls.nwc#77', 'Dragon-Mechanical.nwc#3'],
    'the two rows say which document each one was read from, and which object',
  );
});

test('the same file registered twice duplicates every tag it carries', () => {
  // The degenerate case, and the one a person is most likely to create by
  // accident: the same NWD added under two source ids. Every tag it carries is
  // then claimed twice, and none of the 24 is quietly dropped.
  const project = compileProject(
    inputFor([
      { sourceId: 'mech-a', cache: mechanical.cache },
      { sourceId: 'mech-b', cache: mechanicalTwin.cache },
    ]),
  );

  assert.equal(project.stats.assetCount, 48);
  assert.equal(project.stats.duplicateTagCount, 24);

  const duplicate = project.reviewItems.find(
    (item) => item.kind === 'duplicate-model-tag' && item.canonicalTag === 'MAH001-10-01',
  );
  assert.deepEqual(duplicate.sources, [
    { sourceId: 'mech-a', objectIds: [3] },
    { sourceId: 'mech-b', objectIds: [3] },
  ]);
  assert.deepEqual(
    duplicate.objectIds,
    [3, 3],
    'the flat list repeats the ordinal, which is why it cannot be the identity',
  );
});

/* ------------------------------------------------------ refusing a universe --- */

test('two sources under one id are refused rather than silently merged', () => {
  assert.throws(
    () =>
      compileProject(
        inputFor([
          { sourceId: 'dragon', cache: mechanical.cache },
          { sourceId: 'dragon', cache: controls.cache },
        ]),
      ),
    /duplicate-source-id|dragon/,
  );
});

test('a blank source id is refused: an asset it produced could not be addressed', () => {
  assert.throws(() => compileProject(inputFor([{ sourceId: '', cache: mechanical.cache }])));
});
