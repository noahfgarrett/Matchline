/**
 * Derived attributes, compiled end to end (RELEASE-1.0-PLAN P0-7, hard gate 7).
 *
 * > DerivedAttributeDefinition {attributeId, displayName, resolverChain} with
 * > resolver kinds model-property (ordered PropertyRefs) / tag-segment /
 * > source-assignment / system-field / composite / mel-lookup / manual. Profile
 * > defines fields; compiler resolves deterministically; Composer selects them;
 * > rung provenance; missing stays missing; no fallback value feeds a boundary;
 * > display changes never change grouping identity. Built-ins remain.
 *
 * Dragon supplies the evidence every rung reads: `Dragon Data > UPN` and
 * `Building` for a model property, the anatomy's `unit` segment for a tag
 * segment, the resolved system for a system field, the MEL for a lookup, the
 * source's own assignments for an assignment, and a hand-written table for the
 * manual rung.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { writeWorkbook } from '@matchline/spreadsheet-import';

import { compileProject, DerivedAttributeConfigError } from '../dist/index.js';
import {
  connectivityWorkbooks,
  HIERARCHY,
  idOf,
  melWorkbook,
  oneSource,
  openDragonCache,
  ROLE_GRAPH,
  siteProfile,
} from './support.mjs';

const MAH = idOf('MAH001-10-01');
const PLC = idOf('PLC001-10-01');
const VFD = idOf('VFD001-10-01');

let handle = null;

before(() => {
  handle = openDragonCache('derived-attributes');
});

after(() => {
  handle?.close();
});

/** A compile of Dragon with a derived registry and whatever else is overridden. */
function compile(derivedAttributes, inputOverrides = {}, profileOverrides = {}) {
  return compileProject({
    sources: oneSource(handle.cache),
    profile: siteProfile({ derivedAttributes: derivedAttributes ?? [], ...profileOverrides }),
    melWorkbook: melWorkbook(),
    connectivityWorkbooks: connectivityWorkbooks(),
    ...inputOverrides,
  });
}

/** One asset's level attributes, as the SSM compiler sees them. */
function attributesOf(project, assetId) {
  return project.compileSubjects.find((subject) => subject.assetId === assetId).attributes;
}

/** One asset's resolved derived values. */
function derivedOf(project, assetId) {
  return project.derivedAttributes.find((entry) => entry.assetId === assetId).values;
}

/* ------------------------------------------------------------ every rung */

test('a model-property rung reads an ordered chain, first non-blank rung first', () => {
  const project = compile([
    {
      attributeId: 'plant-code',
      displayName: 'Plant Code',
      resolverChain: [
        {
          kind: 'model-property',
          chain: [
            // Nothing in Dragon states this, so the rung falls through to UPN.
            { category: 'Dragon Data', name: 'Plant Code' },
            { category: 'Dragon Data', name: 'UPN' },
          ],
        },
      ],
    },
  ]);
  assert.equal(attributesOf(project, MAH).get('plant-code'), '001');
  const [value] = derivedOf(project, MAH);
  assert.equal(value.kind, 'model-property');
  assert.equal(value.rungIndex, 0, 'one rung of the resolver chain, whatever the property chain did');
  assert.equal(value.provenance.propertyOrColumn, 'Dragon Data > UPN');
  assert.equal(value.provenance.rule, 'derivedAttributes.plant-code[0].model-property');
});

test('a tag-segment rung reads the anatomy the site already taught', () => {
  const project = compile([
    {
      attributeId: 'unit-number',
      displayName: 'Unit',
      resolverChain: [{ kind: 'tag-segment', segment: 'unit' }],
    },
  ]);
  assert.equal(attributesOf(project, MAH).get('unit-number'), '10');
  assert.equal(attributesOf(project, idOf('MAH001-20-01')).get('unit-number'), '20');
});

test('a system-field rung reads whatever the System Resolver settled on', () => {
  const project = compile([
    {
      attributeId: 'system-words',
      displayName: 'System words',
      resolverChain: [{ kind: 'system-field', field: 'systemDescription' }],
    },
  ]);
  assert.equal(
    attributesOf(project, MAH).get('system-words'),
    'Mechanical Dry Air Handling',
    'System 001, as the MEL describes it',
  );
});

