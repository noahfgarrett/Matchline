/**
 * Invented Dragon-site workbooks, built through this package's own write path.
 *
 * Nothing here is a checked-in binary fixture: every test workbook is generated
 * from an array of arrays at run time, so a fixture can never drift from the
 * code that reads it, and the write path gets exercised on the way in.
 */

import { writeWorkbook } from '../dist/index.js'

/** A MEL-shaped sheet with two junk rows above the headers. */
export const DRAGON_MEL_AOA = [
  ['Dragon Site — Master Equipment List', '', '', '', '', ''],
  ['', '', '', '', '', ''],
  ['Equipment Tag', 'UPN', 'System Description', 'Building', 'Discipline', 'Description'],
  ['MAH001-10-01', '001', 'Dragon Air Handling', 'D-100', 'MECH', 'Primary AHU'],
  ['MAH001-10-02', '001', 'Dragon Air Handling', 'D-100', 'MECH', 'Secondary AHU'],
  ['', '', '', '', '', ''],
  ['EPB002-01-01', '002', 'Dragon Power Distribution', 'D-200', 'ELEC', 'Panelboard'],
  ['', '002', 'Dragon Power Distribution', 'D-200', 'ELEC', 'Tagless spare'],
]

/** Header row index of {@link DRAGON_MEL_AOA} within its sheet. */
export const DRAGON_MEL_HEADER_ROW = 2

/** The mapping a wizard would produce for {@link DRAGON_MEL_AOA}. */
export const DRAGON_MEL_MAPPING = {
  equipmentTag: 'Equipment Tag',
  upn: 'UPN',
  systemDescription: 'System Description',
  building: 'Building',
  discipline: 'Discipline',
  description: 'Description',
}

/** Bytes of a one-sheet workbook holding {@link DRAGON_MEL_AOA}. */
export function dragonMelBytes(sheetName = 'MEL') {
  return writeWorkbook([{ name: sheetName, aoa: DRAGON_MEL_AOA }])
}
