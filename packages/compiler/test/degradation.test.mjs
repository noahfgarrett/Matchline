/**
 * What a compile does when a project is missing a document.
 *
 * A real site rarely arrives with everything. The compile must still finish and
 * still publish every stage -- degraded, and honestly so: no MEL means no System
 * Catalog and no system descriptions, not invented ones; no connectivity means
 * an empty flow projection, not a missing one.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { compileProject } from '../dist/index.js';
import {
  connectivityWorkbooks,
  fullInput,
  HIERARCHY,
  idOf,
  melWorkbook,
  oneSource,
  openDragonCache,
  ROLE_GRAPH,
  siteProfile,
} from './support.mjs';

let handle = null;

before(() => {
  handle = openDragonCache('degradation');
});

after(() => {
  handle?.close();
});

test('without a MEL there is no System Catalog, and the resolver still names every system from the model and the tag', () => {
  const project = compileProject({
    sources: oneSource(handle.cache),
    profile: siteProfile(),
    hierarchy: HIERARCHY,
    roleGraph: ROLE_GRAPH,
    connectivityWorkbooks: connectivityWorkbooks(),
  });

  assert.deepEqual(project.melRows, []);
  assert.equal(project.systemCatalog.size, 0);
  assert.equal(project.stats.systemCatalogSize, 0);

  // The key chain needs no MEL, so every asset still resolves.
  assert.equal(project.stats.resolvedSystemCount, 34);
  const mah = project.systems.bySubject.get(idOf('MAH001-10-01'));
  assert.equal(mah.resolution.systemKey, '001');
  // The description chain is a single MEL join, and there is nothing to join
  // to: absent, not blank, and no claim pretending otherwise.
  assert.equal(mah.resolution.systemDescription, undefined);
  assert.equal(mah.descriptionClaim, null);
  assert.ok(mah.skippedRungs.some((rung) => rung.chain === 'descriptionChain'));

  // The hierarchy groups by systemKey, which survived, so the tree is unchanged.
  assert.deepEqual(
    project.tree.levels[0].levels.map((level) => level.value),
    ['001', '002', '603'],
  );
  // The MEL's own review item is the only one that disappears.
  assert.equal(
    project.reviewItems.some((item) => item.kind === 'system-catalog-conflict'),
    false,
  );
});

test('a tag-segment-only resolver carries the whole system stage on its own', () => {
  const project = compileProject({
    sources: oneSource(handle.cache),
    profile: siteProfile({
      systemResolver: {
        keyChain: [{ kind: 'tag-segment', segment: 'system' }],
        descriptionChain: [],
        normalization: [],
        conflictPolicy: 'review',
      },
    }),
    hierarchy: HIERARCHY,
  });

  const mah = project.systems.bySubject.get(idOf('MAH001-10-01'));
  assert.equal(mah.resolution.systemKey, '001');
  assert.equal(mah.keyClaim.component, 'tag-segment');
  assert.equal(mah.agreement, 'single-source');
  assert.equal(project.stats.resolvedSystemCount, 34);
});

test('without connectivity the flow projection is empty and the family+role rung still builds the same four nestings', () => {
  const project = compileProject({
    sources: oneSource(handle.cache),
    profile: siteProfile(),
    hierarchy: HIERARCHY,
    roleGraph: ROLE_GRAPH,
    melWorkbook: melWorkbook(),
  });

  assert.deepEqual(project.connectivityReports, []);
  assert.deepEqual(project.observations, []);
  assert.equal(project.flow.stats.nodeCount, 0);
  assert.equal(project.flow.stats.edgeCount, 0);
  assert.deepEqual(project.flow.roots, []);
  assert.deepEqual(project.flow.reviewItems, []);

  // Nothing anchors a family now, so every nesting arrives on the weaker rung:
  // MAH->PLC and PLC->VFD once per building.
  assert.equal(project.stats.structuralClaimCount, 4);
  assert.equal(project.stats.dependencyClaimCount, 0);
  assert.ok(project.claims.structural.every((claim) => claim.ladderSource === 'family-role'));

  // The same four assets are placed, by weaker evidence, over the same tree.
  assert.equal(project.snapshot.stats.nodeCount, 34);
  assert.equal(project.snapshot.stats.rootCount, 30);
  assert.equal(project.snapshot.stats.unresolvedCount, 0);
  const plc = project.snapshot.nodes.get(idOf('PLC001-10-01'));
  assert.equal(plc.parent.parentAssetId, idOf('MAH001-10-01'));
  assert.equal(plc.parent.ladderSource, 'family-role');
  assert.deepEqual(plc.dependencies, []);
});

test('without a role graph nothing nests: connectivity still yields dependencies, and every asset roots', () => {
  const project = compileProject(fullInput(handle.cache, { roleGraph: undefined }));

  assert.equal(project.stats.structuralClaimCount, 0);
  // The four flow dependencies survive -- connectivity is always at least a
  // dependency, taught pairings or not (PRODUCT.md §8.2).
  assert.equal(project.stats.dependencyClaimCount, 4);
  assert.equal(project.snapshot.stats.rootCount, 34);
  assert.equal(project.snapshot.stats.nodeCount, 34);

  const plc = project.snapshot.nodes.get(idOf('PLC001-10-01'));
  assert.equal(plc.parent.status, 'root');
  assert.deepEqual(
    plc.dependencies.map((dependency) => dependency.parentAssetId),
    [idOf('MAH001-10-01')],
  );
});
