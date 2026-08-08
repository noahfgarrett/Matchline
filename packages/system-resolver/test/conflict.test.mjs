import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSystemCatalog, resolveSystems } from '../dist/index.js';
import {
  DRAGON_ANATOMY,
  DRAGON_MEL,
  MAH001,
  MAH001_MODEL_SAYS_002,
  MANUAL_650,
  THREE_RUNG_KEY,
  THREE_RUNG_KEY_MANUAL_LAST,
  THREE_RUNG_KEY_PRECEDENCE,
} from './dist/dragon.fixture.js';

const { catalog } = buildSystemCatalog(DRAGON_MEL);
const base = { anatomy: DRAGON_ANATOMY, catalog, melRows: DRAGON_MEL };

function resolveOne(subject, config, context = base) {
  const result = resolveSystems([subject], config, context);
  return { result, subject: result.bySubject.get(subject.assetId) };
}

test('§5.6: model 002 against tag 001 and MEL 001 is a conflict, not a vote', () => {
  const { result, subject } = resolveOne(MAH001_MODEL_SAYS_002, THREE_RUNG_KEY);
  assert.equal(subject.agreement, 'conflict');
  assert.equal(subject.resolution.systemConflictStatus, 'CONFLICTING');
  assert.equal(subject.resolution.systemKey, '002');
  assert.equal(result.reviewItems.length, 1);
});

test('§5.6: the review item carries every competing claim, winners and losers', () => {
  const { result } = resolveOne(MAH001_MODEL_SAYS_002, THREE_RUNG_KEY);
  const item = result.reviewItems[0];
  assert.equal(item.kind, 'system-conflict');
  assert.equal(item.assetId, 'dragon-0002');
  assert.deepEqual(
    item.claims.map((claim) => [claim.component, claim.proposedValue]),
    [
      ['model-field', '002'],
      ['tag-segment', '001'],
      ['mel-lookup', '001'],
    ],
  );
});

test('§5.6: an explicit precedence policy lets chain order decide, silently', () => {
  const { result, subject } = resolveOne(MAH001_MODEL_SAYS_002, THREE_RUNG_KEY_PRECEDENCE);
  assert.equal(subject.agreement, 'resolved-by-precedence');
  assert.equal(subject.resolution.systemConflictStatus, 'RESOLVED_BY_TIER');
  assert.equal(subject.resolution.systemKey, '002');
  assert.deepEqual(result.reviewItems, []);
});

test('either policy keeps all three claims', () => {
  const review = resolveOne(MAH001_MODEL_SAYS_002, THREE_RUNG_KEY).subject;
  const precedence = resolveOne(MAH001_MODEL_SAYS_002, THREE_RUNG_KEY_PRECEDENCE).subject;
  assert.equal(review.claims.length, 3);
  assert.equal(precedence.claims.length, 3);
});

test('rungs that all say 001 are agreement, not a single source', () => {
  const { subject } = resolveOne(MAH001, THREE_RUNG_KEY);
  assert.equal(subject.agreement, 'agreement');
  assert.equal(subject.resolution.systemConflictStatus, 'AGREED');
  assert.equal(subject.claims.length, 3);
});

test('a manual assignment beats every rung even with no manual rung configured', () => {
  const { result, subject } = resolveOne(MAH001_MODEL_SAYS_002, THREE_RUNG_KEY, {
    ...base,
    manual: MANUAL_650,
  });
  assert.equal(subject.resolution.systemKey, '650');
  assert.equal(subject.agreement, 'manual-override');
  assert.equal(subject.resolution.systemConflictStatus, 'RESOLVED_BY_TIER');
  assert.deepEqual(result.reviewItems, []);
});

test('the human overriding does not discard the claims that lost', () => {
  const { subject } = resolveOne(MAH001_MODEL_SAYS_002, THREE_RUNG_KEY, {
    ...base,
    manual: MANUAL_650,
  });
  assert.deepEqual(
    subject.claims.map((claim) => [claim.component, claim.proposedValue]),
    [
      ['model-field', '002'],
      ['tag-segment', '001'],
      ['mel-lookup', '001'],
      ['manual', '650'],
    ],
  );
});

test('the synthetic manual rung sits after the configured chain and says who decided', () => {
  const { subject } = resolveOne(MAH001_MODEL_SAYS_002, THREE_RUNG_KEY, {
    ...base,
    manual: MANUAL_650,
  });
  assert.equal(subject.keyClaim.rungIndex, 3);
  assert.equal(subject.keyClaim.provenance.fallbackRung, 4);
  assert.equal(subject.keyClaim.source, 'MANUAL');
  assert.equal(subject.keyClaim.evidenceTier, 4);
  assert.equal(subject.keyClaim.provenance.manualDecision, 'field walkdown 2026-08-07');
});

test('a manual rung placed last still wins over the rungs above it', () => {
  const { subject } = resolveOne(MAH001_MODEL_SAYS_002, THREE_RUNG_KEY_MANUAL_LAST, {
    ...base,
    manual: MANUAL_650,
  });
  assert.equal(subject.resolution.systemKey, '650');
  assert.equal(subject.keyClaim.rungIndex, 3);
  assert.equal(subject.claims.length, 4);
});

test('a configured manual rung with nothing assigned just stays silent', () => {
  const { subject } = resolveOne(MAH001_MODEL_SAYS_002, THREE_RUNG_KEY_MANUAL_LAST);
  assert.equal(subject.resolution.systemKey, '002');
  assert.equal(subject.agreement, 'conflict');
  assert.equal(subject.skippedRungs[0].component, 'manual');
  assert.equal(subject.skippedRungs[0].reason, 'no-value');
});

test('a conflicted key still drives the description lookup by chain order', () => {
  const { subject } = resolveOne(MAH001_MODEL_SAYS_002, THREE_RUNG_KEY);
  assert.equal(subject.descriptionClaim, null);
  assert.equal(subject.resolution.systemLabel, '002');
});
