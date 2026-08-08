import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSystemCatalog, resolveSystems } from '../dist/index.js';
import {
  COLLIDING_MEL,
  KEY_AND_DESCRIPTION_JOIN,
  PAD_KEY_CORROBORATION,
  PAD_THEN_MEL,
  RAGGED_MEL,
  UNPADDED_MEL,
  VFD001_UNPADDED,
  props,
} from './dist/dragon.fixture.js';

function resolveOne(subject, config, context) {
  return resolveSystems([subject], config, context).bySubject.get(subject.assetId);
}

function skipOf(resolved, chain) {
  return resolved.skippedRungs.find((rung) => rung.chain === chain);
}

test('§5.5: a padded key still finds the system the MEL spelled unpadded', () => {
  const { catalog } = buildSystemCatalog(UNPADDED_MEL);
  const resolved = resolveOne(VFD001_UNPADDED, PAD_THEN_MEL, { catalog, melRows: UNPADDED_MEL });
  assert.equal(resolved.resolution.systemKey, '001');
  assert.equal(resolved.resolution.systemDescription, 'Utility Water');
  assert.deepEqual(resolved.descriptionClaim.provenance.sourceRef, {
    kind: 'sheet-row',
    sheet: 'MEL',
    row: 2,
  });
});

test('the same join works with MEL rows alone and no catalog built', () => {
  const resolved = resolveOne(VFD001_UNPADDED, PAD_THEN_MEL, { melRows: UNPADDED_MEL });
  assert.equal(resolved.resolution.systemDescription, 'Utility Water');
});

test('two MEL keys that normalization collapses onto one yield nothing, never a guess', () => {
  const { catalog } = buildSystemCatalog(COLLIDING_MEL);
  const resolved = resolveOne(VFD001_UNPADDED, PAD_THEN_MEL, { catalog, melRows: COLLIDING_MEL });
  assert.equal(resolved.resolution.systemKey, '001');
  assert.equal('systemDescription' in resolved.resolution, false);

  const skipped = skipOf(resolved, 'descriptionChain');
  assert.equal(skipped.reason, 'ambiguous-join');
  assert.ok(skipped.detail.includes('1'));
  assert.ok(skipped.detail.includes('001'));
});

test('the ambiguity is the same with MEL rows alone', () => {
  const resolved = resolveOne(VFD001_UNPADDED, PAD_THEN_MEL, { melRows: COLLIDING_MEL });
  assert.equal(skipOf(resolved, 'descriptionChain').reason, 'ambiguous-join');
});

test('a systemKey lookup corroborates the padded key and stays in the claim set', () => {
  const { catalog } = buildSystemCatalog(UNPADDED_MEL);
  const resolved = resolveOne(VFD001_UNPADDED, PAD_KEY_CORROBORATION, {
    catalog,
    melRows: UNPADDED_MEL,
  });
  assert.equal(resolved.agreement, 'agreement');
  assert.deepEqual(
    resolved.claims.map((claim) => [claim.component, claim.rawValue, claim.proposedValue]),
    [
      ['model-field', '1', '001'],
      // The MEL's own spelling is what the rung read; the pad is on the record.
      ['mel-lookup', '1', '001'],
    ],
  );
});

test('an ambiguous corroboration rung yields no key claim of its own', () => {
  const { catalog } = buildSystemCatalog(COLLIDING_MEL);
  const resolved = resolveOne(VFD001_UNPADDED, PAD_KEY_CORROBORATION, {
    catalog,
    melRows: COLLIDING_MEL,
  });
  assert.equal(resolved.resolution.systemKey, '001');
  assert.equal(resolved.agreement, 'single-source');
  assert.equal(skipOf(resolved, 'keyChain').reason, 'ambiguous-join');
});

/**
 * The row a key join points at is served from an index built once per compile.
 * This is the scan that index replaced, written out in full: whatever it says
 * about a value and a row address, the resolver has to say too.
 */
function scanForRow(melRows, catalog, melKey, field) {
  let value = '';
  if (catalog !== undefined) {
    const entry = catalog.get(melKey);
    if (entry !== undefined) {
      value = field === 'systemKey' ? melKey : (entry.description ?? '');
    }
  } else if (melRows !== undefined) {
    for (const row of melRows) {
      if ((row.systemKey?.trim() ?? '') !== melKey) {
        continue;
      }
      const candidate = field === 'systemKey' ? melKey : (row.systemDescription?.trim() ?? '');
      if (candidate.length > 0) {
        value = candidate;
        break;
      }
    }
  }
  if (value.length === 0) {
    return null;
  }
  const backing = melRows?.find(
    (row) =>
      (row.systemKey?.trim() ?? '') === melKey &&
      (field === 'systemKey' || (row.systemDescription?.trim() ?? '') === value),
  );
  return {
    value,
    sourceFile: backing?.sourceFile ?? '',
    sourceRef: { kind: 'sheet-row', sheet: backing?.sheet ?? '', row: backing?.row ?? 0 },
  };
}

