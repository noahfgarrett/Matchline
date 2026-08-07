import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyNormalize } from '../src/rules/normalize.js'

const STRIP_SIDES = {
  id: 'sides', kind: 'stripSuffix', enabled: true,
  separators: ['-'], suffixes: ['P', 'S', 'A', 'B', 'OUTPUT'], repeat: true,
}
const STRIP_VARIANT = {
  id: 'variant', kind: 'stripSuffix', enabled: true,
  separators: ['_', '-'], suffixes: ['NPS', 'CPS'], repeat: false,
}
const STRIP_SIDES_IDENTITY = { ...STRIP_SIDES, stage: 'identity' }
const STRIP_VARIANT_MATCHING = { ...STRIP_VARIANT, stage: 'matching' }

test('stripSuffix removes a single terminal suffix', () => {
  assert.equal(applyNormalize('MCC-01-A', [STRIP_SIDES]), 'MCC-01')
})

test('repeat:true strips a chain of suffixes', () => {
  assert.equal(applyNormalize('XFM-1-A-B-P', [STRIP_SIDES]), 'XFM-1')
})

test('repeat:false strips at most one', () => {
  assert.equal(applyNormalize('PNL-1_CPS_CPS', [STRIP_VARIANT]), 'PNL-1_CPS')
})

test('matching is case-insensitive', () => {
  assert.equal(applyNormalize('MCC-01-a', [STRIP_SIDES]), 'MCC-01')
  assert.equal(applyNormalize('PNL-1_cps', [STRIP_VARIANT]), 'PNL-1')
})

test('all matching rules apply in order, not just the first', () => {
  // Sides must run before variant here: 'PNL-1_CPS-A' only exposes the
  // _CPS variant once the trailing -A side has been stripped, mirroring
  // stripPowerVariant(cleanTag(x)) in src/hierarchy/build.js, where
  // cleanTag's suffix strip always runs before the variant strip.
  assert.equal(applyNormalize('PNL-1_CPS-A', [STRIP_SIDES, STRIP_VARIANT]), 'PNL-1')
})

test('a disabled rule is skipped', () => {
  assert.equal(applyNormalize('MCC-01-A', [{ ...STRIP_SIDES, enabled: false }]), 'MCC-01-A')
})

test('a suffix that is the entire tag is not stripped to empty', () => {
  assert.equal(applyNormalize('A', [STRIP_SIDES]), 'A')
  assert.equal(applyNormalize('-A', [STRIP_SIDES]), '-A')
})

test('omitting stage applies every rule, regardless of the rules\' own stage', () => {
  assert.equal(
    applyNormalize('PNL-1_CPS-A', [STRIP_SIDES_IDENTITY, STRIP_VARIANT_MATCHING]),
    'PNL-1',
  )
})

test('a given stage applies only rules tagged with that stage', () => {
  // identity stage: only the panel-side strip runs, the power variant survives
  assert.equal(
    applyNormalize('PNL-1_CPS-A', [STRIP_SIDES_IDENTITY, STRIP_VARIANT_MATCHING], 'identity'),
    'PNL-1_CPS',
  )
})

test('a stage with no matching rules leaves the tag untouched apart from clean()', () => {
  assert.equal(
    applyNormalize('PNL-1_CPS-A', [STRIP_SIDES_IDENTITY, STRIP_VARIANT_MATCHING], 'matching'),
    'PNL-1_CPS-A',
  )
})

test('a rule with no stage of its own applies under every stage', () => {
  const untagged = { ...STRIP_SIDES } // no `stage` property
  assert.equal(applyNormalize('MCC-01-A', [untagged], 'identity'), 'MCC-01')
  assert.equal(applyNormalize('MCC-01-A', [untagged], 'matching'), 'MCC-01')
  assert.equal(applyNormalize('MCC-01-A', [untagged], 'some-other-stage'), 'MCC-01')
})

test('stage filtering composes correctly for the shipped identity/matching split', () => {
  // Mirrors cleanTag (identity only) then stripPowerVariant (matching on top).
  const rules = [STRIP_SIDES_IDENTITY, STRIP_VARIANT_MATCHING]
  const identityOnly = applyNormalize('B14-LVS-5004_CPS', rules, 'identity')
  assert.equal(identityOnly, 'B14-LVS-5004_CPS', 'identity stage must not touch the power variant')
  const matchingOnTop = applyNormalize(identityOnly, rules, 'matching')
  assert.equal(matchingOnTop, 'B14-LVS-5004')
})