test('a composite rung speaks the resolver chain vocabulary, not a second one', () => {
  const project = compile([
    {
      attributeId: 'role-building',
      displayName: 'Role and building',
      resolverChain: [{ kind: 'composite', template: '{segment:role}@{prop:Dragon Data.Building}' }],
    },
  ]);
  assert.equal(attributesOf(project, MAH).get('role-building'), 'MAH@D1');
  assert.equal(attributesOf(project, PLC).get('role-building'), 'PLC@D1');
});

test('a mel-lookup rung returns any column the project mapped, joined by tag', () => {
  // A MEL of this project's own, with a `building` column mapped. The System
  // Resolver never reads that column; a derived attribute is exactly how a site
  // gets at one.
  const melWithBuilding = {
    bytes: writeWorkbook([
      {
        name: 'MEL',
        aoa: [
          ['Equipment Tag', 'UPN', 'System Description', 'Building'],
          ['MAH001-10-01', '001', 'Mechanical Dry Air Handling', 'Registry D1'],
          // A second row for one tag that states nothing: the rung must keep
          // looking rather than answer blank.
          ['PLC001-10-01', '001', 'Mechanical Dry Air Handling', ''],
          ['PLC001-10-01', '001', 'Mechanical Dry Air Handling', 'Registry D1 Controls'],
        ],
      },
    ]),
    sourceFile: 'Dragon-MEL.xlsx',
    sheetName: 'MEL',
    mapping: {
      equipmentTag: 'Equipment Tag',
      upn: 'UPN',
      systemDescription: 'System Description',
      building: 'Building',
    },
    headerRow: 0,
  };
  const project = compile(
    [
      {
        attributeId: 'registry-building',
        displayName: 'Registry building',
        resolverChain: [
          { kind: 'mel-lookup', joinBy: 'equipmentTag', returnField: 'building' },
        ],
      },
    ],
    { melWorkbook: melWithBuilding },
  );
  assert.equal(attributesOf(project, MAH).get('registry-building'), 'Registry D1');
  assert.equal(
    attributesOf(project, PLC).get('registry-building'),
    'Registry D1 Controls',
    'the first row that states the field, not the first row that matches the tag',
  );
  assert.equal(
    attributesOf(project, VFD).get('registry-building'),
    undefined,
    'a tag the MEL does not carry resolves to nothing',
  );
  const [value] = derivedOf(project, MAH);
  assert.equal(value.provenance.sourceFile, 'Dragon-MEL.xlsx');
  assert.equal(value.provenance.sourceRef.kind, 'sheet-row');
});

test('a source-assignment rung reads a site-defined key off the asset (P0-8)', () => {
  const project = compile(
    [
      {
        attributeId: 'turnover-package',
        displayName: 'Turnover Package',
        resolverChain: [{ kind: 'source-assignment', key: 'package' }],
      },
    ],
    {
      sources: [
        {
          sourceId: 'dragon',
          cache: handle.cache,
          assignments: { custom: new Map([['package', 'TP-04']]) },
        },
      ],
    },
  );
  assert.equal(attributesOf(project, MAH).get('turnover-package'), 'TP-04');
  const [value] = derivedOf(project, MAH);
  assert.equal(value.kind, 'source-assignment');
  assert.equal(value.provenance.propertyOrColumn, 'source assignment "package"');
});

test('a manual rung is a person’s table, and nothing is inferred from it', () => {
  const project = compile([
    {
      attributeId: 'zone',
      displayName: 'Zone',
      resolverChain: [{ kind: 'manual', assignments: [{ assetId: MAH, value: 'Z1' }] }],
    },
  ]);
  assert.equal(attributesOf(project, MAH).get('zone'), 'Z1');
  assert.equal(attributesOf(project, PLC).get('zone'), undefined, 'nobody assigned the PLC one');
  assert.equal(derivedOf(project, MAH)[0].provenance.manualDecision !== undefined, true);
});

/* ---------------------------------------------------------- chain order */

test('the first rung that yields a value wins, and the rest are not consulted', () => {
  const project = compile([
    {
      attributeId: 'zone',
      displayName: 'Zone',
      resolverChain: [
        // Nothing in Dragon states this property, so rung 0 yields nothing.
        { kind: 'model-property', chain: [{ category: 'Dragon Data', name: 'Zone' }] },
        { kind: 'tag-segment', segment: 'unit' },
        { kind: 'system-field', field: 'systemKey' },
      ],
    },
  ]);
  const [value] = derivedOf(project, MAH);
  assert.equal(value.value, '10', 'the tag segment, not the system key below it');
  assert.equal(value.rungIndex, 1);
  assert.equal(value.kind, 'tag-segment');
  assert.equal(value.provenance.fallbackRung, 2, 'provenance counts rungs from 1');
});

