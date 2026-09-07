/**
 * The approved Exto spelling, on the way out.
 *
 * Exto validates five of the Rev21 columns against fixed dropdowns and refuses
 * an upload carrying anything outside one. A site that writes `medium voltage`
 * means the approved `Medium Voltage`, and the difference is a spelling rather
 * than a fact — so the sheet prints the spelling the template accepts, and says
 * how many cells it rewrote.
 *
 * A value that matches nothing is printed exactly as it arrived. This corrects
 * spellings; it does not correct data, and a site's own word for something is a
 * fact about the site rather than a typo.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXTO_DROPDOWN_FIELDS,
  buildExtoRows,
  countCanonicalizedCells,
} from '../dist/index.js';

/**
 * A stand-in for `extoRev21Canonical`, on the same contract.
 *
 * Deliberately not the real one. `@matchline/ssm-audit` vendors the approved
 * lists and already depends on this package, so this package cannot import it
 * without closing a cycle — which is exactly why `buildExtoRows` takes a
 * function instead of a vocabulary. What is under test here is the mechanism:
 * that an approved spelling replaces a matching one, that a non-match is left
 * alone, and that both are counted. The real vocabulary is checked where it is
 * used, in `@matchline/compiler` and the desktop's export path.
 *
 * The values below are genuinely the template's, and the contract is the
 * vendored function's: the approved spelling, or `''` when nothing matches.
 */
const APPROVED = {
  upn: ['101', '603'],
  discipline: ['MECHANICAL DRY', 'ELECTRICAL'],
  wbs: [],
  systemName: ['101  Cleanroom Makeup Air System'],
  equipmentClassification: ['Air Handling Unit'],
};

function norm(value) {
  return String(value ?? '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim().toUpperCase();
}

function canonicalize(field, value) {
  return (APPROVED[field] ?? []).find((approved) => norm(approved) === norm(value)) ?? '';
}

/** One asset that spells four approved values four wrong ways. */
const SHOUTING = {
  canonicalTag: 'MAH101-01',
  systemKey: '101',
  ssmDiscipline: 'mechanical   dry',
  equipmentClass: 'air handling unit',
  systemLabel: '101  cleanroom makeup air system',
};

function rowsFor(assets) {
  return buildExtoRows(assets, { canonicalize });
}

test('the five dropdown-backed columns are the five Exto validates', () => {
  assert.deepEqual(
    [...EXTO_DROPDOWN_FIELDS],
    ['upn', 'discipline', 'wbs', 'systemName', 'equipmentClassification'],
  );
});

test('a case- and space-insensitive match prints the approved spelling', () => {
  const [row] = rowsFor([SHOUTING]);

  assert.equal(row.discipline, 'MECHANICAL DRY');
  assert.equal(row.systemName, '101  Cleanroom Makeup Air System');
  assert.equal(row.equipmentClassification, 'Air Handling Unit');
  assert.equal(row.upn, '101', 'already approved, and unchanged');
});

test('the rewritten cells are named on the row, and counted for the export', () => {
  const rows = rowsFor([SHOUTING]);
  const [row] = rows;

  assert.deepEqual(
    row.canonicalizedFields,
    ['discipline', 'systemName', 'equipmentClassification'],
    'in column order, so two runs over one register agree',
  );
  assert.ok(!row.canonicalizedFields.includes('upn'), 'an unchanged cell is not a rewrite');
  assert.equal(countCanonicalizedCells(rows), 3);
});

test('a value the approved list has never heard of is printed verbatim', () => {
  const [row] = rowsFor([
    {
      canonicalTag: 'MAH001-10-01',
      systemKey: '001',
      ssmDiscipline: 'Chilled Water',
      systemLabel: '001 Mechanical Dry Air Handling',
    },
  ]);

  assert.equal(row.upn, '001', 'Dragon numbering is not the template’s, and it is not corrected');
  assert.equal(row.discipline, 'Chilled Water');
  assert.equal(row.systemName, '001 Mechanical Dry Air Handling');
  assert.deepEqual(row.canonicalizedFields, []);
});

test('without a canonicaliser nothing is touched, and nothing is counted', () => {
  const rows = buildExtoRows([SHOUTING]);

  assert.equal(rows[0].discipline, 'mechanical   dry', 'verbatim is still the default');
  assert.deepEqual(rows[0].canonicalizedFields, []);
  assert.equal(countCanonicalizedCells(rows), 0);
});

test('a blank cell stays blank rather than becoming an approved value', () => {
  const [row] = rowsFor([{ canonicalTag: 'X-1' }]);

  for (const field of EXTO_DROPDOWN_FIELDS) {
    assert.equal(row[field], '', `${field} was never stated, and is not invented`);
  }
  assert.deepEqual(row.canonicalizedFields, []);
});

test('canonicalising is deterministic, which is what a byte-stable export needs', () => {
  assert.deepEqual(rowsFor([SHOUTING]), rowsFor([SHOUTING]));
});
