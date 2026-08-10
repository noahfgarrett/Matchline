/**
 * P0-9 — an asset's identity survives a tag correction (hard gate 12).
 *
 * > Identity evidence order: profile-mapped stable id property > source
 * > persistent id + authoring object id > source persistent id + InstanceGuid >
 * > deterministic source-relative structural key > tag (last-resort
 * > reconciliation only). [...] Project persists asset identity ledger
 * > {assetId, currentCanonicalTag, aliases, modelIdentities} so tag corrections
 * > keep assetId, manual system/relationship/review decisions survive, diffs
 * > report tag-change not remove+add. Migrate tag-keyed overrides via latest
 * > snapshot; unmappable overrides become orphaned-decision review items, never
 * > dropped.
 *
 * ## What is true today, and why that is the bug
 *
 * `packages/asset-catalog/src/catalog.ts` derives the asset id from the tag:
 * `tag:<tag>` when unique, `tag:<tag>#<objectId>` when duplicated. It is
 * documented as "deterministic and content-derived, so the same cache rebuilds
 * the same ids" — which is true, and is exactly the problem when the content
 * that derives it is the field most likely to be corrected. Fixing a typo in a
 * tag is not a new piece of equipment, but today it produces a new asset id,
 * and every manual decision recorded against the old id is addressed to
 * something that no longer exists.
 *
 * `mel-export`'s revision diff says the same thing from the other end: "The
 * Equipment Tag is the key. A tag that only the new revision has is an *added*
 * asset" — honest for two workbooks compared in isolation, and wrong for two
 * compiles of one project that has an identity ledger between them.
 *
 * ## The fixture
 *
 * One object, two revisions of the model. Revision A carries the typo
 * `MAH002-10-1`; revision B is the Dragon fixture as generated, with the tag
 * spelled `MAH002-10-01`. Everything else — object id, InstanceGuid, authoring
 * id, position in the tree, every other property — is identical, which is what
 * makes this a correction rather than a replacement.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { compileProject } from '@matchline/compiler';
import { diffMelRevisions } from '@matchline/mel-export';

import {
  HIERARCHY,
  ROLE_GRAPH,
  idOf,
  melWorkbook,
  mentionsAll,
  openDragonCache,
  pending,
  requirePresent,
  siteProfile,
} from './support.mjs';

/** Milestone 3: "Stable identity". */
const MILESTONE = 3;

/** The tag as the corrected model spells it. */
const CORRECT_TAG = 'MAH002-10-01';
/** The same equipment, mis-tagged in the earlier model revision. */
const TYPO_TAG = 'MAH002-10-1';
/** Same building, same system: a parent nothing has to fold. */
const MANUAL_PARENT = idOf('MAH002-10-02');
const MANUAL_NOTE = 'Second hot water train, commissioned as one.';
/** An override naming equipment neither revision has. */
const GHOST_CHILD = idOf('GHOST999-99-99');

let typoRevision = null;
let correctedRevision = null;
let first = null;

function inputFor(cache, overrides = {}) {
  return {
    cache,
    profile: siteProfile(),
    hierarchy: HIERARCHY,
    roleGraph: ROLE_GRAPH,
    melWorkbook: melWorkbook(),
    ...overrides,
  };
}

/** The second compile, carried across by the ledger the first one produced. */
function recompileCorrected(overrides = {}) {
  const ledger = requirePresent(
    MILESTONE,
    'CompiledProject publishes an asset identity ledger {assetId, currentCanonicalTag, aliases, modelIdentities}',
    first.identityLedger,
  );
  return compileProject(inputFor(correctedRevision.cache, { identityLedger: ledger, ...overrides }));
}

before(() => {
  typoRevision = openDragonCache('identity-typo', (context) => {
    context.retag(CORRECT_TAG, TYPO_TAG);
  });
  correctedRevision = openDragonCache('identity-corrected');
  first = compileProject(inputFor(typoRevision.cache));
});

after(() => {
  typoRevision?.close();
  correctedRevision?.close();
});

test('the two revisions are one piece of equipment, re-tagged', () => {
  // Not a target assertion — a guard on the fixture. Same object, same
  // InstanceGuid (the fixture derives it from the object id, which `retag`
  // never touches); only the mapped tag differs.
  const mistagged = first.catalog.assets.find((asset) => asset.canonicalTag === TYPO_TAG);
  assert.ok(mistagged, `revision A should carry the typo tag ${TYPO_TAG}`);
  assert.equal(
    first.catalog.assets.some((asset) => asset.canonicalTag === CORRECT_TAG),
    false,
    'revision A has the typo and nothing else',
  );

  const plain = compileProject(inputFor(correctedRevision.cache));
  const corrected = plain.catalog.assets.find((asset) => asset.canonicalTag === CORRECT_TAG);
  assert.ok(corrected, `revision B should carry the corrected tag ${CORRECT_TAG}`);
  assert.deepEqual(corrected.objectIds, mistagged.objectIds, 'the same model object, either way');
});

