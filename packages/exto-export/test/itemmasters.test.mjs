/**
 * The learned item-master layer: the donor's two rungs, its 0.9 gate, its
 * CA_*→VF_* normalization, and its registry audit.
 *
 * Every expected number below is hand-derived from the counts in
 * `dragon.fixture.ts`, not read off a run.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ITEM_MASTER_MIN_CONFIDENCE,
  ITEM_MASTER_PROPOSAL_CANDIDATES,
  assignItemMaster,
  assignItemMasters,
  describeItemMasterNormalization,
  normalizeItemMasterName,
  suspectRowReason,
  trainItemMasterTable,
} from '../dist/index.js';
import {
  DRAGON_LOOKUPS,
  DRAGON_REGISTRY,
  DRAGON_VF_VOCABULARY,
} from './dist/dragon.fixture.js';

const TABLE = trainItemMasterTable(DRAGON_REGISTRY, {
  vocabulary: DRAGON_VF_VOCABULARY,
  label: 'Dragon registry export 2026-03',
});

/** The one learned entry matching a key, or undefined. */
function entryFor(rung, discipline, equipmentClass, systemKey, descriptionWord = '') {
  return TABLE.entries.find(
    (entry) =>
      entry.rung === rung &&
      entry.discipline === discipline &&
      entry.equipmentClass === equipmentClass &&
      entry.systemKey === systemKey &&
      entry.descriptionWord === descriptionWord,
  );
}

function outcomeFor(tag) {
  const asset = DRAGON_LOOKUPS.find((candidate) => candidate.canonicalTag === tag);
  assert.ok(asset, `no fixture asset ${tag}`);
  return assignItemMaster(TABLE, asset);
}

test('the gate is the donor 0.9 and is not a caller-supplied number', () => {
  assert.equal(ITEM_MASTER_MIN_CONFIDENCE, 0.9);
  assert.equal(ITEM_MASTER_PROPOSAL_CANDIDATES, 3);
});

/* -------------------------------------------------------------------------- */
/* CA_* -> VF_* normalization (donor `normalizeItemMasterName`)                */
/* -------------------------------------------------------------------------- */

test('a CA_ name becomes VF_ only when the template already carries the VF name', () => {
  const vocabulary = ['VF_EL_MV_GEAR', 'VF_IC_RIO'];
  assert.equal(normalizeItemMasterName('CA_NB_EL_MV_GEAR', vocabulary), 'VF_EL_MV_GEAR');
  assert.equal(normalizeItemMasterName('VF_EL_PANEL', vocabulary), 'VF_EL_PANEL', 'VF names pass through');
  assert.equal(
    normalizeItemMasterName('CA_NB_UNKNOWN_THING', vocabulary),
    'CA_NB_UNKNOWN_THING',
    'no VF match keeps the original',
  );
  assert.equal(
    normalizeItemMasterName('CA_NB_EL_MV_GEAR', []),
    'CA_NB_EL_MV_GEAR',
    'no vocabulary means no guessing',
  );
  assert.equal(normalizeItemMasterName(undefined, vocabulary), '');
});

test('normalization says why, in terms a review grid can print', () => {
  const vocabulary = ['VF_EL_MV_GEAR'];
  const rules = (name) => describeItemMasterNormalization(name, vocabulary).rule;
  assert.equal(rules('CA_NB_EL_MV_GEAR'), 'ca-to-vf');
  assert.equal(rules('VF_EL_MV_GEAR'), 'already-vf');
  assert.equal(rules('CA_NB_NOT_LISTED'), 'no-vf-match');
  assert.equal(rules('SOMETHING_ELSE'), 'not-legacy-ca');
  assert.equal(rules('   '), 'blank');
  assert.equal(describeItemMasterNormalization('CA_NB_EL_MV_GEAR', []).rule, 'no-vocabulary');

  const applied = describeItemMasterNormalization('  CA_NB_EL_MV_GEAR  ', vocabulary);
  assert.deepEqual(
    { input: applied.input, output: applied.output },
    { input: 'CA_NB_EL_MV_GEAR', output: 'VF_EL_MV_GEAR' },
  );
  assert.match(applied.detail, /VF_EL_MV_GEAR/);
});

