import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createEngine } from '../src/rules/engine.js'
import { makeExampleProfile } from '../src/rules/defaults.js'
import { createMemoryLookup } from '../src/rules/lookup.js'
import { cleanTag } from '../src/core/tags.js'
import { isSpareName, isSpaceName, isNote } from '../src/profile/classify.js'
import { legacyEquipmentRole, stripPowerVariant, equipmentSuffix } from '../src/hierarchy/build.js'
import { loadApp } from './support/harness.mjs'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Every tag-shaped string in the golden snapshots, plus generated edge cases. */
function corpus() {
  const tags = new Set()
  const goldenDir = resolve(rootDir, 'tests/golden')
  for (const file of readdirSync(goldenDir).filter(f => f.endsWith('.json'))) {
    const walk = value => {
      if (typeof value === 'string') { if (value) tags.add(value); return }
      if (Array.isArray(value)) { value.forEach(walk); return }
      if (value && typeof value === 'object') { Object.values(value).forEach(walk) }
    }
    walk(JSON.parse(readFileSync(resolve(goldenDir, file), 'utf8')))
  }
  // generated edge cases, one per convention
  for (const base of ['MCC-01', 'B14-LVS-1234', 'GIS-01', 'B14-XFM-9', 'PNL-1',
                       'SCR-02', 'SCC-03', 'TX-100', 'B99-GIS-5678', 'B7-XFM-42']) {
    for (const suffix of ['', '-A', '-B', '-P', '-S', '-OUTPUT', '-A-B', '-a', '_CPS', '_NPS', '_cps', '-A_CPS',
                           '-P-S', '-OUTPUT-A', '_nps', '-B_NPS']) {
      tags.add(base + suffix)
    }
  }
  for (const odd of ['A', '-A', 'SP-1', 'SPARE', 'SPARE 2', 'SPARE_3', 'SPACE-1', 'SPACEX-1',
                     'NOTE', 'NOTE 4', 'NOTES', 'GIS-LV-1', 'LV', 'LVS', 'XFMGIS-1', 'B14-CIM', '',
                     // more of the same conventions, at their length/case boundaries
                     'AB', 'ABC', 'ABCD', 'ABCDE', 'sp-2', 'SP-', 'SPARE-1', 'SPARE_1', 'SPACE 1',
                     'SPACE_1', 'NOTE1', 'NOTE 12', 'NOTES 1', 'Note', 'SPARE-a', 'gis-1', 'xfm-1',
                     'lv-1', 'GISXFM-1', 'LV1', 'LVX-1', 'B1-GIS', 'B1_GIS', 'GIS', 'XFM', 'N/A',
                     'SOME MEL', 'note 007', 'space', 'spare', '  SPARE  ', 'SPARE-A-B', 'note-1']) {
    tags.add(odd)
  }
  return [...tags]
}

const TAGS = corpus()
const engine = createEngine(makeExampleProfile())

test('the corpus is large enough to be meaningful', () => {
  assert.ok(TAGS.length > 200, `corpus has only ${TAGS.length} tags`)
})

test('engine canonical tag equals cleanTag + stripPowerVariant for every tag', () => {
  const mismatches = []
  for (const tag of TAGS) {
    const expected = stripPowerVariant(tag)
    const actual = engine.resolve(cleanTag(tag)).canonical
    if (actual !== expected) mismatches.push({ tag, expected, actual })
  }
  assert.deepEqual(mismatches, [], `canonical-tag mismatches:\n${JSON.stringify(mismatches.slice(0, 10), null, 2)}`)
})

test('engine equipmentType equals legacyEquipmentRole for every tag', () => {
  const mismatches = []
  for (const tag of TAGS) {
    const expected = legacyEquipmentRole(tag)
    const actual = engine.resolve(cleanTag(tag)).attributes.equipmentType || ''
    if (actual !== expected) mismatches.push({ tag, expected, actual })
  }
  assert.deepEqual(mismatches, [], `role mismatches:\n${JSON.stringify(mismatches.slice(0, 10), null, 2)}`)
})

