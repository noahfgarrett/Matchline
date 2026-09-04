/**
 * Stable asset identity, end to end through the pipeline (P0-9, hard gate 12).
 *
 * `tests/acceptance-1.0/stable-identity.test.mjs` is the gate; this file is the
 * pipeline's own account of the same rule, against real Dragon caches:
 *
 * - the splice: every stage below the catalog keys on the LEDGER id;
 * - the tiers, exercised through the cache rather than through hand-written
 *   evidence (`@matchline/asset-identity`'s own tests do that half);
 * - how a stored decision recorded under an old id, or an old tag, or a plain
 *   tag, is re-addressed -- and what happens to one that cannot be;
 * - what a project has to persist, and that it survives being persisted.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { compileProject } from '../dist/index.js';
import { diffMelRevisions } from '@matchline/mel-export';
import {
  DRAGON_CONTROLS_MODELS,
  DRAGON_MECHANICAL_MODELS,
  fullInput,
  idOf,
  openDragonCache,
  openDragonSubset,
  oneSource,
  siteProfile,
} from './support.mjs';

/** The unit every rename scenario is about. */
const TAG = 'MAH002-10-01';
/** The same unit, mis-tagged in an earlier revision of the model. */
const TYPO = 'MAH002-10-1';
/** Its neighbour: same building, same system, so nothing has to fold. */
const NEIGHBOUR = 'MAH002-10-02';
/** A property the site nominates as its stable asset id. */
const ASSET_NUMBER = { category: 'Dragon Data', name: 'Asset Number' };

let plain = null;
let typoed = null;

before(() => {
  plain = openDragonCache('ledger-plain');
  typoed = openDragonCache('ledger-typo', (context) => {
    context.retag(TAG, TYPO);
  });
});

after(() => {
  plain?.close();
  typoed?.close();
});

/** The compile of the mis-tagged revision every rename test starts from. */
function firstCompile(overrides = {}) {
  return compileProject(fullInput(typoed.cache, overrides));
}

test('a first compile publishes a ledger with one entry per asset, all new', () => {
  const project = firstCompile();

  assert.equal(project.identityLedger.formatVersion, 1);
  assert.equal(project.identityLedger.entries.length, project.catalog.assets.length);
  assert.equal(
    project.identityLedgerEvents.every((event) => event.kind === 'new-asset'),
    true,
    'a project that has just learned what it contains has nothing else to report',
  );
  // The catalog id is what a new entry adopts, so a fresh ledger reads as the
  // compile that made it. Nothing downstream may depend on that -- it is the
  // ledger, not the spelling, that keeps the id attached from here on.
  assert.equal(
    project.identityLedger.entries.some((entry) => entry.assetId === idOf(TYPO)),
    true,
  );
});

test('a corrected tag keeps the id everywhere the pipeline uses one', () => {
  const first = firstCompile();
  const second = compileProject(
    fullInput(plain.cache, { identityLedger: first.identityLedger }),
  );

  const corrected = second.catalog.assets.find((asset) => asset.canonicalTag === TAG);
  assert.equal(corrected.assetId, idOf(TYPO), 'the id the ledger already assigned');

  // The splice is upstream of everything, so every stage agrees. A stage that
  // had kept the catalog's own id would show up as a miss in exactly one of
  // these.
  assert.ok(second.snapshot.nodes.has(idOf(TYPO)));
  assert.ok(second.systems.bySubject.has(idOf(TYPO)));
  assert.ok(second.subjects.some((subject) => subject.assetId === idOf(TYPO)));
  assert.ok(second.compileSubjects.some((subject) => subject.assetId === idOf(TYPO)));
  assert.ok(
    second.identityIndex.assets.some(
      (asset) => asset.assetId === idOf(TYPO) && asset.canonicalTag === TAG,
    ),
  );
  assert.ok(
    second.generatedMel.assets.some(
      (asset) => asset.stableAssetId === idOf(TYPO) && asset.canonicalTag === TAG,
    ),
  );
  assert.equal(
    second.catalog.assets.some((asset) => asset.assetId === idOf(TAG)),
    false,
    'no asset carries the id the catalog would have derived this time',
  );
});

