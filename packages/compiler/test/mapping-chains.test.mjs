/**
 * Ordered fallback chains, per-source mappings and profile-level assignment
 * rules, through a whole compile (RELEASE-1.0-PLAN P0-8, hard gates 5 and 6).
 *
 * `@matchline/asset-catalog` proves the chain and tier semantics against
 * synthetic caches; what this file proves is that a real compile carries them:
 * that a lifted profile compiles to the same project it always did, that the
 * property-bag seam honours the tag chain the way the catalog does, and that
 * `sourceAssignmentRules` on `CompileProjectInput` reaches the catalog.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { compileProject, subjectPropertiesFor } from '../dist/index.js';
import {
  DRAGON_CONTROLS_MODELS,
  DRAGON_MECHANICAL_MODELS,
  fullInput,
  idOf,
  oneSource,
  openDragonCache,
  openDragonSubset,
  PROPERTY_MAPPINGS,
  siteProfile,
  UNTAGGED_SKID_FILTERS,
  untaggedSkid,
} from './support.mjs';

let handle = null;
let mechanical = null;
let controls = null;

before(() => {
  handle = openDragonCache('mapping-chains');
  mechanical = openDragonSubset('mapping-chains-mech', {
    sourceModels: DRAGON_MECHANICAL_MODELS,
    inputFileName: 'Dragon-Mechanical.nwd',
  });
  controls = openDragonSubset('mapping-chains-ctrl', {
    sourceModels: DRAGON_CONTROLS_MODELS,
    inputFileName: 'Dragon-Controls.nwd',
  });
});

after(() => {
  handle?.close();
  mechanical?.close();
  controls?.close();
});

/** Every mapping as a one-rung chain: the spelling `migratePropertyMappings` produces. */
const CHAINED_MAPPINGS = Object.fromEntries(
  Object.entries(PROPERTY_MAPPINGS).map(([field, ref]) => [field, { chain: [ref] }]),
);

test('a profile lifted to one-rung chains compiles to the project it always did', () => {
  const single = compileProject(fullInput(handle.cache));
  const lifted = compileProject(
    fullInput(handle.cache, { profile: siteProfile({ propertyMappings: CHAINED_MAPPINGS }) }),
  );

  assert.deepEqual(lifted.stats, single.stats);
  assert.deepEqual(
    lifted.catalog.assets.map((asset) => [asset.assetId, asset.building, asset.description]),
    single.catalog.assets.map((asset) => [asset.assetId, asset.building, asset.description]),
  );
  assert.deepEqual(
    Buffer.from(lifted.generatedMel.workbookBytes),
    Buffer.from(single.generatedMel.workbookBytes),
    'byte-identical: a lift is a change of spelling, not of meaning',
  );
});

test('a chain falls through to a later rung across the whole compile', () => {
  // `Dragon Data > Service` is on the MAH equipment and on nothing else, so a
  // chain that tries it first and `Item > Type` second answers both ways in one
  // project -- which is the point of a chain.
  const project = compileProject(
    fullInput(handle.cache, {
      profile: siteProfile({
        propertyMappings: {
          ...PROPERTY_MAPPINGS,
          description: {
            chain: [
              { category: 'Dragon Data', name: 'Service' },
              { category: 'Item', name: 'Type' },
            ],
          },
        },
      }),
    }),
  );

  const mah = project.catalog.assets.find((asset) => asset.assetId === idOf('MAH001-10-01'));
  assert.equal(mah.description, 'Chilled Water');
  assert.equal(mah.provenance.description.rungIndex, 0);

  const plc = project.catalog.assets.find((asset) => asset.assetId === idOf('PLC001-10-01'));
  assert.equal(plc.description, 'Equipment', 'the controls model states no Service');
  assert.equal(plc.provenance.description.rungIndex, 1);
  assert.equal(plc.provenance.description.fallbackRung, 2);
});

test('a per-source override reaches the compile, and only the source that named it', () => {
  const project = compileProject({
    sources: [
      { sourceId: 'dragon-controls', cache: controls.cache },
      { sourceId: 'dragon-mechanical', cache: mechanical.cache },
    ],
    profile: siteProfile({
      propertyMappings: {
        ...PROPERTY_MAPPINGS,
        description: {
          chain: [{ category: 'Dragon Data', name: 'Service' }],
          bySource: [{ sourceId: 'dragon-controls', chain: [{ category: 'Item', name: 'Type' }] }],
        },
      },
    }),
    hierarchy: { levels: [] },
  });

  const plc = project.catalog.assets.find((asset) => asset.assetId === idOf('PLC001-10-01'));
  assert.equal(plc.description, 'Equipment');
  assert.equal(plc.provenance.description.sourceSpecificChain, true);

  const mah = project.catalog.assets.find((asset) => asset.assetId === idOf('MAH001-10-01'));
  assert.equal(mah.description, 'Chilled Water');
  assert.equal(mah.provenance.description.sourceSpecificChain, false);
});

