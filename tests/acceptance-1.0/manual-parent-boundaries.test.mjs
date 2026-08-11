/**
 * P0-4 — a manual parent may not violate an enabled boundary (hard gate 9).
 *
 * > Manual = strongest candidate, wins competition, still folds. Cross-boundary
 * > manual → dependency + provenance records manual origin + boundary demotion +
 * > visible review item. Manual make-root stays final. No "force structural
 * > across boundary" in 1.0.
 * >
 * > Acceptance: RIO(650) manually parented under Panel(603) → flow unchanged,
 * > RIO roots in 650, Panel a dependency, both provenances present, generated
 * > MEL lists Panel as dependency not parent.
 *
 * ## What is true today, and why that is the bug
 *
 * `packages/ssm-compiler/src/compile.ts` short-circuits the fold for the manual
 * tier ("§11.5: a manual parent bypasses the fold entirely"), and
 * `packages/ssm-compiler/src/index.ts` still advertises "Manual outranks and
 * bypasses". So the RIO below nests under the panel across the System boundary
 * and nothing records that it happened. P0-4 replaces *bypasses* with
 * *outranks*: manual still wins the ladder competition, and then folds like any
 * other winner.
 *
 * The two invariants P0-4 keeps are pinned here too, because a fix that folds
 * manual parents could easily take them with it: a manual parent inside one
 * grouping stays structural, and a manual make-root stays final.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { compileProject } from '@matchline/compiler';

import {
  connectivityWorkbooks,
  HIERARCHY,
  idOf,
  melWorkbook,
  mentionsAll,
  MODEL_ONLY_RESOLVER,
  oneSource,
  openDragonCache,
  pending,
  rioPanel,
  ROLE_GRAPH,
  siteProfile,
} from './support.mjs';

/** Milestone 4: "Hierarchy+profile semantics (incl. manual-parent fold)". */
const MILESTONE = 4;

const PANEL = idOf('PNL603-10-01');
const RIO = idOf('RIO603-10-01');
const MANUAL_NOTE = 'Commissioned with the panel that feeds it.';

/** Same building, same system: a manual parent nothing has to fold. */
const SAME_SYSTEM_CHILD = idOf('MAH001-10-02');
const SAME_SYSTEM_PARENT = idOf('MAH001-10-01');

let handle = null;
/** The crossing compile: manual RIO-under-panel, across the System boundary. */
let crossing = null;

function baseInput(overrides) {
  return {
    sources: oneSource(handle.cache),
    profile: siteProfile({ systemResolver: MODEL_ONLY_RESOLVER }),
    melWorkbook: melWorkbook(),
    // The panel really does feed the RIO, so the fold has a physical chain to
    // leave alone and the flow assertion is about a projection that exists.
    connectivityWorkbooks: connectivityWorkbooks([['PNL603-10-01', 'RIO603-10-01']]),
    ...overrides,
  };
}

before(() => {
  handle = openDragonCache('manual-boundaries', rioPanel);
  crossing = compileProject(
    baseInput({
      manualRelationshipOverrides: [
        { childAssetId: RIO, parentAssetId: PANEL, note: MANUAL_NOTE },
      ],
    }),
  );
});

after(() => {
  handle?.close();
});

test('the scenario is the one P0-4 names: one family, two systems, a person parenting across them', () => {
  // Not a target assertion — a guard. If the panel and the RIO ever stop
  // landing in different systems, every assertion below would pass for the
  // wrong reason.
  assert.equal(crossing.systems.bySubject.get(PANEL).resolution.systemKey, '603');
  assert.equal(crossing.systems.bySubject.get(RIO).resolution.systemKey, '650');
  assert.ok(
    crossing.claims.structural.some(
      (claim) => claim.subjectAssetId === RIO && claim.ladderSource === 'manual',
    ),
    'the manual override must reach claims assembly as a structural claim',
  );
});

