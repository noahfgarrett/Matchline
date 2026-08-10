/**
 * The three things a person or a trained model can put into a compile: learned
 * rules, manual parent decisions, and a discipline projection.
 *
 * The invariant under all of them is the same one: what a rule may *do* depends
 * on what it has earned. A proposal-grade learned rule reaches the review queue
 * and stops there (DECISIONS.md #3); a claim-grade one competes on the ladder
 * like any other evidence; a person outranks both and bypasses the boundary
 * fold entirely (PRODUCT.md §11.5).
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { compileProject, ssmDisciplineOf } from '../dist/index.js';
import {
  fullInput,
  HIERARCHY,
  idOf,
  oneSource,
  openDragonCache,
  siteProfile,
} from './support.mjs';

/**
 * A learned rule set that classifies Dragon's controls equipment.
 *
 * `Item > Name` is mapped onto the description role below, so a PLC's
 * description is `PLC001-10-01`, which digit-masks to `plc#-#-#`. That is the
 * whole trick: two patterns, two classes, one affinity, and Dragon's controls
 * gear becomes a child class under a parent-capable one.
 *
 * `grade` is what the tests vary. Everything else is fixed, so the only thing
 * that changes between the two runs below is whether the rule earned the right
 * to write hierarchy.
 */
function learnedRules(grade) {
  return {
    version: 1,
    classification: [
      { discipline: '', pattern: 'plc#-#-#', class: 'PLC', confidence: 1, sampleCount: 12 },
      { discipline: '', pattern: 'vfd#-#-#', class: 'VFD', confidence: 1, sampleCount: 24 },
    ],
    roleGates: [
      {
        class: 'PLC',
        asParent: 24,
        asChild: 0,
        parentRate: 1,
        isChildOnly: false,
        isParentCapable: true,
      },
      {
        class: 'VFD',
        asParent: 0,
        asChild: 24,
        parentRate: 0,
        isChildOnly: true,
        isParentCapable: false,
      },
    ],
    affinities: [{ childClass: 'VFD', parentClass: 'PLC', observations: 4 }],
    grades: [
      grade === 'claim'
        ? { class: 'VFD', predicted: 24, correct: 23, precision: 0.9583, grade: 'claim' }
        : { class: 'VFD', predicted: 8, correct: 4, precision: 0.5, grade: 'proposal' },
    ],
    trainedFrom: { rowCount: 24, label: 'dragon-prior-ssm' },
  };
}

/** The profile the learned runs use: descriptions are the model's own names. */
function learnedProfile() {
  return siteProfile({
    propertyMappings: {
      equipmentTag: { category: 'Dragon Data', name: 'Tag' },
      description: { category: 'Item', name: 'Name' },
      equipmentType: { category: 'Item', name: 'Type' },
      building: { category: 'Dragon Data', name: 'Building' },
      nativeDiscipline: { category: 'Dragon Data', name: 'Service' },
    },
  });
}

/** No workbooks and no role graph, so the learned rung is the only one speaking. */
function learnedInput(cache, grade) {
  return {
    sources: oneSource(cache),
    profile: learnedProfile(),
    hierarchy: HIERARCHY,
    learnedRules: learnedRules(grade),
  };
}

let handle = null;

before(() => {
  handle = openDragonCache('overrides');
});

after(() => {
  handle?.close();
});

test('proposal-grade learned rules reach the review queue as nesting proposals and write no hierarchy at all', () => {
  const project = compileProject(learnedInput(handle.cache, 'proposal'));

  // Eight VFDs, each proposed under the PLC in its own building: the family key
  // decides D1, and the shared 001/20/0x number run decides D2.
  assert.equal(project.learnedProposals.length, 8);
  assert.ok(project.learnedProposals.every((proposal) => proposal.grade === 'proposal'));
  assert.ok(project.learnedProposals.every((proposal) => proposal.rule === 'role-affinity'));

  assert.equal(project.stats.learnedProposalCount, 8);
  assert.equal(project.claims.proposals.length, 8);
  // Never a claim. A rule that has not earned claim grade cannot nest anything.
  assert.equal(project.stats.structuralClaimCount, 0);
  assert.equal(project.snapshot.stats.rootCount, 34);

  assert.equal(project.reviewItems.length, 8);
  assert.ok(project.reviewItems.every((item) => item.kind === 'nesting-proposal'));

  const vfd = project.reviewItems.find((item) => item.assetId === idOf('VFD001-10-01'));
  assert.equal(vfd.proposedParentId, idOf('PLC001-10-01'));
  assert.equal(vfd.confidence, 0.5);
  assert.match(vfd.ruleDetail, /VFD nests under PLC/);
});

test('claim-grade learned rules compete on the ladder and place the same eight assets', () => {
  const project = compileProject(learnedInput(handle.cache, 'claim'));

  assert.equal(project.claims.proposals.length, 0);
  assert.equal(project.stats.structuralClaimCount, 8);
  assert.ok(
    project.claims.structural.every((claim) => claim.ladderSource === 'learned-description'),
  );
  assert.deepEqual(project.reviewItems, []);

  assert.equal(project.snapshot.stats.rootCount, 26);
  const vfd = project.snapshot.nodes.get(idOf('VFD001-20-01'));
  assert.equal(vfd.parent.status, 'resolved');
  assert.equal(vfd.parent.parentAssetId, idOf('PLC001-20-01'));
  assert.equal(vfd.parent.ladderSource, 'learned-description');
});

