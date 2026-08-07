import assert from 'node:assert/strict';
import test from 'node:test';

import { RELATIONSHIP_TYPES, assertNever, relationshipKindOf } from '../dist/index.js';

test('every relationship type resolves to a kind', () => {
  assert.equal(RELATIONSHIP_TYPES.length, 8);
  for (const type of RELATIONSHIP_TYPES) {
    const kind = relationshipKindOf(type);
    assert.ok(
      kind === 'structural-parent' || kind === 'dependency',
      `${type} resolved to unexpected kind ${kind}`,
    );
  }
});

test('control and service relations never re-parent an asset', () => {
  for (const type of ['CONTROLS', 'SERVES', 'DEPENDENCY']) {
    assert.equal(relationshipKindOf(type), 'dependency');
  }
});

test('power, wiring and explicit parentage can nest an asset', () => {
  for (const type of [
    'POWERS',
    'WIRED_TO',
    'EXPLICIT_PARENT',
    'FAMILY_RELATED',
    'STRUCTURAL_PARENT_CANDIDATE',
  ]) {
    assert.equal(relationshipKindOf(type), 'structural-parent');
  }
});

test('an unknown relationship type is rejected rather than silently ignored', () => {
  assert.throws(
    () => relationshipKindOf('TELEPATHY'),
    /unhandled RelationshipType.*TELEPATHY/s,
  );
});

test('assertNever reports the value it was handed', () => {
  assert.throws(() => assertNever('surprise', 'unhandled thing'), /unhandled thing.*surprise/s);
});