test('engine placeholder equals isSpareName / isSpaceName / isNote for every tag', () => {
  const mismatches = []
  for (const tag of TAGS) {
    const expected = isSpareName(tag) ? 'spare' : isSpaceName(tag) ? 'space' : isNote(tag) ? 'note' : ''
    const actual = engine.resolve(cleanTag(tag)).attributes.placeholder || ''
    if (actual !== expected) mismatches.push({ tag, expected, actual })
  }
  assert.deepEqual(mismatches, [], `placeholder mismatches:\n${JSON.stringify(mismatches.slice(0, 10), null, 2)}`)
})

test('engine matchKey equals equipmentSuffix for every tag', () => {
  const mismatches = []
  for (const tag of TAGS) {
    const expected = equipmentSuffix(tag)
    const actual = (engine.resolve(cleanTag(tag)).attributes.matchKey || '').toLowerCase()
    if (actual !== expected) mismatches.push({ tag, expected, actual })
  }
  assert.deepEqual(mismatches, [], `matchKey mismatches:\n${JSON.stringify(mismatches.slice(0, 10), null, 2)}`)
})

/* ---------------------------------------------------------------------- *
 * Task 5 (P1/B-2): the five MEL-dependent Relate conventions.
 *
 * These are only meaningful with real MEL data behind them, so the app is
 * loaded through the same harness tests/support/snapshot.mjs uses, fed the
 * same two MEL fixtures (mel.xlsx + mel-rules.xlsx — the pair the corpus's
 * golden snapshots, with-mel.json and site-conventions.json, were captured
 * against), and buildMel() is run for real. S.melRows is then projected
 * into LookupSource records.
 *
 * Attribute derivation is the crux of this harness: each record's
 * `equipmentType`/`matchKey` come from engine.resolve(...), NOT from
 * legacyEquipmentRole/equipmentSuffix. Deriving them from the hardcoded
 * helpers would make this compare the hardcoded implementation against
 * itself and prove nothing.
 * ---------------------------------------------------------------------- */

function fixtureBytes(file) {
  return [...readFileSync(resolve(rootDir, 'tests/fixtures', file))]
}

async function buildMelHarness() {
  const app = await loadApp()
  const files = ['mel.xlsx', 'mel-rules.xlsx']
  const payload = files.map(f => ({ name: f, bytes: fixtureBytes(f) }))
  app.eval(`globalThis.__fixtures = ${JSON.stringify(payload)}`)
  const melRowsJson = await app.evalAsync(`
    for (const fx of __fixtures) {
      const bytes = new Uint8Array(fx.bytes);
      const wb = XLSX.read(bytes, { type: 'array' });
      const id = 'f' + S.files.length;
      S.files.push({ id, name: fx.name, ext: 'xlsx', size: bytes.length, wb,
        sheets: wb.SheetNames.slice(), strikes: extractStrikeCells(bytes), error: null });
    }
    await prewarmSheets();
    allKeys().forEach(k => { if (isMelSheet(k)) S.melSel.add(k); });
    await buildMel();
    return JSON.stringify(S.melRows);
  `)
  const melRows = JSON.parse(melRowsJson)
  const records = melRows.map(rec => {
    const attrs = engine.resolve(cleanTag(rec.tag)).attributes
    return {
      tag: rec.tag,
      columns: { Building: rec.building, UPN: rec.upn, SystemParent: rec.systemParent },
      attributes: { equipmentType: attrs.equipmentType || '', matchKey: attrs.matchKey || '' },
    }
  })
  return { app, lookup: createMemoryLookup(records), melTags: melRows.map(r => r.tag) }
}