test('the ledger records the correction: the old spelling, and one event that explains it', () => {
  const first = firstCompile();
  const second = compileProject(
    fullInput(plain.cache, { identityLedger: first.identityLedger }),
  );

  const entry = second.identityLedger.entries.find((row) => row.assetId === idOf(TYPO));
  assert.equal(entry.currentCanonicalTag, TAG);
  assert.deepEqual(entry.aliases, [TYPO]);
  assert.equal(entry.status, 'present');

  assert.deepEqual(
    second.identityLedgerEvents.map((event) => `${event.kind}:${event.assetId}`),
    [`tag-changed:${idOf(TYPO)}`],
    'one asset changed, and nothing else is reported',
  );
  const [changed] = second.identityLedgerEvents;
  assert.equal(changed.previousCanonicalTag, TYPO);
  // Dragon's equipment carries an authoring id, and `retag` never touches one.
  assert.equal(changed.tier, 'authoring-id');
});

test('a re-extraction of an unchanged model is not a change: content hash is never identity', () => {
  // Same objects, same GUIDs, a different `input_sha256` -- which is exactly
  // what re-running the extractor over an unchanged NWD produces.
  const rebuilt = openDragonCache('ledger-rebuilt', (context) => {
    context.setMeta(
      'input_sha256',
      '0000000000000000000000000000000000000000000000000000000000000000',
    );
    context.setMeta('extracted_at_utc', '2026-06-01T00:00:00Z');
  });
  try {
    const first = compileProject(fullInput(plain.cache));
    const second = compileProject(
      fullInput(rebuilt.cache, { identityLedger: first.identityLedger }),
    );

    assert.deepEqual(second.identityLedgerEvents, []);
    assert.deepEqual(second.identityLedger.entries, first.identityLedger.entries);
  } finally {
    rebuilt.close();
  }
});

test('an object moved in the tree keeps its id, because the GUID tier outranks the structural one', () => {
  const moved = openDragonCache('ledger-moved', (context) => {
    const d2 = context.layerId('D2', 1);
    context.moveUnder(TAG, d2, 2);
  });
  try {
    const first = compileProject(fullInput(plain.cache));
    const second = compileProject(
      fullInput(moved.cache, { identityLedger: first.identityLedger }),
    );

    assert.deepEqual(second.identityLedgerEvents, []);
    assert.ok(second.snapshot.nodes.has(idOf(TAG)));
  } finally {
    moved.close();
  }
});

test('a profile-mapped stable id outranks every model tier: moved AND re-tagged is still one asset', () => {
  const before = openDragonCache('ledger-stable-before', (context) => {
    const id = context.objectIdOfTag(TAG);
    context.addProperty(id, 'Dragon Data', 'Asset Number', 'REG-000123');
  });
  // Everything a model tier could have matched on is gone: new authoring id,
  // new InstanceGuid, a different position, a different tag. Only the site's
  // own asset number is unchanged.
  const after = openDragonCache('ledger-stable-after', (context) => {
    const id = context.retag(TAG, TYPO);
    context.setObjectIdentity(id, {
      authoringId: 'id-rebuilt-999',
      instanceGuid: '00000000-0000-4000-8000-000000009001',
    });
    context.moveUnder(TYPO, context.layerId('D2', 1), 2);
    context.addProperty(id, 'Dragon Data', 'Asset Number', 'REG-000123');
  });
  try {
    const first = compileProject(
      fullInput(before.cache, { profile: siteProfile({ stableIdProperty: ASSET_NUMBER }) }),
    );
    const second = compileProject(
      fullInput(after.cache, {
        profile: siteProfile({ stableIdProperty: ASSET_NUMBER }),
        identityLedger: first.identityLedger,
      }),
    );

    const [changed] = second.identityLedgerEvents;
    assert.equal(changed.kind, 'tag-changed');
    assert.equal(changed.tier, 'stable-id-property');
    assert.equal(changed.assetId, idOf(TAG));
    assert.equal(
      second.catalog.assets.find((asset) => asset.canonicalTag === TYPO).assetId,
      idOf(TAG),
    );

    // Without the profile mapping the same two compiles are two assets, which
    // is what the tier is worth: it is the site's knowledge, not the model's.
    const unmapped = compileProject(
      fullInput(after.cache, { identityLedger: compileProject(fullInput(before.cache)).identityLedger }),
    );
    assert.deepEqual(
      unmapped.identityLedgerEvents.map((event) => event.kind).sort(),
      ['disappeared', 'new-asset'],
    );
  } finally {
    before.close();
    after.close();
  }
});

