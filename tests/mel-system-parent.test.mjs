import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadApp } from './support/harness.mjs'

/**
 * MEL System Parent as a first-class parent claim.
 *
 * The design point being pinned: the scoping is NOT a rule. Cable Schedule
 * claims only exist for equipment that appears in the Cable Schedule, so
 * ranking cable above mel in parentSourcePriority means MEL can only win where
 * cable is silent — which is the non-electrical equipment MEL is trusted for.
 * Nobody configures that; it falls out of the ordering.
 */
async function app() {
  const instance = await loadApp()
  instance.eval(`
    initProfiles();
    SITE = normalizeProfile(makeDefaultProfile('MEL Site'));
    PROFILE_STORE.profiles.push(SITE);
    PROFILE_STORE.activeId = SITE.id;
    setRuleProfile(activeProfile());
  `)
  return instance
}

/** Seed MEL rows and the equipment set, then record claims. */
function seed(instance, { melRows, known, enabled = true }) {
  instance.eval(`
    S.sourceParentClaims = { easyPower: new Map(), cable: new Map(), mel: new Map(), pmd: new Map() };
    S.melRows = ${JSON.stringify(melRows)};
    S.melDependencyClaims = ${enabled}
      ? recordMelSystemParentClaims(${JSON.stringify(known.map(tag => [tag]))})
      : new Map();
  `)
}

const claimsFor = (instance, tag) => JSON.parse(instance.eval(`
  JSON.stringify([...(S.sourceParentClaims.mel.get(tagKey(${JSON.stringify(tag)})) || new Map()).values()]
    .map(claim => claim.parent))
`))

/* ---------------------------------------------------------------------------
 * Multi-valued System Parent
 * ------------------------------------------------------------------------- */

test('every tag in a multi-valued System Parent column is read, not just the first', () => {
  // The column is literally named "System Parent Equipment Tag(s)". Everything
  // after the first entry used to be discarded silently.
  return app().then(instance => {
    const tags = JSON.parse(instance.eval(
      `JSON.stringify(melSystemParentTags('ZZ9-AAA-0001; ZZ9-BBB-0002, ZZ9-CCC-0003'))`))
    assert.deepEqual(tags, ['ZZ9-AAA-0001', 'ZZ9-BBB-0002', 'ZZ9-CCC-0003'])
    assert.equal(instance.eval(`firstSystemParentTag('ZZ9-AAA-0001; ZZ9-BBB-0002')`), 'ZZ9-AAA-0001',
      'the existing single-value helper must keep its behaviour')
  })
})

test('separators, blanks, and repeats are handled without producing empty tags', async () => {
  const instance = await app()
  assert.deepEqual(JSON.parse(instance.eval(`JSON.stringify(melSystemParentTags(''))`)), [])
  assert.deepEqual(JSON.parse(instance.eval(`JSON.stringify(melSystemParentTags('  ;  , | '))`)), [])
  assert.deepEqual(
    JSON.parse(instance.eval(`JSON.stringify(melSystemParentTags('ZZ9-AAA-0001 | ZZ9-AAA-0001'))`)),
    ['ZZ9-AAA-0001'], 'a repeated tag is listed once')
})

test('the first tag is the structural parent and the rest become dependencies', async () => {
  // A structural parent is singular; dependencies are additive. That is the
  // existing model, applied to data that was previously dropped.
  const instance = await app()
  seed(instance, {
    melRows: [{ tag: 'ZZ9-QQQ-0009', upn: '', building: '', discipline: '', systemDescription: '',
      systemParent: 'ZZ9-AAA-0001; ZZ9-BBB-0002, ZZ9-CCC-0003' }],
    known: ['ZZ9-QQQ-0009'],
  })
  assert.deepEqual(claimsFor(instance, 'ZZ9-QQQ-0009'), ['ZZ9-AAA-0001'], 'exactly one structural parent')
  assert.deepEqual(
    JSON.parse(instance.eval(`JSON.stringify([...S.melDependencyClaims.get(tagKey('ZZ9-QQQ-0009'))])`)),
    ['ZZ9-BBB-0002', 'ZZ9-CCC-0003'])
})

/* ---------------------------------------------------------------------------
 * Claim recording
 * ------------------------------------------------------------------------- */