test('a chain nothing answers leaves the attribute off the asset entirely', () => {
  const project = compile([
    {
      attributeId: 'zone',
      displayName: 'Zone',
      resolverChain: [
        { kind: 'model-property', chain: [{ category: 'Dragon Data', name: 'Zone' }] },
        { kind: 'manual', assignments: [] },
      ],
    },
  ]);
  assert.deepEqual(derivedOf(project, MAH), [], 'no value, and no entry claiming there is one');
  assert.equal(attributesOf(project, MAH).has('zone'), false);
});

test('every asset gets a row, even the ones no chain answered for', () => {
  const project = compile([
    {
      attributeId: 'zone',
      displayName: 'Zone',
      resolverChain: [{ kind: 'manual', assignments: [{ assetId: MAH, value: 'Z1' }] }],
    },
  ]);
  assert.equal(project.derivedAttributes.length, project.catalog.assets.length);
  assert.deepEqual(
    project.derivedAttributes.map((entry) => entry.assetId),
    project.catalog.assets.map((asset) => asset.assetId),
    'in catalog order, so a caller can zip the two lists',
  );
  assert.deepEqual(derivedOf(project, PLC), []);
});

test('a project that defines none publishes an empty list and changes nothing', () => {
  const without = compile(undefined);
  const withEmpty = compile([]);
  // Not one empty row per asset: "this project derives none" is a different
  // answer from "every asset resolved to nothing".
  assert.deepEqual(without.derivedAttributes, []);
  assert.deepEqual(withEmpty.derivedAttributes, []);
  assert.deepEqual(
    [...attributesOf(withEmpty, MAH)],
    [...attributesOf(without, MAH)],
    'the built-in attributes are exactly what they were',
  );
});

/* -------------------------------------------------------- config refusals */

function refusal(definitions) {
  let failure = null;
  try {
    compile(definitions);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof DerivedAttributeConfigError, 'the registry was accepted');
  return failure.reason;
}

test('an id that collides with a built-in attribute key is refused, not resolved', () => {
  // Shadowing `systemKey` would change where every asset on the site is filed,
  // and the person who typed it would have no way to see that it had happened.
  const reason = refusal([
    { attributeId: 'systemKey', displayName: 'Mine', resolverChain: [] },
  ]);
  assert.equal(reason.kind, 'built-in-attribute-id');
  assert.equal(reason.attributeId, 'systemKey');
  assert.equal(reason.definitionIndex, 0);
});

test('two definitions under one id are refused', () => {
  const reason = refusal([
    { attributeId: 'zone', displayName: 'Zone', resolverChain: [] },
    { attributeId: 'zone', displayName: 'Zone again', resolverChain: [] },
  ]);
  assert.equal(reason.kind, 'duplicate-attribute-id');
  assert.equal(reason.definitionIndex, 1);
});

test('an id that is not kebab-case is refused', () => {
  assert.equal(
    refusal([{ attributeId: 'Turnover Package', displayName: 'x', resolverChain: [] }]).kind,
    'invalid-attribute-id',
  );
});

/* -------------------------------------------------- levels and boundaries */

/** Building, then one derived level. `boundary` decides what the fold sees. */
function hierarchyWithDerived(boundary) {
  return {
    levels: [
      HIERARCHY.levels[0],
      {
        levelId: 'zone',
        displayName: 'Zone',
        attributeKey: 'zone',
        boundary,
        missingValuePolicy: 'unassigned-group',
        sort: 'label',
      },
    ],
  };
}

/** MAH and PLC in different zones; the VFD below them in none at all. */
const ZONES = [
  {
    attributeId: 'zone',
    displayName: 'Zone',
    resolverChain: [
      {
        kind: 'manual',
        assignments: [
          { assetId: MAH, value: 'Z1' },
          { assetId: PLC, value: 'Z2' },
        ],
      },
    ],
  },
];