test('the Electrical Flow projection is unchanged: the panel still feeds the RIO', () => {
  // §10, and P0-4's first acceptance bullet. The SSM boundary is never applied
  // to the flow, so whatever the hierarchy decides, the physical chain is whole.
  const edge = crossing.flow.edges.find(
    (candidate) => candidate.fromNodeId === PANEL && candidate.toNodeId === RIO,
  );
  assert.ok(edge, 'the panel -> RIO feed must survive in the flow projection');
  assert.equal(edge.relationshipType, 'POWERS');
  assert.equal(crossing.flow.nodes.get(PANEL).enrichment.systemKey, '603');
  assert.equal(crossing.flow.nodes.get(RIO).enrichment.systemKey, '650');
});

test('a manual parent across an enabled boundary is NOT structural: the RIO roots instead', () => {
  const rio = crossing.snapshot.nodes.get(RIO);
  assert.equal(
    rio.parent.status,
    'root',
    pending(MILESTONE, 'a manual parent still folds at an enabled boundary (it currently bypasses the fold)'),
  );
  assert.equal(
    rio.parent.parentAssetId,
    null,
    pending(MILESTONE, 'a boundary-crossing manual parent leaves no structural parent behind'),
  );
});

test('the RIO roots inside System 650, and the panel keeps no child in 603', () => {
  const d1 = crossing.tree.levels.find((level) => level.value === 'D1');
  const system650 = d1?.levels.find((level) => level.value === '650');
  assert.ok(
    system650,
    pending(MILESTONE, 'System 650 is a grouping of its own once the RIO is not nested under the 603 panel'),
  );
  assert.deepEqual(
    system650.assets.map((asset) => asset.assetId),
    [RIO],
    pending(MILESTONE, 'the RIO is filed by its own level path, not under its demoted parent'),
  );

  const system603 = d1?.levels.find((level) => level.value === '603');
  const panel = system603?.assets.find((asset) => asset.assetId === PANEL);
  assert.ok(panel, 'the panel must still sit in System 603');
  assert.deepEqual(
    panel.children,
    [],
    pending(MILESTONE, 'the panel has no structural children across the System boundary'),
  );
});

test('provenance records BOTH the manual origin and the boundary demotion', () => {
  const rio = crossing.snapshot.nodes.get(RIO);

  // Half one: which boundary took the parent away, and which parent it was.
  const demotion = rio.parent.demotedFrom;
  assert.ok(
    demotion,
    pending(MILESTONE, 'a demoted manual parent records `ParentDecision.demotedFrom`'),
  );
  assert.equal(demotion.parentAssetId, PANEL);
  assert.equal(demotion.boundaryLevelId, 'system');

  // Half two: that a *person* chose this parent is not erased by the fold.
  // Nothing is discarded (ENGINE.md): the refused manual claim is retained.
  const manualClaim = rio.losingClaims.find((claim) => claim.ladderSource === 'manual');
  assert.ok(
    manualClaim,
    pending(MILESTONE, "the refused manual claim is retained on the node's losing claims"),
  );
  assert.equal(manualClaim.targetAssetId, PANEL);
  assert.equal(
    manualClaim.provenance.manualDecision,
    MANUAL_NOTE,
    pending(MILESTONE, "the person's own words survive the demotion"),
  );
});

test('the panel becomes a dependency of the RIO, carrying the manual note', () => {
  const rio = crossing.snapshot.nodes.get(RIO);
  const fromPanel = rio.dependencies.filter((entry) => entry.parentAssetId === PANEL);
  assert.ok(fromPanel.length > 0, 'the relationship remains real: the panel is listed, not deleted');

  // Two entries, and they say different things: POWERS is what the connectivity
  // document states, DEPENDENCY is what the fold left in place of the nesting.
  const demoted = fromPanel.find((entry) => entry.relationshipType === 'DEPENDENCY');
  assert.ok(
    demoted,
    pending(MILESTONE, 'a demoted manual parent is added to the dependency list as DEPENDENCY'),
  );
  assert.equal(
    demoted.provenance.manualDecision,
    MANUAL_NOTE,
    pending(MILESTONE, 'the demoted dependency carries the manual origin in its provenance'),
  );
});