function melClaimOf(resolved, chain) {
  return (
    resolved.claims.find((claim) => claim.chain === chain && claim.component === 'mel-lookup') ??
    null
  );
}

function statedBy(claim) {
  return claim === null
    ? null
    : {
        value: claim.proposedValue,
        sourceFile: claim.provenance.sourceFile,
        sourceRef: claim.provenance.sourceRef,
      };
}

/** `999` is stated by no row at all; the rest each exercise a different row shape. */
const RAGGED_KEYS = ['100', '200', '300', '999'];

for (const withCatalog of [true, false]) {
  const label = withCatalog ? 'with a catalog' : 'with MEL rows alone';

  test(`a key join addresses the same rows the scan did, ${label}`, () => {
    const catalog = withCatalog ? buildSystemCatalog(RAGGED_MEL).catalog : undefined;
    const context = withCatalog ? { catalog, melRows: RAGGED_MEL } : { melRows: RAGGED_MEL };

    for (const key of RAGGED_KEYS) {
      const subject = {
        assetId: `ragged-${key}`,
        canonicalTag: `EQ${key}`,
        properties: props([['Dragon', 'UPN', key]]),
      };
      const resolved = resolveOne(subject, KEY_AND_DESCRIPTION_JOIN, context);

      assert.deepEqual(
        statedBy(melClaimOf(resolved, 'keyChain')),
        scanForRow(RAGGED_MEL, catalog, key, 'systemKey'),
        `key claim for ${key} ${label}`,
      );
      assert.deepEqual(
        statedBy(melClaimOf(resolved, 'descriptionChain')),
        scanForRow(RAGGED_MEL, catalog, key, 'systemDescription'),
        `description claim for ${key} ${label}`,
      );
    }
  });
}

test('the row a description came from is the first row stating it, not the first stating the key', () => {
  const { catalog } = buildSystemCatalog(RAGGED_MEL);
  const subject = {
    assetId: 'ragged-100',
    canonicalTag: 'EQ100',
    properties: props([['Dragon', 'UPN', '100']]),
  };
  const resolved = resolveOne(subject, KEY_AND_DESCRIPTION_JOIN, { catalog, melRows: RAGGED_MEL });

  // Row 2 is the first row stating `100` -- it spells the key with whitespace
  // and states no description at all.
  assert.deepEqual(melClaimOf(resolved, 'keyChain').provenance.sourceRef, {
    kind: 'sheet-row',
    sheet: 'MEL',
    row: 2,
  });
  // Row 3 is the first row stating `100` AND `Chilled Water`. Row 4 restates it
  // and row 5 rivals it; neither may win.
  assert.equal(resolved.descriptionClaim.proposedValue, 'Chilled Water');
  assert.deepEqual(resolved.descriptionClaim.provenance.sourceRef, {
    kind: 'sheet-row',
    sheet: 'MEL',
    row: 3,
  });
});

test('a blank or missing MEL key never leaks into a real key bucket', () => {
  const { catalog } = buildSystemCatalog(RAGGED_MEL);
  const subject = {
    assetId: 'ragged-300',
    canonicalTag: 'EQ300',
    properties: props([['Dragon', 'UPN', '300']]),
  };
  const resolved = resolveOne(subject, KEY_AND_DESCRIPTION_JOIN, { catalog, melRows: RAGGED_MEL });

  // Row 9 states `300` with a whitespace-only description; row 10 is the first
  // that actually describes it. `Nothing At All` sits on a blank key and is
  // unreachable.
  assert.equal(resolved.descriptionClaim.proposedValue, 'Instrument Air');
  assert.deepEqual(resolved.descriptionClaim.provenance.sourceRef, {
    kind: 'sheet-row',
    sheet: 'MEL',
    row: 10,
  });
});

test('a key no row states resolves to no MEL claim at all', () => {
  const { catalog } = buildSystemCatalog(RAGGED_MEL);
  const subject = {
    assetId: 'ragged-999',
    canonicalTag: 'EQ999',
    properties: props([['Dragon', 'UPN', '999']]),
  };
  const resolved = resolveOne(subject, KEY_AND_DESCRIPTION_JOIN, { catalog, melRows: RAGGED_MEL });
  assert.equal(melClaimOf(resolved, 'keyChain'), null);
  assert.equal(resolved.descriptionClaim, null);
  assert.equal(skipOf(resolved, 'descriptionChain').reason, 'no-value');
});
