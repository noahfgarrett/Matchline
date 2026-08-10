/**
 * Derived attributes: fields a site composes rather than reads (P0-7).
 *
 * A hierarchy level names the field it groups by as a plain string, and until
 * now the only strings that meant anything were the compiler's built-in
 * `ATTRIBUTE_KEYS`. P0-7 lets a site define its own -- "Area", "Owner",
 * "Turnover Package" -- out of the evidence it already has, and then group,
 * label or bound on them exactly like a built-in.
 *
 * Types only: the evaluator lives in `@matchline/compiler`, because resolving a
 * chain needs the property bag, the tag anatomy, the System Resolver's answer
 * and the MEL, and the compiler is the one package that holds all four.
 *
 * Three rules govern every definition here, and none of them is negotiable:
 *
 * 1. **First rung wins.** The chain is ordered, the first rung yielding a
 *    non-blank value supplies the answer, and every rung is recorded.
 * 2. **Missing stays missing.** A chain nothing answered leaves the attribute
 *    off the asset. There is no default value, ever -- a fallback value that
 *    reached a boundary would let two assets nobody located compare equal
 *    (ENGINE.md binding rule 4).
 * 3. **Display never decides.** A derived attribute used as a level's display
 *    changes wording; identity is the level's key attribute, and that is a
 *    separate field (P0-6).
 */
import type { SegmentName } from './anatomy.js';
import type { PropertyChain } from './profile.js';

/**
 * One rung of a derived attribute's resolution chain (P0-7).
 *
 * Deliberately the System Resolver's vocabulary (`SystemComponentConfig`) rather
 * than a second one: a site that has already taught Matchline how it names
 * systems should not have to learn a different set of words to name an area.
 * The differences are the two this problem actually has -- a rung that reads a
 * source assignment, and a rung that is a person's own table.
 */
export type AttributeResolver =
  /** An ordered fallback chain of model properties. First non-blank rung wins. */
  | { readonly kind: 'model-property'; readonly chain: PropertyChain }
  /** A segment the site taught in its tag anatomy. */
  | { readonly kind: 'tag-segment'; readonly segment: SegmentName }
  /** A site-defined key from the asset's source assignments (`custom`, P0-8). */
  | { readonly kind: 'source-assignment'; readonly key: string }
  /** Whatever the System Resolver settled on for this asset. */
  | {
      readonly kind: 'system-field';
      readonly field: 'systemKey' | 'systemDescription' | 'systemLabel';
    }
  /** `{segment:role}` / `{prop:Category.Name}` assembly, as §5.2 spells it. */
  | { readonly kind: 'composite'; readonly template: string }
  /**
   * A join into the imported MEL by equipment tag.
   *
   * `returnField` names a field of the MEL mapping the project read the workbook
   * under (`@matchline/spreadsheet-import`'s `MelMapping`): `building`,
   * `discipline`, `projectPhase`, and so on. A field the project did not map
   * yields nothing, exactly as a MEL with no such row does.
   */
  | {
      readonly kind: 'mel-lookup';
      readonly joinBy: 'equipmentTag';
      readonly returnField: string;
    }
  /** A person's own table, by asset id. Never inferred, and never defaulted. */
  | { readonly kind: 'manual'; readonly assignments: ReadonlyMap<string, string> };

/** Every resolver kind, for callers that switch on or validate them. */
export const ATTRIBUTE_RESOLVER_KINDS = [
  'model-property',
  'tag-segment',
  'source-assignment',
  'system-field',
  'composite',
  'mel-lookup',
  'manual',
] as const;

/** One of {@link ATTRIBUTE_RESOLVER_KINDS}. */
export type AttributeResolverKind = (typeof ATTRIBUTE_RESOLVER_KINDS)[number];

/**
 * Compile-time completeness guard. A resolver kind added to the union above
 * without being listed resolves this to `false` and stops this file compiling.
 */
type EveryResolverKindListed =
  Exclude<AttributeResolver['kind'], AttributeResolverKind> extends never ? true : false;

const RESOLVER_KINDS_ARE_COMPLETE: EveryResolverKindListed = true;
void RESOLVER_KINDS_ARE_COMPLETE;

/**
 * One site-defined attribute (P0-7).
 *
 * `attributeId` is the string a hierarchy level addresses, so it lives in the
 * same namespace as the compiler's built-in keys: it must be kebab-case, unique
 * within the profile, and must not collide with a built-in. All three are
 * refused rather than resolved -- a definition that shadowed `systemKey` would
 * silently change where every asset on the site is filed.
 *
 * `displayName` is only what a person reads in the Composer. Renaming it moves
 * nothing (P0-6).
 */
export interface DerivedAttributeDefinition {
  readonly attributeId: string;
  readonly displayName: string;
  readonly resolverChain: ReadonlyArray<AttributeResolver>;
}

/** The shape a valid {@link DerivedAttributeDefinition.attributeId} has. */
export const DERIVED_ATTRIBUTE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Whether `id` is a well-formed kebab-case attribute id. Nothing else. */
export function isDerivedAttributeId(id: string): boolean {
  return DERIVED_ATTRIBUTE_ID_PATTERN.test(id);
}
