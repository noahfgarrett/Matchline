import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadApp } from './harness.mjs'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

/* Compiler-fork test harness: boot the app, activate an editable project
   profile (the harness default is the locked Eagle legacy profile, which keeps
   MEL-first behavior off), ingest fixtures, build. */
export async function buildProjectApp(files) {
  const app = await loadApp()
  app.eval(`
    initProfiles();
    const SITE = normalizeProfile(makeDefaultProfile('Compiler Site'));
    PROFILE_STORE.profiles.push(SITE);
    PROFILE_STORE.activeId = SITE.id;
    setRuleProfile(activeProfile());
  `)
  const payload = files.map(f => f.endsWith('.xer')
    ? { name: f, text: readFileSync(resolve(rootDir, 'tests/fixtures', f), 'utf8') }
    : { name: f, bytes: [...readFileSync(resolve(rootDir, 'tests/fixtures', f))] })
  app.eval(`globalThis.__fixtures = ${JSON.stringify(payload)}`)
  await app.evalAsync(`
    for (const fx of __fixtures) {
      if (fx.text != null) {
        S.files.push({ id: 'f' + S.files.length, name: fx.name, ext: 'xer', size: fx.text.length,
          wb: null, sheets: [], strikes: new Map(), error: null, p6: parseXer(fx.text) });
        continue;
      }
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

/** A canonical record's test-relevant surface, or null. */
export function canonicalRecordOf(app, tag) {
  return JSON.parse(app.eval(`
    JSON.stringify((function () {
      const r = S.canonicalModel.get(tagKey(${JSON.stringify(tag)}));
      return r ? { tag: r.tag, sourceKind: r.sourceKind, includeInRegister: r.includeInRegister,
        includeInHierarchy: r.includeInHierarchy, phaseExcluded: !!r.phaseExcluded,
        ssmParentTag: r.ssmParentTag, dependencies: [...r.dependencies],
        building: r.building, discipline: r.discipline, system: r.system,
        milestone: r.milestone || null, sequence: r.sequence ?? null,
        itemMaster: r.itemMaster || null, itemMasterReview: r.itemMasterReview || null,
        explicit: r.context ? r.context.explicit : null } : null;
    })())
  `))
}
