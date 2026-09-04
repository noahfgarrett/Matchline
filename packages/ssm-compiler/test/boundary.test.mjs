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
  // The rule-driven demotion is counted rather than silent: one row per (level,
  // rung), naming the children whose parents the level took away.
  assert.deepEqual(snapshot.reviewItems, [
    {
      kind: 'boundary-demotion',
      levelId: 'system',
      ladderSource: 'flow-family',
      pairCount: 1,
      exampleAssetIds: [RIO],
    },
  ]);
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

/* ---- P0-6: what a boundary compares ---- */

test('a boundary compares the key, so re-wording a system never demotes anything', () => {
  // The two agree on the System Key and disagree on the words, which is exactly
  // the state a re-typed description leaves a project in halfway through a
  // model revision. A boundary that compared the words would break the nesting.
  const subjects = [
    subject(MAH, { [SYSTEM]: '001', systemLabel: '001 Mechanical Dry Air Handling' }),
    subject(PLC, { [SYSTEM]: '001', systemLabel: '001 Mechanical Dry Air Handling (Zone 1)' }),
  ];
  const hierarchy = {
    levels: [
      {
        levelId: 'system',
        displayName: 'System',
        keyAttributeKey: SYSTEM,
        displayAttributeKey: 'systemLabel',
        boundary: true,
        missingValuePolicy: 'review',
        sort: 'key',
      },
    ],
  };

  const snapshot = compileSnapshot({
    subjects,
    claims: claims({ structural: [claim('flow-family', PLC, MAH)] }),
    hierarchy,
  });
  const plc = snapshot.nodes.get(PLC);
  assert.equal(plc.parent.status, 'resolved');
  assert.equal(plc.parent.parentAssetId, MAH);
  assert.deepEqual(snapshot.reviewItems, []);
});

test('boundaryAttributeKey is what the fold compares when a level names one', () => {
  // A site whose structural rule is the building, grouped and displayed by
  // something else. The two agree on the grouping key and differ on the
  // boundary attribute, and the boundary attribute is what decides.
  const subjects = [
    subject(MAH, { [SYSTEM]: '001', [BUILDING]: 'D1' }),
    subject(PLC, { [SYSTEM]: '001', [BUILDING]: 'D2' }),
  ];
  const hierarchy = {
    levels: [
      {
        levelId: 'system',
        displayName: 'System',
        keyAttributeKey: SYSTEM,
        boundaryAttributeKey: BUILDING,
        boundary: true,
        missingValuePolicy: 'review',
        sort: 'key',
      },
    ],
  };

  const snapshot = compileSnapshot({
    subjects,
    claims: claims({ structural: [claim('flow-family', PLC, MAH)] }),
    hierarchy,
  });
  const plc = snapshot.nodes.get(PLC);
  assert.deepEqual(plc.parent.demotedFrom, { parentAssetId: MAH, boundaryLevelId: 'system' });
  // Grouped by the key it was told to group by, all the same.
  assert.equal(plc.levelPath[0].value, '001');
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
  // One row for the level, counting the assets it left unplaced -- not one row
  // per asset per level, which is the queue nobody can work.
  assert.deepEqual(snapshot.reviewItems, [
    {
      kind: 'missing-boundary-level',
      levelId: 'building',
      assetCount: 1,
      exampleAssetIds: [CHILD],
    },
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
    {
      kind: 'missing-boundary-level',
      levelId: 'building',
      assetCount: 1,
      exampleAssetIds: [CHILD],
    },
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
    {
      kind: 'missing-boundary-level',
      levelId: 'building',
      assetCount: 1,
      exampleAssetIds: [CHILD],
    },
  ]);
});