test('two assets that now share one identity are split, and neither is discarded', () => {
  const cloned = openDragonCache('ledger-split', (context) => {
    const d1 = context.layerId('D1', 1);
    const clone = context.addEquipment({
      sourceModelId: 1,
      parentId: d1,
      depth: 2,
      tag: 'MAH009-10-01',
      className: 'Equipment',
      upn: '002',
      building: 'D1',
      service: 'Hot Water',
    });
    // The authoring application numbered the copy the same as the original.
    context.setObjectIdentity(clone, { authoringId: `id-${TAG}` });
  });
  try {
    const first = compileProject(fullInput(plain.cache));
    const second = compileProject(
      fullInput(cloned.cache, { identityLedger: first.identityLedger }),
    );

    const [split] = second.identityLedgerEvents.filter((event) => event.kind === 'split');
    assert.equal(split.assetId, idOf(TAG), 'the original keeps the id');
    assert.deepEqual(split.siblingAssetIds, [idOf('MAH009-10-01')]);

    // Both are in the register. A merge would have shown up as one asset here.
    assert.equal(second.catalog.assets.length, first.catalog.assets.length + 1);
    assert.ok(second.snapshot.nodes.has(idOf(TAG)));
    assert.ok(second.snapshot.nodes.has(idOf('MAH009-10-01')));
  } finally {
    cloned.close();
  }
});

test('renaming the raw file changes nothing: identity is the source model, not the file name', () => {
  const renamed = openDragonSubset('ledger-renamed', {
    inputFileName: 'Dragon-Coordination-Rev-B.nwd',
  });
  try {
    const first = compileProject(fullInput(plain.cache));
    const second = compileProject(
      fullInput(renamed.cache, { identityLedger: first.identityLedger }),
    );
    assert.deepEqual(second.identityLedgerEvents, []);
  } finally {
    renamed.close();
  }
});

test('a source that is not registered this time leaves its assets flagged, never deleted', () => {
  const mechanical = openDragonSubset('ledger-mech', {
    sourceModels: DRAGON_MECHANICAL_MODELS,
    inputFileName: 'Dragon-Mechanical-only.nwd',
  });
  try {
    const first = compileProject(fullInput(plain.cache));
    const second = compileProject(
      fullInput(mechanical.cache, { identityLedger: first.identityLedger }),
    );

    const gone = second.identityLedger.entries.filter((entry) => entry.status === 'disappeared');
    assert.ok(gone.length > 0);
    assert.ok(gone.some((entry) => entry.assetId === idOf('PLC001-10-01')));
    assert.equal(second.identityLedger.entries.length, first.identityLedger.entries.length);

    // Registering it again gives every one of them the id it always had.
    const controls = openDragonSubset('ledger-controls', {
      sourceModels: DRAGON_CONTROLS_MODELS,
      inputFileName: 'Dragon-Controls-only.nwd',
    });
    try {
      const third = compileProject({
        ...fullInput(mechanical.cache, { identityLedger: second.identityLedger }),
        sources: [
          ...oneSource(mechanical.cache),
          { sourceId: 'dragon-controls', cache: controls.cache },
        ],
      });
      assert.equal(
        third.identityLedgerEvents.some((event) => event.kind === 'new-asset'),
        false,
        'nothing came back as a new asset',
      );
      assert.ok(third.snapshot.nodes.has(idOf('PLC001-10-01')));
    } finally {
      controls.close();
    }
  } finally {
    mechanical.close();
  }
});

/* ------------------------------------------- stored decisions, re-addressed */

/**
 * A parent decision, spelled four different ways.
 *
 * A project file holds whatever the compile that showed it published, and an
 * 0.8.1 file holds tag-derived ids. All four have to reach the same asset --
 * that is what "manual decisions survive" means in practice.
 */
