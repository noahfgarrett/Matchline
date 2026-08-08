/**
 * The property-bag seam, where it disagrees with the catalog and where it must
 * not.
 *
 * The seam's rule is "first object owning a `(category, name)` pair wins,
 * across every object the asset owns". The catalog's rule for the equipment tag
 * is narrower on purpose: the tag names the asset, and an absorbed component is
 * a part of the asset rather than the asset itself, so `canonicalTag` is read
 * off the representative object ONLY (`packages/asset-catalog/src/catalog.ts`,
 * the `AssetDraft` construction). The two rules agree on every mapped field but
 * that one, and this file is where the exception is pinned.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';

import { compileProject, subjectPropertiesFor } from '../dist/index.js';
import {
  fullInput,
  openDragonCache,
  PROPERTY_MAPPINGS,
  siteProfile,
  untaggedSkid,
  UNTAGGED_SKID_FILTERS,
  UNTAGGED_SKID_TAG,
} from './support.mjs';

let handle = null;

before(() => {
  handle = openDragonCache('properties', untaggedSkid);
});

after(() => {
  handle?.close();
});

/** The compile whose skid is untagged and whose absorbed pump is not. */
function collapsedProject() {
  return compileProject(
    fullInput(handle.cache, {
      profile: siteProfile({ assetFilters: UNTAGGED_SKID_FILTERS }),
    }),
  );
}

/**
 * The one asset that absorbed anything.
 *
 * Asserted to be unique rather than picked with `find`, so the test cannot
 * quietly start measuring a different asset if the fixture ever grows.
 */
function absorbingAsset(project) {
  const collapsed = project.catalog.assets.filter((asset) => asset.objectIds.length > 1);
  assert.equal(collapsed.length, 1, 'exactly one asset absorbed a component');
  return collapsed[0];
}

test('the collapse the exception is about actually happened', () => {
  const project = collapsedProject();

  // The pump is not an asset of its own; the skid owns its object.
  assert.equal(
    project.catalog.assets.some((asset) => asset.canonicalTag === UNTAGGED_SKID_TAG),
    false,
    'the tagged pump was absorbed',
  );
  const skid = absorbingAsset(project);
  assert.equal(skid.objectIds.length, 2, 'its own object and the pump it absorbed');
  assert.equal(skid.canonicalTag, '', 'the absorbed tag never renames the whole');
});

test('the seam reads the equipment tag off the representative object only', () => {
  const project = collapsedProject();
  const skid = absorbingAsset(project);

  // Without the special case the bag would answer `PMP002-10-01` here, and a
  // resolver rung or a Studio preview addressing `Dragon Data > Tag` would see
  // a tag the catalog says this asset does not have.
  const bag = subjectPropertiesFor(handle.cache, skid, PROPERTY_MAPPINGS.equipmentTag);
  assert.equal(
    bag.get(PROPERTY_MAPPINGS.equipmentTag.category)?.get(PROPERTY_MAPPINGS.equipmentTag.name),
    undefined,
    'no tag value, matching canonicalTag ""',
  );

  // Every other property still reads across all owned objects: the exception is
  // the tag, not the seam. `Dragon Data > UPN` is only on the absorbed pump.
  assert.equal(bag.get('Dragon Data')?.get('UPN'), '001');
  assert.equal(bag.get('Dragon Data')?.get('Building'), 'D1');
});

test('an untagged asset resolves no system from the tag it does not have', () => {
  const project = collapsedProject();
  const skid = absorbingAsset(project);

  // The end of the argument: the resolver subject is built from the bag, so a
  // leaked tag would have reached the tag-segment rung as evidence.
  const subject = project.subjects.find((entry) => entry.assetId === skid.assetId);
  assert.equal(subject.canonicalTag, '');
  assert.equal(subject.properties.get('Dragon Data')?.get('Tag'), undefined);
});

test('a representative that states its own tag still reports it', () => {
  // The narrow rule is "representative only", not "never" -- an ordinary tagged
  // asset must be unaffected.
  const project = collapsedProject();
  const tagged = project.catalog.assets.find(
    (asset) => asset.canonicalTag === 'MAH001-10-01',
  );
  const bag = subjectPropertiesFor(handle.cache, tagged, PROPERTY_MAPPINGS.equipmentTag);
  assert.equal(bag.get('Dragon Data')?.get('Tag'), 'MAH001-10-01');
});
