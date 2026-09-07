/**
 * End-to-end proof that the SSM SOP builds the hierarchy, and that the SSM
 * Audit gate then agrees with what it built.
 *
 * ## What this file is about
 *
 * Layer 1 vendored SSM-Audit's rulebook and ran it after the compile, so
 * Matchline could be told "this drive is not under the equipment it runs".
 * Layer 3 reads the same sentences forwards. The proof that the two halves are
 * one standard and not two is here: one compile, and the gate reports **zero**
 * `sop.*` and `logic.*` findings over it — not because those rules were
 * switched off, but because the build already satisfied them.
 *
 * ## Noah's directive, as a test
 *
 * > "Instruments need to be placed under their respective parents. The UPN will
 * > be available within the equipment tag like: MAH101-01 has a VFD101-01 down
 * > the line as a child."
 *
 * So the pairing is by tag: UPN `101` and instance `01`. `MAH101-01` is the
 * machine; `VFD101-01`, `LCP101-01`, `TIT101-01` and `PT101-01` all carry the
 * same two and all nest under it — across three disciplines, which is the
 * second half of the directive and the reason the discipline boundary carries
 * an exception rather than being switched off.
 *
 * ## The fixture
 *
 * The Revit-shaped fixture's two B14 packages: `B14-Controls.nwc` (the machine,
 * its drive, its controller, its local panel and a transmitter) and
 * `B14-Commissioning.nwc` (the MCC that feeds it, the transformer and the
 * heat-trace branch under it, the remote I/O drop, a second instrument, and the
 * VESDA / fire-alarm pair). The three MEP packages are filtered out: they are
 * the half of a federation that is NOT on the standard, which the Quick Setup
 * suite already covers, and including them would put a dozen `AHU-1`-shaped
 * assets with no approved UPN into an audit about the SOP.
 *
 * ## The connectivity workbook
 *
 * Invented, in-memory, three columns of a cable schedule. It exists because two
 * of the rules under test — `logic.driven-electrical-path` and
 * `logic.control-electrical-path` — make no claim at all without one. That is
 * deliberate (`packages/relationship-claims/src/sop.ts`: "It never guesses
 * power"), and the honest way to test a rule that reads a document is to give
 * it the document.
 *
 * ## Import mechanism
 *
 * Same as `e3-ssm-compiler.test.mjs` and `e4-commissioning-outputs.test.mjs`:
 * every package resolves by name out of the root `node_modules`, and
 * `npm run build` must have run first. `starterProfile` is imported from the
 * desktop's own build, because item 5 of this layer is a claim about what the
 * fast path proposes, and re-typing its ladder here would prove nothing.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { compileProject } from '@matchline/compiler';
import { LADDER_SOURCE_ORDER, SOP_RULE_IDS } from '@matchline/domain';
import { openExtractionCache } from '@matchline/model-schema';
import { writeRevitShapedFixture } from '@matchline/model-schema/fixtures/revit';
import { writeWorkbook } from '@matchline/spreadsheet-import';

import { starterProfile } from '../../apps/desktop/dist/shared/starter-profile.js';

const MODEL_SOURCE_ID = 'campus';

/** The two packages the SOP scenario lives in. */
const SOP_FILES = ['B14-Controls.nwc', 'B14-Commissioning.nwc'];

/**
 * A Revit federation publishes the mark, the type description and (here) the
 * discipline. It publishes nothing called Building: that comes off the file
 * name, through the source-assignment rule below.
 */
const PROPERTY_MAPPINGS = {
  equipmentTag: { category: 'Element', name: 'Mark' },
  description: { category: 'Revit Type', name: 'Description' },
  equipmentType: { category: 'Revit Type', name: 'Type Name' },
  nativeDiscipline: { category: 'Element', name: 'Discipline' },
};

const ASSET_FILTERS = {
  requireTagProperty: true,
  collapseComponents: false,
  includedSourceModelFiles: [...SOP_FILES],
};

/**
 * The approved-UPN rung, which is what makes a tag pairing possible at all: the
 * System Key comes out of the tag, so `MAH101-01` and `VFD101-01` are on one
 * system before anything nests.
 */
const SYSTEM_RESOLVER = {
  keyChain: [{ kind: 'upn-from-tag' }],
  descriptionChain: [
    { kind: 'exto-system-name', allowUniqueUpn: true },
  ],
  normalization: [{ kind: 'trim' }],
  conflictPolicy: 'review',
  applyIcDisciplineRule: true,
};

/** The default preset, which `withSopException` then amends. */
const BASE_LEVELS = [
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
];

/** Both B14 packages assert the building their file name states. */
const SOURCE_ASSIGNMENTS = [
  { scope: 'filename-pattern', match: 'B14-*', assign: { building: 'B14' } },
];