for (const [label, refOf] of [
  ['the ledger asset id', () => idOf(TYPO)],
  ['the tag it used to carry', () => TYPO],
  ['the tag it carries now', () => TAG],
  ["the catalog's id for the tag it carries now", () => idOf(TAG)],
]) {
  test(`a manual parent recorded under ${label} still applies after the correction`, () => {
    const first = firstCompile();
    const second = compileProject(
      fullInput(plain.cache, {
        identityLedger: first.identityLedger,
        manualRelationshipOverrides: [
          { childAssetId: refOf(), parentAssetId: NEIGHBOUR, note: 'One hot water train.' },
        ],
      }),
    );

    const node = second.snapshot.nodes.get(idOf(TYPO));
    assert.equal(node.parent.status, 'resolved');
    assert.equal(node.parent.parentAssetId, idOf(NEIGHBOUR));
    assert.equal(node.parent.ladderSource, 'manual');
    assert.equal(node.parent.winningClaim.provenance.manualDecision, 'One hot water train.');
    assert.deepEqual(
      second.reviewItems.filter((item) => item.kind === 'orphaned-decision'),
      [],
    );
  });
}

test('a manual system assignment recorded under the old tag survives the correction', () => {
  const first = firstCompile();
  const second = compileProject(
    fullInput(plain.cache, {
      identityLedger: first.identityLedger,
      manualSystemAssignments: new Map([
        [idOf(TYPO), { systemKey: '650', note: 'Commissioned under the utility system.' }],
      ]),
    }),
  );

  assert.equal(second.systems.bySubject.get(idOf(TYPO)).resolution.systemKey, '650');
  assert.deepEqual(
    second.reviewItems.filter((item) => item.kind === 'orphaned-decision'),
    [],
  );
});

test('a decision naming equipment no revision has becomes an orphaned decision, note and all', () => {
  const project = compileProject(
    fullInput(plain.cache, {
      manualRelationshipOverrides: [
        {
          childAssetId: idOf('GHOST999-99-99'),
          parentAssetId: idOf(NEIGHBOUR),
          note: 'Kept from the old register.',
        },
      ],
      manualSystemAssignments: new Map([
        [idOf('GHOST999-99-99'), { systemKey: '650', note: 'Same ghost.' }],
      ]),
    }),
  );

  assert.deepEqual(project.reviewItems.filter((item) => item.kind === 'orphaned-decision'), [
    {
      kind: 'orphaned-decision',
      decision: 'manual-parent',
      childRef: idOf('GHOST999-99-99'),
      parentRef: idOf(NEIGHBOUR),
      reason: 'unknown-child',
      note: 'Kept from the old register.',
    },
    {
      kind: 'orphaned-decision',
      decision: 'manual-system',
      childRef: idOf('GHOST999-99-99'),
      parentRef: '',
      reason: 'unknown-child',
      note: 'Same ghost.',
    },
  ]);
});

test('a decision whose parent left the model is orphaned rather than silently re-rooted', () => {
  const mechanical = openDragonSubset('ledger-orphan-parent', {
    sourceModels: DRAGON_MECHANICAL_MODELS,
    inputFileName: 'Dragon-Mechanical-only.nwd',
  });
  try {
    const project = compileProject(
      fullInput(mechanical.cache, {
        manualRelationshipOverrides: [
          { childAssetId: TAG, parentAssetId: idOf('PLC001-10-01'), note: 'Under the panel.' },
        ],
      }),
    );

    assert.deepEqual(project.reviewItems.filter((item) => item.kind === 'orphaned-decision'), [
      {
        kind: 'orphaned-decision',
        decision: 'manual-parent',
        childRef: TAG,
        parentRef: idOf('PLC001-10-01'),
        reason: 'unknown-parent',
        note: 'Under the panel.',
      },
    ]);
    // The decision produced no hierarchy, which is correct, and it is visible,
    // which is the point.
    assert.equal(project.snapshot.nodes.get(idOf(TAG)).parent.ladderSource, null);
  } finally {
    mechanical.close();
  }
});

test('a decision naming a tag two assets carry is refused rather than attached to one of them', () => {
  const controls = openDragonSubset('ledger-ambiguous', {
    sourceModels: DRAGON_CONTROLS_MODELS,
    inputFileName: 'Dragon-Controls-only.nwd',
  });
  try {
    // The same file twice under two source ids: every tag is duplicated, so no
    // tag names one asset any more.
    const project = compileProject({
      ...fullInput(controls.cache),
      sources: [
        { sourceId: 'controls-a', cache: controls.cache },
        { sourceId: 'controls-b', cache: controls.cache },
      ],
      manualRelationshipOverrides: [
        { childAssetId: 'VFD001-10-01', parentAssetId: 'PLC001-10-01', note: 'Under the panel.' },
      ],
    });

    assert.deepEqual(project.reviewItems.filter((item) => item.kind === 'orphaned-decision'), [
      {
        kind: 'orphaned-decision',
        decision: 'manual-parent',
        childRef: 'VFD001-10-01',
        parentRef: 'PLC001-10-01',
        reason: 'ambiguous-child',
        note: 'Under the panel.',
      },
    ]);
  } finally {
    controls.close();
  }
});

