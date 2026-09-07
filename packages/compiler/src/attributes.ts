/**
 * A `HierarchyLevelConfig` attribute key -> a value on a compiled asset
 * (ENGINE.md E3 step 3).
 *
 * A hierarchy level names the fields it groups by, labels itself with and
 * compares at a boundary as plain strings -- `keyAttributeKey`,
 * `displayAttributeKey` and `boundaryAttributeKey` (P0-6) -- which keeps levels
 * composed rather than hardcoded, and leaves somebody to say what those strings
 * mean. That is this file, and the mapping is deliberately a closed, documented
 * table rather than a lookup that would silently accept a typo. All three read
 * the same table: a level may display `systemLabel` while grouping on
 * `systemKey`, and both are populated on every subject.
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
 * ## Plus whatever the site derived
 *
 * A project's own `DerivedAttributeDefinition`s (P0-7) land in the same map
 * under their `attributeId`, so a level addresses one exactly as it addresses a
 * built-in. They cannot shadow the table above: `validateDerivedAttributes`
 * refuses a definition whose id is one of {@link ATTRIBUTE_KEYS} before any
 * asset is evaluated, which is why merging them here needs no precedence rule.
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
import { extoRev21EffectiveDiscipline, extoRev21UpnCandidates } from '@matchline/ssm-audit/exto';

import type { DerivedAttributeValue, SsmDisciplineProjection } from './types.js';

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
 * What the SSM SOP calls an I&C asset's discipline.
 *
 * Not a Matchline decision: `extoRev21EffectiveDiscipline` is the vendored
 * SSM-Audit rule, and this is the value it maps `I&C`, `I & C`,
 * `Instrumentation` and `Instrumentation & Controls` onto.
 */
export const IC_SSM_DISCIPLINE = 'FACILITIES MONITORING SYSTEM';

/** The provenance rule id every value the I&C rule decided carries. */
export const IC_DISCIPLINE_RULE = 'ssm-audit:ic-discipline';

/** Whether the SOP would read this native discipline as instrumentation. */
function isInstrumentation(native: string): boolean {
  return (
    extoRev21EffectiveDiscipline(native) === IC_SSM_DISCIPLINE &&
    native.trim().toUpperCase() !== IC_SSM_DISCIPLINE
  );
}

/**
 * The SSM discipline for one asset.
 *
 * Four rules, in order:
 *
 * 1. No native discipline (absent, or blank once trimmed) -> no SSM discipline.
 *    Absent stays absent: the projection maps disciplines, it does not mint one.
 * 2. A projection entry -> that value. Something a site wrote down beats
 *    everything below it (PRODUCT.md §11.3: `nativeDiscipline` and
 *    `ssmDiscipline` are separate fields, and the SSM one comes from profile
 *    projection rules).
 * 3. `applyIcRule`, and a native discipline the SOP reads as instrumentation ->
 *    {@link IC_SSM_DISCIPLINE}. The rule the SSM SOP states and Exto's
 *    Discipline dropdown enforces: there is no `I&C` in the approved list, so a
 *    register that prints one is an upload Exto refuses. Opt-in, because
 *    turning it on moves assets between disciplines.
 * 4. Otherwise -> the native discipline unchanged.
 *
 * A projection entry that maps to a blank string yields no value rather than an
 * empty one, because a blank at a boundary would be unknown wearing a value's
 * clothes -- and `ssmDiscipline` is a boundary a site can enable.
 */
