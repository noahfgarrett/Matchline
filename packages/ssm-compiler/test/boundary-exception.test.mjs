/**
 * The one exception to a hard boundary (fold.ts rule 6).
 *
 * `foldBoundaries` is the most consequential comparison in the product, so an
 * exception to it is worth its own file. What is proved here is the shape of
 * the exception rather than the SOP that motivates it: it is keyed on the
 * CHILD's class, it applies to exactly one named level, it silences the missing
 * arm as well as the differing one, and it changes nothing anywhere else.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { compileSnapshot, foldBoundaries } from '../dist/index.js';

const DISCIPLINE_ONLY = {
  levels: [
    {
      levelId: 'ssm-discipline',
      displayName: 'SSM Discipline',
      keyAttributeKey: 'ssmDiscipline',
      boundary: true,
      boundaryExceptions: { childClasses: ['vfd', 'instrument'] },
      missingValuePolicy: 'unassigned-group',
      sort: 'label',
    },
  ],
};

const NO_EXCEPTION = {
  levels: [{ ...DISCIPLINE_ONLY.levels[0], boundaryExceptions: undefined }],
};

function subject(assetId, discipline, equipmentClass) {
  const attributes = new Map();
  if (discipline !== null) {
    attributes.set('ssmDiscipline', discipline);
  }
  return {
    assetId,
    attributes,
    ...(equipmentClass === undefined ? {} : { equipmentClass }),
  };
}

const MACHINE = subject('mah', 'Mechanical');

test('a differing discipline demotes a child whose class is not on the list', () => {
  const pump = subject('pump', 'Electrical', 'driven');
  assert.deepEqual(foldBoundaries(pump, MACHINE, DISCIPLINE_ONLY), {
    kind: 'demote',
    levelId: 'ssm-discipline',
  });
});

test('and keeps one whose class is', () => {
  const drive = subject('vfd', 'Electrical', 'vfd');
  assert.deepEqual(foldBoundaries(drive, MACHINE, DISCIPLINE_ONLY), { kind: 'keep' });
  assert.deepEqual(
    foldBoundaries(drive, MACHINE, NO_EXCEPTION),
    { kind: 'demote', levelId: 'ssm-discipline' },
    'the same pair, with the exception removed',
  );
});

test('the exception reads the child’s class and never the parent’s', () => {
  // A machine under a drive is the pairing upside down, and the exception must
  // not license it just because the drive is on the exempt list.
  const machineUnderDrive = foldBoundaries(
    subject('mah', 'Mechanical', 'driven'),
    subject('vfd', 'Electrical', 'vfd'),
    DISCIPLINE_ONLY,
  );
  assert.deepEqual(machineUnderDrive, { kind: 'demote', levelId: 'ssm-discipline' });
});

test('a level that does not apply cannot be unknown about anything', () => {
  const unstated = subject('tit', null, 'instrument');
  assert.deepEqual(
    foldBoundaries(unstated, MACHINE, DISCIPLINE_ONLY),
    { kind: 'keep' },
    'the missing arm is waived with the differing one',
  );
  assert.equal(
    foldBoundaries(unstated, MACHINE, NO_EXCEPTION).kind,
    'missing',
    'and only because of the exception',
  );
});

test('an unclassified child folds exactly as everything always did', () => {
  const nameless = subject('x', 'Electrical');
  assert.deepEqual(foldBoundaries(nameless, MACHINE, DISCIPLINE_ONLY), {
    kind: 'demote',
    levelId: 'ssm-discipline',
  });
});

test('the exception is per level: another boundary still applies', () => {
  const twoLevels = {
    levels: [
      {
        levelId: 'building',
        displayName: 'Building',
        keyAttributeKey: 'building',
        boundary: true,
        missingValuePolicy: 'unassigned-group',
        sort: 'label',
      },
      ...DISCIPLINE_ONLY.levels,
    ],
  };
  const drive = subject('vfd', 'Electrical', 'vfd');
  drive.attributes.set('building', 'B22');
  const machine = subject('mah', 'Mechanical');
  machine.attributes.set('building', 'B14');

  assert.deepEqual(foldBoundaries(drive, machine, twoLevels), {
    kind: 'demote',
    levelId: 'building',
  });
});

test('the class reaches the snapshot, so a reader need not classify again', () => {
  const snapshot = compileSnapshot({
    subjects: [MACHINE, subject('vfd', 'Electrical', 'vfd')],
    claims: { structural: [], dependencies: [], makeRoot: [] },
    hierarchy: DISCIPLINE_ONLY,
  });
  assert.equal(snapshot.nodes.get('vfd').equipmentClass, 'vfd');
  assert.equal(
    snapshot.nodes.get('mah').equipmentClass,
    undefined,
    'a subject that stated no class states none on the node either',
  );
});