/* --------------------------------------------------- what the project keeps */

test('the revision diff reports the correction as a changed tag, with no hint from the caller', () => {
  const first = firstCompile();
  const second = compileProject(
    fullInput(plain.cache, { identityLedger: first.identityLedger }),
  );

  const diff = diffMelRevisions(first.generatedMel.assets, second.generatedMel.assets);
  assert.deepEqual(diff.added, []);
  assert.deepEqual(diff.removed, []);
  assert.deepEqual(
    diff.changedTags.map((change) => `${change.before} -> ${change.after}`),
    [`${TYPO} -> ${TAG}`],
  );
});

test('the ledger survives being written to a project file and read back', () => {
  const first = firstCompile();
  const stored = JSON.parse(JSON.stringify(first.identityLedger));
  assert.deepEqual(stored, first.identityLedger);

  const second = compileProject(fullInput(plain.cache, { identityLedger: stored }));
  const direct = compileProject(
    fullInput(plain.cache, { identityLedger: first.identityLedger }),
  );
  assert.deepEqual(second.identityLedger, direct.identityLedger);
  assert.deepEqual(second.identityLedgerEvents, direct.identityLedgerEvents);
});

test('a compile with no previous ledger is unchanged by the ledger existing', () => {
  // The pipeline gained a stage; a project that has never been compiled must
  // still produce exactly what it produced before, ids included.
  const project = compileProject(fullInput(plain.cache));
  assert.ok(project.catalog.assets.every((asset) => asset.assetId === idOf(asset.canonicalTag)));
  assert.deepEqual(project.reviewItems.filter((item) => item.kind === 'orphaned-decision'), []);
});

/* ------------------------------- derived-attribute assignments (P0-9) --- */

/** A site-defined attribute assigned by hand, keyed however the caller spells it. */
function zoneProfile(ref) {
  return {
    derivedAttributes: [
      {
        attributeId: 'zone',
        displayName: 'Zone',
        resolverChain: [{ kind: 'manual', assignments: [{ assetId: ref, value: 'Z9' }] }],
      },
    ],
  };
}

test('a derived assignment recorded under the old tag survives the correction', () => {
  // The third kind of stored decision, and the one that used to be positional:
  // a hand-assigned Area or Turnover Package keyed by a spelling the model has
  // since corrected. It is a value a boundary level may compare, so losing it
  // silently moves equipment.
  const first = firstCompile({ profile: siteProfile(zoneProfile(TYPO)) });
  assert.equal(
    first.derivedAttributes.find((entry) => entry.assetId === idOf(TYPO)).values[0].value,
    'Z9',
  );

  const second = compileProject(
    fullInput(plain.cache, {
      profile: siteProfile(zoneProfile(TYPO)),
      identityLedger: first.identityLedger,
    }),
  );

  const corrected = second.catalog.assets.find((asset) => asset.canonicalTag === TAG);
  assert.deepEqual(
    second.derivedAttributes
      .find((entry) => entry.assetId === corrected.assetId)
      .values.map((value) => value.value),
    ['Z9'],
    'the ledger re-aimed the table, so the hand-made value is still on the asset',
  );
  assert.equal(
    second.reviewItems.some((item) => item.kind === 'orphaned-decision'),
    false,
  );
});

test('a derived assignment nobody can re-aim is reported, never dropped', () => {
  const project = firstCompile({ profile: siteProfile(zoneProfile('MAH009-99-99')) });

  const orphaned = project.reviewItems.find(
    (item) => item.kind === 'orphaned-decision' && item.decision === 'derived-attribute',
  );
  assert.equal(orphaned.childRef, 'MAH009-99-99');
  assert.equal(orphaned.field, 'zone', 'two attributes are two rows to re-aim, not one');
  assert.equal(orphaned.reason, 'unknown-child');
  assert.equal(orphaned.note, 'Z9', "the person's own value survives its address");
  assert.equal(
    project.derivedAttributes.every((entry) => entry.values.length === 0),
    true,
    'and nothing was assigned to an asset nobody meant',
  );
});

