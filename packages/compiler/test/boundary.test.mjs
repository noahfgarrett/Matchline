/**
 * PRODUCT.md §2.5's own example, compiled end to end.
 *
 * > - Electrical panel System Key = 603
 * > - RIO System Key = 650
 * > - Electrical Flow retains panel -> RIO
 * > - SSM Hierarchy places the RIO in System 650 with the panel listed as a
 * >   dependency
 *
 * `@matchline/ssm-compiler` proves the fold against a fixture; what this file
 * proves is that a real compile still reaches it. Everything between the
 * spreadsheet and the fold has to hold for that: the connectivity import has to
 * read the row, identity has to match both tags, the resolver has to give the
 * two assets different system keys, and claims assembly has to call the edge
 * STRUCTURAL rather than a plain dependency. Only then is there a nesting for
 * the boundary to take away.
 *
 * The scenario is `rioPanel` in `support.mjs`: `PNL603-10-01` (UPN 603) and
 * `RIO603-10-01` (UPN 650), siblings under the D1 controls layer. Both tags
 * carry the family key `603-10-01`, and the taught `PNL -> RIO` pairing makes
 * the feed between them a structural claim.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { compileProject } from '../dist/index.js';
import {
  connectivityWorkbooks,
  HIERARCHY,
  idOf,
  melWorkbook,
  oneSource,
  openDragonCache,
  RIO_RESOLVER,
  RIO_ROLE_GRAPH,
  rioPanel,
  siteProfile,
} from './support.mjs';

const PANEL = idOf('PNL603-10-01');
const RIO = idOf('RIO603-10-01');

let handle = null;
let project = null;

before(() => {
  handle = openDragonCache('boundary', rioPanel);
  project = compileProject({
    sources: oneSource(handle.cache),
    profile: siteProfile({ systemResolver: RIO_RESOLVER }),
    hierarchy: HIERARCHY,
    roleGraph: RIO_ROLE_GRAPH,
    melWorkbook: melWorkbook(),
    connectivityWorkbooks: connectivityWorkbooks([['PNL603-10-01', 'RIO603-10-01']]),
  });
});

after(() => {
  handle?.close();
});

test('the panel and the RIO are one family in two systems, and the feed between them is a nesting claim', () => {
  // 34 base Dragon assets plus the two.
  assert.equal(project.stats.assetCount, 36);
  assert.equal(project.systems.bySubject.get(PANEL).resolution.systemKey, '603');
  assert.equal(project.systems.bySubject.get(RIO).resolution.systemKey, '650');

  // Same family key, taught pairing, real connectivity: the strongest evidence
  // rung there is short of a person. Without this the fold would have nothing to
  // take away and the test below would pass for the wrong reason.
  const claim = project.claims.structural.find((entry) => entry.subjectAssetId === RIO);
  assert.equal(claim.targetAssetId, PANEL);
  assert.equal(claim.ladderSource, 'flow-family');
  assert.equal(claim.kind, 'structural-parent');
});

test('the system boundary demotes the panel: the RIO roots in 650 and lists the panel as a dependency', () => {
  assert.ok(
    project.snapshot.stats.demotedToDependencyCount >= 1,
    'the cross-system nesting must be folded away',
  );
  // Exactly one: nothing else in Dragon proposes a parent across a boundary.
  assert.equal(project.snapshot.stats.demotedToDependencyCount, 1);

  const rio = project.snapshot.nodes.get(RIO);
  assert.equal(rio.parent.status, 'root');
  assert.equal(rio.parent.parentAssetId, null);
  assert.equal(rio.parent.ladderSource, null);
  // Which parent went, and which boundary took it.
  assert.deepEqual(rio.parent.demotedFrom, { parentAssetId: PANEL, boundaryLevelId: 'system' });

  // "The relationship remains real": the panel is listed, not deleted. Twice
  // over -- as the POWERS feed connectivity stated, and as the DEPENDENCY the
  // fold left behind in place of the nesting.
  assert.deepEqual(
    rio.dependencies.map((dependency) => dependency.parentAssetId),
    [PANEL, PANEL],
  );
  assert.deepEqual(
    rio.dependencies.map((dependency) => dependency.relationshipType).sort(),
    ['DEPENDENCY', 'POWERS'],
  );
  // Nothing is discarded: the claim the fold refused is retained as evidence.
  assert.deepEqual(
    rio.losingClaims.map((claim) => `${claim.ladderSource}:${claim.targetAssetId}`),
    [`flow-family:${PANEL}`],
  );

  // The generated MEL says the same thing: no parent, the panel as a dependency.
  const row = project.generatedMel.rows.find((entry) => entry.equipmentTag === 'RIO603-10-01');
  assert.equal(row.systemParentEquipmentTag, '');
  assert.equal(row.dependencies, 'PNL603-10-01');
});

test('the RIO roots inside System 650 while the panel stays in 603', () => {
  const d1 = project.tree.levels.find((level) => level.value === 'D1');
  // 650 is a grouping of its own, and it exists only because the RIO is in it.
  assert.deepEqual(
    d1.levels.map((level) => level.value),
    ['001', '002', '603', '650'],
  );

  const system650 = d1.levels.find((level) => level.value === '650');
  assert.deepEqual(
    system650.assets.map((asset) => asset.assetId),
    [RIO],
  );
  assert.equal(system650.assets[0].status, 'root');

  // The panel is a top-of-grouping asset in 603, with no RIO nested under it.
  const system603 = d1.levels.find((level) => level.value === '603');
  const panel = system603.assets.find((asset) => asset.assetId === PANEL);
  assert.deepEqual(panel.children, []);
});

test('the Electrical Flow projection is unaffected by the fold: the panel still feeds the RIO', () => {
  // §10: the flow is a projection of what the documents state, and the SSM
  // boundary is never applied to it. The edge the hierarchy refused is here.
  const edge = project.flow.edges.find(
    (candidate) => candidate.fromNodeId === PANEL && candidate.toNodeId === RIO,
  );
  assert.ok(edge, 'the panel -> RIO feed must survive in the flow');
  assert.equal(edge.relationshipType, 'POWERS');

  assert.equal(project.flow.nodes.get(PANEL).assetId, PANEL);
  assert.equal(project.flow.nodes.get(RIO).assetId, RIO);
  // Both ends keep their own system on the projection, boundary or no boundary.
  assert.equal(project.flow.nodes.get(PANEL).enrichment.systemKey, '603');
  assert.equal(project.flow.nodes.get(RIO).enrichment.systemKey, '650');
});
