import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeItemMasterName, suspectRegistryRow } from '../src/compiler/itemmasters.js'
import { extractMilestoneUpns } from '../src/compiler/ladders.js'
import { detectExtoRegistry, detectItemMasterTemplate } from '../src/io/exto.js'
import { buildProjectApp, canonicalRecordOf } from './support/compiler-harness.mjs'

/* Item-master auto-assignment (optional EXTO layer): learned from a prior
   registry, confidence-gated, CA_* names normalized to the universal VF
   vocabulary, and suspect registry rows audited instead of learned. */

const CORE = ['easy-power.xlsx', 'compiler-cable.xlsx', 'compiler-mel.xlsx']
const EXTO = [...CORE, 'compiler-extoreg.xlsx', 'compiler-imtemplate.xlsx']

test('CA_* names normalize to VF when the suffix matches a known VF master', () => {
  const vocab = new Set(['VF_EL_MV_GEAR', 'VF_IC_RIO'])
  assert.equal(normalizeItemMasterName('CA_NB_EL_MV_GEAR', vocab), 'VF_EL_MV_GEAR')
  assert.equal(normalizeItemMasterName('VF_EL_PANEL', vocab), 'VF_EL_PANEL', 'VF names pass through')
  assert.equal(normalizeItemMasterName('CA_NB_UNKNOWN_THING', vocab), 'CA_NB_UNKNOWN_THING', 'no VF match keeps the original')
  assert.equal(normalizeItemMasterName('CA_NB_EL_MV_GEAR', new Set()), 'CA_NB_EL_MV_GEAR', 'no vocabulary means no guessing')
})

test('suspect registry rows: placeholders and electrical gear on non-electrical equipment', () => {
  assert.match(suspectRegistryRow({ itemMaster: 'VF_Blank', discipline: 'UPW' }), /placeholder/)
  assert.match(suspectRegistryRow({ itemMaster: 'CA_NB_EL_MV_GEAR', discipline: 'UPW' }), /non-electrical/)
  assert.equal(suspectRegistryRow({ itemMaster: 'CA_NB_EL_MV_GEAR', discipline: 'ELECTRICAL' }), '')
  assert.equal(suspectRegistryRow({ itemMaster: 'VF_I&C_VALVE', discipline: 'WASTE' }), '')
})

test('milestone names covering several UPNs claim each of them', () => {
  const pattern = /\bUPN\s*[-#]?\s*([A-Za-z0-9./-]+)/i
  assert.deepEqual(extractMilestoneUpns('L2-M1-1220 - UPN 115/116/117 HW/SHW/HRW Enabling', pattern), ['115', '116', '117'])
  assert.deepEqual(extractMilestoneUpns('L2-M1-0602 - UPN 602 MV Energization', pattern), ['602'])
  assert.deepEqual(extractMilestoneUpns('LVSS Green Tag', pattern), [])
})

test('detectors anchor on registry and item-master template shapes without claiming MELs', () => {
  const reg = detectExtoRegistry(['Cx Upload Unique Number', 'Site', 'Building', 'UPN', 'Discipline', 'System Name', 'Equipment ID', 'Equipment Description', 'Closest Parent', 'Item Master Unique Identifier'])
  assert.ok(reg)
  assert.equal(reg.itemMaster, 9)
  assert.equal(detectExtoRegistry(['Equipment Tag', 'UPN', 'Discipline']), null, 'a MEL is not a registry')
  assert.ok(detectItemMasterTemplate(['Site', 'Discipline', 'IM Name', 'Use Case(s)']))
  assert.equal(detectItemMasterTemplate(['Site', 'Discipline']), null)
})

test('integration: item masters auto-assign from the registry with VF normalization', async () => {
  const app = await buildProjectApp(EXTO)
  const rio = canonicalRecordOf(app, 'B14-RIO-6500')
  assert.ok(rio.itemMaster, 'RIO gets an item master from the description rung')
  assert.equal(rio.itemMaster.name, 'VF_IC_RIO', 'CA_NB_IC_RIO normalized to the VF vocabulary')
  const ahu = canonicalRecordOf(app, 'B14-AHU-7001')
  assert.equal(ahu.itemMaster.name, 'VF_MECH_AHU')
  const mtr = canonicalRecordOf(app, 'MTR-9001')
  assert.equal(mtr.itemMaster, null, 'ambiguous key must not auto-assign')
  assert.ok(mtr.itemMasterReview, 'ambiguous key goes to review with candidates')
})

test('integration: registry audit findings surface in the QA sheets', async () => {
  const app = await buildProjectApp(EXTO)
  const rows = JSON.parse(app.eval(`
    JSON.stringify((function () {
      const wb = XLSX.utils.book_new(), used = new Set();
      addQaSheets(wb, used);
      return XLSX.utils.sheet_to_json(wb.Sheets['QA Exceptions'], { header: 1, defval: '' });
    })())
  `))
  assert.ok(rows.some(row => row[0] === 'Registry item-master audit' && /X-BAD/.test(row[1])), 'gear-on-UPW row audited')
  assert.ok(rows.some(row => row[0] === 'Registry item-master audit' && /X-BLANK/.test(row[1])), 'placeholder row audited')
  assert.ok(rows.some(row => row[0] === 'Item master needs review' && /MTR-9001/.test(row[1])))
})

test('integration: disabling the EXTO layer skips item masters and the Exto sheet', async () => {
  const app = await buildProjectApp(EXTO)
  await app.evalAsync(`
    activeProfile().hierarchy.exto.enabled = false;
    await buildHierarchy();
    return '';
  `)
  const rio = canonicalRecordOf(app, 'B14-RIO-6500')
  assert.equal(rio.itemMaster, null, 'no item-master pass when the layer is off')
  const sheetNames = JSON.parse(app.eval(`
    JSON.stringify((function () {
      const wb = XLSX.utils.book_new(), used = new Set();
      addExtoSheet(wb, 'Exto SSM', S.ssmCombined, used);
      return wb.SheetNames;
    })())
  `))
  assert.deepEqual(sheetNames, [], 'no Exto sheet when the layer is off')
  assert.equal(rio.ssmParentTag, '', 'the SSM itself is unaffected')
})
