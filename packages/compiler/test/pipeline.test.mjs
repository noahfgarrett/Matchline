/**
 * One full compile of the Dragon project, asserted at every stage boundary.
 *
 * Every number below was worked out on paper from `support.mjs` before it was
 * written down. That is the point of the file: a compile that silently produced
 * one asset too few, or one claim too many, would still "work", and only a
 * hand-computed count catches it.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { compileProject, subjectPropertiesFor } from '../dist/index.js';
import {
  CONNECTIVITY_SOURCE_FILE,
  DRAGON_ANATOMY,
  FEED_ROOT_TAG,
  fullInput,
  FUZZY_PMD_TAG,
  HIERARCHY,
  idOf,
  MEL_SOURCE_FILE,
  oneSource,
  openDragonCache,
  PROPERTY_MAPPINGS,
  UNKNOWN_FEED_TAG,
  UNKNOWN_PMD_TAG,
} from './support.mjs';

let handle = null;
let project = null;

before(() => {
  handle = openDragonCache('pipeline');
  project = compileProject(fullInput(handle.cache));
});

after(() => {
  handle?.close();
});

test('stage 1: the asset catalog is the 34 tagged Dragon equipment objects, with no duplicate tags', () => {
  const { catalog, stats } = project;
  // 2 buildings x (MAH001 x6 + MAH002 x2 + TIT603 x4) mechanical
  //            + 2 buildings x (PLC001 x1 + VFD001 x4) controls.
  assert.equal(catalog.assets.length, 34);
  assert.equal(stats.assetCount, 34);
  assert.equal(stats.duplicateTagCount, 0);
  assert.deepEqual(catalog.reviewItems, []);

  const mah = catalog.assets.find((asset) => asset.canonicalTag === 'MAH001-10-01');
  assert.ok(mah);
  assert.equal(mah.assetId, idOf('MAH001-10-01'));
  assert.equal(mah.building, 'D1');
  assert.equal(mah.nativeDiscipline, 'Chilled Water');
  assert.equal(mah.status, 'MODEL_CONFIRMED');
});

test('stage 2: the property-bag seam hands the resolver every raw property, addressed by category and name', () => {
  const { catalog, subjects } = project;
  assert.equal(subjects.length, 34);

  const subject = subjects.find((candidate) => candidate.canonicalTag === 'MAH001-10-01');
  assert.ok(subject);
  // `Dragon Data > UPN` is on no `ModelAsset` field -- the profile never mapped
  // it to a role -- so a resolver rung can only reach it through the seam.
  assert.equal(subject.properties.get('Dragon Data')?.get('UPN'), '001');
  assert.equal(subject.properties.get('Item')?.get('Type'), 'Equipment');
  assert.equal(subject.sourceFile, 'Dragon-Mechanical.nwc');

  const asset = catalog.assets.find((candidate) => candidate.canonicalTag === 'MAH001-10-01');
  const standalone = subjectPropertiesFor(oneSource(handle.cache), asset, PROPERTY_MAPPINGS.equipmentTag);
  assert.equal(standalone.get('Dragon Data')?.get('UPN'), '001');
  assert.equal(standalone.get('Dragon Data')?.get('Building'), 'D1');
});

test('stage 3: the MEL yields four usable rows, three systems, and one catalog conflict', () => {
  const { melRows, systemCatalog, stats } = project;
  assert.equal(melRows.length, 4);
  assert.equal(stats.melRowCount, 4);
  assert.deepEqual([...systemCatalog.keys()], ['001', '002', '603']);
  assert.equal(stats.systemCatalogSize, 3);

  // First-seen description wins; the second one raises the review item.
  assert.equal(systemCatalog.get('603')?.description, 'Temperature Instrumentation');
  assert.equal(systemCatalog.get('603')?.sourceRowCount, 2);
  assert.equal(melRows[0].sourceFile, MEL_SOURCE_FILE);
  assert.equal(melRows[0].sheet, 'MEL');
});

test('stage 4: every asset resolves a system, the two rungs agree, and the MEL supplies the description', () => {
  const { systems, stats } = project;
  assert.equal(stats.resolvedSystemCount, 34);
  assert.equal(stats.systemConflictCount, 0);
  assert.deepEqual(systems.reviewItems, []);

  const mah = systems.bySubject.get(idOf('MAH001-10-01'));
  assert.equal(mah.resolution.systemKey, '001');
  assert.equal(mah.resolution.systemDescription, 'Mechanical Dry Air Handling');
  assert.equal(mah.resolution.systemLabel, '001 Mechanical Dry Air Handling');
  assert.equal(mah.agreement, 'agreement');
  assert.equal(mah.resolution.systemConflictStatus, 'AGREED');

  // The system segment of the tag and the mapped model UPN say the same thing
  // for the controls equipment too, which is what puts PLC/VFD/MAH in one
  // system partition and makes the family rules below meaningful.
  assert.equal(systems.bySubject.get(idOf('PLC001-10-01')).resolution.systemKey, '001');
  assert.equal(systems.bySubject.get(idOf('TIT603-10-01')).resolution.systemKey, '603');
});

test('stage 5: the identity index carries all 34 tags and inherits the profile anatomy', () => {
  const { identityIndex, stats } = project;
  assert.equal(identityIndex.assets.length, 34);
  assert.equal(stats.identityAssetCount, 34);
  // The caller stated no identity config at all, so the anatomy tier is enabled
  // from the profile's own taught tag shape rather than needing a second copy.
  assert.deepEqual(identityIndex.config.anatomy, DRAGON_ANATOMY);
});

test('stage 6: the connectivity workbook imports every sheet into nine observations', () => {
  const { connectivityReports, observations, stats } = project;
  assert.equal(connectivityReports.length, 1);

  const [report] = connectivityReports;
  assert.equal(report.sourceFile, CONNECTIVITY_SOURCE_FILE);
  assert.deepEqual(report.unknownSheets, []);
  assert.ok(report.sheets.every((sheet) => sheet.status === 'imported'));
  // 5 EasyPower rows + 2 Cable Schedule rows + 2 PMD rows.
  assert.equal(observations.length, 9);
  assert.equal(stats.observationCount, 9);
});

test('stage 7: the flow projection has ten nodes -- six model-confirmed, four source-only that carry no assetId', () => {
  const { flow } = project;

  // MAH001-10-01, PLC001-10-01, VFD001-10-01, TIT603-10-01, MAH001-20-01, PLC001-20-01.
  assert.equal(flow.stats.modelConfirmedCount, 6);
  // SWBD-1 and UNKNOWN-PANEL-99 appear in feeds; the two PMD tags do not.
  assert.equal(flow.stats.flowOnlyCount, 2);
  assert.equal(flow.stats.pmdOnlyCount, 2);
  assert.equal(flow.stats.nodeCount, 10);
  assert.equal(flow.stats.edgeCount, 9);
  assert.equal(flow.stats.cycleCount, 0);
  // The two parallel cables into PLC001-20-01 multi-feed it once, not twice.
  assert.equal(flow.stats.multiFeedNodeCount, 1);

  // Feeds something, fed by nothing: the unmodeled switchgear, and the D2 air
  // handler whose only edges are the two cables leaving it.
  assert.deepEqual([...flow.roots].sort(), [idOf('MAH001-20-01'), `tag:${FEED_ROOT_TAG}`].sort());

  for (const tag of [FEED_ROOT_TAG, UNKNOWN_FEED_TAG, UNKNOWN_PMD_TAG]) {
    assert.equal(flow.nodes.get(`tag:${tag}`)?.assetId, undefined);
  }
  // Model metadata reaches the matched nodes, system resolution included.
  const enriched = flow.nodes.get(idOf('MAH001-10-01'));
  assert.equal(enriched.enrichment.building, 'D1');
  assert.equal(enriched.enrichment.systemKey, '001');
  assert.equal(enriched.enrichment.sourceModelFile, 'Dragon-Mechanical.nwc');
});

test('stage 8: four structural claims and four dependencies -- flow anchors three families, the role graph supplies the fourth', () => {
  const { claims, stats } = project;

  assert.equal(stats.structuralClaimCount, 4);
  assert.equal(stats.dependencyClaimCount, 4);
  assert.equal(stats.learnedProposalCount, 0);

  const bySource = new Map();
  for (const claim of claims.structural) {
    bySource.set(claim.ladderSource, (bySource.get(claim.ladderSource) ?? 0) + 1);
  }
  // MAH->PLC and PLC->VFD in D1, MAH->PLC in D2 (the two parallel cables state
  // one nesting, deduped to one claim).
  assert.equal(bySource.get('flow-family'), 3);
  // D2's PLC->VFD pairing has no cable of its own, so it arrives on the weaker
  // family+role rung instead.
  assert.equal(bySource.get('family-role'), 1);

  const plc = claims.structural.find((claim) => claim.subjectAssetId === idOf('PLC001-10-01'));
  assert.equal(plc.targetAssetId, idOf('MAH001-10-01'));
  assert.equal(plc.ladderSource, 'flow-family');
  assert.equal(plc.kind, 'structural-parent');
  assert.equal(plc.provenance.sourceFile, CONNECTIVITY_SOURCE_FILE);

  // VFD001-10-01 -> TIT603-10-01 crosses a family key, so connectivity yields a
  // dependency and no nesting at all (PRODUCT.md §8.2).
  const tit = claims.dependencies.find((claim) => claim.subjectAssetId === idOf('TIT603-10-01'));
  assert.equal(tit.targetAssetId, idOf('VFD001-10-01'));
  assert.equal(tit.kind, 'dependency');
  assert.equal(
    claims.structural.some((claim) => claim.subjectAssetId === idOf('TIT603-10-01')),
    false,
  );

  // Edges with a source-only end never become claims: SWBD-1 feeds MAH001-10-01
  // and UNKNOWN-PANEL-99 is fed by VFD001-10-01, and neither is an asset.
  assert.equal(
    claims.dependencies.some((claim) => claim.subjectAssetId === idOf('MAH001-10-01')),
    false,
  );
});

test('stage 9: the snapshot places four assets under a parent and roots the other thirty', () => {
  const { snapshot, compileSubjects } = project;

  assert.equal(snapshot.stats.nodeCount, 34);
  assert.equal(snapshot.stats.rootCount, 30);
  assert.equal(snapshot.stats.unresolvedCount, 0);
  assert.equal(snapshot.stats.ambiguousCount, 0);
  assert.equal(snapshot.stats.cycleCount, 0);
  // Dragon's family key carries the system segment and the building's own token,
  // so a family-anchored parent is always inside both boundaries and the fold
  // never has a cross-boundary parent to take away.
  assert.equal(snapshot.stats.demotedToDependencyCount, 0);

  const plc = snapshot.nodes.get(idOf('PLC001-10-01'));
  assert.equal(plc.parent.status, 'resolved');
  assert.equal(plc.parent.parentAssetId, idOf('MAH001-10-01'));
  assert.equal(plc.parent.ladderSource, 'flow-family');
  assert.deepEqual(plc.levelPath, [
    { levelId: 'building', value: 'D1' },
    { levelId: 'system', value: '001' },
  ]);

  const vfdD2 = snapshot.nodes.get(idOf('VFD001-20-01'));
  assert.equal(vfdD2.parent.parentAssetId, idOf('PLC001-20-01'));
  assert.equal(vfdD2.parent.ladderSource, 'family-role');

  // The attribute mapping: catalog fields, the projected discipline, and the
  // resolver's answer, all keyed the way a hierarchy level addresses them.
  const subject = compileSubjects.find((candidate) => candidate.assetId === idOf('MAH001-10-01'));
  assert.equal(subject.attributes.get('building'), 'D1');
  assert.equal(subject.attributes.get('systemKey'), '001');
  assert.equal(subject.attributes.get('nativeDiscipline'), 'Chilled Water');
  // No projection was configured, so the SSM discipline is the native one.
  assert.equal(subject.attributes.get('ssmDiscipline'), 'Chilled Water');

  // TIT carries a Service property whose value is null, so nobody stated a
  // discipline for it -- and absent stays absent rather than becoming ''.
  const tit = compileSubjects.find((candidate) => candidate.assetId === idOf('TIT603-10-01'));
  assert.equal(tit.attributes.has('nativeDiscipline'), false);
  assert.equal(tit.attributes.has('ssmDiscipline'), false);
});

test('stage 10: the level tree groups by building then system, and the generated MEL names parents by tag', () => {
  const { tree, generatedMel } = project;

  assert.deepEqual(
    tree.levels.map((level) => level.value),
    ['D1', 'D2'],
  );
  assert.equal(tree.levels[0].levelId, HIERARCHY.levels[0].levelId);
  // D1 holds systems 001 (MAH001/PLC001/VFD001), 002 (MAH002) and 603 (TIT603).
  assert.deepEqual(
    tree.levels[0].levels.map((level) => level.value),
    ['001', '002', '603'],
  );

  // Only top-of-grouping assets hang off a level; PLC001-10-01 is nested under
  // MAH001-10-01 and appears as its child, not beside it.
  const d1System001 = tree.levels[0].levels[0];
  const mah = d1System001.assets.find((asset) => asset.assetId === idOf('MAH001-10-01'));
  assert.deepEqual(
    mah.children.map((child) => child.assetId),
    [idOf('PLC001-10-01')],
  );
  assert.deepEqual(
    mah.children[0].children.map((child) => child.assetId),
    [idOf('VFD001-10-01')],
  );

  assert.equal(generatedMel.rows.length, 34);
  const plcRow = generatedMel.rows.find((row) => row.equipmentTag === 'PLC001-10-01');
  // Tags, never asset ids: a MEL is a document engineers join against.
  assert.equal(plcRow.systemParentEquipmentTag, 'MAH001-10-01');
  assert.equal(plcRow.dependencies, 'MAH001-10-01');
  assert.equal(plcRow.systemKey, '001');
  assert.equal(plcRow.parentEvidence, 'flow-family');
  assert.equal(plcRow.inclusionStatus, 'MODEL_CONFIRMED');
  // Rows are ordered by system key then tag, so 001 precedes 002 precedes 603.
  assert.equal(generatedMel.rows[0].systemKey, '001');
});

test('stage 11: the review queue is the MEL catalog conflict and the fuzzy identity proposal, once each', () => {
  const { reviewItems, stats } = project;

  assert.equal(stats.reviewItemCount, reviewItems.length);
  // The two things the fold refused to decide. Everything else in the queue is
  // the SSM Audit gate reading the finished register -- a different question,
  // asserted in full in `ssm-audit.test.mjs`.
  const refusals = reviewItems.filter((item) => item.kind !== 'ssm-audit');
  assert.equal(refusals.length, 2);

  const catalogConflict = reviewItems.find((item) => item.kind === 'system-catalog-conflict');
  assert.equal(catalogConflict.systemKey, '603');
  assert.deepEqual(catalogConflict.descriptions, [
    'Temperature Instrumentation',
    'Temperature Instruments',
  ]);

  const fuzzy = reviewItems.find((item) => item.kind === 'fuzzy-identity');
  assert.equal(fuzzy.evidenceTag, FUZZY_PMD_TAG);
  assert.ok(
    fuzzy.candidates.some((candidate) => candidate.assetId === idOf('TIT603-10-01')),
    'the one-letter typo should propose the real tag',
  );
  // A proposal, never a match: the typo is still a source-only node.
  assert.equal(project.flow.nodes.get(`tag:${FUZZY_PMD_TAG}`).assetId, undefined);
});
