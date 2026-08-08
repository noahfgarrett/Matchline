/**
 * The boundary fold, worked out on paper first (PRODUCT.md §11.3, §11.4,
 * DECISIONS.md #1).
 *
 * The first test is the acceptance case for the whole phase: §2.5's panel and
 * RIO, verbatim, with the exit criterion "RIO cross-System relationship becomes
 * a dependency" asserted directly.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { compileSnapshot } from '../dist/index.js';
import {
  BUILDING,
  buildingOnlyHierarchy,
  claim,
  claims,
  dependency,
  DISCIPLINE,
  DISCIPLINE_BOUNDARY_HIERARCHY,
  DRAGON_HIERARCHY,
  FAMILY_INPUT,
  MAH,
  PANEL,
  PLC,
  RIO,
  RIO_INPUT,
  subject,
  SYSTEM,
  TIT,
  VFD,
} from './dist/dragon.fixture.js';

test('PRODUCT.md §2.5: the panel in 603 becomes a dependency of the RIO in 650', () => {
  const snapshot = compileSnapshot(RIO_INPUT);

  const rio = snapshot.nodes.get(RIO);
  // The relationship remains real, it just stops nesting.
  assert.equal(rio.parent.status, 'root');
  assert.equal(rio.parent.parentAssetId, null);
  assert.equal(rio.parent.ladderSource, null);
  assert.deepEqual(rio.parent.demotedFrom, { parentAssetId: PANEL, boundaryLevelId: 'system' });

  // The panel is listed as a dependency: the flow edge's own POWERS relation,
  // plus the DEPENDENCY the fold created when it took the parent away.
  assert.deepEqual(
    rio.dependencies.map((entry) => `${entry.parentAssetId}:${entry.relationshipType}`),
    [`${PANEL}:DEPENDENCY`, `${PANEL}:POWERS`],
  );

  // The RIO roots in System 650, not in 603.
  assert.deepEqual(rio.levelPath, [
    { levelId: 'building', value: 'D1' },
    { levelId: 'discipline', value: 'Electrical' },
    { levelId: 'system', value: '650' },
  ]);

  // Nothing was discarded: the claim that proposed the nesting is retained.
  assert.deepEqual(
    rio.losingClaims.map((entry) => `${entry.targetAssetId}@${entry.ladderSource}`),
    [`${PANEL}@flow-family`],
  );

  assert.equal(snapshot.nodes.get(PANEL).parent.status, 'root');
  assert.equal(snapshot.stats.demotedToDependencyCount, 1);
  assert.equal(snapshot.stats.rootCount, 2);
  assert.deepEqual(snapshot.reviewItems, []);
});

test('the demotion dependency records the fold, and the demoted claim keeps its own provenance', () => {
  const snapshot = compileSnapshot(RIO_INPUT);
  const rio = snapshot.nodes.get(RIO);

  const demoted = rio.dependencies.find((entry) => entry.relationshipType === 'DEPENDENCY');
  assert.equal(demoted.provenance.rule, 'ssm.boundaryDemotion');
  assert.equal(demoted.provenance.sourceRef.row, 12);
  assert.equal(rio.losingClaims[0].provenance.rule, 'relate.flowAnchoredFamily');
});

test('PRODUCT.md §11.2: MAH/PLC/VFD/TIT resolve within one system, chain intact', () => {
  const snapshot = compileSnapshot(FAMILY_INPUT);

  assert.equal(snapshot.nodes.get(MAH).parent.status, 'root');
  assert.equal(snapshot.nodes.get(PLC).parent.parentAssetId, MAH);
  assert.equal(snapshot.nodes.get(VFD).parent.parentAssetId, PLC);
  assert.equal(snapshot.nodes.get(TIT).parent.parentAssetId, VFD);
  assert.equal(snapshot.nodes.get(TIT).parent.ladderSource, 'family-role');

  assert.deepEqual(snapshot.stats, {
    nodeCount: 4,
    rootCount: 1,
    demotedToDependencyCount: 0,
    unresolvedCount: 0,
    cycleCount: 0,
    ambiguousCount: 0,
  });
  assert.deepEqual(snapshot.reviewItems, []);
});

/** A PLC that is electrically native but commissioned under a Mechanical Dry MAH. */
const CROSS_DISCIPLINE_SUBJECTS = [
  subject(MAH, { [BUILDING]: 'D1', [DISCIPLINE]: 'Mechanical Dry', [SYSTEM]: '001' }),
  subject(PLC, { [BUILDING]: 'D1', [DISCIPLINE]: 'Electrical', [SYSTEM]: '001' }),
];
const CROSS_DISCIPLINE_CLAIMS = claims({ structural: [claim('flow-family', PLC, MAH)] });

