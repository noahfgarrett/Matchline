import assert from 'node:assert/strict';
import test from 'node:test';

import {
  APP_ORIGIN,
  PRODUCTION_CSP,
  buildCsp,
  buildDevelopmentCsp,
} from '../dist/electron/security/csp.js';

/** @param {string} policy @param {string} name */
function directive(policy, name) {
  const found = policy
    .split(';')
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
  assert.ok(found !== undefined, `policy has no ${name} directive`);
  return found;
}

test('the production policy denies everything by default', () => {
  assert.equal(directive(PRODUCTION_CSP, 'default-src'), "default-src 'none'");
  assert.equal(directive(PRODUCTION_CSP, 'object-src'), "object-src 'none'");
  assert.equal(directive(PRODUCTION_CSP, 'base-uri'), "base-uri 'none'");
  assert.equal(directive(PRODUCTION_CSP, 'frame-ancestors'), "frame-ancestors 'none'");
});

test('the production policy never allows inline or eval scripts', () => {
  assert.doesNotMatch(PRODUCTION_CSP, /unsafe-inline/);
  assert.doesNotMatch(PRODUCTION_CSP, /unsafe-eval/);
  assert.doesNotMatch(PRODUCTION_CSP, /unsafe-hashes/);
  assert.equal(directive(PRODUCTION_CSP, 'script-src'), `script-src ${APP_ORIGIN}`);
});

test('the production policy reaches no remote origin', () => {
  assert.doesNotMatch(PRODUCTION_CSP, /https?:/);
  assert.doesNotMatch(PRODUCTION_CSP, /wss?:/);
  assert.doesNotMatch(PRODUCTION_CSP, /\*/);
});

test('buildCsp returns the production policy when no dev server is configured', () => {
  assert.equal(buildCsp(undefined), PRODUCTION_CSP);
});

test('the development policy is scoped to the dev server and is never the production one', () => {
  const devCsp = buildCsp('http://localhost:5173');

  assert.notEqual(devCsp, PRODUCTION_CSP);
  assert.equal(devCsp, buildDevelopmentCsp('http://localhost:5173'));
  assert.match(directive(devCsp, 'connect-src'), /ws:\/\/localhost:5173/);
  assert.equal(directive(devCsp, 'default-src'), "default-src 'none'");
});
