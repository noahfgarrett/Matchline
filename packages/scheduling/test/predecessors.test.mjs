import assert from 'node:assert/strict';
import test from 'node:test';

import { readMappedTable } from '@matchline/spreadsheet-import';

import {
  buildPredecessorMatrix,
  DEFAULT_PREDECESSOR_SHEET_NAME,
  PREDECESSOR_HEADERS,
  PREDECESSOR_SEPARATOR,
  writePredecessorWorkbook,
} from '../dist/index.js';
import {
  CYCLE_ASSETS,
  CYCLE_SNAPSHOT,
  DRAGON_ASSETS,
  DRAGON_SNAPSHOT,
  LEADING_ZERO_ASSETS,
  LEADING_ZERO_SNAPSHOT,
  snapshotOf,
} from './dist/dragon.fixture.js';
import { readSheet, reorder } from './support.mjs';

test('a demoted dependency makes the upstream system a predecessor of the downstream one', () => {
  // PRODUCT.md §2.5: the panel in 603 fed the RIO in 650, the fold demoted it.
  const matrix = buildPredecessorMatrix(DRAGON_SNAPSHOT, DRAGON_ASSETS);

  assert.deepEqual(matrix.rows, [
    { systemKey: '603', predecessorSystemKeys: [] },
    { systemKey: '650', predecessorSystemKeys: ['603'] },
    { systemKey: '777', predecessorSystemKeys: [] },
    { systemKey: '900', predecessorSystemKeys: [] },
    { systemKey: '2201', predecessorSystemKeys: ['603'] },
  ]);
});

test('every edge names the asset relations that stated it', () => {
  const matrix = buildPredecessorMatrix(DRAGON_SNAPSHOT, DRAGON_ASSETS);

  assert.deepEqual(matrix.edges, [
    {
      from: '603',
      to: '650',
      evidence: [{ fromTag: 'PNL603-10-01', toTag: 'RIO650-30-01', kind: 'dependency' }],
    },
    {
      from: '603',
      to: '2201',
      evidence: [{ fromTag: 'PNL603-10-01', toTag: 'MAH2201-20-01', kind: 'dependency' }],
    },
  ]);
});

test('a Kahn sort turns the edges into a startup order', () => {
  const matrix = buildPredecessorMatrix(DRAGON_SNAPSHOT, DRAGON_ASSETS);

  assert.deepEqual(matrix.order, ['603', '650', '777', '900', '2201']);
  assert.deepEqual(matrix.cycles, []);
  assert.ok(matrix.order.indexOf('603') < matrix.order.indexOf('650'));
  assert.ok(matrix.order.indexOf('603') < matrix.order.indexOf('2201'));
});

test('a cross-system flow edge orders systems the snapshot never linked', () => {
  const assets = DRAGON_ASSETS.filter((asset) =>
    ['asset-0030', 'asset-0040'].includes(asset.assetId),
  );
  const bare = buildPredecessorMatrix(snapshotOf([]), assets);
  assert.deepEqual(bare.rows, [
    { systemKey: '777', predecessorSystemKeys: [] },
    { systemKey: '900', predecessorSystemKeys: [] },
  ]);

  const withFlow = buildPredecessorMatrix(snapshotOf([]), assets, {
    flowEdges: [{ fromAssetId: 'asset-0040', toAssetId: 'asset-0030' }],
  });
  assert.deepEqual(withFlow.rows, [
    { systemKey: '777', predecessorSystemKeys: ['900'] },
    { systemKey: '900', predecessorSystemKeys: [] },
  ]);
  assert.deepEqual(withFlow.edges[0].evidence, [
    { fromTag: 'DDC900-50-01', toTag: 'PIT777-40-01', kind: 'flow' },
  ]);
});

test('a relation inside one system is not an edge — a system does not precede itself', () => {
  const assets = DRAGON_ASSETS.filter((asset) => asset.systemKey === '603');
  const matrix = buildPredecessorMatrix(DRAGON_SNAPSHOT, assets, {
    flowEdges: [{ fromAssetId: 'asset-0001', toAssetId: 'asset-0004' }],
  });

  assert.deepEqual(matrix.edges, []);
  assert.deepEqual(matrix.rows, [{ systemKey: '603', predecessorSystemKeys: [] }]);
});