test('a manual parent outranks the ladder and is kept across a hard building boundary', () => {
  const project = compileProject(
    fullInput(handle.cache, {
      manualRelationshipOverrides: [
        {
          childAssetId: idOf('MAH001-20-01'),
          parentAssetId: idOf('MAH001-10-01'),
          note: 'Commissioned together with the D1 unit.',
        },
      ],
    }),
  );

  const child = project.snapshot.nodes.get(idOf('MAH001-20-01'));
  assert.equal(child.parent.status, 'resolved');
  assert.equal(child.parent.parentAssetId, idOf('MAH001-10-01'));
  assert.equal(child.parent.ladderSource, 'manual');
  // §11.5: the fold is not consulted for a manual claim, so a D2 asset really
  // does nest under a D1 one even though `building` is a hard boundary.
  assert.equal(child.parent.demotedFrom, undefined);
  assert.equal(project.snapshot.stats.demotedToDependencyCount, 0);
  assert.equal(
    child.parent.winningClaim.provenance.manualDecision,
    'Commissioned together with the D1 unit.',
  );

  // The decision reaches the generated MEL as a parent tag.
  const row = project.generatedMel.rows.find((entry) => entry.equipmentTag === 'MAH001-20-01');
  assert.equal(row.systemParentEquipmentTag, 'MAH001-10-01');
  assert.equal(row.parentEvidence, 'manual');
});

test('a manual make-root roots an asset the flow had already nested, and the losing claim is retained', () => {
  const project = compileProject(
    fullInput(handle.cache, {
      manualRelationshipOverrides: [{ childAssetId: idOf('PLC001-10-01'), parentAssetId: null }],
    }),
  );

  assert.equal(project.claims.makeRoot.length, 1);
  const plc = project.snapshot.nodes.get(idOf('PLC001-10-01'));
  assert.equal(plc.parent.status, 'root');
  assert.equal(plc.parent.parentAssetId, null);
  assert.equal(plc.parent.ladderSource, null);
  // Nothing is discarded: the flow-anchored claim that would have won is kept.
  assert.deepEqual(
    plc.losingClaims.map((claim) => `${claim.ladderSource}:${claim.targetAssetId}`),
    [`flow-family:${idOf('MAH001-10-01')}`],
  );
  // The VFD still nests under the PLC; a root is a parent like any other.
  assert.equal(
    project.snapshot.nodes.get(idOf('VFD001-10-01')).parent.parentAssetId,
    idOf('PLC001-10-01'),
  );
});

test('ssmDiscipline is the native discipline unless a projection rewrites it, and absent stays absent', () => {
  // The function on its own, at each of its three rules.
  assert.equal(ssmDisciplineOf(undefined), undefined);
  assert.equal(ssmDisciplineOf('  '), undefined);
  assert.equal(ssmDisciplineOf('Chilled Water'), 'Chilled Water');
  assert.equal(
    ssmDisciplineOf('Chilled Water', new Map([['Chilled Water', 'Mechanical']])),
    'Mechanical',
  );
  // An explicit rewrite to nothing is not a value; it is the absence of one.
  assert.equal(ssmDisciplineOf('Chilled Water', new Map([['Chilled Water', '']])), undefined);

  const project = compileProject(
    fullInput(handle.cache, {
      ssmDisciplineProjection: new Map([
        ['Chilled Water', 'Mechanical'],
        ['Hot Water', 'Mechanical'],
      ]),
    }),
  );

  const mah001 = project.compileSubjects.find((s) => s.assetId === idOf('MAH001-10-01'));
  assert.equal(mah001.attributes.get('nativeDiscipline'), 'Chilled Water');
  assert.equal(mah001.attributes.get('ssmDiscipline'), 'Mechanical');

  const mah002 = project.compileSubjects.find((s) => s.assetId === idOf('MAH002-10-01'));
  assert.equal(mah002.attributes.get('nativeDiscipline'), 'Hot Water');
  assert.equal(mah002.attributes.get('ssmDiscipline'), 'Mechanical');

  // The controls model states no discipline, and the projection invents none.
  const plc = project.compileSubjects.find((s) => s.assetId === idOf('PLC001-10-01'));
  assert.equal(plc.attributes.has('nativeDiscipline'), false);
  assert.equal(plc.attributes.has('ssmDiscipline'), false);

  const row = project.generatedMel.rows.find((entry) => entry.equipmentTag === 'MAH001-10-01');
  assert.equal(row.nativeDiscipline, 'Chilled Water');
  assert.equal(row.ssmDiscipline, 'Mechanical');
});

test('an ssmDiscipline boundary breaks a nesting the building and system boundaries allowed', () => {
  // MAH001-10-01 states `Chilled Water`; the PLC it parents states nothing, so
  // the boundary is unknown on one side and no structural decision is safe.
  const project = compileProject(
    fullInput(handle.cache, {
      hierarchy: {
        levels: [
          ...HIERARCHY.levels,
          {
            levelId: 'discipline',
            displayName: 'Discipline',
            attributeKey: 'ssmDiscipline',
            boundary: true,
            missingValuePolicy: 'review',
            sort: 'label',
          },
        ],
      },
    }),
  );

  const plc = project.snapshot.nodes.get(idOf('PLC001-10-01'));
  assert.equal(plc.parent.status, 'unresolved');
  assert.equal(plc.parent.parentAssetId, null);

  const missing = project.reviewItems.filter((item) => item.kind === 'missing-boundary');
  assert.ok(missing.length > 0);
  assert.ok(missing.every((item) => item.levelId === 'discipline'));
});
