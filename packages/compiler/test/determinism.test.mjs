/**
 * Determinism (ENGINE.md binding rule 3) and the single review queue.
 *
 * "Same cache + same profile -> identical outputs, byte-stable exports" is the
 * one property that makes a compiled project reviewable: a diff between two
 * engineers' exports has to mean a real change, and a re-compile that shuffled
 * its own output would make every downstream diff noise.
 *
 * The two compiles below run over two *separately written* cache files in two
 * different temp directories, so a host path, a file handle or a clock leaking
 * into an output would show up here rather than being hidden by reusing one
 * handle.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { reviewKey } from '@matchline/ssm-compiler';

import { aggregateReviewItems, compileProject } from '../dist/index.js';
import { fullInput, idOf, openDragonCache } from './support.mjs';

/** The compiled project minus the one member `deepEqual` cannot compare well. */
function withoutWorkbookBytes(project) {
  return { ...project, generatedMel: { rows: project.generatedMel.rows } };
}

function compileOnce(label) {
  const handle = openDragonCache(label);
  try {
    return compileProject(fullInput(handle.cache));
  } finally {
    handle.close();
  }
}

test('two compiles over two independently written caches produce a deep-equal project', () => {
  const first = compileOnce('determinism-a');
  const second = compileOnce('determinism-b');

  // Maps, nested claims, provenance and every stat, compared structurally.
  assert.deepStrictEqual(withoutWorkbookBytes(first), withoutWorkbookBytes(second));
});

test('the generated MEL workbook is byte-identical across those two compiles', () => {
  const first = compileOnce('determinism-c');
  const second = compileOnce('determinism-d');

  assert.deepEqual(
    Buffer.from(first.generatedMel.workbookBytes),
    Buffer.from(second.generatedMel.workbookBytes),
    'a re-compile must write the same file, not merely an equivalent one',
  );
  assert.ok(first.generatedMel.workbookBytes.length > 0);
});

test('every published list is ordered by content, not by arrival', () => {
  const project = compileOnce('determinism-order');

  // Assets in catalog order; the subjects and compile subjects are built by
  // walking that same list, so the three stay aligned index for index.
  const assetIds = project.catalog.assets.map((asset) => asset.assetId);
  assert.deepEqual(
    project.subjects.map((subject) => subject.assetId),
    assetIds,
  );
  assert.deepEqual(
    project.compileSubjects.map((subject) => subject.assetId),
    assetIds,
  );

  // The snapshot is keyed in asset-id order, whatever order it was handed.
  const snapshotIds = [...project.snapshot.nodes.keys()];
  assert.deepEqual(snapshotIds, [...snapshotIds].sort());

  // Review items are in `reviewKey` order.
  const keys = project.reviewItems.map(reviewKey);
  assert.deepEqual(keys, [...keys].sort());
});

test('the review queue dedupes: one decision reported by two stages is one item', () => {
  const duplicate = {
    kind: 'duplicate-model-tag',
    canonicalTag: 'MAH001-10-01',
    objectIds: [4, 5],
  };
  const fuzzy = {
    kind: 'fuzzy-identity',
    evidenceTag: 'TIT603-1O-01',
    candidates: [{ assetId: idOf('TIT603-10-01'), distance: 1 }],
  };
  const missing = { kind: 'missing-boundary', assetId: idOf('PLC001-10-01'), levelId: 'building' };

  const merged = aggregateReviewItems([
    [duplicate, fuzzy],
    [{ ...duplicate }, missing],
    [{ ...fuzzy }],
  ]);

  assert.equal(merged.length, 3);
  assert.deepEqual(
    merged.map((item) => item.kind),
    ['duplicate-model-tag', 'fuzzy-identity', 'missing-boundary'],
  );

  // Group order cannot change the answer -- the merge sorts before it dedupes.
  const reordered = aggregateReviewItems([
    [missing],
    [{ ...fuzzy }, { ...duplicate }],
    [duplicate, fuzzy],
  ]);
  assert.deepEqual(reordered, merged);
});

test('a real compile publishes no two review items sharing a key', () => {
  const project = compileOnce('determinism-review');
  const keys = project.reviewItems.map(reviewKey);
  assert.equal(new Set(keys).size, keys.length);
});
