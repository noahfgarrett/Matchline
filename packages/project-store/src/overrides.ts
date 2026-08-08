/**
 * Manual overrides: the two places a person overrules the engine, and the
 * shapes they are stored in.
 *
 * Both are keyed by `assetKey` -- the asset's canonical tag. Asset ids are
 * stable across a recompile, but the tag is the identity a person recognises
 * and the one that survives a project being rebuilt from scratch, so the tag is
 * what the row is filed under (PRODUCT.md §4.1, §11.5).
 */
import type { ManualRelationshipOverride } from '@matchline/domain';

import { ProjectStoreError } from './errors.js';
import type { OverrideKind } from './schema.js';
import {
  optionalStringAt,
  requireFilledStringAt,
  requireRecordAt,
  type Fail,
} from './validate.js';

const fail: Fail = (field, detail) => {
  throw new ProjectStoreError({ kind: 'invalid-override', field, detail });
};

/**
 * A person's answer to "what system is this?" (PRODUCT.md §5.6).
 *
 * Both fields are optional because a reviewer often knows the key without the
 * description, or corrects one and leaves the other alone -- but an override
 * with neither says nothing, and is refused rather than stored.
 */
export interface ManualSystemOverride {
  readonly systemKey?: string;
  readonly systemDescription?: string;
}

/** One stored override, discriminated by which kind it is. */
export type StoredOverride =
  | {
      readonly kind: 'system';
      /** The asset's canonical tag. */
      readonly assetKey: string;
      readonly override: ManualSystemOverride;
      readonly updatedAt: string;
    }
  | {
      readonly kind: 'relationship';
      /** The child asset's canonical tag; equals `override.childAssetId`. */
      readonly assetKey: string;
      readonly override: ManualRelationshipOverride;
      readonly updatedAt: string;
    };

/**
 * Validates a system override.
 *
 * @throws ProjectStoreError `invalid-override` when neither field is set, or a
 * field is not a string.
 */
export function validateSystemOverride(value: unknown): ManualSystemOverride {
  const record = requireRecordAt(value, 'systemOverride', fail);
  const systemKey = optionalStringAt(record['systemKey'], 'systemOverride.systemKey', fail);
  const systemDescription = optionalStringAt(
    record['systemDescription'],
    'systemOverride.systemDescription',
    fail,
  );
  if (systemKey === undefined && systemDescription === undefined) {
    fail('systemOverride', 'expected systemKey, systemDescription, or both');
  }

  const override: { systemKey?: string; systemDescription?: string } = {};
  if (systemKey !== undefined) {
    override.systemKey = systemKey;
  }
  if (systemDescription !== undefined) {
    override.systemDescription = systemDescription;
  }
  return override;
}

/**
 * Validates a relationship override.
 *
 * `parentAssetId: null` is a decision, not a gap -- it means "root this asset" --
 * so it is required rather than optional.
 *
 * @throws ProjectStoreError `invalid-override`, naming the field that failed.
 */
export function validateRelationshipOverride(value: unknown): ManualRelationshipOverride {
  const record = requireRecordAt(value, 'relationshipOverride', fail);
  const rawParent = record['parentAssetId'];
  if (rawParent === undefined) {
    fail('relationshipOverride.parentAssetId', 'expected an asset id or null');
  }
  const note = optionalStringAt(record['note'], 'relationshipOverride.note', fail);

  const override: {
    childAssetId: string;
    parentAssetId: string | null;
    note?: string;
  } = {
    childAssetId: requireFilledStringAt(
      record['childAssetId'],
      'relationshipOverride.childAssetId',
      fail,
    ),
    parentAssetId:
      rawParent === null
        ? null
        : requireFilledStringAt(rawParent, 'relationshipOverride.parentAssetId', fail),
  };
  if (note !== undefined) {
    override.note = note;
  }
  if (override.parentAssetId === override.childAssetId) {
    fail('relationshipOverride.parentAssetId', 'an asset cannot be its own parent');
  }
  return override;
}

/** Reads a stored override payload back into its typed shape. */
export function readOverridePayload(
  kind: OverrideKind,
  assetKey: string,
  payload: unknown,
  updatedAt: string,
): StoredOverride {
  if (kind === 'system') {
    return { kind, assetKey, override: validateSystemOverride(payload), updatedAt };
  }
  return { kind, assetKey, override: validateRelationshipOverride(payload), updatedAt };
}
