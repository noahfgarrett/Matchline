import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { clean } from '../src/core/text.js'
import { validateMode, validateModes, groupingLevels, hasFlowLevel } from '../src/hierarchy/modes.js'
import { activeModes, modeById, exampleModes } from '../src/hierarchy/modes.js'
import { makeDefaultProfile, normalizeProfile } from '../src/profile/schema.js'
import { loadApp } from './support/harness.mjs'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const FLOW = { id: 'f', name: 'Flow', executor: 'raw', levels: [{ kind: 'flow' }] }
const GROUPED = {
  id: 'g', name: 'Grouped', executor: 'projected',
  levels: [{ kind: 'grouping', attribute: 'building' }, { kind: 'flow' }],
}

test('a well-formed mode validates', () => {
  assert.deepEqual(validateMode(FLOW), [])
  assert.deepEqual(validateMode(GROUPED), [])
})

test('validateMode tolerates malformed input without throwing', () => {
  // This runs on imported profile JSON, so it must survive anything.
  assert.doesNotThrow(() => validateMode(null))
  assert.doesNotThrow(() => validateMode({ ...FLOW, levels: null }))
  assert.doesNotThrow(() => validateMode({ id: 'x', executor: 'raw' }))
  assert.doesNotThrow(() => validateMode({ ...GROUPED, levels: [null, { kind: 'flow' }] }))
  assert.ok(validateMode(null).length > 0, 'malformed input must be reported, not silently accepted')
})

test('a mode needs an id, a known executor and at least one level', () => {
  assert.ok(validateMode({ ...FLOW, id: '' }).some(e => /id/.test(e)))
  assert.ok(validateMode({ ...FLOW, executor: 'magic' }).some(e => /executor/.test(e)))
  assert.ok(validateMode({ ...FLOW, levels: [] }).some(e => /level/.test(e)))
})

test('at most one flow level, and it must be last', () => {
  const two = { ...FLOW, levels: [{ kind: 'flow' }, { kind: 'flow' }] }
  assert.ok(validateMode(two).some(e => /flow/.test(e)), 'two flow levels must be rejected')

  const notLast = { ...GROUPED, levels: [{ kind: 'flow' }, { kind: 'grouping', attribute: 'building' }] }
  assert.ok(validateMode(notLast).some(e => /last/.test(e)), 'a flow level before a grouping level must be rejected')
})

test('a grouping level must name an attribute', () => {
  const blank = { ...GROUPED, levels: [{ kind: 'grouping', attribute: '' }, { kind: 'flow' }] }
  assert.ok(validateMode(blank).some(e => /attribute/.test(e)))
})

test('validateModes drops invalid modes and keeps the rest', () => {
  const result = validateModes([FLOW, { id: 'bad', executor: 'nope', levels: [] }, GROUPED])
  assert.deepEqual(result.modes.map(m => m.id), ['f', 'g'])
  assert.ok(result.errors.length > 0, 'the reason a mode was dropped must be reported')
})

test('only one raw mode is supported', () => {
  const result = validateModes([FLOW, { ...FLOW, id: 'f2' }])
  assert.deepEqual(result.modes.map(m => m.id), ['f'], 'the second raw mode is dropped')
  assert.ok(result.errors.some(e => /raw/.test(e)), 'the constraint must be reported by name')
})

test('a duplicate id is dropped, keeping the first', () => {
  const grouped = { id: 'g', name: 'G', executor: 'projected',
    levels: [{ kind: 'grouping', attribute: 'building' }, { kind: 'flow' }] }
  const result = validateModes([grouped, { ...grouped, name: 'Second G' }])
  assert.deepEqual(result.modes.map(m => m.name), ['G'], 'the first mode with an id wins')
  assert.ok(result.errors.some(e => /twice/.test(e)), 'the duplicate must be reported')
})

test('level helpers read the list', () => {
  assert.equal(groupingLevels(GROUPED).length, 1)
  assert.equal(hasFlowLevel(GROUPED), true)
  assert.equal(hasFlowLevel({ levels: [{ kind: 'grouping', attribute: 'building' }] }), false)
})

test('the shipped modes preserve legacy occurrences and provide a canonical SSM view', () => {
  const modes = exampleModes()
  assert.equal(modes.length, 2)
  for (const mode of modes) assert.deepEqual(validateMode(mode), [], `${mode.id} must be valid`)
  assert.deepEqual(modes.map(m => m.executor), ['raw', 'projected'])
  assert.deepEqual(modes.map(m => m.id), ['electrical-flow', 'ssm'])
})