test('systems the sort cannot place are reported as a cycle, not broken silently', () => {
  const matrix = buildPredecessorMatrix(CYCLE_SNAPSHOT, CYCLE_ASSETS);

  assert.deepEqual(matrix.order, []);
  assert.deepEqual(matrix.cycles, ['110', '120']);
  assert.deepEqual(matrix.rows, [
    { systemKey: '110', predecessorSystemKeys: ['120'] },
    { systemKey: '120', predecessorSystemKeys: ['110'] },
  ]);
});

test('leading zeros are preserved: 001 and 1 are two systems', () => {
  const matrix = buildPredecessorMatrix(LEADING_ZERO_SNAPSHOT, LEADING_ZERO_ASSETS);

  assert.deepEqual(matrix.rows, [
    { systemKey: '001', predecessorSystemKeys: [] },
    { systemKey: '1', predecessorSystemKeys: ['001'] },
  ]);
});

test('an asset with no resolved system takes part in nothing', () => {
  const matrix = buildPredecessorMatrix(DRAGON_SNAPSHOT, [
    { assetId: 'asset-0003', canonicalTag: 'PNL603-10-01', systemKey: '603' },
    { assetId: 'asset-0020', canonicalTag: 'RIO650-30-01' },
  ]);

  assert.deepEqual(matrix.rows, [{ systemKey: '603', predecessorSystemKeys: [] }]);
  assert.deepEqual(matrix.edges, []);
});

test('the matrix is deterministic under a reordered asset list', () => {
  const straight = buildPredecessorMatrix(DRAGON_SNAPSHOT, DRAGON_ASSETS);
  const shuffled = buildPredecessorMatrix(DRAGON_SNAPSHOT, reorder([...DRAGON_ASSETS]));

  assert.deepEqual(shuffled.rows, straight.rows);
  assert.deepEqual(shuffled.order, straight.order);
  assert.deepEqual(
    shuffled.edges.map((edge) => [edge.from, edge.to]),
    straight.edges.map((edge) => [edge.from, edge.to]),
  );
});

test('empty inputs produce an empty matrix', () => {
  const matrix = buildPredecessorMatrix(snapshotOf([]), []);

  assert.deepEqual(matrix, { rows: [], edges: [], order: [], cycles: [] });
});

test('the workbook round-trips, with system keys still text', () => {
  const matrix = buildPredecessorMatrix(DRAGON_SNAPSHOT, DRAGON_ASSETS);
  const aoa = readSheet(writePredecessorWorkbook(matrix), DEFAULT_PREDECESSOR_SHEET_NAME);

  assert.deepEqual(aoa[0], [...PREDECESSOR_HEADERS]);
  const table = readMappedTable(
    aoa,
    { systemKey: 'System Key', predecessors: 'Predecessor System Keys' },
    { headerRow: 0 },
  );
  assert.deepEqual(
    table.rows.map((row) => ({
      systemKey: row.systemKey,
      predecessorSystemKeys: row.predecessors === '' ? [] : row.predecessors.split(PREDECESSOR_SEPARATOR),
    })),
    matrix.rows,
  );
});

test('a leading-zero system survives the workbook as text', () => {
  const matrix = buildPredecessorMatrix(LEADING_ZERO_SNAPSHOT, LEADING_ZERO_ASSETS);
  const aoa = readSheet(writePredecessorWorkbook(matrix), DEFAULT_PREDECESSOR_SHEET_NAME);

  assert.deepEqual(aoa, [
    ['System Key', 'Predecessor System Keys'],
    ['001', ''],
    ['1', '001'],
  ]);
});

test('the workbook is byte-stable and its sheet name is configurable', () => {
  const matrix = buildPredecessorMatrix(DRAGON_SNAPSHOT, DRAGON_ASSETS);

  assert.deepEqual(writePredecessorWorkbook(matrix), writePredecessorWorkbook(matrix));

  const named = writePredecessorWorkbook(matrix, { sheetName: 'UPN Predecessors' });
  assert.equal(readSheet(named, 'UPN Predecessors').length, matrix.rows.length + 1);
});

test('an empty matrix still writes a workbook Excel can open', () => {
  const bytes = writePredecessorWorkbook(buildPredecessorMatrix(snapshotOf([]), []));

  assert.deepEqual(readSheet(bytes, DEFAULT_PREDECESSOR_SHEET_NAME), [[...PREDECESSOR_HEADERS]]);
});
