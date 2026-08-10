/**
 * P0-5 — the default hierarchy preset (hard gate 11).
 *
 * > Building boundary=true; SSM Discipline visible, boundary=FALSE (startup
 * > families cross native disciplines: MAH/PLC/VFD/TIT one branch); System
 * > boundary=true comparing System Key. UI must not call all-three-structural
 * > standard.
 *
 * ## What is true today, and why that is the bug
 *
 * `apps/desktop/electron/services/project-config.ts` ships
 * `DEFAULT_HIERARCHY_LEVELS` with `boundary: true` on all three levels, and its
 * own comment calls that "DECISIONS.md #1 — hard boundaries". Two different
 * questions got the same answer there: DECISIONS.md #1 says a boundary that IS
 * enabled is hard with no feed-chain exception, which is about the *semantics*
 * of a boundary. P0-5 is about which levels a new project should *enable*, and
 * a commissioning discipline is not one of them — a startup family is a
 * mechanical unit, its controls panel, its drive and its instrument, and every
 * default that makes discipline structural cuts that family into four roots.
 *
 * So this file asserts two things that have to hold together: the constant, and
 * a compile under it. Either alone would be a half-proof — a preset nobody
 * compiles proves nothing, and a hand-written config proves nothing about what
 * a new project actually gets.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { compileProject } from '@matchline/compiler';

// The desktop package's built output. The preset is a desktop constant (it is
// what a *new project* is opened on), so the acceptance test reads the real
// one rather than a copy — a copy would keep passing after somebody changed it.
import { DEFAULT_HIERARCHY_LEVELS } from '../../apps/desktop/dist/electron/services/project-config.js';

import {
  idOf,
  oneSource,
  openDragonCache,
  pending,
  ROLE_GRAPH,
  siteProfile,
  STARTUP_FAMILY,
  startupFamily,
} from './support.mjs';

/** Milestone 4: "Hierarchy+profile semantics". */
const MILESTONE = 4;

/** The chain P0-5 names, child-first: each entry is nested under the next. */
const CHAIN = [
  { child: 'TIT007-10-09', parent: 'VFD007-10-09' },
  { child: 'VFD007-10-09', parent: 'PLC007-10-09' },
  { child: 'PLC007-10-09', parent: 'MAH007-10-09' },
];

let handle = null;
let project = null;

before(() => {
  handle = openDragonCache('default-hierarchy', startupFamily);
  project = compileProject({
    sources: oneSource(handle.cache),
    profile: siteProfile(),
    // The preset itself, unedited. `WireHierarchyLevel` and
    // `HierarchyLevelConfig` are the same field set, which is why
    // `toHierarchyConfig` is a straight copy.
    hierarchy: { levels: [...DEFAULT_HIERARCHY_LEVELS] },
    roleGraph: ROLE_GRAPH,
  });
});

after(() => {
  handle?.close();
});

test('the default preset is Building / SSM Discipline / System, in that order', () => {
  assert.deepEqual(
    DEFAULT_HIERARCHY_LEVELS.map((level) => level.levelId),
    ['building', 'ssm-discipline', 'system'],
  );
  assert.deepEqual(
    DEFAULT_HIERARCHY_LEVELS.map((level) => level.attributeKey),
    ['building', 'ssmDiscipline', 'systemKey'],
  );
});

test('Building is a boundary by default', () => {
  const building = DEFAULT_HIERARCHY_LEVELS.find((level) => level.levelId === 'building');
  assert.equal(building.boundary, true);
});

test('SSM Discipline is VISIBLE but NOT a boundary by default', () => {
  const discipline = DEFAULT_HIERARCHY_LEVELS.find((level) => level.levelId === 'ssm-discipline');
  // Visible: it is still a configured level, so the tree still groups by it.
  assert.ok(discipline, 'SSM Discipline stays a level — P0-5 makes it nonstructural, not absent');
  assert.equal(
    discipline.boundary,
    false,
    pending(MILESTONE, 'DEFAULT_HIERARCHY_LEVELS ships SSM Discipline with boundary=false'),
  );
});

test('System is a boundary by default, compared on the System Key', () => {
  const system = DEFAULT_HIERARCHY_LEVELS.find((level) => level.levelId === 'system');
  assert.equal(system.boundary, true);
  assert.equal(system.attributeKey, 'systemKey', 'the boundary compares the key, never the wording');
});

test('the startup family really does cross four native disciplines in one system', () => {
  // Not a target assertion — a guard. If these four ever stopped disagreeing on
  // discipline or agreeing on system, the chain test below would prove nothing.
  const disciplines = new Set();
  for (const member of STARTUP_FAMILY) {
    const subject = project.compileSubjects.find((entry) => entry.assetId === idOf(member.tag));
    assert.ok(subject, `${member.tag} should be in the compiled universe`);
    assert.equal(subject.attributes.get('nativeDiscipline'), member.service);
    assert.equal(subject.attributes.get('ssmDiscipline'), member.service);
    assert.equal(subject.attributes.get('systemKey'), '007');
    assert.equal(subject.attributes.get('building'), 'D1');
    disciplines.add(member.service);
  }
  assert.equal(disciplines.size, 4, 'four distinct native disciplines, one System Key');
});

test('under the DEFAULT preset the MAH/PLC/VFD/TIT family keeps its structural chain', () => {
  for (const link of CHAIN) {
    const node = project.snapshot.nodes.get(idOf(link.child));
    assert.equal(
      node.parent.status,
      'resolved',
      pending(MILESTONE, `${link.child} stays nested under ${link.parent} across a discipline change`),
    );
    assert.equal(node.parent.parentAssetId, idOf(link.parent));
    assert.equal(node.parent.ladderSource, 'family-role');
    assert.equal(
      node.parent.demotedFrom,
      undefined,
      pending(MILESTONE, `no boundary demotes ${link.child}: SSM Discipline is nonstructural by default`),
    );
  }
});

test('nothing in the startup family is demoted at the discipline level', () => {
  const disciplineDemotions = [...project.snapshot.nodes.values()].filter(
    (node) => node.parent.demotedFrom?.boundaryLevelId === 'ssm-discipline',
  );
  assert.deepEqual(
    disciplineDemotions.map((node) => node.parent.demotedFrom.parentAssetId),
    [],
    pending(MILESTONE, 'a nonstructural SSM Discipline level demotes nothing'),
  );
});

test('the family still appears as one branch in the projected tree', () => {
  // §11.4: an asset is nested under its structural parent's node wherever that
  // parent sits, so the whole chain reads as one branch even though its members
  // carry four different disciplines.
  const d1 = project.tree.levels.find((level) => level.value === 'D1');
  assert.ok(d1, 'building D1 must be a level node');

  const roots = [];
  const walk = (levelNode) => {
    for (const asset of levelNode.assets) {
      if (asset.assetId === idOf('MAH007-10-09')) {
        roots.push(asset);
      }
    }
    for (const child of levelNode.levels) {
      walk(child);
    }
  };
  walk(d1);

  assert.equal(
    roots.length,
    1,
    pending(MILESTONE, 'the family head is filed once, with the rest of the family under it'),
  );
  const depthOf = (node) =>
    node.children.length === 0 ? 1 : 1 + Math.max(...node.children.map(depthOf));
  assert.equal(
    depthOf(roots[0]),
    4,
    pending(MILESTONE, 'MAH -> PLC -> VFD -> TIT is one four-deep branch under the default preset'),
  );
});