test('the ssm example mode reproduces the three grouping levels it replaces', () => {
  const ssm = exampleModes().find(m => m.id === 'ssm')
  assert.deepEqual(groupingLevels(ssm).map(l => l.attribute), ['building', 'discipline', 'system'])
  assert.equal(hasFlowLevel(ssm), true, 'equipment still chains under its parent inside a group')
  // The fallback labels only surface when an attribute is empty, so the golden
  // snapshots barely exercise them -- but task 3 wires level.fallback into live
  // behaviour, and a typo would be silent exactly when it starts to matter.
  assert.deepEqual(groupingLevels(ssm).map(l => l.fallback),
    ['Unassigned Building', 'Unassigned Discipline', 'Unassigned System'],
    'the fallback labels must match the ones groupFor uses today')
})

test('a profile with no usable modes falls back to the examples, on every construction path', () => {
  // The rules equivalent of this check was broken: it inferred "never
  // configured" from migration origin, so rules authored later were discarded.
  // Modes decide from what the profile declares NOW, and nothing else.
  const paths = {
    'fresh default': makeDefaultProfile('New'),
    'saved and reloaded': normalizeProfile(makeDefaultProfile('New')),
    'imported, no schemaVersion': normalizeProfile({ name: 'Imported' }),
    'stored v1': normalizeProfile({ name: 'Old', schemaVersion: 1, tagRules: [] }),
    'declared but empty': { ...makeDefaultProfile('Empty'), modes: [] },
    'declared but all invalid': { ...makeDefaultProfile('Bad'), modes: [{ id: 'x', executor: 'nope', levels: [] }] },
  }
  for (const [label, profile] of Object.entries(paths)) {
    assert.deepEqual(activeModes(profile).map(m => m.id), ['electrical-flow', 'ssm'],
      `${label}: must fall back to the example modes`)
  }
})

test('an authored mode wins over the examples', () => {
  const mine = { id: 'mine', name: 'Mine', executor: 'projected',
    levels: [{ kind: 'grouping', attribute: 'system' }, { kind: 'flow' }] }
  const profile = { ...makeDefaultProfile('Authored'), modes: [mine] }
  assert.deepEqual(activeModes(profile).map(m => m.id), ['mine'],
    'a declared mode must not be replaced by the shipped set')
})

test('modeById falls back to the first mode when the id is unknown', () => {
  const profile = makeDefaultProfile('X')
  assert.equal(modeById(profile, 'ssm').id, 'ssm')
  assert.equal(modeById(profile, 'no-such-mode').id, 'electrical-flow', 'an unknown id must not blank the view')
  assert.equal(modeById(profile, '').id, 'electrical-flow')
})

async function buildWith(files) {
  const app = await loadApp()
  const payload = files.map(f => ({ name: f, bytes: [...readFileSync(resolve(rootDir, 'tests/fixtures', f))] }))
  app.eval(`globalThis.__fixtures = ${JSON.stringify(payload)}`)
  await app.evalAsync(`
    for (const fx of __fixtures) {
      const bytes = new Uint8Array(fx.bytes);
      const wb = XLSX.read(bytes, { type: 'array' });
      S.files.push({ id: 'f' + S.files.length, name: fx.name, ext: 'xlsx', size: bytes.length, wb,
        sheets: wb.SheetNames.slice(), strikes: extractStrikeCells(bytes), error: null });
    }
    await prewarmSheets();
    for (const k of allHierKeys()) S.selected.add(k);
    await buildHierarchy();
    return '';
  `)
  return app
}

/** Distinct node kinds at each depth, for a projection built from `mode`. */
function levelNames(app, modeJson) {
  return JSON.parse(app.eval(`
    JSON.stringify((function () {
      const projection = buildModeProjection(${modeJson});
      const byDepth = [];
      const walk = n => {
        (byDepth[n.depth] = byDepth[n.depth] || []).push(n.kind);
        n.children.forEach(walk);
      };
      projection.roots.forEach(walk);
      return byDepth.map(kinds => [...new Set(kinds)].sort());
    })())
  `))
}