/**
 * A tag re-match against an entry that had VANISHED is a question, not a
 * silence (P0-9).
 *
 * The `tag` tier is the weakest rung and the only one not scoped to a model
 * file. It exists so a re-extraction with no stable evidence still carries an
 * id forward — and the cost is that a number a site retires and reuses hands
 * the new equipment the old unit's id, and with it every manual system, manual
 * parent and review decision recorded against it. The re-match still happens,
 * because refusing it would mint a fresh id and orphan all of that. What was
 * missing was anyone being told.
 */
test('a tag-only re-match against a disappeared entry raises a possible-rematch', () => {
  // 1. The whole site: every asset gets an id on model evidence.
  const first = compileProject(fullInput(plain.cache));

  // 2. A revision of the model that does not contain it at all — the unit was
  //    decommissioned. Its entry is KEPT and marked `disappeared`, which is
  //    what makes the decisions recorded against it still resolvable.
  const without = openDragonSubset('ledger-rematch-gone', {
    tagFilter: (tag) => tag !== TAG,
  });
  let second;
  try {
    second = compileProject(fullInput(without.cache, { identityLedger: first.identityLedger }));
  } finally {
    without.close();
  }
  const vanished = second.identityLedger.entries.find((entry) => entry.assetId === idOf(TAG));
  assert.equal(vanished.status, 'disappeared');

  // 3. It comes back — under the same tag, on an object with none of the model
  //    evidence the ledger remembers. Exactly what a reused tag looks like from
  //    the outside, and exactly what a rebuilt model looks like too, which is
  //    why this is a review item rather than a refusal.
  const reissued = openDragonCache('ledger-rematch-back', (context) => {
    const id = context.objectIdOfTag(TAG);
    context.setObjectIdentity(id, {
      authoringId: 'id-reissued-777',
      instanceGuid: '00000000-0000-4000-8000-000000007771',
    });
    context.moveUnder(TAG, context.layerId('D2', 1), 2);
  });
  try {
    const third = compileProject(
      fullInput(reissued.cache, { identityLedger: second.identityLedger }),
    );

    assert.ok(
      third.identityLedgerEvents.some(
        (event) => event.kind === 'rematched-by-tag' && event.assetId === idOf(TAG),
      ),
      'the ledger still reports the re-match as an event',
    );

    const questions = third.reviewItems.filter((item) => item.kind === 'possible-rematch');
    assert.deepEqual(questions, [
      {
        kind: 'possible-rematch',
        assetId: idOf(TAG),
        canonicalTag: TAG,
        reason: 'reappeared',
        previousSourceIds: ['dragon'],
        sourceIds: ['dragon'],
      },
    ]);

    // The id itself was kept, which is the point: the decisions recorded
    // against it still apply while the question is open.
    assert.ok(third.snapshot.nodes.has(idOf(TAG)));
  } finally {
    reissued.close();
  }
});

test('an ordinary tag re-match, on an entry that never vanished, stays an event', () => {
  const first = compileProject(fullInput(plain.cache));
  // Same object, same place, new authoring evidence: a model re-exported by a
  // tool that renumbers. The tag carries it, and nothing about that is
  // suspicious.
  const reexported = openDragonCache('ledger-rematch-plain', (context) => {
    const id = context.objectIdOfTag(TAG);
    context.setObjectIdentity(id, {
      authoringId: 'id-reexported-888',
      instanceGuid: '00000000-0000-4000-8000-000000008881',
    });
    context.moveUnder(TAG, context.layerId('D2', 1), 2);
  });
  try {
    const second = compileProject(
      fullInput(reexported.cache, { identityLedger: first.identityLedger }),
    );
    assert.ok(
      second.identityLedgerEvents.some((event) => event.kind === 'rematched-by-tag'),
      'still reported as an event',
    );
    assert.deepEqual(
      second.reviewItems.filter((item) => item.kind === 'possible-rematch'),
      [],
      'but not as a question: the entry was there all along, in the same document',
    );
  } finally {
    reexported.close();
  }
});
