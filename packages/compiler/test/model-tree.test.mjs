/**
 * The model tree's ancestry suggestion (PRODUCT.md §11.1 tier 8).
 *
 * The weakest rung on the ladder, and the only one assembled by the orchestrator
 * rather than by `@matchline/relationship-claims`: the tree lives in the
 * extraction cache, which no other package reads.
 *
 * The scenario is `nestedSkid` in `support.mjs`, added to this test's own copy of
 * the Dragon cache:
 *
 * ```text
 * Dragon-Mechanical.nwc
 * +- D1
 * |  +- SKD001-10-01
 * |     +- Skid Frame            (untagged)
 * |        +- PMP001-10-01
 * |           +- VLV001-10-01    (class `Valve`)
 * +- YRD001-10-01
 * ```
 *
 * Four tagged objects join the 34 base Dragon assets, so this cache compiles 38.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { EVIDENCE_TIER } from '@matchline/domain';

import { compileProject } from '../dist/index.js';
import {
  fullInput,
  idOf,
  nestedSkid,
  openDragonCache,
  siteProfile,
} from './support.mjs';

let handle = null;
let project = null;

before(() => {
  handle = openDragonCache('model-tree', nestedSkid);
  project = compileProject(fullInput(handle.cache));
});

after(() => {
  handle?.close();
});

/** One asset's `modelTreeParentId`, or `undefined` when it carries none. */
function suggestionFor(compiled, tag) {
  const subject = compiled.compileSubjects.find((candidate) => candidate.assetId === idOf(tag));
  assert.ok(subject, `no compile subject for ${tag}`);
  return subject.modelTreeParentId;
}

test('the walk climbs past untagged ancestors and stops at the first object another asset owns', () => {
  assert.equal(project.stats.assetCount, 38);

  // `Skid Frame` carries no tag, so no asset owns it and the climb continues
  // through it to the skid.
  assert.equal(suggestionFor(project, 'PMP001-10-01'), idOf('SKD001-10-01'));
});

test('the nearest asset ancestor wins when the model nests two of them above one asset', () => {
  // VLV001-10-01 sits inside PMP001-10-01, which sits inside SKD001-10-01. The
  // outer one is what the inner one sits inside; claiming it here would skip a
  // level the model actually drew.
  assert.equal(suggestionFor(project, 'VLV001-10-01'), idOf('PMP001-10-01'));
});

test('an asset with no asset ancestor carries no suggestion, root representative or not', () => {
  // Nothing above the skid but the building layer and the file node.
  assert.equal(suggestionFor(project, 'SKD001-10-01'), undefined);
  // The yard item IS a root object: the climb ends before it starts.
  assert.equal(suggestionFor(project, 'YRD001-10-01'), undefined);
  // And the whole base fixture is flat -- every tagged object is a sibling under
  // its building layer -- so no base asset gains a suggestion either.
  assert.equal(suggestionFor(project, 'MAH001-10-01'), undefined);
  assert.equal(suggestionFor(project, 'PLC001-10-01'), undefined);
});

test('the suggestion competes on the ladder as a model-tree claim and places the asset', () => {
  const pump = project.snapshot.nodes.get(idOf('PMP001-10-01'));
  assert.equal(pump.parent.status, 'resolved');
  assert.equal(pump.parent.parentAssetId, idOf('SKD001-10-01'));
  assert.equal(pump.parent.ladderSource, 'model-tree');
  assert.equal(pump.parent.winningClaim.kind, 'structural-parent');
  // Derived by rule from the tree's own shape, not stated by any source.
  assert.equal(pump.parent.winningClaim.evidenceTier, EVIDENCE_TIER.INFERRED);
  assert.equal(pump.parent.winningClaim.source, 'MODEL');

  const valve = project.snapshot.nodes.get(idOf('VLV001-10-01'));
  assert.equal(valve.parent.parentAssetId, idOf('PMP001-10-01'));
  assert.equal(valve.parent.ladderSource, 'model-tree');

  // 38 assets, six of them placed: the four the base fixture nests plus these
  // two. The skid and the yard item root.
  assert.equal(project.snapshot.stats.nodeCount, 38);
  assert.equal(project.snapshot.stats.rootCount, 32);
  assert.equal(project.snapshot.stats.demotedToDependencyCount, 0);

  // Tier 8 is the weakest rung there is: the assets the base fixture places on
  // real evidence still get that evidence, not this.
  assert.equal(
    project.snapshot.nodes.get(idOf('PLC001-10-01')).parent.ladderSource,
    'flow-family',
  );

  // The decision reaches the generated MEL like any other.
  const row = project.generatedMel.rows.find((entry) => entry.equipmentTag === 'PMP001-10-01');
  assert.equal(row.systemParentEquipmentTag, 'SKD001-10-01');
  assert.equal(row.parentEvidence, 'model-tree');
});

test('component collapse needs no special case: an absorbed ancestor resolves to the asset that absorbed it', () => {
  // `Valve` escapes collapse, so PMP001-10-01 is absorbed into SKD001-10-01 and
  // VLV001-10-01 stays an asset whose parent OBJECT belongs to the skid.
  const collapsed = compileProject(
    fullInput(handle.cache, {
      profile: siteProfile({
        assetFilters: {
          requireTagProperty: true,
          collapseComponents: true,
          separatelyCommissionableClasses: ['Valve'],
        },
      }),
    }),
  );

  // 38 minus the absorbed pump.
  assert.equal(collapsed.stats.assetCount, 37);
  assert.equal(
    collapsed.catalog.assets.some((asset) => asset.canonicalTag === 'PMP001-10-01'),
    false,
  );
  const skid = collapsed.catalog.assets.find((asset) => asset.canonicalTag === 'SKD001-10-01');
  assert.equal(skid.objectIds.length, 2, 'the skid owns its own object and the pump it absorbed');

  // The climb hits the pump object, which now belongs to the skid -- the same
  // answer walking past it to the skid's own object would have given.
  assert.equal(suggestionFor(collapsed, 'VLV001-10-01'), idOf('SKD001-10-01'));
  assert.equal(suggestionFor(collapsed, 'SKD001-10-01'), undefined);
  assert.equal(
    collapsed.snapshot.nodes.get(idOf('VLV001-10-01')).parent.parentAssetId,
    idOf('SKD001-10-01'),
  );
});