test('level order drives the grouping, so reordering the levels reorders the folders', async () => {
  // The point of the whole change: if this passes only for the shipped order,
  // the levels were renamed rather than moved into data.
  const app = await buildWith(['easy-power.xlsx', 'mel.xlsx'])
  const shipped = JSON.stringify({ id: 'a', name: 'A', executor: 'projected', levels: [
    { kind: 'grouping', attribute: 'building' }, { kind: 'grouping', attribute: 'discipline' }, { kind: 'flow' }] })
  const swapped = JSON.stringify({ id: 'b', name: 'B', executor: 'projected', levels: [
    { kind: 'grouping', attribute: 'discipline' }, { kind: 'grouping', attribute: 'building' }, { kind: 'flow' }] })

  assert.deepEqual(levelNames(app, shipped)[0], ['building'], 'depth 0 follows the first level')
  assert.deepEqual(levelNames(app, shipped)[1], ['discipline'])
  assert.deepEqual(levelNames(app, swapped)[0], ['discipline'], 'swapping the levels swaps the folders')
  assert.deepEqual(levelNames(app, swapped)[1], ['building'])
})

test('a mode with fewer grouping levels produces fewer folder levels', async () => {
  const app = await buildWith(['easy-power.xlsx', 'mel.xlsx'])
  const one = JSON.stringify({ id: 'c', name: 'C', executor: 'projected', levels: [
    { kind: 'grouping', attribute: 'system' }, { kind: 'flow' }] })
  const depths = levelNames(app, one)
  assert.deepEqual(depths[0], ['system'], 'the only grouping level is the root level')
  assert.ok(!depths[1] || !depths[1].includes('building'), 'no building folder when the mode does not ask for one')
})

test('each projected mode gets its own projection slot, keyed by id', async () => {
  const app = await buildWith(['easy-power.xlsx', 'mel.xlsx'])
  const keys = JSON.parse(app.eval(`
    JSON.stringify((function () {
      buildModeProjection({ id: 'alt', name: 'Alt', executor: 'projected',
        levels: [{ kind: 'grouping', attribute: 'system' }, { kind: 'flow' }] });
      return Object.keys(S.projections).sort();
    })())
  `))
  assert.ok(keys.includes('ssm'), 'the shipped mode keeps its slot')
  assert.ok(keys.includes('alt'), 'a second mode does not overwrite the first')
})

test('every active hierarchy view reads its resolved projection', async () => {
  const app = await buildWith(['easy-power.xlsx', 'mel.xlsx'])
  // Identity, not counts. A count comparison passes against the old
  // id-matching accessor too, because falling through to the raw tree also
  // yields a non-empty array -- verified by running this test against the
  // pre-change commit, where the count form passed and this form fails.
  assert.ok(app.eval(`(S.hierarchyMode='electrical-flow', activeHierarchyRoots()===S.projections['electrical-flow'].roots)`),
    'Electrical Flow reads the same resolved snapshot as every other view')
  assert.ok(app.eval(`(S.hierarchyMode='ssm', activeHierarchyRoots()===S.projections.ssm.roots)`),
    'a projected mode renders its own projection, not the raw tree')
})

test('a custom projected mode id is rendered, not just the shipped one', async () => {
  // Proves the accessors resolve through the mode list rather than matching 'ssm'.
  // Counting roots alone would not: an accessor that recognises only 'ssm' falls
  // through to S.roots, which is also non-empty. The identity check is what
  // distinguishes "rendered its own projection" from "rendered the raw tree".
  const app = await buildWith(['easy-power.xlsx', 'mel.xlsx'])
  const result = JSON.parse(app.eval(`
    JSON.stringify((function () {
      const mine = { id: 'mine', name: 'Mine', executor: 'projected',
        levels: [{ kind: 'grouping', attribute: 'system' }, { kind: 'flow' }] };
      // The modes the accessors read come from the active profile itself --
      // setRuleProfile only swaps the profile the RULE ENGINE reads.
      const profile = activeProfile(),shipped = profile.modes;
      try {
        profile.modes = [mine];
        buildModeProjection(mine);
        S.hierarchyMode = 'mine';
        const roots = activeHierarchyRoots(),nodes = activeHierarchyNodeMap();
        return { count: roots.length, ownRoots: roots === S.projections.mine.roots,
          ownNodes: nodes === S.projections.mine.nodeById };
      } finally { profile.modes = shipped; }
    })())
  `))
  assert.ok(result.count > 0, 'an authored projected mode must render its own projection')
  assert.ok(result.ownRoots, 'the roots must come from the authored mode\'s projection, not the raw tree')
  assert.ok(result.ownNodes, 'the node map must come from the same projection as the roots')
})