/**
 * One cable-schedule sheet: what feeds what.
 *
 * `Panel (From)` / `Load Name (To)` / `Cable Tag` are the exact header rung, so
 * detection needs no override.
 */
function connectivityWorkbookBytes() {
  const loads = [
    'MAH101-01',
    'P102-01',
    'VFD101-01',
    'PLC101-01',
    'LCP101-01',
    'RIO101-01',
    'FACP-B14-01',
    'VESDA-B14-01',
  ];
  return writeWorkbook([
    {
      name: 'Cable Schedule',
      aoa: [
        ['Panel (From)', 'Load Name (To)', 'Cable Tag'],
        ...loads.map((load, index) => ['MCC101', load, `C-${String(index + 1).padStart(3, '0')}`]),
        ['XFMR101', 'HTP101-01', 'C-100'],
      ],
    },
  ]);
}

/**
 * The profile a site gets by taking the Quick Setup fast path.
 *
 * The three sections this layer is about are read off `starterProfile` rather
 * than written here: the ladder (which carries the `sop-rule` rung), the SOP
 * rule list (nothing switched off), and the amended level stack (SSM Discipline
 * is a real boundary, with the SOP's controls devices exempt from it).
 */
function siteProfile(disabledSopRuleIds = []) {
  const starter = starterProfile([], BASE_LEVELS);
  return {
    formatVersion: 2,
    profileId: 'campus-e5',
    name: 'Campus E5',
    version: 1,
    propertyMappings: PROPERTY_MAPPINGS,
    sourceAssignments: SOURCE_ASSIGNMENTS,
    assetFilters: ASSET_FILTERS,
    systemResolver: SYSTEM_RESOLVER,
    derivedAttributes: [],
    hierarchy: starter.hierarchy,
    roleGraph: { rules: [] },
    ladder: starter.ladder,
    ssmDisciplineProjection: [],
    parentTagProperty: null,
    stableIdProperty: null,
    identityConfig: starter.identityConfig,
    profileLookup: [],
    priorSsm: [],
    ssmAudit: { disabledRuleIds: [] },
    sopRules: { disabledRuleIds: [...disabledSopRuleIds] },
    authorityRules: [],
    profileTestExamples: [],
  };
}

function compileWith(cache, disabledSopRuleIds = []) {
  return compileProject({
    sources: [{ sourceId: MODEL_SOURCE_ID, cache }],
    profile: siteProfile(disabledSopRuleIds),
    connectivityWorkbooks: [
      { bytes: connectivityWorkbookBytes(), sourceFile: 'B14-Cable-Schedule.xlsx' },
    ],
  });
}

let workDir = '';
let cache = null;
let project = null;

/** Tag -> compiled asset id, through the compile's own identity index. */
function idOf(tag) {
  const matches = project.identityIndex.byExactTag.get(tag);
  assert.ok(matches !== undefined && matches.length === 1, `${tag} names exactly one asset`);
  return matches[0].assetId;
}

/** The structural parent's TAG, or `null` for a root. */
function parentTagOf(tag) {
  const node = project.snapshot.nodes.get(idOf(tag));
  assert.ok(node !== undefined, `${tag} is in the snapshot`);
  const parentId = node.parent.parentAssetId;
  if (parentId === null) {
    return null;
  }
  const asset = project.catalog.assets.find((entry) => entry.assetId === parentId);
  return asset?.canonicalTag ?? null;
}

/** The tags one asset depends on. */
function dependencyTagsOf(tag) {
  const asset = project.generatedMel.assets.find((entry) => entry.canonicalTag === tag);
  assert.ok(asset !== undefined, `${tag} is in the generated MEL`);
  return [...(asset.dependencyTags ?? [])].sort();
}

/** Every finding whose rule is one of the SOP's or commissioning logic's. */
function sopFindings(report) {
  return report.findings.filter(
    (finding) => finding.ruleId.startsWith('sop.') || finding.ruleId.startsWith('logic.'),
  );
}

before(() => {
  workDir = mkdtempSync(join(tmpdir(), 'matchline-e5-'));
  const cachePath = join(workDir, 'Campus.matchline-cache');
  writeRevitShapedFixture(cachePath);
  cache = openExtractionCache(cachePath);
  project = compileWith(cache);
});