test('the property-bag seam keeps EVERY tag rung off an absorbed component', () => {
  // The seam's one exception is the equipment tag, and P0-8 widened it from a
  // pair to a chain: a rung the catalog would have read as a tag must not reach
  // the bag off a component either, or the same disagreement comes back one
  // rung down (`properties.test.mjs` pins the one-rung case).
  const skidHandle = openDragonCache('mapping-chains-skid', untaggedSkid);
  try {
    const equipmentTag = {
      chain: [
        { category: 'Dragon Data', name: 'Tag' },
        // The absorbed pump states this; the untagged skid does not.
        { category: 'Item', name: 'Name' },
      ],
    };
    const project = compileProject(
      fullInput(skidHandle.cache, {
        profile: siteProfile({
          assetFilters: UNTAGGED_SKID_FILTERS,
          propertyMappings: { ...PROPERTY_MAPPINGS, equipmentTag },
        }),
      }),
    );
    const skid = project.catalog.assets.find((asset) => asset.objectIds.length > 1);
    assert.equal(skid.canonicalTag, 'Unlabelled Skid', 'rung 1 answered off the representative');

    const bag = subjectPropertiesFor(oneSource(skidHandle.cache), skid, equipmentTag);
    assert.equal(
      bag.get('Item')?.get('Name'),
      'Unlabelled Skid',
      'the representative’s own reading, never the absorbed pump’s',
    );
    assert.equal(bag.get('Dragon Data')?.get('Tag'), undefined, 'rung 0 is held back too');
    // Everything that is not a tag rung still reads across every owned object.
    assert.equal(bag.get('Dragon Data')?.get('UPN'), '001');
  } finally {
    skidHandle.close();
  }
});

/* ------------------------------------------------- assignment rules (P0-8) */

test('profile assignment rules reach the catalog through compileProject', () => {
  const project = compileProject(
    fullInput(handle.cache, {
      // Dragon's controls equipment states no discipline at all, which is the
      // gap a filename-pattern rule exists to fill.
      profile: siteProfile({
        propertyMappings: {
          ...PROPERTY_MAPPINGS,
          nativeDiscipline: { category: 'Dragon Data', name: 'Service' },
        },
      }),
      sourceAssignmentRules: [
        {
          scope: 'filename-pattern',
          match: 'Dragon-*.nwc',
          assign: { nativeDiscipline: '$1' },
        },
      ],
    }),
  );

  const plc = project.catalog.assets.find((asset) => asset.assetId === idOf('PLC001-10-01'));
  assert.equal(plc.nativeDiscipline, 'Controls', 'captured out of Dragon-Controls.nwc');
  assert.equal(plc.provenance.nativeDiscipline.scope, 'filename-pattern');

  const mah = project.catalog.assets.find((asset) => asset.assetId === idOf('MAH001-10-01'));
  assert.equal(
    mah.nativeDiscipline,
    'Chilled Water',
    'the model states this one, and the model outranks the rule',
  );
  assert.equal(mah.provenance.nativeDiscipline.origin, 'model-property');
});

test('an assigned discipline flows into the SSM discipline and the generated MEL', () => {
  const project = compileProject(
    fullInput(handle.cache, {
      profile: siteProfile({
        propertyMappings: {
          ...PROPERTY_MAPPINGS,
          nativeDiscipline: { category: 'Dragon Data', name: 'Service' },
        },
      }),
      sourceAssignmentRules: [
        { scope: 'filename-pattern', match: 'Dragon-*.nwc', assign: { nativeDiscipline: '$1' } },
      ],
      ssmDisciplineProjection: new Map([['Controls', 'I&C']]),
    }),
  );
  const subject = project.compileSubjects.find(
    (entry) => entry.assetId === idOf('PLC001-10-01'),
  );
  assert.equal(subject.attributes.get('nativeDiscipline'), 'Controls');
  assert.equal(subject.attributes.get('ssmDiscipline'), 'I&C');

  const row = project.generatedMel.rows.find((entry) => entry.equipmentTag === 'PLC001-10-01');
  assert.equal(row.ssmDiscipline, 'I&C');
});

test('a compile with no rules is the compile it was before rules existed', () => {
  const without = compileProject(fullInput(handle.cache));
  const withEmpty = compileProject(fullInput(handle.cache, { sourceAssignmentRules: [] }));
  assert.deepEqual(withEmpty.stats, without.stats);
  assert.deepEqual(
    Buffer.from(withEmpty.generatedMel.workbookBytes),
    Buffer.from(without.generatedMel.workbookBytes),
  );
});
