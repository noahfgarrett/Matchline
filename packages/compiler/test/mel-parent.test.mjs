/**
 * The MEL's own "System Parent" column, and what a duplicated tag does to a
 * parent claim (audit High findings 2 and 3).
 *
 * The MEL is where a site writes down what hangs off what -- it was the donor's
 * primary structural source at priority 900 -- and the new engine read the
 * column, dropped it on the floor and had no ladder rung to put it on. The rung
 * exists now, and it is opt-in: a profile that does not list `mel-parent` walks
 * exactly the ladder it walked before, because a rung the engine learned after
 * a site published its profile is a rung that site never asked for.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { writeWorkbook } from '@matchline/spreadsheet-import';

import { compileProject } from '../dist/index.js';
import { idOf, oneSource, openDragonCache, siteProfile } from './support.mjs';

const MAH = 'MAH001-10-01';
const PLC = 'PLC001-10-01';
const VFD = 'VFD001-10-01';

/** A tag two objects carry, and the child whose model property names it. */
const DUPLICATE_TAG = 'PNL900-10-01';
const CHILD_OF_DUPLICATE = 'RIO900-10-01';
const SECOND_CHILD = 'RIO900-10-02';
const PARENT_TAG_PROPERTY = { category: 'Dragon Data', name: 'Parent Tag' };

let handle = null;
let duplicates = null;

before(() => {
  handle = openDragonCache('mel-parent');
  duplicates = openDragonCache('duplicate-parent', (context) => {
    const d1 = context.layerId('D1', 2);
    const shared = { sourceModelId: 2, parentId: d1, depth: 2, building: 'D1', upn: '900' };
    // One tag, two objects. The catalog keeps both and never merges them.
    context.addEquipment({ ...shared, tag: DUPLICATE_TAG, className: 'Equipment' });
    context.addEquipment({ ...shared, tag: DUPLICATE_TAG, className: 'Equipment' });
    for (const tag of [CHILD_OF_DUPLICATE, SECOND_CHILD]) {
      const id = context.addEquipment({ ...shared, tag, className: 'Equipment' });
      context.addProperty(id, 'Dragon Data', 'Parent Tag', DUPLICATE_TAG);
    }
  });
});

after(() => {
  handle?.close();
  duplicates?.close();
});

/** A MEL whose System Parent column states what hangs off what. */
function melWithParents(parents) {
  return {
    bytes: writeWorkbook([
      {
        name: 'MEL',
        aoa: [
          ['Equipment Tag', 'UPN', 'System Description', 'System Parent'],
          [MAH, '001', 'Mechanical Dry Air Handling', ''],
          [PLC, '001', 'Mechanical Dry Air Handling', ''],
          [VFD, '001', 'Mechanical Dry Air Handling', parents],
        ],
      },
    ]),
    sourceFile: 'Dragon-MEL.xlsx',
    sheetName: 'MEL',
    mapping: {
      equipmentTag: 'Equipment Tag',
      upn: 'UPN',
      systemDescription: 'System Description',
      systemParent: 'System Parent',
    },
    headerRow: 0,
  };
}

/** Dragon with no connectivity, so the MEL and the role graph are the only sources. */
function compile({ parents = MAH, ladder } = {}) {
  return compileProject({
    sources: oneSource(handle.cache),
    profile: siteProfile(ladder === undefined ? {} : { ladder }),
    melWorkbook: melWithParents(parents),
  });
}

/** Every ladder rung, the MEL one included. */
const LADDER_WITH_MEL = {
  tiers: [
    'manual',
    'explicit-model',
    'mel-parent',
    'profile-lookup',
    'flow-family',
    'family-role',
    'learned-description',
    'prior-ssm',
    'model-tree',
  ],
};

test('a site that lists the rung nests on what its MEL says', () => {
  const project = compile({ ladder: LADDER_WITH_MEL });
  const vfd = project.snapshot.nodes.get(idOf(VFD));

  assert.equal(vfd.parent.status, 'resolved');
  assert.equal(vfd.parent.parentAssetId, idOf(MAH));
  assert.equal(vfd.parent.ladderSource, 'mel-parent');
  assert.equal(vfd.parent.winningClaim.source, 'MEL');
  assert.equal(vfd.parent.winningClaim.provenance.sourceFile, 'Dragon-MEL.xlsx');
  assert.equal(vfd.parent.winningClaim.provenance.propertyOrColumn, 'System Parent');
  assert.equal(vfd.parent.winningClaim.provenance.rule, 'relate.melSystemParent');
});

