import test from 'node:test'
import assert from 'node:assert/strict'
import { loadApp } from './support/harness.mjs'
import { buildProjectApp, canonicalRecordOf } from './support/compiler-harness.mjs'

/* Teach-a-suffix: highlight the end of a tag, one click strips that ending
   from every tag via an ordinary profile normalize rule. Plus the shipped
   -C panel-side default, which the frozen legacy baseline must NOT gain. */

test('the shipped profiles strip a trailing -C; the frozen legacy baseline does not', async () => {
  const app = await loadApp()
  const result = JSON.parse(app.eval(`
    JSON.stringify((function () {
      const modern = createEngine(makeDefaultProfile('Modern Site'));
      const legacy = createEngine(normalizeProfile(makeLegacyEagleProfile()));
      return {
        modern: modern.resolve('B14-LVS-1234-C').identity,
        legacy: legacy.resolve('B14-LVS-1234-C').identity,
        modernSides: makeDefaultProfile().rules.normalize.find(r => r.id === 'norm-panel-sides').suffixes,
        legacySides: makeLegacyEagleProfile().rules.normalize.find(r => r.id === 'norm-panel-sides').suffixes,
      };
    })())
  `))
  assert.equal(result.modern, 'B14-LVS-1234', 'the shipped default treats -C as a panel side')
  assert.equal(result.legacy, 'B14-LVS-1234-C', 'the frozen baseline keeps its original suffix list')
  assert.ok(result.modernSides.includes('C'))
  assert.ok(!result.legacySides.includes('C'))
})

test('taughtEndingFromSelection only accepts a real separator-led ending', async () => {
  const app = await loadApp()
  const cases = JSON.parse(app.eval(`
    JSON.stringify({
      good: taughtEndingFromSelection('B14-RIO-6500-C', '-C'),
      underscore: taughtEndingFromSelection('B14-PMP_X1', '_X1'),
      bareLetter: taughtEndingFromSelection('B14-RIO-6500-C', 'C'),
      notASuffix: taughtEndingFromSelection('B14-RIO-6500-C', '-RIO'),
      wholeTag: taughtEndingFromSelection('B14-C', 'B14-C'),
      caseBlind: taughtEndingFromSelection('B14-RIO-6500-C', '-c'),
    })
  `))
  assert.equal(cases.good, '-C')
  assert.equal(cases.underscore, '_X1')
  assert.equal(cases.bareLetter, '', 'a bare letter would merge unrelated tags')
  assert.equal(cases.notASuffix, '', 'mid-tag selections are not endings')
  assert.equal(cases.wholeTag, '', 'the whole tag is not an ending')
  assert.equal(cases.caseBlind, '-c', 'matching is case-insensitive')
})

test('addTaughtSuffixRule persists an editable rule, dedupes, and refuses locked profiles', async () => {
  const app = await loadApp()
  const result = JSON.parse(app.eval(`
    JSON.stringify((function () {
      initProfiles();
      const SITE = normalizeProfile(makeDefaultProfile('Teach Site'));
      PROFILE_STORE.profiles.push(SITE); PROFILE_STORE.activeId = SITE.id;
      setRuleProfile(activeProfile());
      const before = activeProfile().revision;
      const first = addTaughtSuffixRule('-C2');
      const again = addTaughtSuffixRule('-c2');
      const rule = activeProfile().rules.normalize.find(r => r.id === TAUGHT_STRIP_RULE_ID);
      PROFILE_STORE.activeId = 'builtin-eagle';
      const locked = addTaughtSuffixRule('-Z');
      return { first, again, suffixes: rule.suffixes, revisionBumped: activeProfile().revision, before, locked };
    })())
  `))
  assert.deepEqual(result.first, { ok: true })
  assert.deepEqual(result.again, { ok: true, already: true }, 'case-insensitive dedupe')
  assert.deepEqual(result.suffixes, ['-C2'])
  assert.deepEqual(result.locked, { ok: false, reason: 'locked' })
})

test('a taught ending merges both spellings end to end after rebuild', async () => {
  const app = await buildProjectApp(['compiler-mel.xlsx'])
  assert.ok(canonicalRecordOf(app, 'B14-RIO-6500-PS1'), 'the power supply starts as its own record')
  await app.evalAsync(`
    const result = addTaughtSuffixRule('-PS1');
    if (!result.ok) throw new Error('teach failed: ' + result.reason);
    await buildHierarchy();
    return '';
  `)
  const merged = JSON.parse(app.eval(`
    JSON.stringify({
      key: tagKey('B14-RIO-6500-PS1'),
      rioKey: tagKey('B14-RIO-6500'),
      registerHasPs1: S.ssmCombined.some(row => /PS1/i.test(String(row[0]))),
    })
  `))
  assert.equal(merged.key, merged.rioKey, 'both spellings resolve to one identity')
  assert.equal(merged.registerHasPs1, false, 'the register carries only the canonical spelling')
})
