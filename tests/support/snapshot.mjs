import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadApp } from './harness.mjs'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * Scenarios are [name, fixture files, optional working-copy fixture].
 * `workCopy` is loaded into S.workCopy — a different slot from S.files — because
 * parseWorkCopy() reads only that slot; listing it in `files` would do nothing.
 */
export const SCENARIOS = [
  { name: 'easy-power-only', files: ['easy-power.xlsx'] },
  { name: 'with-cable', files: ['easy-power.xlsx', 'cable-schedule.xlsx'] },
  { name: 'with-mel', files: ['easy-power.xlsx', 'mel.xlsx'] },
  { name: 'with-pmd', files: ['easy-power.xlsx', 'pmd.xlsx'] },
  { name: 'all-sources', files: ['easy-power.xlsx', 'cable-schedule.xlsx', 'mel.xlsx', 'pmd.xlsx'] },
  // Cable Schedule parent-chain repair: resolved moves, a synthetic ancestor,
  // an unanchored chain and a cycle.
  { name: 'cable-parent-repair', files: ['easy-power-rules.xlsx', 'cable-schedule-rules.xlsx'] },
  // MEL transformer decisions plus the hardcoded site conventions
  // (CIM / SCR / MAH / power variant / space names).
  { name: 'site-conventions', files: ['easy-power-rules.xlsx', 'mel-rules.xlsx'] },
  // Working-copy comparison: match, off and nohit rows.
  { name: 'working-copy-compare', files: ['easy-power.xlsx'], workCopy: 'working-copy.xlsx' },
]

function fixtureBytes(file) {
  return [...readFileSync(resolve(rootDir, 'tests/fixtures', file))]
}

/**
 * Import fixtures through the app's own detection path, build, and snapshot.
 * Uses XLSX.read on real bytes so sheetAoa and strike extraction are exercised.
 */
export async function captureScenario(scenario, htmlPath) {
  const app = await loadApp(htmlPath)
  const payload = scenario.files.map(f => ({ name: f, bytes: fixtureBytes(f) }))
  const workCopy = scenario.workCopy ? { name: scenario.workCopy, bytes: fixtureBytes(scenario.workCopy) } : null
  app.eval(`globalThis.__fixtures = ${JSON.stringify(payload)}`)
  app.eval(`globalThis.__workCopy = ${JSON.stringify(workCopy)}`)

  return JSON.parse(await app.evalAsync(`
    /* Goldens are the Eagle compatibility baseline. The shipped built-in is
       now the universal compiler profile, so the frozen behavior must be
       selected EXPLICITLY via its factory — relying on any default would
       recapture every golden against the wrong behaviour without a single
       test going red. */
    const LEGACY = normalizeProfile(makeLegacyEagleProfile());
    PROFILE_STORE.profiles = [LEGACY];
    PROFILE_STORE.activeId = LEGACY.id;
    setRuleProfile(activeProfile());
    if (activeProfile().hierarchy.resolutionStrategy !== 'legacy-register') {
      throw new Error('golden capture must run the frozen Eagle baseline, got ' + activeProfile().name);
    }
    for (const fx of __fixtures) {
      const bytes = new Uint8Array(fx.bytes);
      const wb = XLSX.read(bytes, { type: 'array' });
      const id = 'f' + S.files.length;
      S.files.push({ id, name: fx.name, ext: 'xlsx', size: bytes.length, wb,
        sheets: wb.SheetNames.slice(), strikes: extractStrikeCells(bytes), error: null });
    }
    await prewarmSheets();
    if (__workCopy) {
      S.workCopy = { name: __workCopy.name, wb: XLSX.read(new Uint8Array(__workCopy.bytes), { type: 'array' }) };
      parseWorkCopy();
    }
    for (const k of allHierKeys()) S.selected.add(k);
    await buildHierarchy();

    const shape = n => ({
      name: n.name, isId: !!n.isId, isLoad: !!n.isLoad, isInstrument: !!n.isInstrument,
      dep: nodeDep(n) || '', kids: n.children.map(shape),
    });
    // Same fields as the hierarchy shape plus the grouping kind and the spare/space
    // flags, so buildCanonicalModel + buildSsmProjection are asserted, not just run.
    const ssmShape = n => ({
      name: n.name, kind: n.kind, isId: !!n.isId, isLoad: !!n.isLoad, isInstrument: !!n.isInstrument,
      isSpare: !!n.isSpare, isSpace: !!n.isSpace, dep: nodeDep(n) || '', kids: n.children.map(ssmShape),
    });
    return JSON.stringify({
      roots: S.roots.map(shape),
      register: uniqueSsmRows(S.ssmCombined).map(r => {
        const o = ssmRegisterResolve(r);
        return [o.equip, registerDisplayValue(o.parent), registerDisplayValue(o.dep)];
      }),
      review: S.review.map(r => [r.load, r.panel, r.circuit, r.matches.map(m => m.match + ':' + m.pct)]),
      placements: activePlacements().map(p => [p.branchName, p.status, p.source, p.currentParent, p.suggestedParent, p.reason || '']),
      compare: S.compare.map(c => [c.equip, c.status, c.curParent, c.curDep, c.wcParent, c.wcDep, c.inCur, c.inWc, c.acceptedDepMismatch]),
      ssm: { roots: S.projections.ssm.roots.map(ssmShape), stats: S.projections.ssm.stats },
      stats: { nodes: S.stats.nodes, leaves: S.stats.leaves, maxDepth: S.stats.maxDepth,
               rowsRead: S.stats.rowsRead, loads: S.stats.loads, instruments: S.stats.instruments },
    });
  `))
}
