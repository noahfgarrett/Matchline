/**
 * The two ladder rungs a site supplies as tables: the accepted Site Profile
 * lookup (PRODUCT.md §11.1 tier 3) and prior accepted SSM examples (tier 7).
 *
 * `@matchline/relationship-claims` assembles both; what this file proves is the
 * passthrough and the precedence. Both are spelled as TAGS, so a pair only
 * becomes a claim if identity resolves both ends against this compile -- which
 * is the whole reason they run through the orchestrator rather than being handed
 * to assembly by a caller who has already guessed at asset ids.
 *
 * The precedence is the point of having two of them. Tier 3 outranks the
 * flow-anchored family rung, so a lookup row REPLACES what connectivity
 * concluded. Tier 7 is beaten by everything above it, so a prior example only
 * speaks where nothing else does.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { compileProject } from '../dist/index.js';
import { fullInput, idOf, openDragonCache } from './support.mjs';

/** A tag with no relationship to anything Dragon spells, fuzzy or otherwise. */
const UNKNOWN_TAG = 'NOPE-99-99';

let handle = null;

before(() => {
  handle = openDragonCache('ladder-inputs');
});

after(() => {
  handle?.close();
});

test('a profile-lookup pair reaches the snapshot at tier 3, outranking the flow-anchored family rung', () => {
  // Connectivity puts PLC001-10-01 under MAH001-10-01. The site says otherwise,
  // and tier 3 is above tier 4, so the site wins. Both units are in D1 and in
  // system 001, so the boundary fold has no reason to interfere.
  const project = compileProject(
    fullInput(handle.cache, {
      profileLookup: [
        { childTag: 'PLC001-10-01', parentTag: 'MAH001-10-02' },
        { childTag: 'PLC001-20-01', parentTag: UNKNOWN_TAG },
      ],
    }),
  );

  const claim = project.claims.structural.find(
    (entry) =>
      entry.subjectAssetId === idOf('PLC001-10-01') && entry.ladderSource === 'profile-lookup',
  );
  assert.equal(claim.targetAssetId, idOf('MAH001-10-02'));
  // Profile-borne claims address the published profile and the row inside it,
  // so a reviewer lands on the rule that made the claim rather than on "the
  // profile". `siteProfile()` is `dragon` at version 1.
  assert.equal(claim.provenance.sourceFile, 'dragon');
  assert.deepEqual(claim.provenance.sourceRef, {
    kind: 'sheet-row',
    sheet: 'profileLookup',
    row: 1,
  });
  assert.equal(claim.provenance.profileRevision, '1');

  const plc = project.snapshot.nodes.get(idOf('PLC001-10-01'));
  assert.equal(plc.parent.status, 'resolved');
  assert.equal(plc.parent.parentAssetId, idOf('MAH001-10-02'));
  assert.equal(plc.parent.ladderSource, 'profile-lookup');
  // The connectivity evidence is not deleted, it is outranked.
  assert.ok(
    plc.losingClaims.some(
      (losing) =>
        losing.ladderSource === 'flow-family' && losing.targetAssetId === idOf('MAH001-10-01'),
    ),
  );

  // A row naming a tag identity cannot resolve is loud, not silent: the site has
  // to be able to see that its rule is dead.
  assert.equal(project.stats.skippedClaimInputCount, 1);
  assert.deepEqual(project.claims.skipped, [
    {
      ladderSource: 'profile-lookup',
      reason: 'unresolvable-parent-tag',
      childRef: 'PLC001-20-01',
      parentRef: UNKNOWN_TAG,
    },
  ]);
  assert.equal(
    project.snapshot.nodes.get(idOf('PLC001-20-01')).parent.parentAssetId,
    idOf('MAH001-20-01'),
    'the dead row changes nothing; connectivity still places the D2 panel',
  );

  // Loud means a person sees it. A count on `stats` and a list on `claims` are
  // both things nobody opens; the review queue is the one place a site is asked
  // to act, so the dead rule has to arrive there too.
  assert.deepEqual(
    project.reviewItems.filter((item) => item.kind === 'dead-claim-rule'),
    [
      {
        kind: 'dead-claim-rule',
        ladderSource: 'profile-lookup',
        reason: 'unresolvable-parent-tag',
        childRef: 'PLC001-20-01',
        parentRef: UNKNOWN_TAG,
      },
    ],
  );
});

test('a make-root directive whose asset is unknown is an orphaned decision with no parent named', () => {
  const project = compileProject(
    fullInput(handle.cache, {
      manualRelationshipOverrides: [
        { childAssetId: idOf(UNKNOWN_TAG), parentAssetId: null, note: 'commissioned standalone' },
      ],
    }),
  );

  // A manual override is a *decision*, not a rule, and P0-9 says an unmappable
  // one becomes an orphaned-decision review item and is never dropped. The
  // identity ledger re-addresses stored decisions before claims assembly sees
  // them, so a decision naming nothing never reaches assembly to be skipped:
  // this item is what reports it, and unlike the `dead-claim-rule` it replaces
  // it keeps the note, which is the part nobody can reconstruct.
  //
  // A make-root names no parent by construction, and the item has to say that
  // without inventing one.
  assert.deepEqual(
    project.reviewItems.filter((item) => item.kind === 'orphaned-decision'),
    [
      {
        kind: 'orphaned-decision',
        decision: 'manual-parent',
        childRef: idOf(UNKNOWN_TAG),
        parentRef: '',
        reason: 'unknown-child',
        note: 'commissioned standalone',
      },
    ],
  );
  assert.deepEqual(
    project.reviewItems.filter((item) => item.kind === 'dead-claim-rule'),
    [],
    'the decision is reported once, by the stage that could not re-address it',
  );
  assert.equal(project.stats.skippedClaimInputCount, 0);
});

test('a prior-SSM pair loses to every rung above it, and places the asset when there is none', () => {
  const example = [{ childTag: 'PLC001-10-01', parentTag: 'MAH001-10-02' }];

  // With connectivity and a role graph, tier 4 answers first and tier 7 is
  // never consulted.
  const outranked = compileProject(fullInput(handle.cache, { priorSsm: example }));
  const contested = outranked.snapshot.nodes.get(idOf('PLC001-10-01'));
  assert.equal(contested.parent.parentAssetId, idOf('MAH001-10-01'));
  assert.equal(contested.parent.ladderSource, 'flow-family');
  // Assembled and retained all the same -- a rung that loses is still evidence.
  assert.deepEqual(
    contested.losingClaims
      .filter((claim) => claim.ladderSource === 'prior-ssm')
      .map((claim) => claim.targetAssetId),
    [idOf('MAH001-10-02')],
  );

  // Take the role graph away and nothing else has anything to say: no family
  // rung, no learned rules, no lookup. Now the prior SSM is the answer.
  const alone = compileProject(
    fullInput(handle.cache, { roleGraph: undefined, priorSsm: example }),
  );
  assert.equal(alone.stats.structuralClaimCount, 1);

  const plc = alone.snapshot.nodes.get(idOf('PLC001-10-01'));
  assert.equal(plc.parent.status, 'resolved');
  assert.equal(plc.parent.parentAssetId, idOf('MAH001-10-02'));
  assert.equal(plc.parent.ladderSource, 'prior-ssm');
  assert.deepEqual(plc.parent.winningClaim.provenance.sourceRef, {
    kind: 'sheet-row',
    sheet: 'priorSsm',
    row: 1,
  });

  // Exactly one asset moves: 34 assets, 33 roots.
  assert.equal(alone.snapshot.stats.rootCount, 33);
  assert.equal(alone.snapshot.stats.demotedToDependencyCount, 0);
});