test('a mode whose projection was never built renders empty instead of throwing', async () => {
  // S.projections starts empty, so every accessor can be asked for a slot that
  // does not exist yet -- on the result screen before a build, or right after
  // Start Over clears them.
  const app = await loadApp()
  const out = JSON.parse(app.eval(`
    JSON.stringify((function () {
      S.hierarchyMode = 'ssm';
      return { roots: activeHierarchyRoots().length, nodes: activeHierarchyNodeMap().size,
        statNodes: activeHierarchyStats().nodes, cacheKey: typeof treePanelCacheKey() };
    })())
  `))
  assert.deepEqual(out, { roots: 0, nodes: 0, statNodes: 0, cacheKey: 'string' })
})

test('a projected mode with no grouping levels keeps every record', async () => {
  // Valid per validateMode, and groupFor returns null for it -- both callers
  // must handle that. This mode groups by nothing, so nothing may be skipped
  // as a duplicate of a folder that does not exist.
  const app = await buildWith(['easy-power.xlsx'])
  const result = JSON.parse(app.eval(`
    JSON.stringify((function () {
      const projection = buildModeProjection({ id: 'flat', name: 'Flat', executor: 'projected', levels: [{ kind: 'flow' }] });
      const names = [];
      const walk = n => { names.push(n.name); n.children.forEach(walk); };
      projection.roots.forEach(walk);
      return { names, canonical: S.canonicalModel.size };
    })())
  `))
  assert.equal(result.names.length, result.canonical,
    'a mode that groups by nothing must keep every canonical record')
  assert.ok(result.names.includes('602 Medium Voltage'),
    'the system root is a record whose tag equals its own system -- it must survive a mode that does not group by system')
})

test('the toggle renders one button per mode, from the profile', async () => {
  const app = await buildWith(['easy-power.xlsx'])
  const shipped = app.eval(`renderHierarchyModeToggle()`)
  assert.match(shipped, /data-hierarchy-mode="electrical-flow"/)
  assert.match(shipped, /data-hierarchy-mode="ssm"/)
  assert.match(shipped, /Electrical Flow/)
  assert.match(shipped, /SSM Hierarchy/)

  // setRuleProfile does NOT affect activeProfile() -- see the brief. Mutate the
  // active profile's modes directly and restore.
  const custom = app.eval(`
    (function () {
      const profile = activeProfile(), previous = profile.modes;
      profile.modes = [{ id: 'only', name: 'Only Mine', icon: 'zap',
        caption: 'One mode', executor: 'raw', levels: [{ kind: 'flow' }] }];
      try { return renderHierarchyModeToggle(); }
      finally { profile.modes = previous; }
    })()
  `)
  assert.match(custom, /Only Mine/, 'an authored mode must appear in the toggle')
  assert.ok(!/SSM Hierarchy/.test(custom), 'the shipped modes must not be forced in alongside it')
  assert.equal((custom.match(/data-hierarchy-mode=/g) || []).length, 1, 'one button per declared mode')
})

test('a three-mode profile renders three buttons', async () => {
  const app = await buildWith(['easy-power.xlsx'])
  const html = app.eval(`
    (function () {
      const profile = activeProfile(), previous = profile.modes;
      profile.modes = [
        { id: 'a', name: 'Alpha', executor: 'raw', levels: [{ kind: 'flow' }] },
        { id: 'b', name: 'Beta', executor: 'projected', levels: [{ kind: 'grouping', attribute: 'system' }, { kind: 'flow' }] },
        { id: 'c', name: 'Gamma', executor: 'projected', levels: [{ kind: 'grouping', attribute: 'building' }, { kind: 'flow' }] },
      ];
      try { return renderHierarchyModeToggle(); }
      finally { profile.modes = previous; }
    })()
  `)
  assert.equal((html.match(/data-hierarchy-mode=/g) || []).length, 3, 'the UI must not assume two modes')
})