test("the template's own spelling wins, and the first listed variant is chosen", () => {
  /* The suffix is matched case-insensitively but the output is the template's
     text, so a registry shouting CA_NB_el_mv_gear still writes the legal name. */
  assert.equal(normalizeItemMasterName('CA_NB_el_mv_gear', ['VF_EL_MV_GEAR']), 'VF_EL_MV_GEAR');
  assert.equal(
    normalizeItemMasterName('CA_NB_EL_MV_GEAR', ['VF_El_Mv_Gear', 'VF_EL_MV_GEAR']),
    'VF_El_Mv_Gear',
    'a template listing two case variants resolves to the one it lists first',
  );
});

test('a bare CA_ name with no site segment is not a legacy name', () => {
  /* `CA_NB_X` splits into site NB and name X; `CA_X` has no site segment at all
     and the donor's pattern does not match it. */
  assert.equal(normalizeItemMasterName('CA_GEAR', ['VF_GEAR']), 'CA_GEAR');
  assert.equal(normalizeItemMasterName('CA_NB_GEAR', ['VF_GEAR']), 'VF_GEAR');
});

/* -------------------------------------------------------------------------- */
/* Suspect registry rows (donor `suspectRegistryRow`)                          */
/* -------------------------------------------------------------------------- */

test('placeholders and electrical gear on non-electrical equipment are suspect', () => {
  assert.equal(
    suspectRowReason({ itemMaster: 'VF_Blank', discipline: 'UPW' }),
    'placeholder-item-master',
  );
  assert.equal(
    suspectRowReason({ itemMaster: 'CA_NB_EL_MV_GEAR', discipline: 'UPW' }),
    'electrical-gear-on-non-electrical',
  );
  assert.equal(suspectRowReason({ itemMaster: '', discipline: 'UPW' }), 'blank-item-master');
  assert.equal(suspectRowReason({ itemMaster: 'CA_NB_EL_MV_GEAR', discipline: 'ELECTRICAL' }), null);
  assert.equal(suspectRowReason({ itemMaster: 'VF_I&C_VALVE', discipline: 'WASTE' }), null);
});

test('suspect rows are audited, not learned, and everything else is learned', () => {
  assert.deepEqual(
    TABLE.audit.map((row) => [row.equipmentId, row.reason]),
    [
      ['DRG-X-PLACEHOLDER', 'placeholder-item-master'],
      ['DRG-X-GEAR', 'electrical-gear-on-non-electrical'],
      ['DRG-X-NOMASTER', 'blank-item-master'],
    ],
  );
  assert.equal(entryFor('class', 'mechanical', 'xv', '001'), undefined, 'placeholder row taught nothing');
  assert.equal(entryFor('class', 'upw', 'pmp', '004'), undefined, 'gear-on-UPW row taught nothing');
  assert.equal(TABLE.trainedFrom.rowCount, DRAGON_REGISTRY.length);
  assert.equal(TABLE.trainedFrom.label, 'Dragon registry export 2026-03');
});

test('a registry row with no UPN teaches nothing, because nothing could look it up', () => {
  assert.equal(entryFor('class', 'mechanical', 'pmp', ''), undefined);
  assert.equal(entryFor('description', 'mechanical', '', '', 'unscoped'), undefined);
  assert.ok(
    TABLE.entries.every((entry) => entry.systemKey !== ''),
    'no learned key may have an empty UPN',
  );
});

/* -------------------------------------------------------------------------- */
/* Training                                                                    */
/* -------------------------------------------------------------------------- */