test('§11.4: a display-only discipline difference keeps the structural parent', () => {
  const snapshot = compileSnapshot({
    subjects: CROSS_DISCIPLINE_SUBJECTS,
    claims: CROSS_DISCIPLINE_CLAIMS,
    hierarchy: DRAGON_HIERARCHY,
  });

  const plc = snapshot.nodes.get(PLC);
  assert.equal(plc.parent.status, 'resolved');
  assert.equal(plc.parent.parentAssetId, MAH);
  assert.equal(plc.parent.demotedFrom, undefined);
  // Native and SSM discipline stay separate: the PLC still reads Electrical.
  assert.equal(plc.levelPath[1].value, 'Electrical');
  assert.equal(snapshot.stats.demotedToDependencyCount, 0);
});

test('§11.4: the same difference demotes once discipline is an enabled boundary', () => {
  const snapshot = compileSnapshot({
    subjects: CROSS_DISCIPLINE_SUBJECTS,
    claims: CROSS_DISCIPLINE_CLAIMS,
    hierarchy: DISCIPLINE_BOUNDARY_HIERARCHY,
  });

  const plc = snapshot.nodes.get(PLC);
  assert.equal(plc.parent.status, 'root');
  assert.deepEqual(plc.parent.demotedFrom, { parentAssetId: MAH, boundaryLevelId: 'discipline' });
  assert.deepEqual(
    plc.dependencies.map((entry) => entry.relationshipType),
    ['DEPENDENCY'],
  );
  assert.equal(snapshot.stats.demotedToDependencyCount, 1);
});

const CHILD = 'asset-child';
const PARENT = 'asset-parent';

/** The parent's building was never stated. Nothing may substitute for it. */
function missingBuildingInput(policy) {
  return {
    subjects: [subject(CHILD, { [BUILDING]: 'D1' }), subject(PARENT, {})],
    claims: claims({ structural: [claim('flow-family', CHILD, PARENT)] }),
    hierarchy: buildingOnlyHierarchy(policy),
  };
}

test("missingValuePolicy 'review': unknown boundary leaves the child unresolved", () => {
  const snapshot = compileSnapshot(missingBuildingInput('review'));

  const child = snapshot.nodes.get(CHILD);
  assert.equal(child.parent.status, 'unresolved');
  assert.equal(child.parent.parentAssetId, null);
  // The claim is not kept -- it is retained as evidence, not as a decision.
  assert.equal(child.losingClaims.length, 1);
  assert.deepEqual(snapshot.reviewItems, [
    { kind: 'missing-boundary', assetId: PARENT, levelId: 'building' },
  ]);
  assert.equal(snapshot.stats.unresolvedCount, 1);
  // 'review' refuses to bucket the asset, so the level path stays blank.
  assert.deepEqual(snapshot.nodes.get(PARENT).levelPath, [{ levelId: 'building', value: '' }]);
});

test("missingValuePolicy 'provisional-root': the child roots, flagged", () => {
  const snapshot = compileSnapshot(missingBuildingInput('provisional-root'));

  assert.equal(snapshot.nodes.get(CHILD).parent.status, 'provisional-root');
  assert.equal(snapshot.stats.rootCount, 2);
  assert.equal(snapshot.stats.unresolvedCount, 0);
  assert.deepEqual(snapshot.reviewItems, [
    { kind: 'missing-boundary', assetId: PARENT, levelId: 'building' },
  ]);
});