test('a MEL row with a System Parent claims a parent even with no UPN mismatch', async () => {
  // The whole change. Previously a claim was only recorded where the UPN
  // correction path fired, so a row that simply states its parent was ignored.
  const instance = await app()
  seed(instance, {
    melRows: [{ tag: 'ZZ9-QQQ-0009', upn: 'UPN-1', building: '', discipline: '', systemDescription: '',
      systemParent: 'ZZ9-AAA-0001' }],
    known: ['ZZ9-QQQ-0009'],
  })
  assert.deepEqual(claimsFor(instance, 'ZZ9-QQQ-0009'), ['ZZ9-AAA-0001'])
})

test('a MEL row for equipment this build never imported claims nothing', async () => {
  // A real MEL is mostly rows about equipment outside this build. Recording
  // them would grow the claim map without any record ever reading it.
  const instance = await app()
  seed(instance, {
    melRows: [{ tag: 'ZZ9-NOT-HERE', upn: '', building: '', discipline: '', systemDescription: '',
      systemParent: 'ZZ9-AAA-0001' }],
    known: ['ZZ9-QQQ-0009'],
  })
  assert.equal(instance.eval('S.sourceParentClaims.mel.size'), 0)
})

test('a row whose System Parent is itself is refused rather than creating a self-parent', async () => {
  const instance = await app()
  seed(instance, {
    melRows: [{ tag: 'ZZ9-QQQ-0009', upn: '', building: '', discipline: '', systemDescription: '',
      systemParent: 'ZZ9-QQQ-0009; ZZ9-BBB-0002' }],
    known: ['ZZ9-QQQ-0009'],
  })
  assert.deepEqual(claimsFor(instance, 'ZZ9-QQQ-0009'), [], 'no structural parent')
  assert.deepEqual(
    JSON.parse(instance.eval(`JSON.stringify([...(S.melDependencyClaims.get(tagKey('ZZ9-QQQ-0009')) || [])])`)),
    ['ZZ9-BBB-0002'], 'the other tag still becomes a dependency')
})

test('an empty System Parent column claims nothing', async () => {
  const instance = await app()
  seed(instance, {
    melRows: [{ tag: 'ZZ9-QQQ-0009', upn: '', building: '', discipline: '', systemDescription: '', systemParent: '' }],
    known: ['ZZ9-QQQ-0009'],
  })
  assert.equal(instance.eval('S.sourceParentClaims.mel.size'), 0)
  assert.equal(instance.eval('S.melDependencyClaims.size'), 0)
})

/* ---------------------------------------------------------------------------
 * The scoping that makes this safe
 * ------------------------------------------------------------------------- */

test('cable outranks MEL, so MEL only parents what the Cable Schedule leaves alone', async () => {
  // This is the design claim in one test: no per-discipline precedence exists,
  // and none is needed. Electrical is what appears in the Cable Schedule.
  const instance = await app()
  seed(instance, {
    melRows: [
      { tag: 'ZZ9-ELEC-0001', upn: '', building: '', discipline: '', systemDescription: '', systemParent: 'ZZ9-MEL-PARENT' },
      { tag: 'ZZ9-MECH-0002', upn: '', building: '', discipline: '', systemDescription: '', systemParent: 'ZZ9-MEL-PARENT' },
    ],
    known: ['ZZ9-ELEC-0001', 'ZZ9-MECH-0002'],
  })
  // Only the electrical asset is in the Cable Schedule.
  instance.eval(`recordSourceParentClaim('cable','ZZ9-ELEC-0001','ZZ9-CABLE-PARENT',{status:'validated-chain'})`)

  const winner = tag => instance.eval(`
    (function () {
      const order = activeProfile().hierarchy.parentSourcePriority;
      for (const source of order) {
        const parents = S.sourceParentClaims[source].get(tagKey(${JSON.stringify(tag)}));
        if (parents && parents.size === 1) return source;
      }
      return '';
    })()
  `)
  assert.deepEqual(JSON.parse(instance.eval('JSON.stringify(activeProfile().hierarchy.parentSourcePriority)')),
    ['cable', 'mel', 'easyPower', 'pmd'], 'precondition: cable outranks mel')
  assert.equal(winner('ZZ9-ELEC-0001'), 'cable', 'the Cable Schedule keeps the electrical asset')
  assert.equal(winner('ZZ9-MECH-0002'), 'mel', 'MEL parents the asset cable never mentions')
})

