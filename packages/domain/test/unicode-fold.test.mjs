import assert from 'node:assert/strict';
import test from 'node:test';

import { unicodeFold } from '../dist/index.js';

test('the dash family and the minus sign all fold onto the ASCII hyphen', () => {
  for (const dash of ['‐', '‑', '‒', '–', '—', '―', '−']) {
    assert.equal(unicodeFold(`MAH001${dash}10${dash}01`), 'MAH001-10-01');
  }
});

test('invisible characters are dropped rather than compared', () => {
  assert.equal(unicodeFold('MAH001​-10-01'), 'MAH001-10-01');
  assert.equal(unicodeFold('﻿MAH001-10-01'), 'MAH001-10-01');
});

test('a non-breaking space becomes an ordinary one, and hyphens lose their padding', () => {
  assert.equal(unicodeFold('MAH001 Unit'), 'MAH001 Unit');
  assert.equal(unicodeFold('MAH001 - 10 - 01'), 'MAH001-10-01');
});

test('it does not trim, and it does not change case', () => {
  assert.equal(unicodeFold('  mah001-10-01  '), '  mah001-10-01  ');
});

test('a tag with nothing to fold is returned unchanged', () => {
  assert.equal(unicodeFold('MAH001-10-01'), 'MAH001-10-01');
});
