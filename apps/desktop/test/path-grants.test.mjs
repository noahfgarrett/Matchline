import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import { createPathGrants } from '../dist/electron/security/path-grants.js';

/**
 * The renderer's path allowlist (electron/security/path-grants.ts).
 *
 * The behaviour that matters is what is *not* granted: a sibling file in a
 * granted folder, a parent directory, a path nobody chose.
 */

test('nothing is granted until something grants it', () => {
  const grants = createPathGrants();
  assert.equal(grants.isGranted('/Users/dragon/Dragon.matchline'), false);
  assert.equal(grants.size, 0);
});

test('a granted path is granted, however it is spelled', () => {
  const grants = createPathGrants();
  grants.grant('/Users/dragon/Dragon.matchline');

  assert.equal(grants.isGranted('/Users/dragon/Dragon.matchline'), true);
  assert.equal(grants.isGranted('/Users/dragon/./Dragon.matchline'), true);
  assert.equal(grants.isGranted('/Users/dragon/sub/../Dragon.matchline'), true);
  assert.equal(grants.size, 1, 'the three spellings are one entry');
});

test('granting a file grants that file and nothing beside it', () => {
  const grants = createPathGrants();
  grants.grant('/Users/dragon/Dragon.matchline');

  assert.equal(grants.isGranted('/Users/dragon/Secrets.matchline'), false);
  assert.equal(grants.isGranted('/Users/dragon'), false);
  assert.equal(grants.isGranted('/Users/dragon/Dragon.matchline.backup-1'), false);
});

test('several paths can be granted in one call, as a multi-select dialog does', () => {
  const grants = createPathGrants();
  grants.grant('/a/one.xlsx', '/a/two.xlsx');

  assert.equal(grants.isGranted('/a/one.xlsx'), true);
  assert.equal(grants.isGranted('/a/two.xlsx'), true);
  assert.equal(grants.size, 2);
});

test('an empty path grants nothing rather than throwing', () => {
  const grants = createPathGrants();
  grants.grant('');
  assert.equal(grants.size, 0);
  assert.equal(grants.isGranted(''), false);
});

test('a relative path is resolved against the process directory, once', () => {
  const grants = createPathGrants();
  grants.grant('Dragon.matchline');
  assert.equal(grants.isGranted(resolve('Dragon.matchline')), true);
});

test('the list is capped, oldest first, so a session cannot grow without bound', () => {
  const grants = createPathGrants(3);
  grants.grant('/a/1', '/a/2', '/a/3');
  grants.grant('/a/4');

  assert.equal(grants.size, 3);
  assert.equal(grants.isGranted('/a/1'), false, 'the oldest fell off');
  assert.equal(grants.isGranted('/a/4'), true);
});

test('re-granting a path moves it out of the way of the cap', () => {
  const grants = createPathGrants(3);
  grants.grant('/a/1', '/a/2', '/a/3');
  grants.grant('/a/1');
  grants.grant('/a/4');

  assert.equal(grants.isGranted('/a/1'), true, 'the file the user keeps choosing survives');
  assert.equal(grants.isGranted('/a/2'), false);
});

test('clearing forgets everything', () => {
  const grants = createPathGrants();
  grants.grant('/a/1', '/a/2');
  grants.clear();

  assert.equal(grants.size, 0);
  assert.equal(grants.isGranted('/a/1'), false);
});
