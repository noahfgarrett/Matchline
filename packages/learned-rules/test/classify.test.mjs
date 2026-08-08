import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyDescription, trainLearnedRules } from '../dist/index.js';
import {
  BORDERLINE_CLASS_ROWS,
  DRAGON_TRAINING_ROWS,
  SPLIT_CLASS_ROWS,
} from './dist/dragon.fixture.js';

const dragon = () => trainLearnedRules(DRAGON_TRAINING_ROWS);

test('a description the export never disagreed about classifies outright', () => {
  assert.deepEqual(classifyDescription(dragon(), 'AIR HANDLING UNIT 042', 'Mechanical'), {
    class: 'MAH',
    confidence: 1,
  });
});

test('an unseen instance number classifies off the masked pattern', () => {
  // 042 appears nowhere in the training export; the pattern does.
  assert.equal(
    classifyDescription(dragon(), 'temperature transmitter 9999', 'Instrumentation').class,
    'TIT',
  );
});

test('case and repeated whitespace are normalization, not distinction', () => {
  assert.deepEqual(classifyDescription(dragon(), '  Air   Handling  Unit 7 ', 'MECHANICAL'), {
    class: 'MAH',
    confidence: 1,
  });
});

test('discipline is part of the key, not a hint', () => {
  const ruleSet = dragon();
  assert.equal(classifyDescription(ruleSet, 'AIR HANDLING UNIT 001', 'Electrical'), null);
  assert.equal(
    classifyDescription(ruleSet, 'AIR HANDLING UNIT 001'),
    null,
    'omitting the discipline looks under the empty discipline, which trained nothing',
  );
});

test('a description the export never carried has no class', () => {
  assert.equal(classifyDescription(dragon(), 'CONTROL PANEL RACK 001', 'Electrical'), null);
  assert.equal(classifyDescription(dragon(), '', 'Electrical'), null);
  assert.equal(classifyDescription(dragon(), undefined, 'Electrical'), null);
});

test('a pattern that split three ways to two is under the gate and answers nothing', () => {
  const ruleSet = trainLearnedRules(SPLIT_CLASS_ROWS);
  assert.equal(ruleSet.classification[0].confidence, 0.6);
  assert.equal(
    classifyDescription(ruleSet, 'TEMPERATURE TRANSMITTER 042', 'Instrumentation'),
    null,
  );
});

test('exactly 0.9 confidence still answers', () => {
  const ruleSet = trainLearnedRules(BORDERLINE_CLASS_ROWS);
  assert.deepEqual(classifyDescription(ruleSet, 'TEMPERATURE TRANSMITTER 042', 'Instrumentation'), {
    class: 'TIT',
    confidence: 0.9,
  });
});

test('an untrained rule set classifies nothing', () => {
  assert.equal(classifyDescription(trainLearnedRules([]), 'AIR HANDLING UNIT 001', 'Mechanical'), null);
});
