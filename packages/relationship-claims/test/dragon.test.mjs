/**
 * The PRODUCT.md §11.2 family, counted by hand.
 *
 * Five subjects, three flow edges, one role graph. Every expected count in this
 * file was worked out on paper first: two flow-anchored family claims, one
 * family+role claim where flow anchored nothing, three dependencies because
 * connectivity always yields one, and nothing at all from the cross-family feed.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { assembleRelationshipClaims } from '../dist/index.js';
import {
  AMBIGUOUS_FAMILY_SUBJECTS,
  DRAGON_FLOW_EDGES,
  DRAGON_OPTIONS,
  DRAGON_ROLE_GRAPH,
  DRAGON_SUBJECTS,
  resolveDragonTag,
  VFD_TO_TIT_EDGE,
} from './dist/dragon.fixture.js';

/** `child<-parent@rung`, which is the whole content of a claim in one line. */
function shape(claim) {
  return `${claim.subjectAssetId}<-${claim.targetAssetId}@${claim.ladderSource}`;
}

test('the Dragon family assembles three structural claims and three dependencies', () => {
  const assembled = assembleRelationshipClaims(DRAGON_SUBJECTS, DRAGON_OPTIONS);

  assert.deepEqual(assembled.structural.map(shape), [
    'asset-0002<-asset-0001@flow-family',
    'asset-0003<-asset-0002@flow-family',
    'asset-0004<-asset-0003@family-role',
  ]);
  assert.deepEqual(assembled.dependencies.map(shape), [
    'asset-0002<-asset-0001@flow-family',
    'asset-0002<-asset-0005@flow-family',
    'asset-0003<-asset-0002@flow-family',
  ]);
  assert.deepEqual(assembled.proposals, []);
  assert.deepEqual(assembled.makeRoot, []);
  assert.deepEqual(assembled.skipped, []);
});

test('a cross-family feed is a dependency and never a structural claim', () => {
  const assembled = assembleRelationshipClaims(DRAGON_SUBJECTS, DRAGON_OPTIONS);

  // asset-0005 (MAH002-20-01) feeds asset-0002 (PLC001-10-01): the role pairing
  // matches, the family key does not, so nothing structural survives.
  assert.equal(
    assembled.structural.some((claim) => claim.targetAssetId === 'asset-0005'),
    false,
  );
  const dependency = assembled.dependencies.find((claim) => claim.targetAssetId === 'asset-0005');
  assert.equal(dependency.subjectAssetId, 'asset-0002');
  assert.equal(dependency.relationshipType, 'POWERS');
  assert.equal(dependency.provenance.sourceRef.row, 42);
});

test('flow without a role pairing is connectivity only, at every rung', () => {
  const assembled = assembleRelationshipClaims(DRAGON_SUBJECTS, {
    flowEdges: DRAGON_FLOW_EDGES,
    resolveTag: resolveDragonTag,
  });

  assert.deepEqual(assembled.structural, []);
  assert.equal(assembled.dependencies.length, 3);
});

test('a role pairing without flow or family produces nothing', () => {
  const strangers = DRAGON_SUBJECTS.map((subject) => ({
    assetId: subject.assetId,
    canonicalTag: subject.canonicalTag,
    role: subject.role,
  }));
  const assembled = assembleRelationshipClaims(strangers, {
    roleGraph: DRAGON_ROLE_GRAPH,
    resolveTag: resolveDragonTag,
  });

  assert.deepEqual(assembled.structural, []);
  assert.deepEqual(assembled.dependencies, []);
});

test('family and role without a flow anchor is a weaker claim, not no claim', () => {
  const assembled = assembleRelationshipClaims(DRAGON_SUBJECTS, {
    roleGraph: DRAGON_ROLE_GRAPH,
    resolveTag: resolveDragonTag,
  });

  assert.deepEqual(assembled.structural.map(shape), [
    'asset-0002<-asset-0001@family-role',
    'asset-0003<-asset-0002@family-role',
    'asset-0004<-asset-0003@family-role',
  ]);
  const [first] = assembled.structural;
  assert.equal(first.evidenceTier, 1);
  assert.equal(first.provenance.rule, 'MAH>PLC');
  assert.equal(first.provenance.sourceRef.sheet, 'roleGraph');
  assert.equal(first.provenance.fallbackRung, 6);
});

test('once flow anchors a pairing, family+role stops repeating it', () => {
  const assembled = assembleRelationshipClaims(DRAGON_SUBJECTS, {
    ...DRAGON_OPTIONS,
    flowEdges: [...DRAGON_FLOW_EDGES, VFD_TO_TIT_EDGE],
  });

  assert.deepEqual(assembled.structural.map(shape), [
    'asset-0002<-asset-0001@flow-family',
    'asset-0003<-asset-0002@flow-family',
    'asset-0004<-asset-0003@flow-family',
  ]);
  assert.equal(
    assembled.structural.every((claim) => claim.ladderSource === 'flow-family'),
    true,
  );
  assert.equal(assembled.dependencies.length, 4);
});

test('a flow-anchored claim keeps the cable row that anchored it', () => {
  const assembled = assembleRelationshipClaims(DRAGON_SUBJECTS, DRAGON_OPTIONS);
  const [anchored] = assembled.structural;

  assert.equal(anchored.source, 'FLOW');
  assert.equal(anchored.evidenceTier, 3);
  assert.equal(anchored.relationshipType, 'FAMILY_RELATED');
  assert.equal(anchored.provenance.sourceFile, 'Dragon-CableSchedule.xlsx');
  assert.equal(anchored.provenance.sourceRef.row, 18);
  assert.equal(anchored.provenance.rule, 'MAH>PLC');
  assert.equal(anchored.provenance.fallbackRung, 5);
});

test('two role-compatible parents in one family both get claims', () => {
  const assembled = assembleRelationshipClaims(AMBIGUOUS_FAMILY_SUBJECTS, DRAGON_OPTIONS);
  const forInstrument = assembled.structural.filter(
    (claim) => claim.subjectAssetId === 'asset-0004',
  );

  // Pre-filtering here would hide the tie the ladder exists to surface.
  assert.deepEqual(forInstrument.map(shape), [
    'asset-0004<-asset-0003@family-role',
    'asset-0004<-asset-0006@family-role',
  ]);
  assert.equal(assembled.structural.length, 5);
});
