import assert from 'node:assert/strict';
import test from 'node:test';

import { decodePropertyRef, encodePropertyRef } from '../dist/shared/property-ref.js';

/**
 * The `<option value>` codec for a `PropertyRef`.
 *
 * This exists because the first version split on a delimiter and lost, twice
 * over: a space cut `Dragon Data > Tag` between "Dragon" and "Data Tag", and a
 * control-character separator made the browser fail to match the option at all,
 * so the `<select>` showed "Not chosen yet" over a mapping that was in fact set.
 * Both failures are here as cases.
 */

const AWKWARD_REFS = [
  { category: 'Dragon Data', name: 'Tag' },
  { category: 'Item', name: 'Name' },
  { category: '', name: 'Unnamed category' },
  { category: 'Revit Type', name: 'Type Comments' },
  { category: 'Has "quotes"', name: 'and \\backslashes\\' },
  { category: 'a > b', name: 'c > d' },
  { category: 'tabs\there', name: 'newlines\nhere' },
  { category: 'unicode — em dash', name: 'ünïcode' },
];

test('every awkward property pair round-trips', () => {
  for (const ref of AWKWARD_REFS) {
    assert.deepEqual(decodePropertyRef(encodePropertyRef(ref)), ref, JSON.stringify(ref));
  }
});

test('a category containing a space does not get split inside it', () => {
  const encoded = encodePropertyRef({ category: 'Dragon Data', name: 'Tag' });
  assert.deepEqual(decodePropertyRef(encoded), { category: 'Dragon Data', name: 'Tag' });
});

test('the encoding is printable, so the DOM can carry it as an attribute', () => {
  for (const ref of AWKWARD_REFS) {
    const encoded = encodePropertyRef(ref);
    assert.doesNotMatch(encoded, /[\u0000-\u001f]/, `${encoded} carries a control character`);
  }
});

test('two different pairs never encode to the same string', () => {
  const encoded = new Set(AWKWARD_REFS.map(encodePropertyRef));
  assert.equal(encoded.size, AWKWARD_REFS.length);

  // The classic delimiter collision: `"a b" + "c"` vs `"a" + "b c"`.
  assert.notEqual(
    encodePropertyRef({ category: 'a b', name: 'c' }),
    encodePropertyRef({ category: 'a', name: 'b c' }),
  );
});

test('null and the empty option are the same thing', () => {
  assert.equal(encodePropertyRef(null), '');
  assert.equal(decodePropertyRef(''), null);
});

test('anything that is not a valid pair decodes to null rather than a half-ref', () => {
  for (const junk of ['not json', '{}', '[]', '["only one"]', '["a","b","c"]', '["a",1]', '["a",""]', 'null']) {
    assert.equal(decodePropertyRef(junk), null, junk);
  }
});