after(() => {
  cache?.close();
  if (workDir !== '') {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test('sanity: the two B14 packages, and nothing else', () => {
  assert.equal(project.stats.assetCount, 14);
  assert.equal(project.stats.duplicateTagCount, 0);
  assert.deepEqual(
    project.generatedMel.assets.map((asset) => asset.canonicalTag).sort(),
    [
      'FACP-B14-01',
      'HTC101-01',
      'HTP101-01',
      'LCP101-01',
      'MAH101-01',
      'MCC101',
      'P102-01',
      'PLC101-01',
      'PT101-01',
      'RIO101-01',
      'TIT101-01',
      'VESDA-B14-01',
      'VFD101-01',
      'XFMR101',
    ],
  );
});

test('the fast path proposes the SOP rung, every SOP rule, and the boundary exception', () => {
  const starter = starterProfile([], BASE_LEVELS);
  assert.deepEqual(starter.ladder.tiers, [...LADDER_SOURCE_ORDER]);
  assert.ok(starter.ladder.tiers.includes('sop-rule'));
  assert.deepEqual(starter.sopRules, { disabledRuleIds: [] }, 'nothing switched off');

  const discipline = starter.hierarchy.levels.find((level) => level.levelId === 'ssm-discipline');
  assert.equal(discipline.boundary, true, 'a real boundary, not a switched-off one');
  assert.ok(discipline.boundaryExceptions.childClasses.includes('vfd'));
  assert.ok(discipline.boundaryExceptions.childClasses.includes('instrument'));
  assert.ok(discipline.boundaryExceptions.childClasses.includes('lcp'));

  // Every other level is returned untouched: the exception amends one level.
  assert.deepEqual(
    starter.hierarchy.levels.filter((level) => level.levelId !== 'ssm-discipline'),
    BASE_LEVELS.filter((level) => level.levelId !== 'ssm-discipline'),
  );
});

test('1. the tag pairing: VFD101-01 nests under MAH101-01, by UPN and instance', () => {
  assert.equal(parentTagOf('VFD101-01'), 'MAH101-01');

  const node = project.snapshot.nodes.get(idOf('VFD101-01'));
  assert.equal(node.parent.ladderSource, 'sop-rule');
  assert.equal(node.parent.winningClaim.rule, 'sop.tag-pair');
  assert.equal(node.parent.winningClaim.provenance.rule, 'sop.tag-pair');
  assert.equal(node.parent.winningClaim.provenance.sourceFile, 'ssm-sop');
  assert.match(node.parent.winningClaim.provenance.propertyOrColumn, /UPN 101, instance 01/);
  assert.match(node.parent.winningClaim.provenance.propertyOrColumn, /MAH101-01/);
});

test('2. the instruments cross the discipline line rather than being demoted by it', () => {
  assert.equal(parentTagOf('TIT101-01'), 'MAH101-01');
  assert.equal(parentTagOf('PT101-01'), 'MAH101-01');

  // The disciplines really do differ. If they did not, this test would pass for
  // the wrong reason.
  const byTag = new Map(
    project.generatedMel.assets.map((asset) => [asset.canonicalTag, asset.ssmDiscipline]),
  );
  assert.equal(byTag.get('MAH101-01'), 'Mechanical');
  assert.equal(byTag.get('TIT101-01'), 'FACILITIES MONITORING SYSTEM');
  assert.equal(byTag.get('VFD101-01'), 'Electrical');

  // And the exception is an exception, not a switched-off boundary: nothing was
  // demoted at the discipline level.
  const demotions = project.snapshot.reviewItems.filter(
    (item) => item.kind === 'boundary-demotion' && item.levelId === 'ssm-discipline',
  );
  assert.deepEqual(demotions, [], 'the SOP’s devices are exempt, not demoted');

  for (const tag of ['TIT101-01', 'PT101-01', 'VFD101-01', 'LCP101-01']) {
    const node = project.snapshot.nodes.get(idOf(tag));
    assert.equal(node.parent.status, 'resolved', `${tag} kept its parent`);
    assert.equal(node.parent.demotedFrom, undefined, `${tag} was never demoted`);
  }
});

test('3. the local control panel goes with the equipment it serves', () => {
  assert.equal(parentTagOf('LCP101-01'), 'MAH101-01');
  const node = project.snapshot.nodes.get(idOf('LCP101-01'));
  assert.equal(node.parent.winningClaim.rule, 'sop.lcp-placement');

  // The model tree put it inside PLC101-01. The SOP outranks the model tree,
  // and the losing claim is retained rather than discarded.
  assert.ok(
    node.losingClaims.some((claim) => claim.ladderSource === 'model-tree'),
    'the model tree’s own answer is still on the node',
  );
});

test('4. the VFD depends on its panel and its PLC', () => {
  const dependencies = dependencyTagsOf('VFD101-01');
  assert.ok(dependencies.includes('MCC101'), 'the electrical panel');
  assert.ok(dependencies.includes('PLC101-01'), 'the controlling PLC');

  const claims = project.claims.dependencies.filter(
    (claim) => claim.subjectAssetId === idOf('VFD101-01') && claim.rule === 'sop.vfd-dependencies',
  );
  assert.deepEqual(
    claims.map((claim) => claim.targetAssetId).sort(),
    [idOf('MCC101'), idOf('PLC101-01')].sort(),
  );
});

test('5. the heat trace chain: panel under transformer, box under panel', () => {
  assert.equal(parentTagOf('HTP101-01'), 'XFMR101');
  assert.equal(parentTagOf('HTC101-01'), 'HTP101-01');
  for (const tag of ['HTP101-01', 'HTC101-01']) {
    assert.equal(
      project.snapshot.nodes.get(idOf(tag)).parent.winningClaim.rule,
      'logic.heat-trace-chain',
    );
  }
});

test('6. the VESDA depends on its fire alarm panel, and the RIO on its PLC', () => {
  assert.ok(dependencyTagsOf('VESDA-B14-01').includes('FACP-B14-01'));
  assert.ok(dependencyTagsOf('RIO101-01').includes('PLC101-01'));

  const vesda = project.claims.dependencies.find(
    (claim) => claim.subjectAssetId === idOf('VESDA-B14-01') && claim.rule === 'logic.vesda-fire-alarm',
  );
  assert.ok(vesda, 'the rule fired, by building rather than by system');
  assert.equal(vesda.targetAssetId, idOf('FACP-B14-01'));

  const rio = project.claims.dependencies.find(
    (claim) => claim.subjectAssetId === idOf('RIO101-01') && claim.rule === 'logic.rio-control-path',
  );
  assert.ok(rio);
  assert.equal(rio.targetAssetId, idOf('PLC101-01'));
});

test('7. the power paths are read from the cable schedule and never guessed', () => {
  const paths = project.claims.dependencies.filter(
    (claim) =>
      claim.rule === 'logic.driven-electrical-path' ||
      claim.rule === 'logic.control-electrical-path',
  );
  assert.ok(paths.length > 0, 'the cable schedule states feeds, so the rules claim them');
  for (const claim of paths) {
    assert.match(claim.provenance.propertyOrColumn, /per connectivity/);
  }

  // With no connectivity at all, neither rule claims anything.
  const unpowered = compileProject({
    sources: [{ sourceId: MODEL_SOURCE_ID, cache }],
    profile: siteProfile(),
  });
  assert.deepEqual(
    unpowered.claims.dependencies.filter(
      (claim) =>
        claim.rule === 'logic.driven-electrical-path' ||
        claim.rule === 'logic.control-electrical-path',
    ),
    [],
    'no cable schedule, no power claim',
  );
});

test('8. the SSM Audit gate reports no SOP or commissioning-logic finding at all', () => {
  const findings = sopFindings(project.ssmAudit);
  assert.deepEqual(
    findings.map((finding) => `${finding.ruleId} on ${finding.equipmentId}`),
    [],
    'the build satisfied the rulebook rather than the rulebook being switched off',
  );

  // And it is switched ON: every one of those rules ran and is listed enabled.
  const enabled = new Map(project.ssmAudit.rulesEnabled.map((rule) => [rule.ruleId, rule.enabled]));
  for (const ruleId of ['sop.vfd-dependencies', 'logic.drive-parent-unexpected', 'logic.vesda-fire-alarm-missing']) {
    assert.equal(enabled.get(ruleId), true, `${ruleId} ran`);
  }
});

test('9. switching the pairing off removes it, and the gate says so', () => {
  const without = compileWith(cache, ['sop.tag-pair']);

  const vfd = without.identityIndex.byExactTag.get('VFD101-01')[0].assetId;
  assert.equal(
    without.snapshot.nodes.get(vfd).parent.parentAssetId,
    null,
    'nothing else in this project claims a parent for the drive',
  );

  const findings = sopFindings(without.ssmAudit);
  assert.ok(
    findings.some(
      (finding) =>
        finding.ruleId === 'logic.drive-parent-unexpected' && finding.equipmentId === 'VFD101-01',
    ),
    'the gate reports exactly what the build stopped doing',
  );

  // One rule off is one rule off: the heat-trace chain and the LCP are untouched.
  const stillPlaced = without.generatedMel.assets.find(
    (asset) => asset.canonicalTag === 'HTP101-01',
  );
  assert.equal(stillPlaced.systemParentTag, 'XFMR101');
});

test('10. every rule in the catalogue is one a profile can switch off', () => {
  // The catalogue is what the profile and the Quick Setup step both read, so a
  // rule that fired under a name not in it would be unswitchable.
  const fired = new Set(
    [...project.claims.structural, ...project.claims.dependencies]
      .filter((claim) => claim.ladderSource === 'sop-rule')
      .map((claim) => claim.rule),
  );
  assert.ok(fired.size > 0);
  for (const ruleId of fired) {
    assert.ok(SOP_RULE_IDS.includes(ruleId), `${ruleId} is in the catalogue`);
  }
});
