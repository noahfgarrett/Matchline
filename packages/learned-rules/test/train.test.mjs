import assert from 'node:assert/strict';
import test from 'node:test';

import { trainLearnedRules } from '../dist/index.js';
import {
  DRAGON_TRAINING_ROWS,
  DRAGON_TRAINING_ROWS_REORDERED,
  GRADE_AT_THRESHOLD_ROWS,
  GRADE_BELOW_THRESHOLD_ROWS,
  GRADE_TOO_FEW_PREDICTIONS_ROWS,
  THREE_OBSERVATION_ROWS,
  TWO_OBSERVATION_ROWS,
} from './dist/dragon.fixture.js';

const dragon = () => trainLearnedRules(DRAGON_TRAINING_ROWS, { label: 'Dragon finished SSM' });

const gateFor = (ruleSet, cls) => ruleSet.roleGates.find((gate) => gate.class === cls);
const gradeFor = (ruleSet, cls) => ruleSet.grades.find((entry) => entry.class === cls);

test('training the same export twice produces byte-identical rules', () => {
  assert.deepEqual(dragon(), dragon());
  assert.equal(JSON.stringify(dragon()), JSON.stringify(dragon()));
});

test('row order carries no information: reordering the export changes nothing', () => {
  const reordered = trainLearnedRules(DRAGON_TRAINING_ROWS_REORDERED, {
    label: 'Dragon finished SSM',
  });
  assert.deepEqual(reordered, dragon());
});

test('digit runs are masked, so every air handler description is one pattern', () => {
  const ruleSet = dragon();
  const patterns = ruleSet.classification.map((entry) => entry.pattern);
  assert.deepEqual(patterns, [
    'programmable logic controller #',
    'variable frequency drive #',
    'temperature transmitter #',
    'air handling unit #',
  ]);

  // MAH001's and MAH002's descriptions differ only in their number.
  const airHandlers = ruleSet.classification.find(
    (entry) => entry.pattern === 'air handling unit #',
  );
  assert.equal(airHandlers.class, 'MAH');
  assert.equal(airHandlers.sampleCount, 10, 'all ten air handlers landed on one pattern');
  assert.equal(airHandlers.confidence, 1);
});

test('the same masked pattern under two disciplines stays two rules', () => {
  const ruleSet = dragon();
  const disciplines = ruleSet.classification.map((entry) => entry.discipline);
  assert.deepEqual(disciplines, ['electrical', 'electrical', 'instrumentation', 'mechanical']);
});

test('role counts come from the links the finished SSM actually made', () => {
  const ruleSet = dragon();
  // 10 VFDs and 6 PLCs hang off air handlers; 10 TITs and 4 PLCs off drives.
  assert.deepEqual(
    { asParent: gateFor(ruleSet, 'MAH').asParent, asChild: gateFor(ruleSet, 'MAH').asChild },
    { asParent: 16, asChild: 0 },
  );
  assert.deepEqual(
    { asParent: gateFor(ruleSet, 'VFD').asParent, asChild: gateFor(ruleSet, 'VFD').asChild },
    { asParent: 14, asChild: 10 },
  );
  assert.deepEqual(
    { asParent: gateFor(ruleSet, 'TIT').asParent, asChild: gateFor(ruleSet, 'TIT').asChild },
    { asParent: 0, asChild: 10 },
  );
});

test('a class that never parents anything over ten sightings is child-only', () => {
  const ruleSet = dragon();
  assert.equal(gateFor(ruleSet, 'TIT').isChildOnly, true);
  assert.equal(gateFor(ruleSet, 'PLC').isChildOnly, true);
  assert.equal(gateFor(ruleSet, 'TIT').isParentCapable, false);
  assert.equal(gateFor(ruleSet, 'PLC').isParentCapable, false);
});

test('a class that parents regularly stays a parent candidate', () => {
  const ruleSet = dragon();
  assert.equal(gateFor(ruleSet, 'MAH').isParentCapable, true);
  assert.equal(gateFor(ruleSet, 'MAH').isChildOnly, false);
  // The drive is both: a child of the air handler and a parent of the transmitter.
  assert.equal(gateFor(ruleSet, 'VFD').parentRate, 0.5833);
  assert.equal(gateFor(ruleSet, 'VFD').isParentCapable, true);
  assert.equal(gateFor(ruleSet, 'VFD').isChildOnly, false);
});