test("missingValuePolicy 'unassigned-group': the asset is bucketed, the parent is still not kept", () => {
  const snapshot = compileSnapshot(missingBuildingInput('unassigned-group'));

  const child = snapshot.nodes.get(CHILD);
  assert.equal(child.parent.status, 'root');
  assert.equal(child.parent.parentAssetId, null);
  assert.equal(child.losingClaims.length, 1);
  // The sentinel is a display bucket, never a value the fold could match on.
  assert.deepEqual(snapshot.nodes.get(PARENT).levelPath, [
    { levelId: 'building', value: '(unassigned)' },
  ]);
  assert.deepEqual(snapshot.reviewItems, [
    { kind: 'missing-boundary', assetId: PARENT, levelId: 'building' },
  ]);
});

test('unknown never equals unknown: two unstated buildings do not nest', () => {
  const snapshot = compileSnapshot({
    subjects: [subject(CHILD, {}), subject(PARENT, {})],
    claims: claims({ structural: [claim('flow-family', CHILD, PARENT)] }),
    hierarchy: buildingOnlyHierarchy('unassigned-group'),
  });

  assert.equal(snapshot.nodes.get(CHILD).parent.parentAssetId, null);
  // Both sides lacked the value, and the review item names both.
  assert.deepEqual(snapshot.reviewItems, [
    { kind: 'missing-boundary', assetId: CHILD, levelId: 'building' },
    { kind: 'missing-boundary', assetId: PARENT, levelId: 'building' },
  ]);
});

test('a blank attribute is unstated, not a value two assets can share', () => {
  const snapshot = compileSnapshot({
    subjects: [subject(CHILD, { [BUILDING]: '' }), subject(PARENT, { [BUILDING]: '' })],
    claims: claims({ structural: [claim('flow-family', CHILD, PARENT)] }),
    hierarchy: buildingOnlyHierarchy('review'),
  });

  assert.equal(snapshot.nodes.get(CHILD).parent.status, 'unresolved');
});

test('a definite difference outranks an unknown at a different level', () => {
  // Building differs (D1 vs D2) and system is unstated on the parent. The parent
  // is wrong whatever the system would have said, so the fold demotes.
  const snapshot = compileSnapshot({
    subjects: [
      subject(CHILD, { [BUILDING]: 'D1', [SYSTEM]: '001' }),
      subject(PARENT, { [BUILDING]: 'D2' }),
    ],
    claims: claims({ structural: [claim('flow-family', CHILD, PARENT)] }),
    hierarchy: DRAGON_HIERARCHY,
  });

  const child = snapshot.nodes.get(CHILD);
  assert.deepEqual(child.parent.demotedFrom, {
    parentAssetId: PARENT,
    boundaryLevelId: 'building',
  });
  assert.equal(snapshot.reviewItems.length, 0);
});

test('dependencies are additive, deduped by upstream asset and type, and never fold', () => {
  const snapshot = compileSnapshot({
    subjects: [
      subject(CHILD, { [BUILDING]: 'D1', [SYSTEM]: '001' }),
      subject(PARENT, { [BUILDING]: 'D2', [SYSTEM]: '900' }),
    ],
    claims: claims({
      dependencies: [
        dependency(CHILD, PARENT, 'POWERS'),
        dependency(CHILD, PARENT, 'POWERS'),
        dependency(CHILD, PARENT, 'CONTROLS'),
      ],
    }),
    hierarchy: DRAGON_HIERARCHY,
  });

  // A cross-building dependency is simply a dependency. It is never demoted,
  // never conflicts, and never affects the parent decision.
  assert.deepEqual(
    snapshot.nodes.get(CHILD).dependencies.map((entry) => entry.relationshipType),
    ['CONTROLS', 'POWERS'],
  );
  assert.equal(snapshot.nodes.get(CHILD).parent.status, 'root');
});