test('legacy names are normalized before they are counted, not after', () => {
  const rio = entryFor('class', 'i&c', 'rio', '650');
  assert.deepEqual(
    { itemMaster: rio?.itemMaster, confidence: rio?.confidence, sampleCount: rio?.sampleCount },
    { itemMaster: 'VF_IC_RIO', confidence: 1, sampleCount: 10 },
    'ten CA_NB_IC_RIO rows are ten votes for VF_IC_RIO, not ten for a legacy name',
  );
  assert.equal(entryFor('class', 'electrical', 'swg', '002')?.itemMaster, 'VF_EL_MV_GEAR');
});

test('confidence is the dominant share of the rows behind a key', () => {
  assert.equal(entryFor('class', 'mechanical', 'ahu', '001')?.confidence, 1);
  assert.equal(entryFor('class', 'mechanical', 'mtr', '001')?.confidence, 0.8, '8 of 10');
  assert.equal(entryFor('class', 'mechanical', 'pmp', '002')?.confidence, 0.9, '9 of 10');
  assert.equal(entryFor('description', 'mechanical', '', '003', 'chilled')?.sampleCount, 5);
});

test('a below-gate key offers its candidates, most-voted first', () => {
  const mtr = entryFor('class', 'mechanical', 'mtr', '001');
  assert.deepEqual(mtr?.candidates, ['VF_MECH_FAN', 'VF_MECH_PUMP']);
  assert.equal(mtr?.itemMaster, 'VF_MECH_FAN', 'the dominant name is still recorded');
});

test('both rungs are learned from the same row', () => {
  assert.equal(entryFor('class', 'mechanical', 'ahu', '001')?.itemMaster, 'VF_MECH_AHU');
  assert.equal(entryFor('description', 'mechanical', '', '001', 'air')?.itemMaster, 'VF_MECH_AHU');
  /* The MTR rows split cleanly by description even though their class does not. */
  assert.equal(entryFor('description', 'mechanical', '', '001', 'supply')?.confidence, 1);
  assert.equal(entryFor('description', 'mechanical', '', '001', 'booster')?.confidence, 1);
});

test('an empty registry trains an empty table that assigns nothing', () => {
  const empty = trainItemMasterTable([]);
  assert.deepEqual(
    { entries: empty.entries.length, audit: empty.audit.length, rows: empty.trainedFrom.rowCount },
    { entries: 0, audit: 0, rows: 0 },
  );
  assert.deepEqual(empty.vocabulary, []);
  assert.deepEqual(assignItemMaster(empty, DRAGON_LOOKUPS[0]), {
    kind: 'unmatched',
    canonicalTag: 'MAH001-10-01',
    reason: 'no-learned-key',
  });
});

/* -------------------------------------------------------------------------- */
/* The 0.9 gate                                                                */
/* -------------------------------------------------------------------------- */

test('a key above the gate assigns, with the reasoning behind it', () => {
  const outcome = outcomeFor('MAH001-10-01');
  assert.equal(outcome.kind, 'assigned');
  assert.deepEqual(
    {
      itemMaster: outcome.itemMaster,
      rung: outcome.rung,
      confidence: outcome.confidence,
      sampleCount: outcome.sampleCount,
    },
    { itemMaster: 'VF_MECH_AHU', rung: 'class', confidence: 1, sampleCount: 10 },
  );
  assert.match(outcome.rule, /mechanical \/ ahu \/ UPN 001/);
});

test('a key exactly on the gate assigns — 0.9 is admitted, not excluded', () => {
  const outcome = outcomeFor('PMP002-01-01');
  assert.equal(outcome.kind, 'assigned');
  assert.equal(outcome.confidence, ITEM_MASTER_MIN_CONFIDENCE);
  assert.equal(outcome.itemMaster, 'VF_MECH_PUMP');
});

test('a key below the gate assigns nothing and proposes instead', () => {
  const outcome = outcomeFor('MTR001-10-04');
  assert.equal(outcome.kind, 'proposal');
  assert.equal(outcome.itemMaster, undefined, 'a proposal states no item master');
  assert.deepEqual(outcome.candidates, ['VF_MECH_FAN', 'VF_MECH_PUMP']);
  assert.equal(outcome.confidence, 0.8);
  assert.equal(outcome.sampleCount, 10);
});

