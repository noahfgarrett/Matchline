import assert from 'node:assert/strict';
import test from 'node:test';

import {
  escapeSourceId,
  modelObjectKeyToString,
  parseModelObjectKey,
  unescapeSourceId,
} from '../dist/index.js';
import {
  ASSIGNMENT_FIELDS,
  COLLIDING_SOURCE_IDS,
  DRAGON_ASSIGNMENTS,
  DRAGON_OBJECT_KEYS,
  DRAGON_SOURCES,
} from './dist/model-universe.fixture.js';

test('two sources that share a raw file name are still two sources', () => {
  const [mechanical, controls] = DRAGON_SOURCES;
  assert.equal(mechanical.rawFileName, controls.rawFileName);
  assert.notEqual(mechanical.sourceId, controls.sourceId);
});

test('one object ordinal in two sources is two keys', () => {
  const [inMechanical, inControls] = DRAGON_OBJECT_KEYS;
  assert.equal(inMechanical.objectId, inControls.objectId);
  assert.notEqual(modelObjectKeyToString(inMechanical), modelObjectKeyToString(inControls));
});

test('a key reads back exactly as it was written', () => {
  for (const sourceId of COLLIDING_SOURCE_IDS) {
    for (const objectId of [0, 1, 42, Number.MAX_SAFE_INTEGER]) {
      const key = { sourceId, objectId };
      assert.deepEqual(parseModelObjectKey(modelObjectKeyToString(key)), key);
    }
  }
});

test('source ids that differ only in escapable characters never share a key', () => {
  const strings = COLLIDING_SOURCE_IDS.map((sourceId) =>
    modelObjectKeyToString({ sourceId, objectId: 1 }),
  );
  assert.equal(new Set(strings).size, strings.length);
});

test('escaping is reversible for any source id, not only for safe ones', () => {
  for (const sourceId of [...COLLIDING_SOURCE_IDS, '%25', '%2F', 'a#b/c%d']) {
    assert.equal(unescapeSourceId(escapeSourceId(sourceId)), sourceId);
  }
});

test('a key string carries exactly one unescaped separator', () => {
  const text = modelObjectKeyToString({ sourceId: 'a/b/c', objectId: 7 });
  assert.equal(text, 'a%2Fb%2Fc/7');
  assert.equal(text.split('/').length - 1, 1);
});

test('text this module did not write is refused rather than read loosely', () => {
  for (const text of [
    'no-separator',
    'source/',
    'source/x',
    'source/-1',
    'source/007',
    'source/1.5',
    'source/9007199254740993',
    // Not canonical: a lowercase escape is a different spelling of one key,
    // and accepting it would make two texts name one object.
    'a%2fb/1',
    // Not canonical: a raw `/` in the source id would have been escaped.
    'a%2Fb/1/2',
  ]) {
    assert.equal(parseModelObjectKey(text), null, text);
  }
});

test('an assignment states only what the site actually assigned', () => {
  assert.deepEqual([...ASSIGNMENT_FIELDS], ['building', 'nativeDiscipline']);
  for (const field of ASSIGNMENT_FIELDS) {
    assert.equal(typeof DRAGON_ASSIGNMENTS[field], 'string');
  }
  assert.deepEqual(
    [...DRAGON_ASSIGNMENTS.custom.keys()],
    ['contractor', 'package'],
    'custom keys are site-defined and carried verbatim',
  );
});