/**
 * A second, isolated app carrying nothing but one synthetic SCC- record —
 * fresh so S.melByGram stays empty and melLookupSearchRows takes its
 * unindexed fallback (`if(!S.melByGram.size)return S.melRows;`), meaning a
 * plain push onto S.melRows is enough for melContainingRecord to see it,
 * with no need to replicate buildMel's suffix/gram indexing by hand.
 *
 * S.melLookup (the LookupSource Relate rules read, built once at the end of
 * buildMel — see Task 6) is a snapshot, not a live view of S.melRows, so the
 * manual push above is invisible to it unless rebuilt the same way buildMel
 * itself does. melScrSccParent now goes through that lookup (Task 7), so
 * this harness has to keep it in sync or it proves nothing about the quirk.
 */
async function buildScrSccQuirkHarness() {
  const app = await loadApp()
  await app.evalAsync(`
    await buildMel();
    const rec = { tag: 'ZZ14-SCC-9001', upn: '', building: 'ZZ14', systemParent: '' };
    S.melRows.push(rec);
    S.melByTag.set(tagKey(rec.tag), rec);
    S.melLookup = createMemoryLookup(S.melRows.map(r => {
      const resolved = ruleEngine().resolve(cleanTag(r.tag));
      return { tag: r.tag, columns: { Building: r.building, UPN: r.upn, SystemParent: r.systemParent },
        attributes: { equipmentType: resolved.attributes.equipmentType || '', matchKey: resolved.attributes.matchKey || '' } };
    }));
  `)
  const lookup = createMemoryLookup([{ tag: 'ZZ14-SCC-9001', columns: { Building: 'ZZ14' }, attributes: {} }])
  return { app, lookup }
}

const melHarness = await buildMelHarness()

// Every engine.relate call below is fed cleanTag(tag), not the raw corpus
// string — the same convention the four tests above use for
// engine.resolve(). The engine's Normalize rules replicate cleanTag's
// site-specific suffix stripping, but not its Unicode/whitespace hygiene
// (e.g. collapsing 'B14 - CIM' to 'B14-CIM'); that is assumed to already
// have happened before a tag reaches the engine, exactly as it has for
// every other consumer of engine.resolve/engine.relate in this file.

test('engine matches melScrSccParent for every tag, given the real MEL fixtures', () => {
  const expectedJson = melHarness.app.eval(`JSON.stringify((${JSON.stringify(TAGS)}).map(t => melScrSccParent(t)))`)
  const expected = JSON.parse(expectedJson)
  const mismatches = []
  TAGS.forEach((tag, i) => {
    const d = engine.relate(cleanTag(tag), '', { sources: { mel: melHarness.lookup } })
    const actual = d.ruleId === 'scr-scc-parent' ? d.parent : ''
    if (actual !== expected[i]) mismatches.push({ tag, expected: expected[i], actual })
  })
  assert.deepEqual(mismatches, [], `SCR/SCC parent mismatches:\n${JSON.stringify(mismatches.slice(0, 10), null, 2)}`)
})

test('engine matches melCimParent for every tag, given the real MEL fixtures', () => {
  const expectedJson = melHarness.app.eval(`JSON.stringify((${JSON.stringify(TAGS)}).map(t => melCimParent(t)))`)
  const expected = JSON.parse(expectedJson)
  const mismatches = []
  TAGS.forEach((tag, i) => {
    const d = engine.relate(cleanTag(tag), '', { sources: { mel: melHarness.lookup } })
    const actual = d.ruleId === 'cim-parent' ? d.parent : ''
    if (actual !== expected[i]) mismatches.push({ tag, expected: expected[i], actual })
  })
  assert.deepEqual(mismatches, [], `CIM parent mismatches:\n${JSON.stringify(mismatches.slice(0, 10), null, 2)}`)
})