test('the rung outranks the rules, and the rule it beat is retained', () => {
  const project = compile({ ladder: LADDER_WITH_MEL });
  const vfd = project.snapshot.nodes.get(idOf(VFD));

  // The taught PLC -> VFD pairing proposed the PLC. The MEL outranks it, and
  // nothing is discarded to make that true.
  assert.ok(
    vfd.losingClaims.some(
      (claim) => claim.ladderSource === 'family-role' && claim.targetAssetId === idOf(PLC),
    ),
  );
});

test('a profile that never asked for the rung walks the ladder it always walked', () => {
  const project = compile();
  const vfd = project.snapshot.nodes.get(idOf(VFD));

  // The claim exists -- evidence is assembled whether or not a ladder walks it --
  // and the taught role pairing still decides, exactly as it did before the rung.
  assert.equal(vfd.parent.ladderSource, 'family-role');
  assert.equal(vfd.parent.parentAssetId, idOf(PLC));
  assert.ok(
    project.claims.structural.some((claim) => claim.ladderSource === 'mel-parent'),
    'the MEL still had its say; the site simply does not listen to it',
  );
});

test('a second System Parent on one row is a dependency, never a second nesting', () => {
  const project = compile({ ladder: LADDER_WITH_MEL, parents: `${MAH}, ${PLC}` });
  const vfd = project.snapshot.nodes.get(idOf(VFD));

  assert.equal(vfd.parent.parentAssetId, idOf(MAH), 'the first tag is the parent');
  assert.ok(
    vfd.dependencies.some((dependency) => dependency.parentAssetId === idOf(PLC)),
    'and the second is a relation that orders work without nesting',
  );
});

test('a MEL parent nobody carries is a dead rule in the queue, not silence', () => {
  const project = compile({ ladder: LADDER_WITH_MEL, parents: 'MAH009-99-99' });

  const dead = project.reviewItems.find(
    (item) => item.kind === 'dead-claim-rule' && item.ladderSource === 'mel-parent',
  );
  assert.equal(dead.reason, 'unresolvable-parent-tag');
  assert.equal(dead.childRef, VFD);
  assert.equal(dead.parentRef, 'MAH009-99-99');
});

/* --------------------------------------------------- the duplicated tag */

test('a parent tag two assets carry places neither child', () => {
  const project = compileProject({
    sources: oneSource(duplicates.cache),
    profile: siteProfile({ parentTagProperty: PARENT_TAG_PROPERTY }),
  });

  const children = project.catalog.assets.filter(
    (asset) => asset.canonicalTag === CHILD_OF_DUPLICATE || asset.canonicalTag === SECOND_CHILD,
  );
  assert.equal(children.length, 2);
  for (const child of children) {
    const node = project.snapshot.nodes.get(child.assetId);
    assert.equal(
      node.parent.parentAssetId,
      null,
      'the tag names two assets, so it names no parent',
    );
  }

  // And the queue says so, naming both children and the tag they both meant.
  const skipped = project.reviewItems.filter(
    (item) => item.kind === 'dead-claim-rule' && item.reason === 'duplicate-target',
  );
  assert.equal(skipped.length, 2);
  assert.deepEqual(
    [...new Set(skipped.map((item) => item.parentRef))],
    [DUPLICATE_TAG],
  );
  const named = new Set(skipped.map((item) => item.childRef));
  for (const child of children) {
    assert.ok(named.has(child.assetId), `${child.canonicalTag} is named in the queue`);
  }
});

test('the duplicate itself is still reported, as it always was', () => {
  const project = compileProject({
    sources: oneSource(duplicates.cache),
    profile: siteProfile({ parentTagProperty: PARENT_TAG_PROPERTY }),
  });

  assert.ok(
    project.reviewItems.some(
      (item) => item.kind === 'duplicate-model-tag' && item.canonicalTag === DUPLICATE_TAG,
    ),
  );
});
