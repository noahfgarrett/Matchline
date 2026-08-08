/**
 * The donor invariant, ported from `packages/legacy-parity/tests/aoa-dense.test.mjs`.
 *
 * The engine reads workbooks dense for speed; the sparse path stays for
 * anything that hands `sheetAoa` an address-keyed worksheet. The two must be
 * indistinguishable — every downstream stage consumes this output.
 *
 * The donor compares real fixture workbooks read both ways. We do that too
 * (against workbooks written by this package), and then go further: worksheet
 * objects built by hand cover the cell shapes a freshly-written .xlsx never
 * contains — holes in a dense row, formatting-only cells, cells carrying a
 * formula but no cached value.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { readWorkbook, sheetAoa, writeWorkbook } from '../dist/index.js'
import { DRAGON_MEL_AOA } from './support.mjs'

const MIXED_AOA = [
  ['Tag', 'Qty', 'Zeros', 'Blank'],
  ['MAH001-10-01', 12, '001', ''],
  ['', '', '', ''],
  ['EPB002-01-01', 0, '0007', 'x'],
]

test('dense and sparse worksheet scans produce identical AoA output', () => {
  const bytes = writeWorkbook([
    { name: 'MEL', aoa: DRAGON_MEL_AOA },
    { name: 'Mixed', aoa: MIXED_AOA },
  ])
  const dense = readWorkbook(bytes, { dense: true })
  const sparse = readWorkbook(bytes, { dense: false })

  assert.deepEqual(dense.sheetNames, ['MEL', 'Mixed'])
  for (const name of dense.sheetNames) {
    const fromDense = sheetAoa(dense.getSheet(name))
    const fromSparse = sheetAoa(sparse.getSheet(name))
    assert.equal(
      JSON.stringify(fromDense),
      JSON.stringify(fromSparse),
      `${name}: dense scan diverged from sparse`,
    )
    assert.ok(fromDense.aoa.length > 0, `${name}: fixture unexpectedly empty`)
  }
})

/* One worksheet, expressed both ways. Row 2 (index 1) is deliberately absent
   from the dense array entirely; row 3 holds a hole at column 0 and a
   formatting-only cell at column 1, both of which must be skipped. */
const HAND_CELLS = [
  { r: 0, c: 0, cell: { t: 's', v: 'Tag', w: 'Tag' } },
  { r: 0, c: 1, cell: { t: 's', v: 'Zeros', w: 'Zeros' } },
  { r: 0, c: 3, cell: { t: 's', v: 'Far', w: 'Far' } },
  { r: 2, c: 1, cell: { t: 's', v: '001', w: '001' } },
  { r: 2, c: 2, cell: { t: 'n', v: 1 } },
  { r: 3, c: 1, cell: { t: 'z' } },
  { r: 3, c: 2, cell: { t: 's', v: 'kept', w: 'kept' } },
]

const COLUMN_LETTERS = ['A', 'B', 'C', 'D', 'E']

function handBuiltSparse() {
  const worksheet = { '!ref': 'A1:D4', '!margins': { left: 0.7 }, '!cols': [{ wch: 12 }] }
  for (const { r, c, cell } of HAND_CELLS) worksheet[`${COLUMN_LETTERS[c]}${r + 1}`] = cell
  return worksheet
}

function handBuiltDense() {
  const worksheet = []
  for (const { r, c, cell } of HAND_CELLS) {
    if (!worksheet[r]) worksheet[r] = []
    worksheet[r][c] = cell
  }
  worksheet['!ref'] = 'A1:D4'
  worksheet['!margins'] = { left: 0.7 }
  worksheet['!cols'] = [{ wch: 12 }]
  return worksheet
}

test('hand-built dense and sparse worksheets scan identically', () => {
  const fromSparse = sheetAoa(handBuiltSparse())
  const fromDense = sheetAoa(handBuiltDense())
  assert.equal(JSON.stringify(fromDense), JSON.stringify(fromSparse))
})

test('the scan drops empty rows, keeps source row numbers, and pads to one width', () => {
  const { aoa, rowNums } = sheetAoa(handBuiltDense())
  /* Worksheet row 2 (index 1) held nothing and row 4 (index 3) held one real
     cell plus one formatting-only cell, so three rows survive. */
  assert.deepEqual(rowNums, [0, 2, 3])
  assert.deepEqual(aoa, [
    ['Tag', 'Zeros', '', 'Far'],
    ['', '001', '1', ''],
    ['', '', 'kept', ''],
  ])
})

test('a worksheet with no !ref scans to nothing', () => {
  assert.deepEqual(sheetAoa({}), { aoa: [], rowNums: [] })
  assert.deepEqual(sheetAoa(undefined), { aoa: [], rowNums: [] })
})

test('non-address keys are ignored on the sparse path', () => {
  const worksheet = handBuiltSparse()
  worksheet['!autofilter'] = { ref: 'A1:D1' }
  worksheet['AAAA1'] = { t: 's', v: 'four letters is not an address', w: 'no' }
  const scanned = sheetAoa(worksheet)
  assert.equal(JSON.stringify(scanned), JSON.stringify(sheetAoa(handBuiltDense())))
})
