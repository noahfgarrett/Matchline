import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadApp } from './harness.mjs'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

export const FROZEN_SSM_BUILDER = '/Users/noahgarrett/Codebase/SSM-Builder/SSM-Builder.html'

function fixtureBytes(file) {
  return [...readFileSync(resolve(rootDir, 'tests/fixtures', file))]
}

/**
 * Capture the user-visible electrical hierarchy and register/export rows that
 * exist in both frozen SSM Builder v1.1.37 and SSManagement.
 */
export async function captureLegacyComparableScenario(scenario, htmlPath) {
  const app = await loadApp(htmlPath)
  const payload = scenario.files.map(file => ({ name: file, bytes: fixtureBytes(file) }))
  const workCopy = scenario.workCopy
    ? { name: scenario.workCopy, bytes: fixtureBytes(scenario.workCopy) }
    : null

  app.eval(`globalThis.__legacyFixtures = ${JSON.stringify(payload)}`)
  app.eval(`globalThis.__legacyWorkCopy = ${JSON.stringify(workCopy)}`)

  return JSON.parse(await app.evalAsync(`
    /* Select Eagle EXPLICITLY. This harness compares SSManagement against the
       frozen SSM Builder, so it must run the compatibility profile -- relying on
       Eagle happening to be the default would silently compare whatever profile
       a first run lands on, and the differential would pass or fail for reasons
       that have nothing to do with compatibility. */
    if (typeof initProfiles === 'function') initProfiles();
    if (typeof PROFILE_STORE !== 'undefined' && PROFILE_STORE.profiles.some(profile => profile.id === 'builtin-eagle')) {
      PROFILE_STORE.activeId = 'builtin-eagle';
      if (typeof setRuleProfile === 'function') setRuleProfile(activeProfile());
    }
    for (const fx of __legacyFixtures) {
      const bytes = new Uint8Array(fx.bytes);
      const wb = XLSX.read(bytes, { type: 'array' });
      const id = 'f' + S.files.length;
      S.files.push({
        id,
        name: fx.name,
        ext: 'xlsx',
        size: bytes.length,
        wb,
        sheets: wb.SheetNames.slice(),
        strikes: extractStrikeCells(bytes),
        error: null
      });
    }
    await prewarmSheets();
    if (__legacyWorkCopy) {
      S.workCopy = {
        name: __legacyWorkCopy.name,
        wb: XLSX.read(new Uint8Array(__legacyWorkCopy.bytes), { type: 'array' })
      };
      parseWorkCopy();
    }
    for (const key of allHierKeys()) S.selected.add(key);
    await buildHierarchy();

    const shape = node => ({
      name: node.name,
      isId: !!node.isId,
      isLoad: !!node.isLoad,
      isInstrument: !!node.isInstrument,
      dep: nodeDep(node) || '',
      kids: node.children.map(shape)
    });
    const register = rows => uniqueSsmRows(rows).map(row => {
      const resolved = ssmRegisterResolve(row);
      return [
        resolved.equip,
        registerDisplayValue(resolved.parent),
        registerDisplayValue(resolved.dep)
      ];
    });
    const visibleElectricalRoots=S.projections&&S.projections['electrical-flow']
      ?S.projections['electrical-flow'].roots:S.roots;
    const perSheetRows=sheet=>typeof resolvedRegisterRowsFor==='function'
      ?resolvedRegisterRowsFor(sheet.ssmRows):sheet.ssmRows;
    return JSON.stringify({
      roots: visibleElectricalRoots.map(shape),
      register: register(S.ssmCombined),
      sheets: S.sheets.map(sheet => ({
        name: sheet.sheetName,
        register: register(perSheetRows(sheet))
      })),
      review: S.review.map(row => [
        row.load,
        row.panel,
        row.circuit,
        row.matches.map(match => match.match + ':' + match.pct)
      ]),
      placements: activePlacements().map(item => [
        item.branchName,
        item.status,
        item.source,
        item.currentParent,
        item.suggestedParent,
        item.reason || ''
      ]),
      compare: S.compare.map(item => [
        item.equip,
        item.status,
        item.curParent,
        item.curDep,
        item.wcParent,
        item.wcDep,
        item.inCur,
        item.inWc,
        item.acceptedDepMismatch
      ]),
      stats: {
        nodes: S.stats.nodes,
        leaves: S.stats.leaves,
        maxDepth: S.stats.maxDepth,
        rowsRead: S.stats.rowsRead,
        loads: S.stats.loads,
        instruments: S.stats.instruments,
        deps: S.stats.deps,
        review: S.stats.review
      }
    });
  `))
}
