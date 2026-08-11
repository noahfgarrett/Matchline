import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decodePropertyRef,
  encodePropertyRef,
  isPropertyInCatalog,
  missingPropertyLabel,
  propertyRefEquals,
} from '../dist/shared/property-ref.js';

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

/* ------------------------------------------- the mapped-but-absent state (M4c) */

/**
 * The picker's second failure mode, and the one this round fixed.
 *
 * The codec above stopped the `<select>` losing a mapping it *could* show. This
 * is the case where it cannot: the profile maps a property the currently loaded
 * model sources do not carry. That is an ordinary state — a source mid
 * re-extraction, a model swapped for a newer issue, a profile imported before
 * its models were added — and it used to render as "Not mapped", because a
 * `<select>` whose value matches no option falls back to the first one. The
 * screen stated a decision nobody had made, and because the DOM's own selection
 * had already moved, the next interaction wrote that emptiness into the draft.
 */

const CATALOG = [
  { category: 'Dragon Data', name: 'Tag' },
  { category: 'Item', name: 'Name' },
];

test('a property the catalog carries is recognised', () => {
  assert.equal(isPropertyInCatalog({ category: 'Dragon Data', name: 'Tag' }, CATALOG), true);
});

test('a mapped property the catalog does not carry is recognised as absent', () => {
  assert.equal(isPropertyInCatalog({ category: 'Legacy', name: 'Asset Number' }, CATALOG), false);
  // Not a near-match either: a property is only addressable as the pair.
  assert.equal(isPropertyInCatalog({ category: 'Item', name: 'Tag' }, CATALOG), false);
  assert.equal(isPropertyInCatalog({ category: 'Dragon Data', name: 'Name' }, CATALOG), false);
});

test('an unmapped field is not "absent" — it is unmapped, which is a different sentence', () => {
  assert.equal(isPropertyInCatalog(null, CATALOG), false);
  assert.equal(isPropertyInCatalog(null, []), false);
});

test('two addresses are equal only when both halves are', () => {
  assert.equal(
    propertyRefEquals({ category: 'a', name: 'b' }, { category: 'a', name: 'b' }),
    true,
  );
  assert.equal(
    propertyRefEquals({ category: 'a', name: 'b' }, { category: 'a', name: 'c' }),
    false,
  );
  assert.equal(propertyRefEquals(null, null), true);
  assert.equal(propertyRefEquals(null, { category: 'a', name: 'b' }), false);
});

test('the absent label states the mapping first and the absence second', () => {
  const label = missingPropertyLabel({ category: 'Legacy Data', name: 'Asset Number' });

  assert.match(label, /^Mapped: Legacy Data > Asset Number/, 'the mapping is the fact');
  assert.match(label, /not present in the current model sources/, 'the absence is the circumstance');
  assert.doesNotMatch(label, /Not mapped/, 'and it never says the thing that was wrong');
});