/* ---------------------------------------------------------------------------
 * Eagle
 * ------------------------------------------------------------------------- */

test('Eagle declares the policy off, and a project profile declares it on', async () => {
  const instance = await app()
  assert.equal(instance.eval(`makeDefaultProfile().hierarchy.workflow.melSystemParentClaims`), false,
    'Eagle must not gain a parent source the frozen build never had')
  assert.equal(instance.eval(`makeDefaultProfile('Project').hierarchy.workflow.melSystemParentClaims`), true)
})

test('the flag is visible in the Studio, not hidden behavior', async () => {
  // The invariant the profile is built on: every executable policy is declared
  // and editable, never inherited silently.
  const instance = await app()
  const markup = instance.eval(`S.profileDraft = profileClone(activeProfile()); renderHierarchyProfile(S.profileDraft)`)
  assert.ok(markup.includes('data-workflow-policy="melSystemParentClaims"'), 'the toggle must be rendered')
  assert.ok(markup.includes('Nest from MEL System Parent'))
})

test('claims are evidence only and never rewrite the raw tree', async () => {
  // The UPN path mutates the raw Eagle tree because it reproduces frozen
  // behavior. This one records claims and stops, which is why it cannot move
  // Eagle even if it were switched on.
  const instance = await app()
  instance.eval(`
    S.roots = [];
    S.sourceParentClaims = { easyPower: new Map(), cable: new Map(), mel: new Map(), pmd: new Map() };
    S.melRows = [{ tag: 'ZZ9-QQQ-0009', upn: '', building: '', discipline: '', systemDescription: '', systemParent: 'ZZ9-AAA-0001' }];
    recordMelSystemParentClaims([['ZZ9-QQQ-0009']]);
  `)
  assert.equal(instance.eval('S.roots.length'), 0, 'recording a claim must not build or mutate a tree')
  assert.equal(instance.eval('S.sourceParentClaims.mel.size'), 1)
})

/* ---------------------------------------------------------------------------
 * The source summary
 * ------------------------------------------------------------------------- */

test('the source summary names the source that actually won each parent', async () => {
  const instance = await app()
  assert.equal(instance.eval(`resolvedParentSourceLabel('parent:cable:a:b')`), 'Cable Schedule')
  assert.equal(instance.eval(`resolvedParentSourceLabel('parent:mel:a:b')`), 'Master Equipment List')
  assert.equal(instance.eval(`resolvedParentSourceLabel('manual:placement-1')`), 'Placement Review')
  assert.equal(instance.eval(`resolvedParentSourceLabel('parent:rule-abc:a:b')`), 'Relationship rules')
  assert.equal(instance.eval(`resolvedParentSourceLabel('parent:resolved-register:a:b')`), 'Resolved register')
  assert.equal(instance.eval(`resolvedParentSourceLabel('')`), '')
})

test('the summary asks for a build rather than reporting zeroes', async () => {
  const instance = await app()
  instance.eval('S.canonicalModel = new Map()')
  assert.match(instance.eval('sourceClaimSummary()'), /Build a hierarchy/)
})

test('the summary counts resolved parents by source and reports what stayed unparented', async () => {
  const instance = await app()
  const markup = instance.eval(`
    S.canonicalModel = new Map([
      ['a', { key: 'a', occurrences: [1], resolution: { parentResolution: { selectedCandidateId: 'parent:cable:a:x' } } }],
      ['b', { key: 'b', occurrences: [1], resolution: { parentResolution: { selectedCandidateId: 'parent:cable:b:x' } } }],
      ['c', { key: 'c', occurrences: [1], resolution: { parentResolution: { selectedCandidateId: 'parent:mel:c:x' } } }],
      ['d', { key: 'd', occurrences: [1], resolution: { parentResolution: { selectedCandidateId: null } } }],
      ['x', { key: 'x', occurrences: [], isSyntheticParent: true, resolution: { parentResolution: { selectedCandidateId: null } } }],
    ]);
    sourceClaimSummary()
  `)
  assert.ok(markup.includes('<b>Cable Schedule</b> 2'), markup)
  assert.ok(markup.includes('<b>Master Equipment List</b> 1'))
  assert.ok(markup.includes('1 unparented'))
  assert.equal(markup.includes('2 unparented'), false,
    'a record invented only to hold a parent tag is neither parented nor unparented')
})
