/**
 * P0-6 — a level's key is its identity; its display is only words (hard gate 8).
 *
 * > HierarchyLevelConfig gains keyAttributeKey / displayAttributeKey? /
 * > boundaryAttributeKey? (defaults collapse to key). Standard System level:
 * > key=systemKey, display=systemLabel, boundary=systemKey.
 * > Description/label edits never move equipment; revision diff reports label
 * > change, not a system move. Migrate old single attributeKey.
 *
 * ## What is true today, and why that is the bug
 *
 * `HierarchyLevelConfig` (`packages/domain/src/hierarchy-config.ts`) has one
 * `attributeKey`, and `packages/ssm-compiler/src/tree.ts` says so out loud:
 * "`label` and `key` differ only once the Site Profile supplies display labels,
 * which is a later phase; until then the level value *is* the label". That is
 * this phase. A site that groups on `systemKey` today cannot show the system's
 * words; a site that groups on `systemLabel` to get the words has made the
 * wording load-bearing, and re-typing a description re-buckets equipment.
 *
 * The two compiles below differ in exactly one character sequence — the System
 * 001 row of the MEL — and nothing else. Every assertion is a way of saying
 * that a reworded system is the same system.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { compileProject } from '@matchline/compiler';
import { diffMelRevisions } from '@matchline/mel-export';

import {
  idOf,
  melWorkbook,
  oneSource,
  openDragonCache,
  pending,
  ROLE_GRAPH,
  siteProfile,
  SYSTEM_001_DESCRIPTION_A,
  SYSTEM_001_DESCRIPTION_B,
} from './support.mjs';

/** Milestone 4: "Hierarchy+profile semantics". */
const MILESTONE = 4;

/**
 * The standard System level P0-6 specifies, plus a Building level still spelled
 * the old way.
 *
 * Both spellings on purpose: "Migrate old single attributeKey" means a config
 * written before this change keeps working, so the acceptance case has to mix
 * them rather than rewrite everything into the new form.
 */
const HIERARCHY_V2 = {
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
      levelId: 'system',
      displayName: 'System',
      keyAttributeKey: 'systemKey',
      displayAttributeKey: 'systemLabel',
      boundaryAttributeKey: 'systemKey',
      boundary: true,
      missingValuePolicy: 'unassigned-group',
      sort: 'key',
    },
  ],
};

const SYSTEM_001_LABEL_A = `001 ${SYSTEM_001_DESCRIPTION_A}`;
const SYSTEM_001_LABEL_B = `001 ${SYSTEM_001_DESCRIPTION_B}`;

let handle = null;
let revisionA = null;
let revisionB = null;

function compileWith(description) {
  return compileProject({
    sources: oneSource(handle.cache),
    profile: siteProfile(),
    hierarchy: HIERARCHY_V2,
    roleGraph: ROLE_GRAPH,
    melWorkbook: melWorkbook(description),
  });
}

/** The System level node for key `001` in building D1, however it is spelled. */
function system001(project) {
  const d1 = project.tree.levels.find((level) => (level.key ?? level.value) === 'D1');
  return d1?.levels.find((level) => (level.key ?? level.value) === '001');
}

/** One asset's level path as identities only: `levelId=key`, outermost first. */
function levelIdentity(project, assetId) {
  const node = project.snapshot.nodes.get(assetId);
  return node.levelPath.map((entry) => `${entry.levelId}=${entry.key ?? entry.value}`);
}

before(() => {
  handle = openDragonCache('level-key-display');
  revisionA = compileWith(SYSTEM_001_DESCRIPTION_A);
  revisionB = compileWith(SYSTEM_001_DESCRIPTION_B);
});

after(() => {
  handle?.close();
});

test('the two compiles differ in the system wording and in nothing else', () => {
  // Not a target assertion — a guard. If the reword ever stopped reaching the
  // resolved system, every assertion below would pass for the wrong reason.
  const rowA = revisionA.generatedMel.rows.find((row) => row.equipmentTag === 'MAH001-10-01');
  const rowB = revisionB.generatedMel.rows.find((row) => row.equipmentTag === 'MAH001-10-01');
  assert.equal(rowA.systemDescription, SYSTEM_001_DESCRIPTION_A);
  assert.equal(rowB.systemDescription, SYSTEM_001_DESCRIPTION_B);
  assert.equal(rowA.systemKey, '001');
  assert.equal(rowB.systemKey, '001');
  assert.equal(revisionA.stats.assetCount, revisionB.stats.assetCount);
});