export function ssmDisciplineOf(
  nativeDiscipline: string | undefined,
  projection?: SsmDisciplineProjection,
  applyIcRule = false,
): string | undefined {
  const native = nativeDiscipline?.trim();
  if (native === undefined || native === '') {
    return undefined;
  }
  const mapped = projection?.get(native);
  if (mapped !== undefined) {
    const trimmed = mapped.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  if (applyIcRule && isInstrumentation(native)) {
    return IC_SSM_DISCIPLINE;
  }
  return native;
}

/**
 * The UPN an I&C asset carries in its own tag.
 *
 * The other half of the SOP's instrumentation rule. An I&C register does not
 * state a system: the transmitter, the panel and the controller all belong to
 * whatever they monitor, and the only place that is written down is the tag --
 * `TIT101-01` is on system 101. So when the rule is on and the asset is
 * instrumentation, the approved UPN in the tag is the system key, ahead of
 * anything the resolver chain settled.
 *
 * `undefined` unless the tag yields exactly one approved UPN. Zero says the tag
 * does not carry one; several says it carries two real systems, and picking
 * between them is not something a projection gets to do.
 */
export function icSystemKeyOf(
  canonicalTag: string,
  nativeDiscipline: string | undefined,
  applyIcRule: boolean,
): string | undefined {
  const native = nativeDiscipline?.trim();
  if (!applyIcRule || native === undefined || native === '' || !isInstrumentation(native)) {
    return undefined;
  }
  const candidates = extoRev21UpnCandidates(canonicalTag);
  return candidates.length === 1 ? candidates[0] : undefined;
}

/** Adds an entry only when the value says something. */
function put(attributes: Map<string, string>, key: string, value: string | undefined): void {
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
 * whatever the System Resolver settled on, and whatever the site derived.
 *
 * `resolution` is `null` for an asset no resolver rung could place. Its three
 * system keys are then simply absent, which is the honest reading -- an
 * unresolved system is not the empty system.
 *
 * `derived` is what `derivedAttributesFor` resolved for this asset (P0-7).
 * Every entry there already yielded a non-blank value, so nothing is filtered
 * here; a definition that yielded nothing produced no entry, and its key stays
 * off the map exactly like an unmapped built-in.
 */
export function attributesFor(
  asset: ModelAsset,
  resolution: SystemResolution | null,
  projection?: SsmDisciplineProjection,
  derived: ReadonlyArray<DerivedAttributeValue> = [],
  applyIcRule = false,
): ReadonlyMap<string, string> {
  const attributes = new Map<string, string>();

  put(attributes, 'canonicalTag', asset.canonicalTag);
  put(attributes, 'description', asset.description);
  put(attributes, 'equipmentType', asset.equipmentType);
  put(attributes, 'building', asset.building);
  put(attributes, 'nativeDiscipline', asset.nativeDiscipline);
  put(
    attributes,
    'ssmDiscipline',
    ssmDisciplineOf(asset.nativeDiscipline, projection, applyIcRule),
  );

  if (resolution !== null) {
    put(attributes, 'systemKey', resolution.systemKey);
    put(attributes, 'systemDescription', resolution.systemDescription);
    put(attributes, 'systemLabel', resolution.systemLabel);
  }

  for (const value of derived) {
    put(attributes, value.attributeId, value.value);
  }

  return attributes;
}

/**
 * The two things the SSM SOP reads out of a tag: its UPN and its instance.
 *
 * Noah's directive is a statement about tags -- "MAH101-01 has a VFD101-01 down
 * the line as a child" -- so the pairing needs `101` and `01` out of every tag,
 * and there are two honest ways to get them.
 *
 * 1. **The site's own anatomy**, when it taught a `system` and an `instance`
 *    segment. A taught anatomy is a person saying where in the tag each thing
 *    lives, and nothing outranks that.
 * 2. **The approved Exto list plus the trailing run**, otherwise. A Revit mark
 *    like `MAH101-01` carries no taught anatomy on most sites, and
 *    `extoRev21UpnCandidates` is the vendored rule for reading an approved UPN
 *    out of a tag -- the same one the I&C discipline rule already uses. The
 *    instance is the trailing `-NN` group, which is what the SOP's own examples
 *    are shaped like.
 *
 * Either half may come back absent, and an absent half simply disqualifies the
 * asset from the rules that need it. Nothing is invented: more than one
 * approved UPN in a tag yields none, because a tag naming two systems has not
 * named one.
 */
export function sopTagFactsOf(
  canonicalTag: string,
  segments: { readonly system?: string; readonly instance?: string },
): { readonly upn?: string; readonly instance?: string } {
  const taughtUpn = segments.system?.trim();
  const taughtInstance = segments.instance?.trim();
  if (taughtUpn !== undefined && taughtUpn !== '' && taughtInstance !== undefined && taughtInstance !== '') {
    return { upn: taughtUpn, instance: taughtInstance };
  }

  const tag = canonicalTag.trim();
  if (tag === '') {
    return {};
  }
  const candidates = extoRev21UpnCandidates(tag);
  const upn = candidates.length === 1 ? candidates[0] : undefined;
  const trailing = /-([0-9]{1,4})$/.exec(tag);
  const instance = trailing === null ? undefined : trailing[1];
  return {
    ...(upn === undefined ? {} : { upn }),
    ...(instance === undefined ? {} : { instance }),
  };
}