test('setHierarchyMode rejects an id no mode declares', async () => {
  const app = await buildWith(['easy-power.xlsx'])
  app.eval(`S.hierarchyMode='ssm'; setHierarchyMode('not-a-mode');`)
  assert.equal(app.eval('S.hierarchyMode'), 'ssm', 'an unknown id must leave the view alone')
  app.eval(`setHierarchyMode('electrical-flow');`)
  assert.equal(app.eval('S.hierarchyMode'), 'electrical-flow', 'a declared id must still switch')

  // The two assertions above pass against the hardcoded ['electrical-flow','ssm']
  // list too, because the shipped modes carry exactly those ids -- verified by
  // running them against the pre-change build. Only an authored profile whose ids
  // differ from the shipped pair can tell "validates against the mode list" apart
  // from "validates against two literals".
  const authored = JSON.parse(app.eval(`
    JSON.stringify((function () {
      const profile = activeProfile(), previous = profile.modes;
      profile.modes = [
        { id: 'only', name: 'Only Mine', executor: 'raw', levels: [{ kind: 'flow' }] },
        { id: 'other', name: 'Other', executor: 'projected', levels: [{ kind: 'grouping', attribute: 'system' }, { kind: 'flow' }] },
      ];
      S.hierarchyMode = 'only';
      try {
        setHierarchyMode('ssm');
        const afterShippedId = S.hierarchyMode;
        setHierarchyMode('other');
        return { afterShippedId, afterAuthoredId: S.hierarchyMode };
      } finally { profile.modes = previous; S.hierarchyMode = 'electrical-flow'; }
    })())
  `))
  assert.equal(authored.afterShippedId, 'only', 'a shipped id this profile does not declare must be rejected')
  assert.equal(authored.afterAuthoredId, 'other', 'an authored id must switch the view')
})

test('the drawer crosslink follows the mode list and disappears when there is only one mode', async () => {
  const app = await buildWith(['easy-power.xlsx'])
  const one = app.eval(`
    (function () {
      const profile = activeProfile(), previous = profile.modes;
      profile.modes = [{ id: 'only', name: 'Only Mine', executor: 'raw', levels: [{ kind: 'flow' }] }];
      S.hierarchyMode = 'only';
      try { return hierarchyCrosslinkHtml(); }
      finally { profile.modes = previous; S.hierarchyMode = 'electrical-flow'; }
    })()
  `)
  assert.equal(clean(one), '', 'with one mode there is nowhere to cross-link to')

  const cycle = JSON.parse(app.eval(`
    JSON.stringify((function () {
      const profile = activeProfile(), previous = profile.modes;
      profile.modes = [
        { id: 'a', name: 'Alpha', executor: 'raw', levels: [{ kind: 'flow' }] },
        { id: 'b', name: 'Beta', executor: 'projected', levels: [{ kind: 'grouping', attribute: 'system' }, { kind: 'flow' }] },
        { id: 'c', name: 'Gamma', executor: 'projected', levels: [{ kind: 'grouping', attribute: 'building' }, { kind: 'flow' }] },
      ];
      try {
        return ['a', 'b', 'c'].map(id => { S.hierarchyMode = id; return hierarchyCrosslinkHtml(); });
      } finally { profile.modes = previous; S.hierarchyMode = 'electrical-flow'; }
    })())
  `))
  assert.match(cycle[0], /Beta/, 'the crosslink offers the next mode in the list')
  assert.match(cycle[1], /Gamma/)
  assert.match(cycle[2], /Alpha/, 'the last mode wraps round to the first')
})

test('a projected node never carries a placementId', async () => {
  // The placement flag renders on `node.placementId` alone, with no mode check.
  // That is only safe while projections leave it empty: buildRoots copies it onto
  // raw-tree nodes, buildModeProjection hardcodes '' (src/hierarchy/projection.js).
  // If someone later threads placementId through the projection -- which would
  // look like a feature -- projected views would sprout flags whose
  // data-placement targets a branch in a different tree.
  const app = await buildWith(['easy-power.xlsx', 'mel.xlsx'])
  const counts = JSON.parse(app.eval(`
    JSON.stringify({
      projected: [...S.projections['ssm'].nodeById.values()].filter(n => n.placementId).length,
      projectedTotal: S.projections['ssm'].nodeById.size,
      raw: [...S.nodeById.values()].filter(n => n.placementId).length,
    })
  `))
  assert.equal(counts.projected, 0, 'a projected node must never carry a placementId')
  assert.ok(counts.projectedTotal > 0, 'the projection must be non-empty, or this asserts nothing')
  assert.ok(counts.raw > 0, 'the raw tree must carry flags, or the invariant is untested either way')
})