test('a level configured with keyAttributeKey groups by the key', () => {
  const nodeA = system001(revisionA);
  assert.ok(
    nodeA,
    pending(MILESTONE, 'HierarchyLevelConfig.keyAttributeKey groups the System level by System Key'),
  );
  assert.equal(
    nodeA.key,
    '001',
    pending(MILESTONE, 'HierarchyLevelNode publishes the grouping key separately from the display'),
  );
});

test('the grouping identity is the same node key across both compiles', () => {
  const nodeA = system001(revisionA);
  const nodeB = system001(revisionB);
  assert.ok(nodeA && nodeB, pending(MILESTONE, 'both revisions produce a System level node keyed 001'));
  assert.equal(
    nodeB.key,
    nodeA.key,
    pending(MILESTONE, 'rewording a system description does not change its level node key'),
  );
});

test('the display label follows displayAttributeKey, and it is what changed', () => {
  const nodeA = system001(revisionA);
  const nodeB = system001(revisionB);
  assert.equal(
    nodeA?.label,
    SYSTEM_001_LABEL_A,
    pending(MILESTONE, 'HierarchyLevelConfig.displayAttributeKey supplies HierarchyLevelNode.label'),
  );
  assert.equal(
    nodeB?.label,
    SYSTEM_001_LABEL_B,
    pending(MILESTONE, 'the reworded system shows the new label under the same key'),
  );
  assert.notEqual(nodeA.label, nodeB.label, 'the display is the only thing that moved');
});

test('no equipment moved: every asset keeps its level identity and its parent', () => {
  const identitiesA = [];
  const identitiesB = [];
  for (const assetId of revisionA.snapshot.nodes.keys()) {
    identitiesA.push(`${assetId} @ ${levelIdentity(revisionA, assetId).join(' / ')}`);
    identitiesB.push(`${assetId} @ ${levelIdentity(revisionB, assetId).join(' / ')}`);
  }
  assert.deepEqual(identitiesB, identitiesA, 'a reworded description must not re-bucket anything');

  // And the identity really is the key, not a sentinel: without this guard the
  // comparison above would also hold for two compiles that both grouped
  // everything into `(unassigned)`.
  assert.deepEqual(
    levelIdentity(revisionA, idOf('MAH001-10-01')),
    ['building=D1', 'system=001'],
    pending(MILESTONE, 'the System level path entry carries the System Key as its identity'),
  );

  for (const [assetId, node] of revisionA.snapshot.nodes) {
    assert.equal(
      revisionB.snapshot.nodes.get(assetId).parent.parentAssetId,
      node.parent.parentAssetId,
      `${assetId} must keep its structural parent across a wording change`,
    );
  }
});

test('the revision diff reports a description/label change, not a move and not a re-key', () => {
  const diff = diffMelRevisions(revisionA.generatedMel.assets, revisionB.generatedMel.assets);

  assert.deepEqual(diff.added, [], 'rewording a system adds no assets');
  assert.deepEqual(diff.removed, [], 'rewording a system removes no assets');
  assert.deepEqual(diff.changedTags, [], 'no tag changed');
  assert.deepEqual(diff.movedParents, [], 'P0-6: a label change is never a parent move');
  assert.deepEqual(diff.changedSystemKeys, [], 'P0-6: a label change is never a system move');
  assert.deepEqual(diff.changedHierarchyLevels, [], 'no grouping level changed');

  // What it *must* report. The category is deliberately not pinned to a field
  // name — P0-6 binds the behaviour ("revision diff reports label change") and
  // the milestone author names the list. What is pinned: the diff is not empty,
  // and it says what the new wording is.
  const reportedChanges = Object.values(diff.summary).reduce((total, count) => total + count, 0);
  assert.ok(
    reportedChanges > 0,
    pending(MILESTONE, 'MelRevisionDiff reports a system description/label change instead of nothing'),
  );
  assert.ok(
    JSON.stringify(diff).includes(SYSTEM_001_DESCRIPTION_B),
    pending(MILESTONE, 'the revision diff names the new system wording'),
  );
});