test('a corrected tag keeps the asset id it already had', () => {
  const mistagged = first.catalog.assets.find((asset) => asset.canonicalTag === TYPO_TAG);
  const second = recompileCorrected();
  const corrected = second.catalog.assets.find((asset) => asset.canonicalTag === CORRECT_TAG);

  assert.ok(corrected, 'the corrected revision must carry the corrected tag');
  assert.equal(
    corrected.assetId,
    mistagged.assetId,
    pending(MILESTONE, 'a tag correction keeps the assetId the identity ledger already assigned'),
  );
});

test('the ledger records the old spelling as an alias of the same asset', () => {
  const second = recompileCorrected();
  const ledger = requirePresent(
    MILESTONE,
    'the recompile publishes an updated identity ledger',
    second.identityLedger,
  );
  const mistagged = first.catalog.assets.find((asset) => asset.canonicalTag === TYPO_TAG);
  assert.ok(
    mentionsAll(ledger, [mistagged.assetId, TYPO_TAG, CORRECT_TAG]),
    pending(MILESTONE, 'the ledger keeps the old tag as an alias so old evidence still resolves'),
  );
});

test('a relationship override recorded under the OLD tag still applies after the correction', () => {
  const mistagged = first.catalog.assets.find((asset) => asset.canonicalTag === TYPO_TAG);
  const second = recompileCorrected({
    // Exactly what the project file would hold: a decision a person made while
    // the model still spelled the tag wrong.
    manualRelationshipOverrides: [
      { childAssetId: mistagged.assetId, parentAssetId: MANUAL_PARENT, note: MANUAL_NOTE },
    ],
  });

  const corrected = second.catalog.assets.find((asset) => asset.canonicalTag === CORRECT_TAG);
  const node = second.snapshot.nodes.get(corrected.assetId);
  assert.equal(
    node.parent.status,
    'resolved',
    pending(MILESTONE, 'a manual decision recorded under the old tag survives the correction'),
  );
  assert.equal(node.parent.parentAssetId, MANUAL_PARENT);
  assert.equal(node.parent.ladderSource, 'manual');
  assert.equal(node.parent.winningClaim.provenance.manualDecision, MANUAL_NOTE);
});

test('the revision diff reports a tag change, not a remove and an add', () => {
  const second = recompileCorrected();
  // No `renamedTags` hint on purpose: the identity ledger is what knows these
  // two rows are one asset. Making the caller claim the rename by hand is the
  // 0.8.1 behaviour P0-9 replaces.
  const diff = diffMelRevisions(first.generatedMel.assets, second.generatedMel.assets);

  assert.deepEqual(
    diff.added.map((entry) => entry.canonicalTag),
    [],
    pending(MILESTONE, 'a corrected tag is not a new asset'),
  );
  assert.deepEqual(
    diff.removed.map((entry) => entry.canonicalTag),
    [],
    pending(MILESTONE, 'a corrected tag does not remove the old asset'),
  );
  assert.deepEqual(
    diff.changedTags.map((change) => `${change.before} -> ${change.after}`),
    [`${TYPO_TAG} -> ${CORRECT_TAG}`],
    pending(MILESTONE, 'the diff reports the correction as one changed tag'),
  );
});

test('an override that cannot be mapped becomes an orphaned-decision review item, never a silent drop', () => {
  const project = compileProject(
    inputFor(correctedRevision.cache, {
      manualRelationshipOverrides: [
        { childAssetId: GHOST_CHILD, parentAssetId: MANUAL_PARENT, note: 'Kept from the old register.' },
      ],
    }),
  );

  // This half already holds: claims assembly reports the override it could not
  // apply as a `dead-claim-rule` item with `reason: 'unknown-child-asset'`. It
  // is asserted anyway, because P0-9 adds ledger-based override migration and
  // the easy way to build that is a pass that quietly swallows what it cannot
  // map. The decision produced no hierarchy, which is correct — and it must
  // still be visible, which is the point. The kind is not pinned: P0-9 names
  // the concept ("orphaned-decision review items"), not the type.
  const orphaned = project.reviewItems.filter((item) => mentionsAll(item, [GHOST_CHILD]));
  assert.ok(
    orphaned.length > 0,
    pending(MILESTONE, 'an unmappable manual override surfaces as an orphaned-decision review item'),
  );
  assert.ok(
    mentionsAll(orphaned[0], [GHOST_CHILD, MANUAL_PARENT]),
    pending(MILESTONE, 'the orphaned-decision item names the decision that could not be applied'),
  );
});
