import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildDerivedPreview,
  indexMelByAsset,
} from '../dist/electron/services/derived-preview.js';

/**
 * Screen 6's MEL join, which must be the compile's MEL join.
 *
 * `compileProject` re-addresses MEL rows onto assets through
 * `@matchline/identity`, so the normalization a site taught applies to its MEL.
 * A preview that bucketed rows by the raw `equipmentTag` would disagree with
 * the compile on exactly the rows a site cares about most: the ones a word
 * processor rewrote. `MAH001–10–01` below is spelled with en dashes (U+2013),
 * which is what a MEL pasted out of a specification actually contains.
 */

/** Asset ids are `tag:` + the model's own spelling, as the catalog builds them. */
function asset(canonicalTag) {
  return {
    assetId: `tag:${canonicalTag}`,
    canonicalTag,
    assignedAttributes: new Map(),
  };
}

const HYPHEN_TAG = 'MAH001-10-01';
const EN_DASH_TAG = 'MAH001–10–01';

const MEL_ROW = {
  equipmentTag: EN_DASH_TAG,
  systemKey: '001',
  systemDescription: 'Air handling',
  sourceFile: 'MEL.xlsx',
  sheet: 'MEL',
  row: 2,
};

/** The step a profile names to mean "compare the characters a person would". */
const FOLD = { tagNormalization: [{ kind: 'unicodeFold' }] };

const MEL_DEFINITION = {
  attributeId: 'melSystem',
  label: 'MEL system',
  resolverChain: [{ kind: 'mel-lookup', joinBy: 'equipmentTag', returnField: 'systemDescription' }],
};

function subjectFor(modelAsset) {
  return {
    asset: modelAsset,
    subject: { assetId: modelAsset.assetId, properties: new Map() },
    system: null,
    anatomy: null,
  };
}

test('an en-dash MEL tag joins to the hyphen asset under the profile fold', () => {
  const model = asset(HYPHEN_TAG);
  const byAsset = indexMelByAsset([MEL_ROW], [model], FOLD);
  assert.deepEqual([...byAsset.keys()], [model.assetId]);
  assert.deepEqual(byAsset.get(model.assetId), [MEL_ROW]);
});

test('the preview resolves a mel-lookup rung through that join', () => {
  const model = asset(HYPHEN_TAG);
  const preview = buildDerivedPreview(
    MEL_DEFINITION,
    [subjectFor(model)],
    indexMelByAsset([MEL_ROW], [model], FOLD),
  );
  assert.equal(preview.state, 'ready');
  assert.equal(preview.resolvedCount, 1);
  assert.equal(preview.coverage, 1);
  assert.deepEqual(
    preview.samples.map((sample) => sample.value),
    ['Air handling'],
  );
});

test('without the fold the row joins to nothing, as the compile would also find', () => {
  const model = asset(HYPHEN_TAG);
  const byAsset = indexMelByAsset([MEL_ROW], [model], {});
  assert.equal(byAsset.size, 0);
  const preview = buildDerivedPreview(MEL_DEFINITION, [subjectFor(model)], byAsset);
  assert.equal(preview.resolvedCount, 0);
  assert.deepEqual(preview.unresolvedExamples, [HYPHEN_TAG]);
});

test('a tag two assets carry joins to neither, the refusal the compile takes', () => {
  const first = { ...asset(HYPHEN_TAG), assetId: 'object:1' };
  const second = { ...asset(HYPHEN_TAG), assetId: 'object:2' };
  const byAsset = indexMelByAsset([MEL_ROW], [first, second], FOLD);
  assert.equal(byAsset.size, 0);
});

test('a row whose tag matches nothing, and a blank tag, are both dropped', () => {
  const model = asset(HYPHEN_TAG);
  const byAsset = indexMelByAsset(
    [{ equipmentTag: '   ' }, { equipmentTag: 'PNL999-10-01' }, MEL_ROW],
    [model],
    FOLD,
  );
  assert.equal(byAsset.size, 1);
  assert.deepEqual(byAsset.get(model.assetId), [MEL_ROW]);
});

test('every row of one asset is kept, in MEL order', () => {
  const model = asset(HYPHEN_TAG);
  const second = { ...MEL_ROW, row: 7, systemDescription: 'Second row' };
  const byAsset = indexMelByAsset([MEL_ROW, second], [model], FOLD);
  assert.deepEqual(byAsset.get(model.assetId), [MEL_ROW, second]);
});
