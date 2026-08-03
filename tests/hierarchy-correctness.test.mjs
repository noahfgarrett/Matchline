import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { loadApp } from './support/harness.mjs'
import { PROFILE_STORE, makeDefaultProfile } from '../src/profile/schema.js'
import { setRuleProfile } from '../src/rules/provider.js'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function fixtureBytes(file) {
  return [...readFileSync(resolve(rootDir, 'tests/fixtures', file))]
}

function useCorrectnessPolicies(){
  const profile=makeDefaultProfile('Correctness policies');
  PROFILE_STORE.activeId=profile.id;PROFILE_STORE.profiles=[profile];setRuleProfile(profile);
}

/** Import fixtures through the app's own path and run a real buildHierarchy. */
async function build(files) {
  const app = await loadApp()
  app.eval(`globalThis.__fixtures = ${JSON.stringify(files.map(f => ({ name: f, bytes: fixtureBytes(f) })))}`)
  await app.evalAsync(`
    const profile=makeDefaultProfile('Correctness policies');
    PROFILE_STORE.activeId=profile.id;PROFILE_STORE.profiles=[profile];setRuleProfile(profile);
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

/* ----------------------------------------------------------------------
 * Case-variant identity.
 *
 * tagKey (src/state.js) lowercases, and it is the identity the app uses
 * essentially everywhere -- MEL indexing, register dedupe, comparison.
 * The tree was the outlier: insertPath keyed children by the raw string,
 * and the SSM row accumulator keyed paths by the raw segments, so the same
 * equipment spelled two ways produced two tree nodes and two pushed rows --
 * of which uniqueSsmRows, which DOES use tagKey, then kept only one.
 * ---------------------------------------------------------------------- */

test('a tag spelled several ways is one tree node and one register row', async () => {
  const app = await build(['case-variants.xlsx'])

  const nodeNames = JSON.parse(app.eval(`
    JSON.stringify((function () {
      const found = [];
      const walk = n => { found.push(n.name); n.children.forEach(walk); };
      S.roots.forEach(walk);
      return found;
    })())
  `))
  const variants = nodeNames.filter(n => String(n).toLowerCase() === 'mcc-1')
  assert.deepEqual(variants, ['MCC-1'],
    `case variants must collapse to the first-seen spelling, got ${JSON.stringify(variants)}`)

  const rows = JSON.parse(app.eval(`JSON.stringify(S.ssmCombined.map(r => r[0]))`))
  const rowVariants = rows.filter(r => String(r).toLowerCase() === 'mcc-1')
  assert.equal(rowVariants.length, 1, 'the register must carry exactly one row for the tag')

  // The real point of the fix: the tree and the register must agree. Before it,
  // the tree had 3 nodes and the register 1, so every count derived from one
  // disagreed with the other.
  assert.equal(variants.length, rowVariants.length,
    'tree node count and register row count for the same tag must agree')
})

/* ----------------------------------------------------------------------
 * A tag claimed by two parents.
 *
 * The raw import records both parents and raises the existing review flag. The
 * resolved snapshot does not make row order a hidden tiebreaker: the structural
 * edge stays quarantined until Placement Review supplies an explicit override.
 * ---------------------------------------------------------------------- */

test('a tag listed under two parents raises a review flag instead of vanishing', async () => {
  const app = await build(['duplicate-parents.xlsx'])
  const flags = JSON.parse(app.eval(`
    JSON.stringify(S.placements.filter(p => p.status === 'duplicate-parent')
      .map(p => ({ branchName: p.branchName, currentParent: p.currentParent, reason: p.reason, source: p.source })))
  `))

  assert.equal(flags.length, 1, `expected exactly one conflict, got ${JSON.stringify(flags)}`)
  assert.equal(flags[0].branchName, 'PNL-9')
  assert.equal(flags[0].currentParent, 'B14-XFM-1111', 'the first parent is the one kept')
  assert.match(flags[0].reason, /B14-XFM-2222/, 'the discarded parent must be named in the reason')

  // The register stays a strict tree, but an unresolved equal-priority conflict
  // cannot silently select whichever parent happened to be read first.
  const rows = JSON.parse(app.eval(`JSON.stringify(S.ssmCombined.filter(r => r[0] === 'PNL-9'))`))
  assert.equal(rows.length, 1, 'the register stays a strict tree')
  assert.equal(rows[0][1], '', 'the parent remains quarantined until an engineer resolves the conflict')

  // The flag must render as itself, not fall through to the generic
  // "Needs parent" label that every unrecognised status gets.
  const label = app.eval(`placementState(S.placements.find(p => p.status === 'duplicate-parent'), true)`)
  assert.match(label, /more than one parent/, `unhandled status rendered as "${label}"`)
})

test('a tag that is a Starting Source in one row and downstream in another is not flagged', async () => {
  // An empty parent is the top of its own path, not a competing claim. Without
  // this exclusion the flag fires on ordinary data and the panel becomes noise.
  const app = await build(['duplicate-parents.xlsx'])
  const flagged = JSON.parse(app.eval(`
    JSON.stringify(S.placements.filter(p => p.status === 'duplicate-parent').map(p => p.branchName))
  `))
  assert.ok(!flagged.includes('B14-XFM-1111'),
    'a tag appearing as both a root and a child must not be reported as a parent conflict')
})

test('which parent survives does not depend on the order the rows arrived in', async () => {
  // A tag that is a Starting Source in one row and nested under a real parent
  // in another produces two register rows: one with a blank parent, one with a
  // real one. uniqueSsmRows kept whichever came FIRST, so the real parent was
  // discarded whenever the root occurrence happened to be read first -- and the
  // duplicate-parent flag did not fire, because it ignores blank parents by
  // design to avoid firing on ordinary data. Silent, and order-dependent.
  useCorrectnessPolicies()
  const { uniqueSsmRows } = await import('../src/hierarchy/build.js')
  const rootFirst = [['B14-XFM-1111', ''], ['B14-XFM-1111', 'GIS-01']]
  const nestedFirst = [['B14-XFM-1111', 'GIS-01'], ['B14-XFM-1111', '']]
  assert.equal(uniqueSsmRows(rootFirst)[0][1], 'GIS-01', 'a real parent must beat a blank one, whatever the row order')
  assert.equal(uniqueSsmRows(nestedFirst)[0][1], 'GIS-01')
  assert.deepEqual(uniqueSsmRows(rootFirst), uniqueSsmRows(nestedFirst),
    'the same rows in either order must give the same register')
})

test('a tag with only a blank parent still keeps its row', async () => {
  // Preferring a real parent must not drop genuine roots, which legitimately
  // have no parent at all.
  useCorrectnessPolicies()
  const { uniqueSsmRows } = await import('../src/hierarchy/build.js')
  const rows = uniqueSsmRows([['GIS-01', ''], ['B14-XFM-1', 'GIS-01']])
  assert.deepEqual(rows.map(r => [r[0], r[1]]), [['GIS-01', ''], ['B14-XFM-1', 'GIS-01']])
})

/* ----------------------------------------------------------------------
 * A blank downstream column with populated levels after it.
 *
 * The loop used to break at the first blank, so every later level was
 * discarded. Equipment appearing nowhere else left the hierarchy entirely --
 * no node, no register row, nothing in review. Its loads were re-parented
 * onto whatever survived, which looks like a valid tree.
 * ---------------------------------------------------------------------- */

test('a level after a blank downstream column is kept, not truncated away', async () => {
  const app = await build(['downstream-gap.xlsx'])

  const names = JSON.parse(app.eval(`
    JSON.stringify((function(){const o=[];const w=n=>{o.push(n.name);n.children.forEach(w)};S.roots.forEach(w);return o})())
  `))
  assert.ok(names.includes('PNL-7'), `PNL-7 sits after a blank level and must survive, got ${JSON.stringify(names)}`)

  const rows = JSON.parse(app.eval(`JSON.stringify(S.ssmCombined.filter(r => r[0] === 'PNL-7'))`))
  assert.equal(rows.length, 1, 'the kept level must reach the register too')
  assert.equal(rows[0][1], 'B14-XFM-3333', 'it is filed under the nearest populated level')

  // Its load must hang off it, not off the level above -- the truncation used
  // to re-parent MTR-D onto B14-XFM-3333, which looks like a valid tree.
  const parentOfLoad = app.eval(`
    (function(){let found='';const w=(n,p)=>{if(n.name==='MTR-D')found=p;n.children.forEach(k=>w(k,n.name))};
     S.roots.forEach(r=>w(r,''));return found})()
  `)
  assert.equal(parentOfLoad, 'PNL-7', 'the load belongs to the level that was being dropped')
})

test('a bridged gap is flagged, and an ordinary trailing blank is not', async () => {
  const app = await build(['downstream-gap.xlsx'])
  const flags = JSON.parse(app.eval(`
    JSON.stringify(S.placements.filter(p => p.status === 'bridged-gap').map(p => ({ branchName: p.branchName, currentParent: p.currentParent })))
  `))
  // Three bridged edges across two rows: one in the PNL-7 row, two in the row
  // that has gaps at both Downstream2 and Downstream4. Every edge the build
  // invents must be reported -- only the first used to be.
  assert.deepEqual(flags, [
    { branchName: 'PNL-7', currentParent: 'B14-XFM-3333' },
    { branchName: 'PNL-5', currentParent: 'B14-XFM-5555' },
    { branchName: 'PNL-6', currentParent: 'PNL-5' },
  ], 'every bridged gap is flagged; the trailing-blank row must produce nothing')

  const label = app.eval(`placementState(S.placements.find(p => p.status === 'bridged-gap'), true)`)
  assert.match(label, /Blank downstream level skipped/, `unhandled status rendered as "${label}"`)
})

/* ----------------------------------------------------------------------
 * A load fed from more than one panel.
 *
 * cleanTag strips panel sides, so 'PNL-1-A' fed from SWBD-2 and 'PNL-1-B'
 * fed from SWBD-3 collapse onto one dependency key and the second feed was
 * dropped with nothing recorded. The kept feed is unchanged -- S.deps is
 * still a single value because the cable parent-chain repair walks it
 * upward as a tag name -- but the loss is now reported.
 * ---------------------------------------------------------------------- */

test('a load fed from two panels reports the feed that was not used', async () => {
  const app = await build(['easy-power.xlsx', 'cable-schedule.xlsx'])
  const flags = JSON.parse(app.eval(`
    JSON.stringify(S.placements.filter(p => p.status === 'cable-conflict')
      .map(p => ({ branchName: p.branchName, currentParent: p.currentParent, reason: p.reason })))
  `))
  assert.equal(flags.length, 1, `expected one feed conflict, got ${JSON.stringify(flags)}`)
  assert.equal(flags[0].branchName, 'PNL-1', 'PNL-1-A and PNL-1-B collapse onto PNL-1')
  assert.equal(flags[0].currentParent, 'SWBD-2', 'the first Panel (From) is the one kept')
  assert.match(flags[0].reason, /SWBD-3/, 'the unused feed must be named')

  // Behaviour preserved: the dependency stays a single tag, because the cable
  // parent-chain repair walks it (`cursor = depOf(cursor)`) as a tag name.
  assert.equal(app.eval(`depOf('PNL-1')`), 'SWBD-2',
    'the dependency must stay single-valued until parent and dependency-set are separated')

  const label = app.eval(`placementState(S.placements.find(p => p.status === 'cable-conflict'), true)`)
  assert.match(label, /more than one panel/, `unhandled status rendered as "${label}"`)
})

/* ----------------------------------------------------------------------
 * A review flag the engineer cannot act on is worse than no flag: it
 * reports a problem and then offers nothing. These entries are raised
 * while rows are being read -- some before the tree exists at all -- so
 * they carried no node, and the drawer had no branch size, no candidate
 * parents and no acknowledge button.
 * ---------------------------------------------------------------------- */

test('a bridged-gap flag is bound to its node, so the branch can be re-parented', async () => {
  const app = await build(['downstream-gap.xlsx'])
  const bound = JSON.parse(app.eval(`
    JSON.stringify(S.placements.filter(p => p.status === 'bridged-gap').map(p => ({
      branchName: p.branchName,
      hasNode: !!p.node,
      nodeName: p.node ? p.node.name : '',
      descendants: p.node ? rawSubtreeCount(p.node) : null,
      pathLength: (p.path || []).length,
      candidates: placementCandidates(p, '').length,
      acknowledgeable: isAcknowledgeableIssue(p),
    })))
  `))
  const flag = bound.find(item => item.branchName === 'PNL-7')
  assert.ok(flag, 'the PNL-7 gap must be among the bound flags')
  assert.equal(flag.hasNode, true, 'the flag must carry the node it describes')
  assert.equal(flag.nodeName, 'PNL-7')
  assert.equal(flag.descendants, 1, 'PNL-7 has MTR-D beneath it -- the drawer must not report 0')
  assert.ok(flag.pathLength > 0, 'a bound flag has a real path to show')
  assert.ok(flag.candidates > 0, 'the drawer must offer somewhere to move the branch')
  assert.equal(flag.acknowledgeable, true, 'the entry must be dismissible as well as movable')
})

test('every informational flag can be acknowledged, and acknowledging clears it', async () => {
  const app = await build(['easy-power.xlsx', 'cable-schedule.xlsx'])
  const statuses = JSON.parse(app.eval(`
    JSON.stringify(S.placements.map(p => [p.status, isAcknowledgeableIssue(p)]))
  `))
  assert.ok(statuses.length > 0, 'fixture must raise at least one flag')
  for (const [status, ok] of statuses) {
    assert.equal(ok, true, `status "${status}" has no way to be cleared from the review panel`)
  }
  const before = Number(app.eval('activePlacements().length'))
  await app.evalAsync(`await acceptPlacement(S.placements[0].id); return '';`)
  assert.equal(Number(app.eval('activePlacements().length')), before - 1,
    'acknowledging must remove the entry from the active review list')
})

test('loads under case-variant spellings all land on the one surviving node', async () => {
  const app = await build(['case-variants.xlsx'])
  const loads = JSON.parse(app.eval(`
    JSON.stringify((function () {
      const out = [];
      const walk = n => {
        if (String(n.name).toLowerCase() === 'mcc-1') n.children.forEach(k => out.push(k.name));
        n.children.forEach(walk);
      };
      S.roots.forEach(walk);
      return out.sort();
    })())
  `))
  assert.deepEqual(loads, ['MTR-1', 'MTR-2', 'MTR-3'],
    'merging spellings must not drop the children that hung off the other spellings')
})