test('a level may group by a derived attribute, end to end through compileProject', () => {
  const project = compile(ZONES, {}, { hierarchy: hierarchyWithDerived(false) });
  const d1 = project.tree.levels.find((level) => level.value === 'D1');
  assert.deepEqual(
    d1.levels.map((level) => level.value),
    ['(unassigned)', 'Z1'],
    'the assigned zone is a grouping of its own; everything unassigned falls in the visible bucket',
  );

  const z1 = d1.levels.find((level) => level.value === 'Z1');
  assert.deepEqual(
    z1.assets.map((asset) => asset.assetId),
    [MAH],
  );
  // The PLC is in Z2 and still nested under the MAH, which is what a level that
  // is NOT a boundary means: it groups the roots, and it breaks no parents
  // (P0-5's own reading of the SSM Discipline level).
  assert.equal(project.snapshot.nodes.get(PLC).parent.parentAssetId, MAH);
  assert.deepEqual(
    z1.assets[0].children.map((child) => child.assetId),
    [PLC],
  );
});

test('a boundary on a derived attribute folds a parent away exactly like a built-in', () => {
  // Dragon's connectivity makes `MAH001-10-01 -> PLC001-10-01` a flow-family
  // nesting; the derived boundary is what has to take it apart.
  const kept = compile(ZONES, {}, { hierarchy: hierarchyWithDerived(false) });
  assert.equal(
    kept.snapshot.nodes.get(PLC).parent.parentAssetId,
    MAH,
    'without the boundary the nesting is there to lose',
  );

  const folded = compile(ZONES, {}, { hierarchy: hierarchyWithDerived(true) });
  const plc = folded.snapshot.nodes.get(PLC);
  assert.equal(plc.parent.status, 'root');
  assert.deepEqual(plc.parent.demotedFrom, { parentAssetId: MAH, boundaryLevelId: 'zone' });
  assert.deepEqual(
    plc.dependencies.map((dependency) => dependency.parentAssetId),
    [MAH, MAH],
    'the relationship stays real: POWERS from the flow, DEPENDENCY from the fold',
  );
});

test('an unresolved derived attribute at a boundary is unknown, never a default', () => {
  // `VFD001-10-01` is fed by the PLC and nobody assigned it a zone. A fallback
  // value here would make it match some other asset that also has none, which is
  // exactly the nesting ENGINE.md binding rule 4 forbids.
  const folded = compile(ZONES, {}, { hierarchy: hierarchyWithDerived(true) });
  const vfd = folded.snapshot.nodes.get(VFD);
  assert.equal(vfd.parent.status, 'root');
  assert.equal(vfd.parent.parentAssetId, null);
  assert.equal(
    folded.compileSubjects.find((subject) => subject.assetId === VFD).attributes.has('zone'),
    false,
    'no value at all, rather than an empty one two assets could share',
  );
  const item = folded.reviewItems.find(
    (candidate) => candidate.kind === 'missing-boundary' && candidate.assetId === VFD,
  );
  assert.equal(item.levelId, 'zone', 'and it is a visible decision, not a silent root');
});

test('a derived attribute used only for display never moves equipment (P0-6)', () => {
  const grouping = {
    levels: [
      HIERARCHY.levels[0],
      {
        levelId: 'system',
        displayName: 'System',
        attributeKey: 'systemKey',
        displayAttributeKey: 'zone',
        boundary: true,
        missingValuePolicy: 'unassigned-group',
        sort: 'key',
      },
    ],
  };
  const withDisplay = compile(ZONES, {}, { hierarchy: grouping });
  const withoutDisplay = compile(undefined, {}, { hierarchy: grouping });

  // The words differ; the identity does not.
  const d1 = withDisplay.tree.levels.find((level) => level.value === 'D1');
  const plain = withoutDisplay.tree.levels.find((level) => level.value === 'D1');
  assert.deepEqual(
    d1.levels.map((level) => level.value),
    plain.levels.map((level) => level.value),
  );
  assert.deepEqual(
    d1.levels.map((level) => level.assets.map((asset) => asset.assetId)),
    plain.levels.map((level) => level.assets.map((asset) => asset.assetId)),
    'the same assets in the same groupings',
  );
  assert.equal(
    d1.levels.find((level) => level.value === '001').label,
    'Z1',
    'and the label is the derived value, which is all it is',
  );
});

/* ----------------------------------------------------------- determinism */

test('the same project and registry compile to the same derived values twice', () => {
  const first = compile(ZONES, {}, { hierarchy: hierarchyWithDerived(true) });
  const second = compile(ZONES, {}, { hierarchy: hierarchyWithDerived(true) });
  assert.deepEqual(second.derivedAttributes, first.derivedAttributes);
});