test('engine matches mahClosestParent for every tag, given the real MEL fixtures', () => {
  const expectedJson = melHarness.app.eval(`JSON.stringify((${JSON.stringify(TAGS)}).map(t => mahClosestParent(t)))`)
  const expected = JSON.parse(expectedJson)
  const mismatches = []
  TAGS.forEach((tag, i) => {
    const d = engine.relate(cleanTag(tag), '', { sources: { mel: melHarness.lookup } })
    const actual = d.ruleId === 'mah-parent' ? d.parent : ''
    if (actual !== expected[i]) mismatches.push({ tag, expected: expected[i], actual })
  })
  assert.deepEqual(mismatches, [], `MAH parent mismatches:\n${JSON.stringify(mismatches.slice(0, 10), null, 2)}`)
})

/**
 * NON-IDEMPOTENT NORMALISATION — the hazard that produced a real defect.
 *
 * stripPowerVariant is not idempotent for a tag shaped like
 * "<base>-<panel side>_<power variant>" (e.g. 'B14-LVS-1234-B_NPS'): the
 * first pass strips only the terminal power variant ('_NPS'), because
 * cleanTag's panel-side strip doesn't see the panel side ('-B') while the
 * variant still hides it at the end of the string. The now-exposed '-B'
 * only gets stripped on a SECOND pass. Measured:
 *
 *   equipmentSuffix('B14-LVS-1234-B_NPS')                    === '34-b'
 *   equipmentSuffix(stripPowerVariant('B14-LVS-1234-B_NPS')) === '1234'
 *
 * The now-deleted melMatchingTransformer computed its lookup key the second
 * way while buildMel indexed the first way, so for these shapes its candidate
 * lookup could never hit. That function was already dead code by the end of
 * P1 — the live path, melTransformerDecision, delegates to the rule engine —
 * and P2 removed it together with S.melXfmBySuffix, the index it was the sole
 * reader of.
 *
 * No pairs are excluded from the comparison below any more; the exclusion
 * that used to live here was vestigial once the live path went through the
 * engine. What survives is a corpus-coverage canary: the tag shape that made
 * the defect possible has to stay in the corpus, so that any future code
 * applying a normalisation twice gets compared on the shapes where doing so
 * actually diverges.
 */
function suffixAfterExtraStrip(tag) {
  return equipmentSuffix(stripPowerVariant(tag))
}
function isNonIdempotentUnderStrip(tag) {
  const suffix = equipmentSuffix(tag)
  return !!suffix && suffix !== suffixAfterExtraStrip(tag)
}

