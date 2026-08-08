import assert from 'node:assert/strict';
import test from 'node:test';

import { proposeNestings, trainLearnedRules } from '../dist/index.js';
import {
  DRAGON_ASSETS,
  DRAGON_TRAINING_ROWS,
  NO_AFFINITY_ASSETS,
  OTHER_SYSTEM_TIT,
  RACK_ASSET,
  SIBLING_ASSET,
  SYSTEMLESS_TIT,
  dragonAssetId,
} from './dist/dragon.fixture.js';

const RULES = trainLearnedRules(DRAGON_TRAINING_ROWS, { label: 'Dragon finished SSM' });

const propose = (assets) => proposeNestings(RULES, assets);
const forChild = (proposals, assetId) =>
  proposals.find((proposal) => proposal.childAssetId === assetId);

test('a claim-grade class pairs with its own unit and says so', () => {
  const proposal = forChild(propose(DRAGON_ASSETS), dragonAssetId('TIT', 3));
  assert.deepEqual(proposal, {
    childAssetId: dragonAssetId('TIT', 3),
    parentAssetId: dragonAssetId('VFD', 3),
    rule: 'role-affinity',
    ruleDetail: 'TIT nests under VFD (10x in training); shared number run 3',
    confidence: 1,
    grade: 'claim',
  });
});

test('a class that self-graded below the bar can only ever propose', () => {
  const proposal = forChild(propose(DRAGON_ASSETS), dragonAssetId('PLC', 8));
  assert.equal(proposal.grade, 'proposal');
  assert.equal(proposal.confidence, 0.6, 'the measured precision, not a guess');
  assert.equal(
    proposal.parentAssetId,
    dragonAssetId('MAH', 8),
    'the majority pairing wins the pick even where the export disagreed',
  );
});

test('a child-only class is never proposed as a parent', () => {
  const proposals = propose(DRAGON_ASSETS);
  const childOnlyParents = proposals.filter(
    (proposal) => proposal.parentAssetId.includes('TIT') || proposal.parentAssetId.includes('PLC'),
  );
  assert.deepEqual(childOnlyParents, []);
});

test('a class that parents things is not inferred as a child', () => {
  const proposals = propose(DRAGON_ASSETS);
  assert.equal(forChild(proposals, dragonAssetId('VFD', 1)), undefined);
  assert.equal(forChild(proposals, dragonAssetId('MAH', 1)), undefined);
  assert.equal(proposals.length, 20, 'ten transmitters and ten controllers, nothing else');
});

test('the pairing is confined to one system', () => {
  const relocated = [
    ...DRAGON_ASSETS.filter((asset) => asset.assetId !== dragonAssetId('TIT', 1)),
    OTHER_SYSTEM_TIT,
  ];
  assert.equal(
    forChild(propose(relocated), OTHER_SYSTEM_TIT.assetId),
    undefined,
    'its drive is one system away, which is a boundary, not a distance',
  );
});

test('an asset with no system has no partition and no proposal', () => {
  assert.equal(
    forChild(propose([...DRAGON_ASSETS, SYSTEMLESS_TIT]), SYSTEMLESS_TIT.assetId),
    undefined,
  );
});

test('a parent-capable peer the class was never paired with is not enough', () => {
  assert.deepEqual(propose(NO_AFFINITY_ASSETS), [], 'transmitters never nested under air handlers');
});

test('a tag that literally extends another is a claim regardless of class', () => {
  const proposal = forChild(propose([...DRAGON_ASSETS, RACK_ASSET]), RACK_ASSET.assetId);
  assert.deepEqual(proposal, {
    childAssetId: RACK_ASSET.assetId,
    parentAssetId: dragonAssetId('PLC', 1),
    rule: 'containment',
    ruleDetail: 'PLC001-10-01-RACK extends PLC001-10-01',
    confidence: 1,
    grade: 'claim',
  });
});

test('a letter-suffixed tag is a sibling, never a child of the tag it extends', () => {
  const proposal = forChild(propose([...DRAGON_ASSETS, SIBLING_ASSET]), SIBLING_ASSET.assetId);
  assert.equal(proposal.rule, 'role-affinity', 'the -A suffix is not containment');
  assert.notEqual(proposal.parentAssetId, dragonAssetId('TIT', 1));
  assert.equal(
    proposal.parentAssetId,
    dragonAssetId('VFD', 1),
    'it nests where its class nests, alongside its sibling',
  );
});

test('an asset whose description the table cannot classify is left alone', () => {
  const stranger = {
    assetId: 'asset-unknown',
    tag: 'XYZ001-10-01',
    description: 'SOMETHING NOBODY TRAINED ON 001',
    discipline: 'Mechanical',
    systemKey: 'SYS-10',
  };
  assert.equal(forChild(propose([...DRAGON_ASSETS, stranger]), stranger.assetId), undefined);
});

test('an untrained rule set is inert', () => {
  assert.deepEqual(proposeNestings(trainLearnedRules([]), DRAGON_ASSETS), []);
});

test('proposals are deterministic and ordered by child asset', () => {
  const first = propose(DRAGON_ASSETS);
  const second = propose([...DRAGON_ASSETS].reverse());
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.map((proposal) => proposal.childAssetId),
    [...first.map((proposal) => proposal.childAssetId)].sort(),
  );
});

test('proposals are ordered by code unit, never by a locale', () => {
  const assets = DRAGON_ASSETS.map((asset) => ({
    ...asset,
    // Two sites' worth of asset ids, one upper-cased: a locale collator
    // interleaves them by letter, UTF-16 keeps every "B" before every "a".
    assetId: (asset.tag.startsWith('TIT') ? 'B:' : 'a:') + asset.assetId,
  }));
  const ordered = propose(assets).map((proposal) => proposal.childAssetId);
  assert.deepEqual(ordered, [...ordered].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)));
  assert.ok(ordered.length > 1);
  assert.ok(ordered[0].startsWith('B:'));
});