test('a review item explains the crossing, naming the child, the parent and the boundary', () => {
  // Deliberately not pinned to a `ReviewItem` kind: P0-4 requires "a visible
  // review item" and names no kind, so the milestone author picks the name and
  // this test insists only that the item says what a reviewer needs to read.
  const explaining = crossing.reviewItems.filter((item) => mentionsAll(item, [RIO, PANEL]));
  assert.ok(
    explaining.length > 0,
    pending(MILESTONE, 'a review item names the manual decision the System boundary refused'),
  );
  const named = explaining.find((item) => (item.boundaryLevelId ?? item.levelId) === 'system');
  assert.ok(
    named,
    pending(MILESTONE, "that review item names the boundary level it crosses ('system')"),
  );
});

test('the generated MEL lists the panel under Dependencies, not as System Parent', () => {
  const row = crossing.generatedMel.rows.find((entry) => entry.equipmentTag === 'RIO603-10-01');
  assert.ok(row, 'the RIO must have a row in the generated MEL');
  assert.equal(
    row.systemParentEquipmentTag,
    '',
    pending(MILESTONE, 'the delivered MEL does not print a cross-boundary manual parent as System Parent'),
  );
  assert.ok(
    row.dependencies.includes('PNL603-10-01'),
    'the panel must still be printed as a dependency',
  );
});

test('a manual parent INSIDE one grouping stays structural — the fold is not a veto', () => {
  // The other half of "manual = strongest candidate, wins competition": when
  // nothing is crossed, a person's decision is the parent, full stop. A fix
  // that folded manual parents indiscriminately would break this.
  const project = compileProject(
    baseInput({
      manualRelationshipOverrides: [
        {
          childAssetId: SAME_SYSTEM_CHILD,
          parentAssetId: SAME_SYSTEM_PARENT,
          note: 'One air handling train.',
        },
      ],
    }),
  );

  const child = project.snapshot.nodes.get(SAME_SYSTEM_CHILD);
  assert.equal(child.parent.status, 'resolved');
  assert.equal(child.parent.parentAssetId, SAME_SYSTEM_PARENT);
  assert.equal(child.parent.ladderSource, 'manual');
  assert.equal(child.parent.demotedFrom, undefined, 'nothing was crossed, so nothing folds');
  assert.equal(child.parent.winningClaim.provenance.manualDecision, 'One air handling train.');

  const row = project.generatedMel.rows.find((entry) => entry.equipmentTag === 'MAH001-10-02');
  assert.equal(row.systemParentEquipmentTag, 'MAH001-10-01');
  assert.equal(row.parentEvidence, 'manual');
});

test('a manual make-root is final: nothing on the ladder can re-parent it', () => {
  // P0-4: "Manual make-root stays final." The panel/RIO feed would otherwise
  // give the RIO a flow-anchored parent.
  const project = compileProject(
    baseInput({ manualRelationshipOverrides: [{ childAssetId: RIO, parentAssetId: null }] }),
  );

  const rio = project.snapshot.nodes.get(RIO);
  assert.equal(rio.parent.status, 'root');
  assert.equal(rio.parent.parentAssetId, null);
  assert.equal(rio.parent.ladderSource, null);
  assert.equal(rio.parent.demotedFrom, undefined, 'a chosen root is decided, not demoted');
  // Nothing is discarded: the flow-anchored claim it overruled is retained.
  assert.ok(
    rio.losingClaims.some(
      (claim) => claim.ladderSource === 'flow-family' && claim.targetAssetId === PANEL,
    ),
    'the claim the make-root overruled must be retained',
  );
});
