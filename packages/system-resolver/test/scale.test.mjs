/**
 * A guard on the shape of the curve, not on the clock.
 *
 * A `mel-lookup` by systemKey used to find its provenance row by scanning the
 * MEL once per subject, which made a compile cost subjects x MEL rows: a site
 * that doubles its model and its MEL pays four times, and the resolver became
 * the slowest thing in a large compile. Both MEL-side indexes are now built
 * once and shared, so the cost is subjects + rows.
 *
 * The bound below is deliberately loose in the direction that matters. On this
 * workload the indexed resolver lands around 65ms and the scan it replaced took
 * about 1.9 seconds, so the budget sits roughly 15x above the one and 2x below
 * the other. Nothing but a return to quadratic gets near it.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSystemCatalog, resolveSystems } from '../dist/index.js';

const SUBJECTS = 25_000;
const ROWS = 25_000;
const BUDGET_MS = 1_000;

const CONFIG = {
  keyChain: [{ kind: 'model-field', property: { category: 'Dragon', name: 'UPN' } }],
  descriptionChain: [{ kind: 'mel-lookup', joinBy: 'systemKey', returnField: 'systemDescription' }],
  normalization: [{ kind: 'padStart', length: 6, fill: '0' }],
  conflictPolicy: 'review',
};

function buildMel() {
  const rows = [];
  for (let i = 0; i < ROWS; i += 1) {
    rows.push({
      equipmentTag: `EQ${i}`,
      systemKey: String(i).padStart(6, '0'),
      systemDescription: `System ${i}`,
      sourceFile: 'Scale-MEL.xlsx',
      sheet: 'MEL',
      row: i + 2,
    });
  }
  return rows;
}

function buildSubjects() {
  const subjects = [];
  for (let i = 0; i < SUBJECTS; i += 1) {
    subjects.push({
      assetId: `scale-${i}`,
      canonicalTag: `EQ${i % ROWS}`,
      sourceFile: 'Scale-Model.nwd',
      // The model writes the key unpadded, so the join has to go through
      // normalization on both sides -- the realistic shape, not the easy one.
      properties: new Map([['Dragon', new Map([['UPN', String(i % ROWS)]])]]),
    });
  }
  return subjects;
}

test('a 25k-subject model against a 25k-row MEL does not pay per-subject for the MEL', () => {
  const melRows = buildMel();
  const subjects = buildSubjects();
  const { catalog } = buildSystemCatalog(melRows);

  const started = performance.now();
  const result = resolveSystems(subjects, CONFIG, { catalog, melRows });
  const elapsed = performance.now() - started;

  // The work actually happened: every subject found its system and its row.
  assert.equal(result.bySubject.size, SUBJECTS);
  const first = result.bySubject.get('scale-7');
  assert.equal(first.resolution.systemKey, '000007');
  assert.equal(first.resolution.systemDescription, 'System 7');
  assert.deepEqual(first.descriptionClaim.provenance.sourceRef, {
    kind: 'sheet-row',
    sheet: 'MEL',
    row: 9,
  });

  assert.ok(
    elapsed < BUDGET_MS,
    `resolving ${SUBJECTS} subjects against ${ROWS} MEL rows took ${elapsed.toFixed(0)}ms, budget ${BUDGET_MS}ms`,
  );
});
