/**
 * Invented Dragon-site connectivity workbooks, built through
 * `@matchline/spreadsheet-import`'s write path.
 *
 * Nothing here is a checked-in binary: every workbook is generated from an
 * array of arrays at run time, so a fixture can never drift from the code that
 * reads it. The same AoAs are used two ways — handed straight to an importer,
 * and written to .xlsx and read back — and they are deliberately free of
 * fully-blank rows so both routes yield identical row numbering. The one
 * fixture that *does* have a blank row ({@link DRAGON_GAP_PMD_AOA}) exists to
 * pin the opposite case.
 *
 * The Dragon site: a kiln hall (`DGN-GIS-01` incoming switchgear) feeding air
 * handlers `MAH001-*`, a panelboard `EPB002-01-01`, a drive `VFD001-10-01`, a
 * controls PLC `PLC001-10-01`, and kiln transmitters `TIT603-*`.
 */

import { writeWorkbook } from '../../spreadsheet-import/dist/index.js'

/* ---- EasyPower ---- */

/**
 * A power study with a title banner above its headers.
 *
 * Header row 1. Seven data rows, hand-counted:
 *   rows 2, 3, 7, 8 → observations (row 7 repeats row 2's pair; row 8 needs trimming)
 *   row 4 → missing-from, row 5 → missing-to, row 6 → self-loop
 */
export const DRAGON_EASYPOWER_AOA = [
  ['Dragon Site — Power Study', '', '', '', '', ''],
  ['Starting Source', 'Downstream1', 'Final Source', 'ID Name', 'Load Description', 'Circuit #'],
  ['DGN-GIS-01', 'EPB002-01-01', 'EPB002-01-01', 'MAH001-10-01', 'Primary AHU', '12'],
  ['DGN-GIS-01', 'EPB002-01-01', 'EPB002-01-01', 'MAH001-10-02', 'Secondary AHU', '14'],
  ['', 'EPB002-01-01', 'EPB002-01-01', 'TIT603-10-01', 'Kiln transmitter', '16'],
  ['DGN-GIS-01', 'EPB002-01-01', 'EPB002-01-01', '', 'Unnamed spare', '18'],
  ['VFD001-10-01', 'VFD001-10-01', 'VFD001-10-01', 'VFD001-10-01', 'Drive loopback', '20'],
  ['DGN-GIS-01', 'EPB002-01-01', 'EPB002-01-01', 'MAH001-10-01', 'Primary AHU', '22'],
  ['  DGN-GIS-01  ', 'EPB002-01-01', 'EPB002-01-01', '  PLC001-10-01 ', 'Controls PLC', '24'],
]

export const DRAGON_EASYPOWER_HEADER_ROW = 1
export const DRAGON_EASYPOWER_MAPPING = { source: 0, load: 3 }

/* ---- Cable Schedule ---- */

/**
 * Header row 0. Six data rows:
 *   rows 1, 2, 6 → observations (1 and 2 are a parallel run: same pair, two cables)
 *   row 3 → missing-to, row 4 → missing-from, row 5 → self-loop
 *   row 6 → no cable tag, so no `via`
 */
export const DRAGON_CABLE_AOA = [
  ['Load Name (To)', 'Panel (From)', 'Circuit_Number', 'Cable Tag'],
  ['MAH001-10-01', 'EPB002-01-01', '12', 'DGN-C-0001'],
  ['MAH001-10-01', 'EPB002-01-01', '13', 'DGN-C-0002'],
  ['', 'EPB002-01-01', '14', 'DGN-C-0003'],
  ['TIT603-10-01', '', '15', 'DGN-C-0004'],
  ['EPB002-01-01', 'EPB002-01-01', '16', 'DGN-C-0005'],
  ['VFD001-10-01', 'EPB002-01-01', '17', ''],
]

export const DRAGON_CABLE_HEADER_ROW = 0
export const DRAGON_CABLE_MAPPING = { from: 1, to: 0, cableTag: 3 }

/* ---- PMD ---- */

/**
 * Header row 0. Six data rows:
 *   rows 1, 2, 6 → observations (row 6 repeats row 1's pair on another card)
 *   row 3 → missing-to, row 4 → missing-from, row 5 → self-loop
 */
export const DRAGON_PMD_AOA = [
  ['PANEL', 'INSTRUMENT TAG', 'CARD', 'POINT TYPE', 'DESCRIPTION'],
  ['PLC001-10-01', 'TIT603-10-01', 'C1', 'AI', 'Kiln zone 1 temperature'],
  ['PLC001-10-01', 'TIT603-10-02', 'C1', 'AI', 'Kiln zone 2 temperature'],
  ['PLC001-10-01', '', 'C2', 'AI', 'Unassigned point'],
  ['', 'TIT603-10-03', 'C2', 'DI', 'Point with no panel'],
  ['PLC001-10-01', 'PLC001-10-01', 'C3', 'DI', 'Panel self test'],
  ['PLC001-10-01', 'TIT603-10-01', 'C4', 'AI', 'Redundant zone 1 point'],
]

export const DRAGON_PMD_HEADER_ROW = 0
export const DRAGON_PMD_MAPPING = { panel: 0, instrument: 1 }

/* ---- MEL and a tab that is neither ---- */

/** Recognized as a MEL, never imported here: a MEL carries identity, not connectivity. */
export const DRAGON_MEL_AOA = [
  ['Equipment Tag', 'UPN', 'Bldg', 'System Parent Equipment Tag', 'Discipline', 'System Description'],
  ['MAH001-10-01', '001', 'D-100', '', 'MECH', 'Dragon Air Handling'],
  ['EPB002-01-01', '002', 'D-200', '', 'ELEC', 'Dragon Power Distribution'],
]

export const DRAGON_NOTES_AOA = [
  ['Note', 'Author'],
  ['Kiln commissioning walkdown pending', 'D. Reyes'],
]

/**
 * A PMD tab whose third worksheet row holds no cells at all. `sheetAoa` drops
 * it, so AoA index 2 is worksheet row 3 — which is what `rowNums` is for.
 */
export const DRAGON_GAP_PMD_AOA = [
  ['PANEL', 'INSTRUMENT TAG'],
  ['PLC001-10-01', 'TIT603-10-01'],
  [null, null],
  ['PLC001-10-01', 'TIT603-10-02'],
]

/* ---- workbooks ---- */

/** The five-tab project workbook a Dragon engineer would drop on Screen 1. */
export function dragonWorkbookBytes() {
  return writeWorkbook([
    { name: 'EasyPower', aoa: DRAGON_EASYPOWER_AOA },
    { name: 'Cable Schedule', aoa: DRAGON_CABLE_AOA },
    { name: 'INSTALL PMD', aoa: DRAGON_PMD_AOA },
    { name: 'Equipment_List', aoa: DRAGON_MEL_AOA },
    { name: 'Notes', aoa: DRAGON_NOTES_AOA },
  ])
}

/** A one-tab workbook holding {@link DRAGON_GAP_PMD_AOA}. */
export function dragonGapWorkbookBytes() {
  return writeWorkbook([{ name: 'Points', aoa: DRAGON_GAP_PMD_AOA }])
}

/** A one-tab workbook with a caller-supplied sheet name and AoA. */
export function sheetBytes(name, aoa) {
  return writeWorkbook([{ name, aoa }])
}

/** The `ObservationSource` a literal-AoA test uses: index `i` is row `i`. */
export function literalSource(sheet) {
  return { sourceFile: 'dragon-connectivity.xlsx', sheet }
}
