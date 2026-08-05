import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createContext, runInContext } from 'node:vm'

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const htmlPath = resolve(rootDir, 'SSMCompiler.html')
const fixturesDir = resolve(rootDir, 'tests/fixtures')
const html = readFileSync(htmlPath, 'utf8')
const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
if (!blocks.length) throw new Error(`No <script> block found in ${htmlPath} — cannot borrow SheetJS`)
const sheetjs = blocks[0][1]

const ctx = createContext({ console })
runInContext(sheetjs, ctx)
const XLSX = ctx.XLSX
if (!XLSX) throw new Error('Running the vendored SheetJS block did not define XLSX')

const SHEETS = {
  'easy-power.xlsx': {
    EasyPower: [
      ['Starting Source', 'Downstream1', 'Downstream2', 'Final Source', 'ID Name', 'Load Description', 'Circuit #'],
      ['GIS-01', 'B14-XFM-1234', 'B14-LVS-1234', 'B14-LVS-1234', '', 'MTR-9001', '12'],
      ['GIS-01', 'B14-XFM-1234', 'B14-LVS-1234', 'B14-LVS-1234', 'B14-LVS-1234-A', 'MTR-9002', '14'],
      ['GIS-01', 'B14-XFM-5678', 'B14-LVS-5678', 'B14-LVS-5678', '', 'MTR-9003', '16'],
      ['GIS-01', 'B14-XFM-5678', 'B14-LVS-5678', 'B14-LVS-5678', '', 'SPARE-1', '18'],
      ['GIS-01', 'B14-SCR-2201', '', 'B14-SCR-2201', '', '', '20'],
    ],
  },
  'cable-schedule.xlsx': {
    'Cable Schedule': [
      ['Load Name (To)', 'Panel (From)', 'Circuit_Number', 'Cable Tag'],
      ['MTR-9001', 'B14-LVS-1234', '12', 'C-0001'],
      ['PNL-1-A', 'SWBD-2', '3', 'C-0002'],
      ['PNL-1-B', 'SWBD-3', '4', 'C-0003'],
      ['ORPHAN-77', 'MISSING-PARENT-9', '5', 'C-0004'],
    ],
  },
  'mel.xlsx': {
    Equipment_List: [
      ['Equipment Tag', 'UPN', 'Bldg', 'System Parent Equipment Tag', 'Discipline', 'System Description'],
      ['B14-XFM-1234', 'UPN-1234', 'B14', '', 'Electrical', 'Main Intake'],
      ['B14-XFM-5678', 'UPN-5678', 'B14', '', 'Electrical', 'Main Intake'],
      ['B14-LVS-1234', 'UPN-1234', 'B14', 'B14-XFM-1234', 'Electrical', 'Main Intake'],
      ['B14-SCR-2201', 'UPN-2201', 'B14', '', 'I&C', 'Screening'],
    ],
  },
  /* Compiler-fork fixtures: a MEL that is the seed universe (MEL-only rows,
     Project Phase gating, cross-UPN feeds for the partition fold) plus the
     cable row that feeds an I&C panel from an Electrical UPN. */
  'compiler-mel.xlsx': {
    Equipment_List: [
      ['Equipment Tag', 'Equipment Description', 'UPN', 'Bldg', 'System Parent Equipment Tag', 'Discipline', 'System Description', 'Project Phase'],
      ['B14-XFM-1234', 'Main transformer', '1234', 'B14', '', 'Electrical', 'Main Intake', 'New'],
      ['B14-LVS-1234', 'LV switchgear', '1234', 'B14', 'B14-XFM-1234', 'Electrical', 'Main Intake', 'New'],
      ['MTR-9001', 'Supply fan motor', '2201', 'B14', 'B14-AHU-7002', 'Mechanical', 'Screening', 'New'],
      ['B14-AHU-7001', 'Air handler', '2201', 'B14', '', 'Mechanical', 'Screening', 'New'],
      ['B14-AHU-7002', 'Future air handler', '2201', 'B14', '', 'Mechanical', 'Screening', 'Future'],
      ['B14-RIO-6500', 'Remote IO panel', '650', 'B14', '', 'I&C', 'FMS Network', 'New'],
      ['B14-FCU-7101', 'Fan coil unit', '2201', 'B14', 'B14-AHU-7001', 'Mechanical', 'Screening', 'New'],
      ['B14-DDC-7301', 'DDC controller', '650', 'B14', '', 'I&C', 'FMS Network', 'New'],
      ['B14-TT-7001-02A', 'Temperature transmitter', '2201', 'B14', '', 'Mechanical', 'Screening', 'New'],
      ['B14-RIO-6500-PS1', 'RIO power supply', '650', 'B14', '', 'I&C', 'FMS Network', 'New'],
    ],
  },
  /* Optional EXTO-layer fixtures: a prior registry export (item-master
     learning source, with one bulk-fill audit case and one placeholder) and
     the VF item-master vocabulary template. */
  'compiler-extoreg.xlsx': {
    Registry: [
      ['Cx Upload Unique Number', 'Site', 'Building', 'UPN', 'Discipline', 'System Name', 'Equipment ID', 'Equipment Description', 'Equipment Classification', 'Closest Parent', 'Item Master Unique Identifier'],
      ['E-1', 'B1', 'B14', '650', 'I&C', '650 FMS Network', 'X-RIO-1', 'Remote IO panel', 'RIO', '650 FMS Network', 'CA_NB_IC_RIO'],
      ['E-2', 'B1', 'B14', '2201', 'MECHANICAL', '2201 Screening', 'X-AHU-9', 'Air handler', 'AHU', '2201 Screening', 'VF_MECH_AHU'],
      ['E-3', 'B1', 'B14', '2201', 'MECHANICAL', '2201 Screening', 'X-M1', 'Supply fan motor', 'MTR', 'X-AHU-9', 'VF_MECH_FAN'],
      ['E-4', 'B1', 'B14', '2201', 'MECHANICAL', '2201 Screening', 'X-M2', 'Supply fan motor', 'MTR', 'X-AHU-9', 'VF_MECH_PUMP'],
      ['E-5', 'B1', 'B14', '241', 'UPW', '241 UPW Makeup', 'X-BAD', 'Makeup pump', 'PMP', '241 UPW Makeup', 'CA_NB_EL_MV_GEAR'],
      // role-teaching rows: TT is a child-only class (>=10 sightings) that
      // conventionally nests under AHU-class equipment (affinity >= 3)
      ...Array.from({ length: 10 }, (_, i) =>
        ['E-T' + i, 'B1', 'B14', '2201', 'MECHANICAL', '2201 Screening', 'X-TT-' + i, 'Temperature transmitter', 'TT', 'X-AHU-9', 'VF_I&C_TRANSMITTER']),
      ['E-6', 'B1', 'B14', '266', 'WASTE', '266 HFW Treatment', 'X-BLANK', 'Isolation valve', 'XV', '266 HFW Treatment', 'VF_Blank'],
    ],
  },
  'compiler-imtemplate.xlsx': {
    'VF POR Item Masters': [
      ['Site', 'Discipline', 'IM Name', 'Use Case(s)'],
      ['VF', 'I&C', 'VF_IC_RIO', 'Remote IO panels'],
      ['VF', 'MECH', 'VF_MECH_AHU', 'Air handlers'],
      ['VF', 'MECH', 'VF_MECH_FAN', 'Fans'],
      ['VF', 'MECH', 'VF_MECH_PUMP', 'Pumps'],
    ],
  },
  'compiler-wc.xlsx': {
    SSM: [
      ['Equipment ID', 'Closest Parent', 'Dependencies'],
      ['B14-RIO-6500', 'B14-LVS-1234', 'B14-XFM-9999'],
      ['GONE-1', 'B14-LVS-1234', ''],
    ],
  },
  'compiler-linelist.xlsx': {
    Line_List: [
      ['Line ID', 'UPN', 'Service'],
      ['2201-SCW-L2-M1-1001', '2201', 'Screening chilled water'],
      ['2201-SCW-L2-M1-1002', '2201', 'Screening chilled water'],
      ['650-FMS-TRAY-01', '650', 'FMS cable tray'],
    ],
  },
  'compiler-p6.xlsx': {
    Activities: [
      ['Activity ID', 'Activity Name', 'Equipment ID', 'UPN'],
      ['A2000', 'Commission RIO 6500 remote IO', 'B14-RIO-6500', '650'],
      ['A2010', 'Terminate FMS network trunk', '', '650'],
    ],
  },
  'compiler-cable.xlsx': {
    'Cable Schedule': [
      ['Load Name (To)', 'Panel (From)', 'Circuit_Number', 'Cable Tag'],
      ['B14-RIO-6500', 'B14-LVS-1234', '7', 'C-9001'],
      ['MTR-9001', 'B14-AHU-7001', '8', 'C-9002'],
      ['DDC-7301', 'B14-LVS-1234', '9', 'C-9003'],
    ],
  },
  'pmd.xlsx': {
    'INSTALL PMD': [
      ['PANEL', 'INSTRUMENT TAG', 'CARD', 'POINT TYPE', 'DESCRIPTION'],
      ['MTR-9001', 'PT-0001', 'C1', 'AI', 'Pressure transmitter'],
      ['MTR-9001', 'TT-0002', 'C1', 'AI', 'Temperature transmitter'],
    ],
  },
  'easy-power-pmd-variants.xlsx': {
    EasyPower: [
      ['Starting Source', 'Downstream1', 'Final Source', 'ID Name', 'Load Description'],
      ['GIS-01', 'MCC-1_NPS', 'MCC-1_NPS', '', 'RIO-1_NPS'],
      ['GIS-01', 'MCC-1_CPS', 'MCC-1_CPS', '', 'RIO-1_CPS'],
    ],
  },
  'pmd-building-prefix.xlsx': {
    'INSTALL PMD': [
      ['PANEL', 'INSTRUMENT TAG', 'CARD', 'POINT TYPE', 'DESCRIPTION'],
      ['OO44-RIO-1', 'OO44-TET-100', 'C1', 'AI', 'Temperature element'],
      ['OO44-RIO-1', 'OO44-TIV-200', 'C1', 'DI', 'Temperature indication'],
    ],
  },
  'working-copy.xlsx': {
    SSM: [
      ['Equipment ID', 'Closest Parent', 'Dependencies'],
      ['B14-XFM-1234', 'GIS-01', 'N/A'],            // match
      ['B14-LVS-1234', 'B14-XFM-1234', 'N/A'],      // match
      ['MTR-9001', 'B14-LVS-1234 [existing]', 'B14-LVS-1234'], // match through the "[…]" suffix strip
      ['MTR-9003', 'B14-LVS-5678', ''],             // match via isAcceptedMissingWorkingDependency
      ['SPARE-1', 'B14-LVS-5678', 'B14-LVS-9999'],  // off on the dependency only
      ['B14-LVS-5678', 'WRONG-PARENT', 'N/A'],      // off on the parent
      ['GONE-FROM-EXTRACT', 'B14-LVS-1234', 'N/A'], // nohit, working copy only
    ],
  },
  // Site-convention fixtures. Kept separate from easy-power.xlsx so a parity failure
  // points at the rule under test instead of at every scenario at once.
  'easy-power-rules.xlsx': {
    EasyPower: [
      ['Starting Source', 'Downstream1', 'Downstream2', 'Final Source', 'ID Name', 'Load Description', 'Circuit #'],
      // cable-derived parent that anchors straight onto an existing branch
      ['GIS-02', 'B14-XFM-4001', 'B14-LVS-4001', 'B14-LVS-4001', '', 'MTR-4100', '10'],
      ['GIS-02', 'B14-XFM-4002', 'B14-LVS-4002', 'B14-LVS-4002', '', 'MTR-4200', '11'],
      // cable chain that needs one synthetic ancestor before it anchors
      ['GIS-02', 'B14-XFM-4003', 'B14-LVS-4003', 'B14-LVS-4003', '', 'MTR-4300', '12'],
      // cable chain that never reaches the hierarchy
      ['GIS-02', 'B14-XFM-4005', 'B14-LVS-4005', 'B14-LVS-4005', '', 'MTR-4500', '13'],
      // cable chain that loops back on itself
      ['GIS-02', 'B14-XFM-4006', 'B14-LVS-4006', 'B14-LVS-4006', '', 'MTR-4600', '14'],
      // second top-level branch, detached by enforceSystemRoots
      ['B14-SWG-9100', 'B14-PNL-9101', '', 'B14-PNL-9101', '', '', '21'],
      // cleanTag suffix stripping: -S, the -B-OUTPUT chain, and -P
      ['GIS-02', 'B14-XFM-4007-S', 'B14-PNL-0800-B-OUTPUT', 'B14-PNL-0800-B-OUTPUT', '', 'MTR-4700-P', '22'],
      // isSpaceName
      ['GIS-02', 'B14-XFM-4002', 'B14-LVS-4002', 'B14-LVS-4002', '', 'SPACE-2', '23'],
      // melTransformerDecision -> suggested (exactly one MEL candidate)
      ['GIS-02', 'B14-XFM-5001', 'B14-LVS-5002', 'B14-LVS-5002', '', '', '30'],
      // stripPowerVariant (_CPS) feeding the same suffix match
      ['GIS-02', 'B14-XFM-5003', 'B14-LVS-5004_CPS', 'B14-LVS-5004_CPS', '', '', '31'],
      // melTransformerDecision -> unplaced (no MEL candidate)
      ['GIS-02', 'B14-XFM-5005', 'B14-LVS-6009', 'B14-LVS-6009', '', '', '32'],
      // melTransformerDecision -> unplaced (two MEL candidates share the suffix)
      ['GIS-02', 'B70-XFM-5006', 'B70-LVS-7777', 'B70-LVS-7777', '', '', '33'],
      // melCimParent
      ['GIS-02', 'B14-CIM-0001', '', 'B14-CIM-0001', '', '', '34'],
      // melScrSccParent with a building-unit parent distinct from the tag
      ['GIS-02', 'B14-SCR-3300_SEC2', 'B14-PNL-3301', 'B14-PNL-3301', '', '', '35'],
      // mahClosestParent
      ['GIS-02', 'B14-MAH-01_SEC1', 'B14-PNL-0700', 'B14-PNL-0700', '', '', '36'],
    ],
  },
  /* Case-variant tags. Deliberately NOT a golden scenario -- it exists to pin
     one specific inconsistency: the tree keyed children by the raw string while
     the register deduped by tagKey (case-insensitive), so the same equipment
     spelled two ways became two tree nodes but one register row. */
  'case-variants.xlsx': {
    EasyPower: [
      ['Starting Source', 'Downstream1', 'Downstream2', 'Final Source', 'ID Name', 'Load Description', 'Circuit #'],
      ['GIS-01', 'B14-XFM-1234', 'MCC-1', 'MCC-1', '', 'MTR-1', '10'],
      ['GIS-01', 'B14-XFM-1234', 'mcc-1', 'mcc-1', '', 'MTR-2', '11'],
      ['GIS-01', 'B14-XFM-1234', 'McC-1', 'McC-1', '', 'MTR-3', '12'],
    ],
  },
  /* One equipment tag claimed by two different parents. Not a golden scenario:
     it pins that uniqueSsmRows' first-wins drop is surfaced rather than silent. */
  'duplicate-parents.xlsx': {
    EasyPower: [
      ['Starting Source', 'Downstream1', 'Downstream2', 'Final Source', 'ID Name', 'Load Description', 'Circuit #'],
      ['GIS-01', 'B14-XFM-1111', 'PNL-9', 'PNL-9', '', 'MTR-A', '10'],
      ['GIS-01', 'B14-XFM-2222', 'PNL-9', 'PNL-9', '', 'MTR-B', '11'],
      // a tag that is a Starting Source in one row and downstream in another is
      // NOT a conflict -- the empty parent is the top of its own path
      ['B14-XFM-1111', 'PNL-8', '', 'PNL-8', '', 'MTR-C', '12'],
    ],
  },
  /* A blank downstream column with a populated one AFTER it. Not a golden
     scenario: it pins that the later level is kept rather than truncated away.
     Needs three downstream columns -- with two, a blank can only ever be
     trailing, which is the case that was always handled correctly. */
  'downstream-gap.xlsx': {
    EasyPower: [
      ['Starting Source', 'Downstream1', 'Downstream2', 'Downstream3', 'Downstream4', 'Downstream5', 'Final Source', 'ID Name', 'Load Description', 'Circuit #'],
      // interior gap: PNL-7 sits after a blank level
      ['GIS-01', 'B14-XFM-3333', '', 'PNL-7', '', '', 'PNL-7', '', 'MTR-D', '13'],
      // TWO gaps in one row: every bridged edge is created, so every one must be reported
      ['GIS-01', 'B14-XFM-5555', '', 'PNL-5', '', 'PNL-6', 'PNL-6', '', 'MTR-F', '15'],
      // trailing blank only: the ordinary shape, must NOT be reported as a gap
      ['GIS-01', 'B14-XFM-4444', 'B14-LVS-4444', '', '', '', 'B14-LVS-4444', '', 'MTR-E', '14'],
    ],
  },
  'cable-schedule-rules.xlsx': {
    'Cable Schedule': [
      ['Load Name (To)', 'Panel (From)', 'Circuit_Number', 'Cable Tag'],
      ['MTR-4100', 'B14-LVS-4002', '10', 'C-4100'],
      ['MTR-4300', 'B14-DP-4400', '12', 'C-4300'],
      ['B14-DP-4400', 'B14-LVS-4002', '1', 'C-4400'],
      ['MTR-4500', 'B99-UNKNOWN-DP', '13', 'C-4500'],
      ['MTR-4600', 'B14-TIE-4600', '14', 'C-4600'],
      ['B14-TIE-4600', 'MTR-4600', '2', 'C-4601'],
    ],
  },
  'mel-rules.xlsx': {
    Equipment_List: [
      ['Equipment Tag', 'UPN', 'Bldg', 'System Parent Equipment Tag'],
      ['B14-XFM-5002', 'UPN-5002', 'B14', ''],
      ['B14-XFM-5004', 'UPN-5004', 'B14', ''],
      ['B14-XFM-7777', 'UPN-7777', 'B14', ''],
      ['B22-XFM-7777', 'UPN-7778', 'B22', ''],
      ['B14-CIM-0001', 'UPN-CIM1', 'B14', ''],
      ['B14-SCR-3300_SEC2', 'UPN-3300', 'B14', ''],
    ],
  },
  // Performance-budget fixture (tests/perf.test.mjs). 20,000 rows to exercise
  // the app at the scale it's designed for. No golden snapshot — see perf.test.mjs.
  'large.xlsx': {
    EasyPower: [
      ['Starting Source', 'Downstream1', 'Downstream2', 'Final Source', 'ID Name', 'Load Description', 'Circuit #'],
      ...Array.from({ length: 20000 }, (_, i) => {
        const b = 100 + (i % 40), u = 1000 + (i % 500)
        return [`GIS-0${1 + (i % 3)}`, `B${b}-XFM-${u}`, `B${b}-LVS-${u}`, `B${b}-LVS-${u}`, '', `MTR-${10000 + i}`, String(i % 42)]
      }),
    ],
  },
}

mkdirSync(fixturesDir, { recursive: true })

for (const [file, sheets] of Object.entries(SHEETS)) {
  const wb = XLSX.utils.book_new()
  for (const [name, aoa] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), name)
  }
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
  writeFileSync(resolve(fixturesDir, file), Buffer.from(out))
  console.log('wrote', file)
}
