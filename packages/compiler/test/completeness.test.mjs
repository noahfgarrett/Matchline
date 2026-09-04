/**
 * The completeness report (audit blocker B3).
 *
 * The failure it exists for, reproduced first: the shipped default profile
 * enables Building and System as hard boundaries, maps no building property and
 * configures no resolver, so every asset roots under `(unassigned)`, the compile
 * succeeds and nothing says "0 of 34 assets are nested". These tests are the
 * numbers that now say it.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { writeWorkbook } from '@matchline/spreadsheet-import';

import { compileProject } from '../dist/index.js';
import {
  fullInput,
  idOf,
  melWorkbook,
  MEL_MAPPING,
  MEL_SOURCE_FILE,
  oneSource,
  openDragonCache,
  siteProfile,
} from './support.mjs';

let handle = null;

before(() => {
  handle = openDragonCache('completeness');
});

after(() => {
  handle?.close();
});

/**
 * The wizard's shipped default, near enough to reproduce B3.
 *
 * Building and System are hard boundaries; nothing maps a building property and
 * no resolver is configured, which is exactly what a Revit-shaped model taken
 * through Quick Setup produces.
 */
const DEFAULT_PROFILE_HIERARCHY = {
  levels: [
    {
      levelId: 'building',
      displayName: 'Building',
      attributeKey: 'building',
      boundary: true,
      missingValuePolicy: 'unassigned-group',
      sort: 'label',
    },
    {
      levelId: 'ssm-discipline',
      displayName: 'SSM Discipline',
      attributeKey: 'ssmDiscipline',
      boundary: false,
      missingValuePolicy: 'unassigned-group',
      sort: 'label',
    },
    {
      levelId: 'system',
      displayName: 'System',
      attributeKey: 'systemKey',
      displayAttributeKey: 'systemLabel',
      boundary: true,
      missingValuePolicy: 'unassigned-group',
      sort: 'key',
    },
  ],
};

/** Dragon compiled under a profile that has been taught nothing. */
function emptyProfileCompile() {
  const profile = siteProfile({
    // No building property, no discipline property: a mapping with only the tag,
    // which is the least a compile can run on.
    propertyMappings: { equipmentTag: { category: 'Dragon Data', name: 'Tag' } },
    hierarchy: DEFAULT_PROFILE_HIERARCHY,
    roleGraph: { rules: [] },
  });
  const { systemResolver: _dropped, tagAnatomy: _alsoDropped, ...rest } = profile;
  return compileProject({ sources: oneSource(handle.cache), profile: rest });
}

test('an empty default profile nests nothing, and the report says so', () => {
  const project = emptyProfileCompile();
  const report = project.completeness;

  assert.equal(report.assetCount, project.catalog.assets.length);
  assert.equal(report.assetsNested, 0, 'the tree is flat');
  assert.equal(
    report.assetsRooted,
    report.assetCount,
    'every asset is a root, which is the fact the summary never stated',
  );
  // Nobody proposed a parent for anything: no role graph, no connectivity, no
  // model tree ancestry between tagged assets.
  assert.equal(report.assetsWithNoParentCandidate, report.assetCount);
});

test('every enabled boundary reports 100% of the site with no value', () => {
  const report = emptyProfileCompile().completeness;

  const byLevel = new Map(report.levels.map((level) => [level.levelId, level]));
  for (const levelId of ['building', 'system']) {
    const level = byLevel.get(levelId);
    assert.equal(level.boundary, true);
    assert.equal(
      level.assetsWithoutValue,
      report.assetCount,
      `${levelId} has no value on any asset`,
    );
    assert.equal(level.blocksNesting, true, 'and at a boundary that stops every nesting');
  }

  // The grouping-only level is measured too, and says it costs nothing.
  const discipline = byLevel.get('ssm-discipline');
  assert.equal(discipline.boundary, false);
  assert.equal(discipline.blocksNesting, false);
});

test('an unresolved system is a counted queue row, not just a number', () => {
  const project = emptyProfileCompile();

  assert.equal(project.completeness.assetsWithoutSystem, project.completeness.assetCount);
  const [group] = project.completeness.unresolvedSystemBySkipReason;
  assert.equal(group.assetCount, project.completeness.assetCount);

  const item = project.reviewItems.find((candidate) => candidate.kind === 'unresolved-system');
  assert.equal(item.assetCount, project.completeness.assetCount);
  assert.deepEqual(item.skipReasons, ['no system resolver rung produced a key']);
  assert.ok(item.exampleAssetIds.length > 0 && item.exampleAssetIds.length <= 10);
});

test('a configured Dragon compile reports what it actually nested', () => {
  const project = compileProject(fullInput(handle.cache));
  const report = project.completeness;

  assert.equal(report.assetCount, project.catalog.assets.length);
  assert.equal(report.assetsNested + report.assetsRooted, report.assetCount);
  assert.equal(report.assetsNested, project.stats.assetCount - project.stats.snapshot.rootCount);
  assert.equal(report.assetsWithoutSystem, 0, 'every Dragon asset resolves a system');
  assert.deepEqual(report.unresolvedSystemBySkipReason, []);

  // Every level states a value on every asset, so nothing here is blocking.
  for (const level of report.levels) {
    assert.equal(level.assetsWithoutValue, 0, `${level.levelId} is fully populated`);
    assert.equal(level.blocksNesting, false);
  }
});

test('the report is deterministic, like every other published stage', () => {
  const first = compileProject(fullInput(handle.cache));
  const second = compileProject(fullInput(handle.cache));
  assert.deepEqual(first.completeness, second.completeness);
});

test('MEL rows that say nothing at all are dropped, and counted', () => {
  const bytes = writeWorkbook([
    {
      name: 'MEL',
      aoa: [
        ['Equipment Tag', 'UPN', 'System Description'],
        ['MAH001-10-01', '001', 'Mechanical Dry Air Handling'],
        // Three rows the reader keeps and the catalog cannot use: no tag, no
        // key, no description. A mapping that names the wrong columns produces
        // a workbook of them, and until now they vanished uncounted.
        ['', '', ''],
        ['', '', ''],
        ['', '', ''],
      ],
    },
  ]);
  const project = compileProject({
    ...fullInput(handle.cache),
    melWorkbook: { ...melWorkbook(), bytes },
  });

  assert.equal(project.melRows.length, 1, 'only the row that states something');
  assert.equal(project.completeness.melRowsDropped, 0, 'a fully blank row is not a MEL row');
});

test('a row with a tag column nobody filled is dropped and counted', () => {
  // `readMelTable` drops a row whose every mapped cell is blank, so a counted
  // drop needs a row that states something the compile cannot use: here the
  // Equipment Tag column is mapped onto a header this sheet fills with a value
  // no other mapped column accompanies.
  const bytes = writeWorkbook([
    {
      name: 'MEL',
      aoa: [
        ['Equipment Tag', 'UPN', 'System Description', 'Notes'],
        ['MAH001-10-01', '001', 'Mechanical Dry Air Handling', ''],
        ['   ', '  ', '   ', 'still to be issued'],
      ],
    },
  ]);
  const project = compileProject({
    ...fullInput(handle.cache),
    melWorkbook: {
      bytes,
      sourceFile: MEL_SOURCE_FILE,
      sheetName: 'MEL',
      mapping: { ...MEL_MAPPING, description: 'Notes' },
      headerRow: 0,
    },
  });

  assert.equal(project.completeness.melRowsDropped, 1);
  assert.equal(project.melRows.length, 1);
});