test('unknown never equals unknown: two unstated buildings do not nest', () => {
  const snapshot = compileSnapshot({
    subjects: [subject(CHILD, {}), subject(PARENT, {})],
    claims: claims({ structural: [claim('flow-family', CHILD, PARENT)] }),
    hierarchy: buildingOnlyHierarchy('unassigned-group'),
  });

  assert.equal(snapshot.nodes.get(CHILD).parent.parentAssetId, null);
  // One asset went unplaced, whichever side of the pair was missing the value.
  assert.deepEqual(snapshot.reviewItems, [
    {
      kind: 'missing-boundary-level',
      levelId: 'building',
      assetCount: 1,
      exampleAssetIds: [CHILD],
    },
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
  assert.deepEqual(
    snapshot.reviewItems.map((item) => `${item.kind}:${item.levelId}`),
    ['boundary-demotion:building'],
  );
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

/* ------------------------------------------------- what a boundary compares */

test('D1 and d1 are one building: case never demotes a parent', () => {
  const snapshot = compileSnapshot({
    subjects: [subject(CHILD, { [BUILDING]: 'd1' }), subject(PARENT, { [BUILDING]: 'D1' })],
    claims: claims({ structural: [claim('flow-family', CHILD, PARENT)] }),
    hierarchy: buildingOnlyHierarchy('review'),
  });

  const child = snapshot.nodes.get(CHILD);
  assert.equal(child.parent.status, 'resolved');
  assert.equal(child.parent.parentAssetId, PARENT);
  assert.deepEqual(snapshot.reviewItems, []);
  // What the source wrote is what the level still groups and labels by: the
  // fold decides equality, and nothing else (P0-6).
  assert.equal(child.levelPath[0].value, 'd1');
  assert.equal(snapshot.nodes.get(PARENT).levelPath[0].value, 'D1');
});

test('padding, a non-breaking space and an en dash do not demote either', () => {
  const snapshot = compileSnapshot({
    subjects: [
      subject(CHILD, { [BUILDING]: ' D1 – North ' }),
      subject(PARENT, { [BUILDING]: 'D1 - north' }),
    ],
    claims: claims({ structural: [claim('flow-family', CHILD, PARENT)] }),
    hierarchy: buildingOnlyHierarchy('review'),
  });

  assert.equal(snapshot.nodes.get(CHILD).parent.parentAssetId, PARENT);
});

test('a value that is only whitespace is unstated, not a value two assets share', () => {
  const snapshot = compileSnapshot({
    subjects: [subject(CHILD, { [BUILDING]: '   ' }), subject(PARENT, { [BUILDING]: '   ' })],
    claims: claims({ structural: [claim('flow-family', CHILD, PARENT)] }),
    hierarchy: buildingOnlyHierarchy('review'),
  });

  assert.equal(snapshot.nodes.get(CHILD).parent.status, 'unresolved');
});

test('two genuinely different buildings still demote', () => {
  const snapshot = compileSnapshot({
    subjects: [subject(CHILD, { [BUILDING]: 'D1' }), subject(PARENT, { [BUILDING]: 'D2' })],
    claims: claims({ structural: [claim('flow-family', CHILD, PARENT)] }),
    hierarchy: buildingOnlyHierarchy('review'),
  });

  assert.equal(snapshot.nodes.get(CHILD).parent.parentAssetId, null);
  assert.equal(snapshot.nodes.get(CHILD).parent.demotedFrom.boundaryLevelId, 'building');
});

/* ------------------------------------------------------- counted aggregates */

test('a counted level names at most ten assets and counts every one of them', () => {
  const subjects = [subject(PARENT, {})];
  const structural = [];
  for (let index = 0; index < 25; index += 1) {
    const id = `asset-${String(index).padStart(2, '0')}`;
    subjects.push(subject(id, { [BUILDING]: 'D1' }));
    structural.push(claim('flow-family', id, PARENT, index + 1));
  }

  const snapshot = compileSnapshot({
    subjects,
    claims: claims({ structural }),
    hierarchy: buildingOnlyHierarchy('unassigned-group'),
  });

  assert.deepEqual(snapshot.reviewItems, [
    {
      kind: 'missing-boundary-level',
      levelId: 'building',
      assetCount: 25,
      exampleAssetIds: [
        'asset-00',
        'asset-01',
        'asset-02',
        'asset-03',
        'asset-04',
        'asset-05',
        'asset-06',
        'asset-07',
        'asset-08',
        'asset-09',
      ],
    },
  ]);
});

test('an asset with a manual decision keeps its own row when a boundary is unstated', () => {
  const snapshot = compileSnapshot({
    subjects: [subject(CHILD, { [BUILDING]: 'D1' }), subject(PARENT, {})],
    claims: claims({ structural: [claim('manual', CHILD, PARENT)] }),
    hierarchy: buildingOnlyHierarchy('review'),
  });

  // Refusing a person is owed a named explanation; refusing a rule is owed a
  // number. The row names the end that actually lacked the value.
  assert.deepEqual(snapshot.reviewItems, [
    { kind: 'missing-boundary', assetId: PARENT, levelId: 'building' },
  ]);
});

test('demotions are counted per rung, so two rungs are two rows', () => {
  const snapshot = compileSnapshot({
    subjects: [
      subject('asset-one', { [BUILDING]: 'D1' }),
      subject('asset-two', { [BUILDING]: 'D1' }),
      subject('asset-far', { [BUILDING]: 'D2' }),
    ],
    claims: claims({
      structural: [
        claim('flow-family', 'asset-one', 'asset-far', 1),
        claim('profile-lookup', 'asset-two', 'asset-far', 2),
      ],
    }),
    hierarchy: buildingOnlyHierarchy('review'),
  });

  assert.deepEqual(
    snapshot.reviewItems.map((item) => `${item.ladderSource}:${item.pairCount}`),
    ['flow-family:1', 'profile-lookup:1'],
  );
});