test('the system root name comes from the mode policy, not a compiled-in constant', async () => {
  const app = await buildWith(['easy-power.xlsx'])
  assert.equal(app.eval(`isSystemName('602 Medium Voltage')`), true,
    'the shipped policy still recognises its own root')

  // setRuleProfile does NOT change activeProfile() -- mutate it directly.
  const renamed = JSON.parse(app.eval(`
    (function () {
      const profile = activeProfile(), previous = profile.modes;
      profile.modes = [{ id: 'electrical-flow', name: 'Flow', executor: 'raw',
        rootPolicy: { requireRoot: '900 High Voltage', fallbackParent: '900 High Voltage' },
        levels: [{ kind: 'flow' }] }];
      try { return JSON.stringify([isSystemName('900 High Voltage'), isSystemName('602 Medium Voltage')]); }
      finally { profile.modes = previous; }
    })()
  `))
  assert.deepEqual(renamed, [true, false],
    'a site naming its root differently must have that name recognised, and only that name')
})

test('the MEL mapping carries Discipline and System Description', async () => {
  const app = await buildWith(['easy-power.xlsx', 'mel.xlsx'])
  const record = JSON.parse(app.eval(`JSON.stringify(melRecord('B14-XFM-1234'))`))
  assert.equal(record.discipline, 'Electrical', 'Discipline must be read from the MEL row')
  assert.equal(record.systemDescription, 'Main Intake', 'System Description must be read from the MEL row')

  // Rules read the MEL through S.melLookup, not through S.melByTag, so the new
  // columns have to reach the lookup projection or an authored rule cannot use them.
  const columns = JSON.parse(app.eval(`
    JSON.stringify(S.melLookup.find('B14-SCR-2201', 'exact').columns)
  `))
  assert.equal(columns.Discipline, 'I&C', 'rules read these through the lookup, so they must reach it')
  assert.equal(columns.SystemDescription, 'Screening')
})

test('the new MEL columns stay inert under the frozen legacy baseline', async () => {
  // The goldens are captured under makeLegacyEagleProfile — if the legacy
  // baseline ever started composing System values from the new MEL columns,
  // every snapshot would move. The shipped built-in consumes them by design.
  const app = await loadApp()
  app.eval(`
    const LEGACY = normalizeProfile(makeLegacyEagleProfile());
    PROFILE_STORE.profiles = [LEGACY]; PROFILE_STORE.activeId = LEGACY.id;
    setRuleProfile(activeProfile());
  `)
  const payload = ['easy-power.xlsx', 'mel.xlsx'].map(f => ({ name: f, bytes: [...readFileSync(resolve(rootDir, 'tests/fixtures', f))] }))
  app.eval(`globalThis.__fixtures = ${JSON.stringify(payload)}`)
  await app.evalAsync(`
    for (const fx of __fixtures) {
      const bytes = new Uint8Array(fx.bytes);
      const wb = XLSX.read(bytes, { type: 'array' });
      S.files.push({ id: 'f' + S.files.length, name: fx.name, ext: 'xlsx', size: bytes.length, wb,
        sheets: wb.SheetNames.slice(), strikes: extractStrikeCells(bytes), error: null });
    }
    await prewarmSheets();
    for (const k of allHierKeys()) S.selected.add(k);
    await buildHierarchy();
    return '';
  `)
  const contexts = JSON.parse(app.eval(`
    JSON.stringify([...S.canonicalModel.values()].map(r => r.system).filter(Boolean))
  `))
  assert.ok(!contexts.some(s => /Main Intake|Screening/.test(s)),
    'the legacy baseline must not compose System values from the new columns')
})

test('a saved MEL mapping still carries Discipline and System Description', async () => {
  // melInfo switches to its manual-mapping branch the moment a profile sets
  // fields.equipmentTag, so anything profileFieldsFromHeaders omits resolves to
  // -1 and the column is dropped even though the sheet has it. Auto-mapping has
  // to enumerate every key detectMel returns.
  const { profileFieldsFromHeaders } = await import('../src/io/detect.js')
  const fields = profileFieldsFromHeaders('mel',
    ['Equipment Tag', 'UPN', 'Bldg', 'System Parent Equipment Tag', 'Discipline', 'System Description'])
  assert.equal(fields.discipline, 4, 'Discipline must be auto-mapped, not left for hand-mapping')
  assert.equal(fields.systemDescription, 5, 'System Description must be auto-mapped')
  assert.equal(fields.equipmentTag, 0, 'the pre-existing fields must keep working')
})