test('the class rung is consulted first, but a below-gate class rung yields to the description rung', () => {
  /* The donor takes the first candidate that cleared the gate, not the first
     candidate that matched: MTR/001 is 0.8, but "supply" in system 001 is 1.0. */
  const outcome = outcomeFor('MTR001-10-03');
  assert.equal(outcome.kind, 'assigned');
  assert.deepEqual(
    { itemMaster: outcome.itemMaster, rung: outcome.rung },
    { itemMaster: 'VF_MECH_FAN', rung: 'description' },
  );
  assert.match(outcome.rule, /description "supply"/);
});

test('an asset the registry never classified is still reachable by description', () => {
  const outcome = outcomeFor('CHW003-01-01');
  assert.deepEqual(
    { kind: outcome.kind, itemMaster: outcome.itemMaster, rung: outcome.rung },
    { kind: 'assigned', itemMaster: 'VF_MECH_PUMP', rung: 'description' },
  );
});

test('an unseen key and a missing system key are told apart', () => {
  assert.deepEqual(outcomeFor('TK010-01-01'), {
    kind: 'unmatched',
    canonicalTag: 'TK010-01-01',
    reason: 'no-learned-key',
  });
  assert.deepEqual(outcomeFor('FCU-SPARE-07'), {
    kind: 'unmatched',
    canonicalTag: 'FCU-SPARE-07',
    reason: 'no-system-key',
  });
});

test('a key is scoped to its system — the same class in another UPN does not vote', () => {
  const elsewhere = assignItemMaster(TABLE, {
    canonicalTag: 'MAH009-10-01',
    ssmDiscipline: 'Mechanical',
    equipmentClass: 'AHU',
    systemKey: '009',
    description: 'Air handling unit 99',
  });
  assert.equal(elsewhere.kind, 'unmatched', 'system 001 taught nothing about system 009');
});

/* -------------------------------------------------------------------------- */
/* Determinism                                                                 */
/* -------------------------------------------------------------------------- */

test('the trained table does not depend on the order the registry arrived in', () => {
  const shuffled = [...DRAGON_REGISTRY].reverse();
  const other = trainItemMasterTable(shuffled, {
    vocabulary: DRAGON_VF_VOCABULARY,
    label: 'Dragon registry export 2026-03',
  });
  assert.deepEqual(other.entries, TABLE.entries);
  /* The audit deliberately follows registry order: it is a reading list. */
  assert.deepEqual(
    [...other.audit].map((row) => row.equipmentId).sort(),
    [...TABLE.audit].map((row) => row.equipmentId).sort(),
  );
});

test('assignment is a pure function of the table and the asset', () => {
  const first = assignItemMasters(TABLE, DRAGON_LOOKUPS);
  const second = assignItemMasters(TABLE, DRAGON_LOOKUPS);
  assert.deepEqual(first, second);
  assert.equal(first.length, DRAGON_LOOKUPS.length, 'one outcome per asset, in input order');
  assert.deepEqual(
    first.map((outcome) => outcome.canonicalTag),
    DRAGON_LOOKUPS.map((asset) => asset.canonicalTag),
  );
});

test('whitespace and case in a key do not make a second key', () => {
  const outcome = assignItemMaster(TABLE, {
    canonicalTag: 'MAH001-10-09',
    ssmDiscipline: '  mechanical ',
    equipmentClass: 'ahu',
    systemKey: ' 001 ',
    description: 'AIR   handling unit 09',
  });
  assert.deepEqual(
    { kind: outcome.kind, itemMaster: outcome.itemMaster },
    { kind: 'assigned', itemMaster: 'VF_MECH_AHU' },
  );
});

test("a UPN's leading zeros are part of the key", () => {
  const outcome = assignItemMaster(TABLE, {
    canonicalTag: 'MAH1-10-01',
    ssmDiscipline: 'Mechanical',
    equipmentClass: 'AHU',
    systemKey: '1',
    description: 'Air handling unit',
  });
  assert.equal(outcome.kind, 'unmatched', "'1' is not '001'");
});
