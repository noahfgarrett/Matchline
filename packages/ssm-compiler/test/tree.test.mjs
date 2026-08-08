/**
 * The level tree projection (ENGINE.md E3 step 3).
 *
 * The shape assertions are written as compact path strings so a whole tree fits
 * on one screen: `D1/Electrical/650` is a level path, and the asset lists under
 * it are the top-of-grouping assets.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { compileSnapshot, hierarchyTree } from '../dist/index.js';
import {
  BUILDING,
  claim,
  claims,
  DISCIPLINE,
  DRAGON_HIERARCHY,
  DRAGON_INPUT,
  MAH,
  PANEL,
  PLC,
  RIO,
  subject,
  SYSTEM,
  TIT,
  VFD,
} from './dist/dragon.fixture.js';

/** Every leaf level path in the tree, with the assets filed under it. */
function leaves(node, prefix = []) {
  const path = [...prefix, node.value];
  if (node.levels.length === 0) {
    return [`${path.join('/')} -> ${node.assets.map((asset) => asset.assetId).join(',')}`];
  }
  return node.levels.flatMap((child) => leaves(child, path));
}

function treePaths(tree) {
  return tree.levels.flatMap((node) => leaves(node));
}

/** One asset subtree as `id(child,child)`. */
function outline(asset) {
  if (asset.children.length === 0) {
    return asset.assetId;
  }
  return `${asset.assetId}(${asset.children.map(outline).join(',')})`;
}

test('the Dragon compile projects into building / discipline / system', () => {
  const snapshot = compileSnapshot(DRAGON_INPUT);
  const tree = hierarchyTree(snapshot, DRAGON_HIERARCHY, DRAGON_INPUT.subjects);

  assert.deepEqual(treePaths(tree), [
    `D1/Electrical/603 -> ${PANEL}`,
    `D1/Electrical/650 -> ${RIO}`,
    `D1/Mechanical Dry/001 -> ${MAH}`,
    'D2/Electrical/603 -> asset-0006-xfmr',
  ]);
  assert.deepEqual(tree.assets, []);
});

test('structural children nest under their parent, dependencies are listed by ref', () => {
  const snapshot = compileSnapshot(DRAGON_INPUT);
  const tree = hierarchyTree(snapshot, DRAGON_HIERARCHY, DRAGON_INPUT.subjects);

  const mechanical = tree.levels[0].levels[1].levels[0];
  assert.equal(mechanical.value, '001');
  assert.equal(
    outline(mechanical.assets[0]),
    `${MAH}(${PLC}(${VFD}(${TIT},asset-0005-tit)))`,
  );

  const rio = tree.levels[0].levels[0].levels[1].assets[0];
  assert.equal(rio.assetId, RIO);
  assert.deepEqual(rio.children, []);
  assert.deepEqual(
    rio.dependencies.map((entry) => `${entry.parentAssetId}:${entry.relationshipType}`),
    [`${PANEL}:DEPENDENCY`, `${PANEL}:POWERS`],
  );
});

test('§11.4: a child nests under its parent even from a different display level', () => {
  const subjects = [
    subject(MAH, { [BUILDING]: 'D1', [DISCIPLINE]: 'Mechanical Dry', [SYSTEM]: '001' }),
    subject(PLC, { [BUILDING]: 'D1', [DISCIPLINE]: 'Electrical', [SYSTEM]: '001' }),
  ];
  const snapshot = compileSnapshot({
    subjects,
    claims: claims({ structural: [claim('flow-family', PLC, MAH)] }),
    hierarchy: DRAGON_HIERARCHY,
  });
  const tree = hierarchyTree(snapshot, DRAGON_HIERARCHY, subjects);

  // The PLC reads Electrical and is commissioned under the Mechanical Dry MAH,
  // so it appears in the MAH's branch and nowhere else.
  assert.deepEqual(treePaths(tree), [`D1/Mechanical Dry/001 -> ${MAH}`]);
  assert.equal(outline(tree.levels[0].levels[0].levels[0].assets[0]), `${MAH}(${PLC})`);
});

test('unresolved and provisional assets are still placed, carrying their status', () => {
  const subjects = [
    subject('asset-a', { [BUILDING]: 'D1', [DISCIPLINE]: 'Electrical', [SYSTEM]: '001' }),
    subject('asset-b', { [BUILDING]: 'D1', [DISCIPLINE]: 'Electrical', [SYSTEM]: '001' }),
    subject('asset-c', { [BUILDING]: 'D1', [DISCIPLINE]: 'Electrical', [SYSTEM]: '001' }),
  ];
  const snapshot = compileSnapshot({
    subjects,
    claims: claims({
      structural: [
        claim('flow-family', 'asset-c', 'asset-a', 1),
        claim('flow-family', 'asset-c', 'asset-b', 2),
      ],
    }),
    hierarchy: DRAGON_HIERARCHY,
  });
  const tree = hierarchyTree(snapshot, DRAGON_HIERARCHY, subjects);

  const bucket = tree.levels[0].levels[0].levels[0];
  assert.deepEqual(
    bucket.assets.map((asset) => `${asset.assetId}:${asset.status}`),
    ['asset-a:root', 'asset-b:root', 'asset-c:unresolved'],
  );
});

test('the unassigned bucket is a visible level value', () => {
  const hierarchy = {
    levels: [
      {
        levelId: 'building',
        displayName: 'Building',
        attributeKey: BUILDING,
        boundary: false,
        missingValuePolicy: 'unassigned-group',
        sort: 'label',
      },
    ],
  };
  const subjects = [subject('asset-a', { [BUILDING]: 'D1' }), subject('asset-b', {})];
  const snapshot = compileSnapshot({ subjects, claims: claims({}), hierarchy });

  assert.deepEqual(treePaths(hierarchyTree(snapshot, hierarchy, subjects)), [
    '(unassigned) -> asset-b',
    'D1 -> asset-a',
  ]);
});

test('a hierarchy with no levels puts every root asset at the top', () => {
  const subjects = [subject('asset-b', {}), subject('asset-a', {})];
  const snapshot = compileSnapshot({ subjects, claims: claims({}), hierarchy: { levels: [] } });
  const tree = hierarchyTree(snapshot, { levels: [] }, subjects);

  assert.deepEqual(tree.levels, []);
  assert.deepEqual(
    tree.assets.map((asset) => asset.assetId),
    ['asset-a', 'asset-b'],
  );
});

test('the tree is identical whatever order the subjects arrive in', () => {
  const snapshot = compileSnapshot(DRAGON_INPUT);
  const forward = hierarchyTree(snapshot, DRAGON_HIERARCHY, DRAGON_INPUT.subjects);
  const backward = hierarchyTree(snapshot, DRAGON_HIERARCHY, [...DRAGON_INPUT.subjects].reverse());

  assert.equal(JSON.stringify(backward), JSON.stringify(forward));
});

test('an empty snapshot projects to an empty tree', () => {
  const snapshot = compileSnapshot({ subjects: [], claims: claims({}), hierarchy: DRAGON_HIERARCHY });

  assert.deepEqual(hierarchyTree(snapshot, DRAGON_HIERARCHY, []), { levels: [], assets: [] });
});