test('engine matches melTransformerDecision for LVS/XFM pairs drawn from the fixtures', () => {
  const roleOf = tag => engine.resolve(cleanTag(tag)).attributes.equipmentType || ''
  const universe = [...new Set([...TAGS, ...melHarness.melTags])]
  const lvsTags = universe.filter(t => roleOf(t) === 'LVS')
  const xfmTags = universe.filter(t => roleOf(t) === 'XFM')
  const pairs = []
  for (const equip of lvsTags) for (const parent of xfmTags) pairs.push([equip, parent])

  const expectedJson = melHarness.app.eval(
    `JSON.stringify((${JSON.stringify(pairs)}).map(([equip, parent]) => melTransformerDecision(equip, parent)))`,
  )
  const expected = JSON.parse(expectedJson)

  // Vocabulary mapping (melTransformerDecision's {matched,suggested,unplaced}
  // vs the engine's {resolved,ambiguous,none} decision statuses):
  //
  //   null / 'matched' -> 'none'.
  //     null covers the guard failures (either tag under 4 characters, or a
  //     role mismatch) — the hardcoded function declines to decide at all.
  //     'matched' means the equipment and its current parent already share
  //     their last four characters — nothing to correct. Both cases mean
  //     "leave the current parent alone", which in the decision vocabulary
  //     is 'none', NOT 'resolved' with the unchanged parent named explicitly
  //     — engine.relate has no way to distinguish "resolved to X" from
  //     "X was already correct", and 'none' is the status whose documented
  //     meaning ("no rule fired; the caller keeps the parent it already
  //     had") matches what melTransformerDecision's 'matched' means. This
  //     is reproduced by the transformer-match rule's `whenDiffers:
  //     'matchKey'` guard (src/rules/relate.js): the rule does not fire at
  //     all when the equipment's and its current parent's matchKey already
  //     agree, or when either is missing (the under-4-characters case).
  //   'suggested' -> 'resolved', parent === decision.corrected.
  //   'unplaced'  -> 'ambiguous', candidates as a set === decision.candidates,
  //     reason === decision.reason.
  const mismatches = []
  const compoundShapePairs = []
  pairs.forEach(([equip, parent], i) => {
    const hd = expected[i]
    const d = engine.relate(cleanTag(equip), cleanTag(parent), { sources: { mel: melHarness.lookup } })
    if (isNonIdempotentUnderStrip(equip) || isNonIdempotentUnderStrip(parent)) {
      compoundShapePairs.push({ equip, parent })
    }
    let ok
    if (!hd || hd.status === 'matched') {
      ok = d.status === 'none'
    } else if (hd.status === 'suggested') {
      ok = d.status === 'resolved' && d.parent === hd.corrected
    } else if (hd.status === 'unplaced') {
      ok = d.status === 'ambiguous'
        && d.reason === hd.reason
        && JSON.stringify([...d.candidates].sort()) === JSON.stringify([...hd.candidates].sort())
    } else {
      ok = false
    }
    if (!ok) mismatches.push({ equip, parent, expected: hd, actual: d })
  })
  assert.deepEqual(mismatches, [], `transformer decision mismatches:\n${JSON.stringify(mismatches.slice(0, 10), null, 2)}`)
  // Corpus-coverage canary, NOT an exclusion: these pairs are compared like
  // every other one above. The compound "panel side then power variant" shapes
  // (e.g. '-A_CPS', '-B_NPS' — see corpus()) are the only ones where applying a
  // normalisation twice diverges from applying it once, so they are what makes
  // the comparison able to catch that class of defect at all. If this reaches
  // 0, the corpus stopped generating the shape and this test quietly lost the
  // coverage that mattered.
  assert.ok(
    compoundShapePairs.length > 0,
    'corpus no longer contains any tag whose suffix changes under a second stripPowerVariant pass; ' +
      'the compound "<base>-<panel side>_<power variant>" shapes were the coverage that made the ' +
      'double-strip class detectable — restore them in corpus()',
  )
})

test("melScrSccParent's SCR-before-SCC quirk: a tag with both markers never tries SCC", async () => {
  const { app, lookup } = await buildScrSccQuirkHarness()

  // Sanity check: with no SCR- marker in the way, SCC- alone resolves —
  // otherwise this test would prove nothing about the quirk itself.
  const isolatedExpected = app.eval(`melScrSccParent('SCC-9001')`)
  assert.notEqual(isolatedExpected, '', 'fixture assumption broke: the synthetic SCC record must be reachable alone')
  const isolatedActual = engine.relate('SCC-9001', '', { sources: { mel: lookup } })
  assert.equal(isolatedActual.status, 'resolved')
  assert.equal(isolatedActual.parent, isolatedExpected)

  // A tag with an SCR- marker that matches no MEL record, followed later by
  // an SCC- marker that WOULD match on its own, is swallowed by SCR's early
  // return (src/hierarchy/build.js:116-125: `if(!match)return '';` inside
  // the `for(const role of ['SCR','SCC'])` loop) — reproduced deliberately
  // by fragmentLookupDecision (src/rules/relate.js), not "fixed".
  const quirkTag = 'SCR-0000_SCC-9001'
  const quirkExpected = app.eval(`melScrSccParent(${JSON.stringify(quirkTag)})`)
  assert.equal(quirkExpected, '', 'fixture assumption broke: SCR-0000 must not match anything either')
  const quirkActual = engine.relate(quirkTag, '', { sources: { mel: lookup } })
  assert.equal(quirkActual.status, 'none')
  assert.equal(quirkActual.parent, quirkExpected)
})
