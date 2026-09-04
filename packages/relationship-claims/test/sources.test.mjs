/**
 * One rung at a time: what each source contributes, and what it refuses to.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { assembleRelationshipClaims } from '../dist/index.js';
import {
  DRAGON_LEARNED,
  DRAGON_MANUAL_OVERRIDES,
  DRAGON_MEL_PARENTS,
  DRAGON_PRIOR_SSM,
  DRAGON_PROFILE_LOOKUP,
  DRAGON_SUBJECTS,
  DUPLICATE_PARENT_SUBJECTS,
  EXPLICIT_PARENT_SUBJECTS,
  resolveDragonTag,
  resolveWithDuplicateTag,
} from './dist/dragon.fixture.js';

const BARE = { resolveTag: resolveDragonTag };

test('a manual override is a claim at the top rung, carrying the reason given', () => {
  const assembled = assembleRelationshipClaims(DRAGON_SUBJECTS, {
    ...BARE,
    manualOverrides: DRAGON_MANUAL_OVERRIDES,
  });

  assert.equal(assembled.structural.length, 1);
  const [claim] = assembled.structural;
  assert.equal(claim.subjectAssetId, 'asset-0004');
  assert.equal(claim.targetAssetId, 'asset-0002');
  assert.equal(claim.ladderSource, 'manual');
  assert.equal(claim.source, 'MANUAL');
  assert.equal(claim.relationshipType, 'EXPLICIT_PARENT');
  assert.equal(claim.evidenceTier, 4);
  assert.equal(claim.provenance.manualDecision, 'walked down 2026-08-05');
  assert.equal(claim.provenance.fallbackRung, 1);
  assert.equal(claim.provenance.sourceRef.sheet, 'manualOverrides');
  assert.equal(claim.provenance.sourceRef.row, 1);
});

test('a null parent is a make-root directive, not a claim pointing at nothing', () => {
  const assembled = assembleRelationshipClaims(DRAGON_SUBJECTS, {
    ...BARE,
    manualOverrides: DRAGON_MANUAL_OVERRIDES,
  });

  assert.deepEqual(
    assembled.structural.map((claim) => claim.targetAssetId),
    ['asset-0002'],
  );
  assert.equal(assembled.makeRoot.length, 1);
  const [root] = assembled.makeRoot;
  assert.equal(root.childAssetId, 'asset-0005');
  assert.equal(root.note, 'stands alone, no feeder');
  assert.equal(root.provenance.sourceRef.row, 2);
});

test('a manual override naming an unknown asset is skipped, loudly', () => {
  const assembled = assembleRelationshipClaims(DRAGON_SUBJECTS, {
    ...BARE,
    manualOverrides: [
      { childAssetId: 'asset-9999', parentAssetId: 'asset-0001' },
      { childAssetId: 'asset-0001', parentAssetId: 'asset-9999' },
      { childAssetId: 'asset-0001', parentAssetId: 'asset-0001' },
    ],
  });

  assert.deepEqual(assembled.structural, []);
  assert.deepEqual(
    assembled.skipped.map((skip) => skip.reason),
    ['self-parent', 'unknown-child-asset', 'unknown-parent-asset'],
  );
  assert.equal(
    assembled.skipped.every((skip) => skip.ladderSource === 'manual'),
    true,
  );
});

test('an explicit model parent resolves through identity and keeps its address', () => {
  const assembled = assembleRelationshipClaims(EXPLICIT_PARENT_SUBJECTS, BARE);

  assert.equal(assembled.structural.length, 1);
  const [claim] = assembled.structural;
  assert.equal(claim.subjectAssetId, 'asset-0004');
  assert.equal(claim.targetAssetId, 'asset-0003');
  assert.equal(claim.ladderSource, 'explicit-model');
  assert.equal(claim.source, 'MODEL');
  assert.equal(claim.evidenceTier, 4);
  assert.equal(claim.provenance.sourceRef.kind, 'model-object');
  assert.equal(claim.provenance.propertyOrColumn, 'Dragon Data > Parent Tag');
  assert.equal(claim.provenance.fallbackRung, 2);
});

test('an explicit parent tag nothing resolves invents no asset and no claim', () => {
  const assembled = assembleRelationshipClaims(EXPLICIT_PARENT_SUBJECTS, BARE);

  assert.deepEqual(assembled.skipped, [
    {
      ladderSource: 'explicit-model',
      reason: 'unresolvable-parent-tag',
      childRef: 'asset-0005',
      parentRef: 'PLC009-99-99',
    },
  ]);
});

test('a profile lookup claims resolved pairs and skips the ones it cannot resolve', () => {
  const assembled = assembleRelationshipClaims(DRAGON_SUBJECTS, {
    ...BARE,
    profileLookup: DRAGON_PROFILE_LOOKUP,
  });

  assert.equal(assembled.structural.length, 1);
  const [claim] = assembled.structural;
  assert.equal(claim.ladderSource, 'profile-lookup');
  assert.equal(claim.evidenceTier, 2);
  assert.equal(claim.provenance.sourceFile, 'site-profile');
  assert.equal(claim.provenance.sourceRef.sheet, 'profileLookup');
  assert.equal(claim.provenance.fallbackRung, 4);

  assert.deepEqual(assembled.skipped, [
    {
      ladderSource: 'profile-lookup',
      reason: 'unresolvable-child-tag',
      childRef: 'TIT404-40-04',
      parentRef: 'VFD001-10-01',
    },
  ]);
});

test('a prior accepted SSM example is a claim on the rung below learning', () => {
  const assembled = assembleRelationshipClaims(DRAGON_SUBJECTS, {
    ...BARE,
    priorSsm: DRAGON_PRIOR_SSM,
  });

  assert.equal(assembled.structural.length, 1);
  const [claim] = assembled.structural;
  assert.equal(claim.subjectAssetId, 'asset-0003');
  assert.equal(claim.targetAssetId, 'asset-0001');
  assert.equal(claim.ladderSource, 'prior-ssm');
  assert.equal(claim.relationshipType, 'STRUCTURAL_PARENT_CANDIDATE');
  assert.equal(claim.provenance.fallbackRung, 8);
});

test('a claim-grade learned rule claims; a proposal-grade one only proposes', () => {
  const assembled = assembleRelationshipClaims(DRAGON_SUBJECTS, {
    ...BARE,
    learned: DRAGON_LEARNED,
  });

  assert.deepEqual(
    assembled.structural.map((claim) => `${claim.subjectAssetId}@${claim.ladderSource}`),
    ['asset-0003@learned-description'],
  );
  assert.equal(assembled.structural[0].provenance.rule, 'MAH parents VFD (12/13 sightings)');

  assert.deepEqual(assembled.proposals, [
    {
      kind: 'nesting-proposal',
      assetId: 'asset-0004',
      proposedParentId: 'asset-0002',
      ruleDetail: 'PLC parents TIT (4/9 sightings)',
      confidence: 0.444,
    },
  ]);
  assert.equal(
    assembled.structural.some((claim) => claim.subjectAssetId === 'asset-0004'),
    false,
  );
});

test('a learned rule about an unknown asset is skipped at both grades', () => {
  const assembled = assembleRelationshipClaims(DRAGON_SUBJECTS, {
    ...BARE,
    learned: [
      {
        childAssetId: 'asset-9999',
        parentAssetId: 'asset-0001',
        ruleDetail: 'ghost',
        confidence: 0.99,
        grade: 'claim',
      },
      {
        childAssetId: 'asset-0002',
        parentAssetId: 'asset-9999',
        ruleDetail: 'ghost parent',
        confidence: 0.5,
        grade: 'proposal',
      },
    ],
  });

  assert.deepEqual(assembled.structural, []);
  assert.deepEqual(assembled.proposals, []);
  assert.deepEqual(
    assembled.skipped.map((skip) => skip.reason),
    ['unknown-child-asset', 'unknown-parent-asset'],
  );
});

test('a flow edge whose endpoints are unknown yields no dependency either', () => {
  const assembled = assembleRelationshipClaims(DRAGON_SUBJECTS, {
    ...BARE,
    flowEdges: [
      {
        fromAssetId: 'asset-0001',
        toAssetId: 'asset-9999',
        relationshipType: 'POWERS',
        provenance: { sourceFile: 'x.xlsx', sourceRef: { kind: 'sheet-row', sheet: 'Cables', row: 1 } },
      },
      {
        fromAssetId: 'asset-0001',
        toAssetId: 'asset-0001',
        relationshipType: 'POWERS',
        provenance: { sourceFile: 'x.xlsx', sourceRef: { kind: 'sheet-row', sheet: 'Cables', row: 2 } },
      },
    ],
  });

  assert.deepEqual(assembled.dependencies, []);
  assert.deepEqual(
    assembled.skipped.map((skip) => `${skip.ladderSource}:${skip.reason}`),
    ['flow-family:self-parent', 'flow-family:unknown-child-asset'],
  );
});

test('the MEL System Parent column is a claim on the rung under the model', () => {
  const assembled = assembleRelationshipClaims(DRAGON_SUBJECTS, {
    ...BARE,
    melParents: DRAGON_MEL_PARENTS,
  });

  assert.deepEqual(
    assembled.structural.map((claim) => `${claim.subjectAssetId}<-${claim.targetAssetId}`),
    ['asset-0002<-asset-0001', 'asset-0003<-asset-0002'],
  );
  const [claim] = assembled.structural;
  assert.equal(claim.ladderSource, 'mel-parent');
  assert.equal(claim.source, 'MEL');
  assert.equal(claim.relationshipType, 'EXPLICIT_PARENT');
  // Tier 2: a maintained tracking document, not stamped engineering.
  assert.equal(claim.evidenceTier, 2);
  assert.equal(claim.provenance.sourceFile, 'Dragon-MEL.xlsx');
  assert.deepEqual(claim.provenance.sourceRef, { kind: 'sheet-row', sheet: 'MEL', row: 2 });
  assert.equal(claim.provenance.rule, 'relate.melSystemParent');
  assert.equal(claim.provenance.fallbackRung, 3);
});

test('a second System Parent on one row is a dependency, never a second nesting', () => {
  const assembled = assembleRelationshipClaims(DRAGON_SUBJECTS, {
    ...BARE,
    melParents: DRAGON_MEL_PARENTS,
  });

  assert.deepEqual(
    assembled.dependencies.map((claim) => `${claim.subjectAssetId}<-${claim.targetAssetId}`),
    ['asset-0003<-asset-0001'],
  );
  const [dependency] = assembled.dependencies;
  assert.equal(dependency.kind, 'dependency');
  assert.equal(dependency.provenance.sourceRef.row, 3);
});

test('a MEL row naming a parent the model does not carry is skipped, loudly', () => {
  const assembled = assembleRelationshipClaims(DRAGON_SUBJECTS, {
    ...BARE,
    melParents: DRAGON_MEL_PARENTS,
  });

  assert.deepEqual(assembled.skipped, [
    {
      ladderSource: 'mel-parent',
      reason: 'unresolvable-parent-tag',
      childRef: 'TIT001-10-01',
      parentRef: 'MAH009-99-99',
    },
  ]);
});

test('a parent tag two assets carry places neither of them', () => {
  const assembled = assembleRelationshipClaims(DUPLICATE_PARENT_SUBJECTS, {
    resolveTag: resolveWithDuplicateTag,
  });

  // Nothing was guessed: the tag names two assets, so it names no parent.
  assert.deepEqual(assembled.structural, []);
  assert.deepEqual(assembled.skipped, [
    {
      ladderSource: 'explicit-model',
      reason: 'duplicate-target',
      childRef: 'asset-0002',
      parentRef: 'PNL001-10-01',
    },
    {
      ladderSource: 'explicit-model',
      reason: 'duplicate-target',
      childRef: 'asset-0003',
      parentRef: 'PNL001-10-01',
    },
  ]);
});

test('a duplicated tag in a profile lookup is refused the same way', () => {
  const assembled = assembleRelationshipClaims(DRAGON_SUBJECTS, {
    resolveTag: resolveWithDuplicateTag,
    profileLookup: [{ childTag: 'VFD001-10-01', parentTag: 'PNL001-10-01' }],
  });

  assert.deepEqual(assembled.structural, []);
  assert.deepEqual(assembled.skipped, [
    {
      ladderSource: 'profile-lookup',
      reason: 'duplicate-target',
      childRef: 'VFD001-10-01',
      parentRef: 'PNL001-10-01',
    },
  ]);
});
