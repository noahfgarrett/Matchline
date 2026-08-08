import assert from 'node:assert/strict';
import test from 'node:test';

import {
  proposeNestings,
  trainLearnedRules,
  validateLearnedRuleSet,
} from '../dist/index.js';
import { DRAGON_ASSETS, DRAGON_TRAINING_ROWS } from './dist/dragon.fixture.js';

const dragon = () => trainLearnedRules(DRAGON_TRAINING_ROWS, { label: 'Dragon finished SSM' });

test('a rule set survives the trip through a site profile unchanged', () => {
  const ruleSet = dragon();
  const restored = JSON.parse(JSON.stringify(ruleSet));
  assert.deepEqual(restored, ruleSet);
});

test('a restored rule set behaves identically to the one that was saved', () => {
  const restored = JSON.parse(JSON.stringify(dragon()));
  assert.deepEqual(proposeNestings(restored, DRAGON_ASSETS), proposeNestings(dragon(), DRAGON_ASSETS));
});

test('the validator accepts what training emits, trained or empty', () => {
  assert.equal(validateLearnedRuleSet(JSON.parse(JSON.stringify(dragon()))), true);
  assert.equal(validateLearnedRuleSet(JSON.parse(JSON.stringify(trainLearnedRules([])))), true);
});

test('the validator rejects things that are not a rule set at all', () => {
  for (const value of [null, undefined, 42, 'rules', [], () => undefined]) {
    assert.equal(validateLearnedRuleSet(value), false);
  }
});

test('the validator rejects a rule set from a version it cannot read', () => {
  const ruleSet = JSON.parse(JSON.stringify(dragon()));
  assert.equal(validateLearnedRuleSet({ ...ruleSet, version: 2 }), false);
  assert.equal(validateLearnedRuleSet({ ...ruleSet, version: '1' }), false);
});

test('the validator rejects a missing or malformed section', () => {
  const ruleSet = JSON.parse(JSON.stringify(dragon()));
  assert.equal(validateLearnedRuleSet({ ...ruleSet, affinities: undefined }), false);
  assert.equal(validateLearnedRuleSet({ ...ruleSet, roleGates: {} }), false);
  assert.equal(validateLearnedRuleSet({ ...ruleSet, grades: [null] }), false);
  assert.equal(validateLearnedRuleSet({ ...ruleSet, trainedFrom: { rowCount: 1 } }), false);
});

test('the validator rejects a grade nothing in this package can produce', () => {
  const ruleSet = JSON.parse(JSON.stringify(dragon()));
  const grades = ruleSet.grades.map((entry) => ({ ...entry, grade: 'definitely' }));
  assert.equal(validateLearnedRuleSet({ ...ruleSet, grades }), false);
});

test('the validator rejects out-of-range numbers a hand-edited profile could carry', () => {
  const ruleSet = JSON.parse(JSON.stringify(dragon()));
  const inflated = ruleSet.grades.map((entry) => ({ ...entry, precision: 12 }));
  assert.equal(validateLearnedRuleSet({ ...ruleSet, grades: inflated }), false);

  const negative = ruleSet.affinities.map((entry) => ({ ...entry, observations: -3 }));
  assert.equal(validateLearnedRuleSet({ ...ruleSet, affinities: negative }), false);

  const notFinite = ruleSet.classification.map((entry) => ({ ...entry, confidence: NaN }));
  assert.equal(validateLearnedRuleSet({ ...ruleSet, classification: notFinite }), false);
});

test('a rule set carries what it was trained from', () => {
  assert.deepEqual(dragon().trainedFrom, { rowCount: 40, label: 'Dragon finished SSM' });
  assert.deepEqual(trainLearnedRules(DRAGON_TRAINING_ROWS).trainedFrom, {
    rowCount: 40,
    label: '',
  });
});
