/**
 * `HierarchyLevelConfig.attributeKey` -> a value on a compiled asset
 * (ENGINE.md E3 step 3).
 *
 * A hierarchy level names the field it groups by as a plain string, which keeps
 * levels composed rather than hardcoded -- and leaves somebody to say what those
 * strings mean. That is this file, and the mapping is deliberately a closed,
 * documented table rather than a lookup that would silently accept a typo.
 *
 * ## The attribute keys
 *
 * | key                | source                                            |
 * |--------------------|---------------------------------------------------|
 * | `canonicalTag`     | `ModelAsset.canonicalTag`                          |
 * | `description`      | `ModelAsset.description` (profile-mapped property) |
 * | `equipmentType`    | `ModelAsset.equipmentType`                         |
 * | `building`         | `ModelAsset.building`                              |
 * | `nativeDiscipline` | `ModelAsset.nativeDiscipline`                      |
 * | `ssmDiscipline`    | {@link ssmDisciplineOf} over `nativeDiscipline`    |
 * | `systemKey`        | `SystemResolution.systemKey`                       |
 * | `systemDescription`| `SystemResolution.systemDescription`               |
 * | `systemLabel`      | `SystemResolution.systemLabel`                     |
 *
 * Every key with a value is populated on every subject, not only the ones the
 * configured hierarchy happens to name, so the UI can read an asset's level
 * candidates without recompiling. A level naming anything else finds no value
 * and is treated as unstated -- which is what `missingValuePolicy` is for, and
 * is far safer than inventing a bucket for a misspelled key.
 *
 * ## Explicit values only
 *
 * An absent or blank source field puts no entry in the map (ENGINE.md binding
 * rule 4). `foldBoundaries` treats absent as unknown and refuses to nest on it,
 * so a fallback leaking in here would let two assets nobody located compare
 * equal at a boundary.
 */
import type { SystemResolution } from '@matchline/domain';
import type { ModelAsset } from '@matchline/asset-catalog';

import type { SsmDisciplineProjection } from './types.js';

/** Every attribute key a configured hierarchy level may address. */
export const ATTRIBUTE_KEYS = [
  'canonicalTag',
  'description',
  'equipmentType',
  'building',
  'nativeDiscipline',
  'ssmDiscipline',
  'systemKey',
  'systemDescription',
  'systemLabel',
] as const;

/** One of {@link ATTRIBUTE_KEYS}. */
export type AttributeKey = (typeof ATTRIBUTE_KEYS)[number];

/**
 * The SSM discipline for one asset.
 *
 * Three rules, in order:
 *
 * 1. No native discipline (absent, or blank once trimmed) -> no SSM discipline.
 *    Absent stays absent: the projection maps disciplines, it does not mint one.
 * 2. A projection entry -> that value. This is the only way an SSM discipline
 *    can differ from the native one, and it is always something a site wrote
 *    down (PRODUCT.md §11.3: `nativeDiscipline` and `ssmDiscipline` are separate
 *    fields, and the SSM one comes from profile projection rules).
 * 3. Otherwise -> the native discipline unchanged.
 *
 * A projection entry that maps to a blank string yields no value rather than an
 * empty one, because a blank at a boundary would be unknown wearing a value's
 * clothes -- and `ssmDiscipline` is a boundary a site can enable.
 */
export function ssmDisciplineOf(
  nativeDiscipline: string | undefined,
  projection?: SsmDisciplineProjection,
): string | undefined {
  const native = nativeDiscipline?.trim();
  if (native === undefined || native === '') {
    return undefined;
  }
  const mapped = projection?.get(native);
  if (mapped === undefined) {
    return native;
  }
  const trimmed = mapped.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** Adds an entry only when the value says something. */
function put(attributes: Map<string, string>, key: AttributeKey, value: string | undefined): void {
  if (value === undefined) {
    return;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return;
  }
  attributes.set(key, trimmed);
}

/**
 * The level attributes for one asset: catalog fields, the projected discipline,
 * and whatever the System Resolver settled on.
 *
 * `resolution` is `null` for an asset no resolver rung could place. Its three
 * system keys are then simply absent, which is the honest reading -- an
 * unresolved system is not the empty system.
 */
export function attributesFor(
  asset: ModelAsset,
  resolution: SystemResolution | null,
  projection?: SsmDisciplineProjection,
): ReadonlyMap<string, string> {
  const attributes = new Map<string, string>();

  put(attributes, 'canonicalTag', asset.canonicalTag);
  put(attributes, 'description', asset.description);
  put(attributes, 'equipmentType', asset.equipmentType);
  put(attributes, 'building', asset.building);
  put(attributes, 'nativeDiscipline', asset.nativeDiscipline);
  put(attributes, 'ssmDiscipline', ssmDisciplineOf(asset.nativeDiscipline, projection));

  if (resolution !== null) {
    put(attributes, 'systemKey', resolution.systemKey);
    put(attributes, 'systemDescription', resolution.systemDescription);
    put(attributes, 'systemLabel', resolution.systemLabel);
  }

  return attributes;
}