test('class pairs are counted as observed', () => {
  assert.deepEqual(dragon().affinities, [
    { childClass: 'PLC', parentClass: 'MAH', observations: 6 },
    { childClass: 'PLC', parentClass: 'VFD', observations: 4 },
    { childClass: 'TIT', parentClass: 'VFD', observations: 10 },
    { childClass: 'VFD', parentClass: 'MAH', observations: 10 },
  ]);
});

test('two sightings of a pairing is a coincidence, three is a rule', () => {
  assert.deepEqual(trainLearnedRules(TWO_OBSERVATION_ROWS).affinities, []);
  assert.deepEqual(trainLearnedRules(THREE_OBSERVATION_ROWS).affinities, [
    { childClass: 'SEN', parentClass: 'HUB', observations: 3 },
  ]);
});

test('a class that nests the same way every time earns the claim grade', () => {
  assert.deepEqual(gradeFor(dragon(), 'TIT'), {
    class: 'TIT',
    predicted: 10,
    correct: 10,
    precision: 1,
    grade: 'claim',
  });
});

test('a class the export nested inconsistently self-grades down to a proposal', () => {
  // Six PLCs under an air handler, four under a drive: the policy always
  // predicts the air handler, so it is right six times out of ten.
  assert.deepEqual(gradeFor(dragon(), 'PLC'), {
    class: 'PLC',
    predicted: 10,
    correct: 6,
    precision: 0.6,
    grade: 'proposal',
  });
});

test('only child-only classes are graded at all', () => {
  assert.deepEqual(
    dragon().grades.map((entry) => entry.class),
    ['PLC', 'TIT'],
    'the drive parents too much to be inferred as a child',
  );
});

test('exactly 85% precision earns the claim; a point under does not', () => {
  const atThreshold = gradeFor(trainLearnedRules(GRADE_AT_THRESHOLD_ROWS), 'SEN');
  assert.deepEqual(atThreshold, {
    class: 'SEN',
    predicted: 20,
    correct: 17,
    precision: 0.85,
    grade: 'claim',
  });

  const below = gradeFor(trainLearnedRules(GRADE_BELOW_THRESHOLD_ROWS), 'SEN');
  assert.deepEqual(below, {
    class: 'SEN',
    predicted: 20,
    correct: 16,
    precision: 0.8,
    grade: 'proposal',
  });
});

test('perfect precision over too few predictions is still only a proposal', () => {
  assert.deepEqual(gradeFor(trainLearnedRules(GRADE_TOO_FEW_PREDICTIONS_ROWS), 'SEN'), {
    class: 'SEN',
    predicted: 8,
    correct: 8,
    precision: 1,
    grade: 'proposal',
  });
});

test('an empty export trains an empty rule set, not a set of NaNs', () => {
  const ruleSet = trainLearnedRules([]);
  assert.deepEqual(ruleSet, {
    version: 1,
    classification: [],
    roleGates: [],
    affinities: [],
    grades: [],
    trainedFrom: { rowCount: 0, label: '' },
  });
  assert.ok(!JSON.stringify(ruleSet).includes('null'), 'no NaN serialized as null');
});

test('a row that names itself as its own parent is not a link', () => {
  const ruleSet = trainLearnedRules([
    {
      equipmentTag: 'MAH001-10-01',
      description: 'AIR HANDLING UNIT 001',
      parentTag: 'mah001-10-01',
      systemKey: 'SYS-10',
    },
  ]);
  assert.deepEqual(ruleSet.roleGates, []);
  assert.deepEqual(ruleSet.affinities, []);
});

test('a parent in another system is not a link', () => {
  const ruleSet = trainLearnedRules([
    { equipmentTag: 'MAH001-10-01', description: 'AIR HANDLING UNIT 001', systemKey: 'SYS-10' },
    {
      equipmentTag: 'VFD001-10-01',
      description: 'VARIABLE FREQUENCY DRIVE 001',
      parentTag: 'MAH001-10-01',
      systemKey: 'SYS-20',
    },
  ]);
  assert.deepEqual(ruleSet.roleGates, []);
});
