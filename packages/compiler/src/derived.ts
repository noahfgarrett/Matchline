/**
 * Derived attributes: the evaluator (P0-7).
 *
 * `@matchline/domain` states what a `DerivedAttributeDefinition` is; this runs
 * one. It lives in the compiler because a resolver chain reads the property bag,
 * the tag anatomy, the System Resolver's answer, the source assignments and the
 * MEL -- and the orchestrator is the only place all five are in hand at once.
 *
 * ## Deliberately the System Resolver's shape
 *
 * A rung is a pure `(resolver, subject) -> value | nothing`, the chain is walked
 * in order, the first non-blank value wins and every rung's outcome is a fact
 * about that asset rather than about the chain. `composite` is not merely
 * modelled on §5.2's templates -- it IS `expandComposite`, imported, so a site
 * that taught Matchline `{segment:role}` for its systems does not meet a second
 * spelling here.
 *
 * ## What this may never do
 *
 * Invent a value. A chain that yields nothing leaves the attribute off the
 * asset, and `foldBoundaries` then treats it as unknown and refuses to nest on
 * it. A default here would let two assets nobody located compare equal at a
 * boundary, which is exactly what ENGINE.md binding rule 4 forbids -- and a
 * derived attribute is addressable by a boundary level like any other.
 */
import { assertNever, isDerivedAttributeId } from '@matchline/domain';
import type {
  AttributeResolver,
  DerivedAttributeDefinition,
  Provenance,
  SystemResolution,
  TagAnatomyConfig,
} from '@matchline/domain';
import type { ModelAsset } from '@matchline/asset-catalog';
import { applyAnatomy } from '@matchline/tag-anatomy';
import type { AnatomyResult } from '@matchline/tag-anatomy';
import { expandComposite, UNSTATED_ROW, UNSTATED_SOURCE_FILE } from '@matchline/system-resolver';
import type { ResolverSubject } from '@matchline/system-resolver';

import { ATTRIBUTE_KEYS } from './attributes.js';
import { DerivedAttributeConfigError } from './errors.js';
import type { DerivedAttributeValue } from './types.js';

/** One MEL row as the workbook was read, under the project's own field names. */
export type MelRecord = Readonly<Record<string, string | undefined>>;

/** The MEL, addressed the one way a derived rung joins into it: by tag. */
export interface MelJoinIndex {
  /** Every row stating a tag, in workbook order, grouped by that tag. */
  readonly byTag: ReadonlyMap<string, ReadonlyArray<MelRecord>>;
  readonly sourceFile: string;
  readonly sheet: string;
}

/** The empty MEL a project with no workbook resolves against. */
export const NO_MEL_JOIN: MelJoinIndex = {
  byTag: new Map(),
  sourceFile: UNSTATED_SOURCE_FILE,
  sheet: '',
};

/** Everything one asset's chains may consult. Assembled once per asset. */
export interface DerivedSubject {
  readonly asset: ModelAsset;
  readonly subject: ResolverSubject;
  readonly resolution: SystemResolution | null;
  /** `applyAnatomy` for this asset's tag, or `null` when the site taught none. */
  readonly anatomy: AnatomyResult | null;
}

/**
 * Checks a registry and returns it, or refuses it (P0-7).
 *
 * Three refusals, in the order a reader would spot them: a malformed id, an id
 * that shadows a built-in, and two definitions under one id. All three are
 * configuration mistakes whose only other outcome is equipment quietly filed
 * somewhere nobody chose.
 *
 * @throws DerivedAttributeConfigError naming the definition that failed.
 */
export function validateDerivedAttributes(
  definitions: ReadonlyArray<DerivedAttributeDefinition>,
): ReadonlyArray<DerivedAttributeDefinition> {
  const builtIn = new Set<string>(ATTRIBUTE_KEYS);
  const seen = new Set<string>();
  for (const [definitionIndex, definition] of definitions.entries()) {
    const attributeId = definition.attributeId;
    // The collision is checked before the shape: every built-in key is camelCase
    // and would fail the shape test too, and "that is a built-in" is the answer
    // the person who typed `systemKey` actually needs.
    if (builtIn.has(attributeId)) {
      throw new DerivedAttributeConfigError({
        kind: 'built-in-attribute-id',
        attributeId,
        definitionIndex,
      });
    }
    if (!isDerivedAttributeId(attributeId)) {
      throw new DerivedAttributeConfigError({
        kind: 'invalid-attribute-id',
        attributeId,
        definitionIndex,
      });
    }
    if (seen.has(attributeId)) {
      throw new DerivedAttributeConfigError({
        kind: 'duplicate-attribute-id',
        attributeId,
        definitionIndex,
      });
    }
    seen.add(attributeId);
  }
  return definitions;
}

/** Trimmed, or `null` when the rung said nothing. A blank is not a value. */
function meaningful(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Where a rung read its value, before the rung's own identity is stamped on. */
type RungProvenance = Omit<Provenance, 'rule' | 'fallbackRung'>;

/** One rung's answer: a value and where it came from, or nothing. */
interface RungYield {
  readonly value: string;
  readonly provenance: RungProvenance;
}

/** The model-object address a rung's provenance points at. */
function modelRef(subject: ResolverSubject): Provenance['sourceRef'] {
  return { kind: 'model-object', objectId: subject.objectId ?? subject.assetId };
}

function modelProvenance(subject: ResolverSubject, propertyOrColumn: string): RungProvenance {
  return {
    sourceFile: subject.sourceFile ?? UNSTATED_SOURCE_FILE,
    sourceRef: modelRef(subject),
    propertyOrColumn,
  };
}

/**
 * Runs one rung.
 *
 * Every branch reads what it addresses and nothing else; no rung consults the
 * chain around it, which is what keeps chain order the whole of the precedence
 * story -- the same property `@matchline/system-resolver`'s `evaluateComponent`
 * has, and for the same reason.
 */
function evaluateResolver(
  resolver: AttributeResolver,
  context: DerivedSubject,
  mel: MelJoinIndex,
): RungYield | null {
  const { asset, subject } = context;

  switch (resolver.kind) {
    case 'model-property': {
      // The rung is itself an ordered chain of addresses: first non-blank wins,
      // exactly as a mapped field's chain does (P0-8).
      for (const property of resolver.chain) {
        const value = meaningful(subject.properties.get(property.category)?.get(property.name));
        if (value !== null) {
          return {
            value,
            provenance: modelProvenance(subject, `${property.category} > ${property.name}`),
          };
        }
      }
      return null;
    }

    case 'tag-segment': {
      const anatomy = context.anatomy;
      if (anatomy === null || !anatomy.matched) {
        return null;
      }
      const value = meaningful(anatomy.segments[resolver.segment]);
      if (value === null) {
        return null;
      }
      return {
        value,
        provenance: modelProvenance(subject, `tag segment "${resolver.segment}"`),
      };
    }

    case 'source-assignment': {
      const value = meaningful(asset.assignedAttributes.get(resolver.key));
      if (value === null) {
        return null;
      }
      // The assignment's own provenance already names the rule that assigned it
      // (P0-8), so the derived value points at the same document rather than at
      // a second, weaker account of where it came from.
      const assigned = asset.assignedAttributeProvenance.get(resolver.key);
      return {
        value,
        provenance: {
          sourceFile: assigned?.sourceFile ?? subject.sourceFile ?? UNSTATED_SOURCE_FILE,
          sourceRef: assigned?.sourceRef ?? modelRef(subject),
          propertyOrColumn: `source assignment "${resolver.key}"`,
        },
      };
    }

    case 'system-field': {
      const resolution = context.resolution;
      if (resolution === null) {
        return null;
      }
      const value = meaningful(resolution[resolver.field]);
      if (value === null) {
        return null;
      }
      return { value, provenance: modelProvenance(subject, `system ${resolver.field}`) };
    }

    case 'composite': {
      const expanded = expandComposite(resolver.template, subject, context.anatomy);
      if (!expanded.ok) {
        return null;
      }
      return {
        value: expanded.value,
        provenance: modelProvenance(subject, `composite ${resolver.template}`),
      };
    }

    case 'mel-lookup': {
      if (asset.canonicalTag === '') {
        return null;
      }
      // First row that both matches the tag and actually states the field --
      // the same rule `@matchline/system-resolver`'s tag join follows, so the
      // two cannot disagree about which row answered.
      for (const row of mel.byTag.get(asset.canonicalTag) ?? []) {
        const value = meaningful(row[resolver.returnField]);
        if (value !== null) {
          return {
            value,
            provenance: {
              sourceFile: mel.sourceFile,
              // `readMelTable` returns records, not addresses: blank rows are
              // dropped on the way out, so a position in the array is not a
              // sheet row and printing one would be a wrong row number.
              sourceRef: { kind: 'sheet-row', sheet: mel.sheet, row: UNSTATED_ROW },
              propertyOrColumn: resolver.returnField,
            },
          };
        }
      }
      return null;
    }

    case 'manual': {
      const value = meaningful(resolver.assignments.get(asset.assetId));
      if (value === null) {
        return null;
      }
      return {
        value,
        provenance: {
          sourceFile: subject.sourceFile ?? UNSTATED_SOURCE_FILE,
          sourceRef: modelRef(subject),
          manualDecision: `derived attribute assigned by hand`,
        },
      };
    }

    default:
      return assertNever(resolver, 'unhandled AttributeResolver');
  }
}

/** The rule identifier a derived value's provenance carries. */
export function derivedRuleIdOf(
  attributeId: string,
  rungIndex: number,
  kind: AttributeResolver['kind'],
): string {
  return `derivedAttributes.${attributeId}[${String(rungIndex)}].${kind}`;
}

/**
 * Every derived attribute one asset resolves to, in definition order.
 *
 * A definition whose chain yielded nothing contributes no entry at all: missing
 * stays missing, and the caller must not be able to tell "resolved to blank"
 * from "nobody said" by inspecting a value, because there is no difference and
 * pretending otherwise is how a fallback gets invented.
 */
export function derivedAttributesFor(
  definitions: ReadonlyArray<DerivedAttributeDefinition>,
  context: DerivedSubject,
  mel: MelJoinIndex,
): ReadonlyArray<DerivedAttributeValue> {
  const values: DerivedAttributeValue[] = [];
  for (const definition of definitions) {
    for (const [rungIndex, resolver] of definition.resolverChain.entries()) {
      const answer = evaluateResolver(resolver, context, mel);
      if (answer === null) {
        continue;
      }
      values.push({
        attributeId: definition.attributeId,
        value: answer.value,
        rungIndex,
        kind: resolver.kind,
        provenance: {
          ...answer.provenance,
          rule: derivedRuleIdOf(definition.attributeId, rungIndex, resolver.kind),
          // Provenance counts rungs from 1, most direct first.
          fallbackRung: rungIndex + 1,
        },
      });
      break;
    }
  }
  return values;
}

/**
 * Whether any rung in the registry needs the tag anatomy run.
 *
 * `applyAnatomy` is per asset, so on a 40,000-asset project it is 40,000 tag
 * parses -- worth skipping outright for a registry that reads only properties
 * and the MEL. Asked once, before the assets are walked.
 */
export function derivedNeedsAnatomy(
  definitions: ReadonlyArray<DerivedAttributeDefinition>,
): boolean {
  return definitions.some((definition) =>
    definition.resolverChain.some(
      (resolver) => resolver.kind === 'tag-segment' || resolver.kind === 'composite',
    ),
  );
}

/**
 * `applyAnatomy` for one tag.
 *
 * Published so the pipeline can build a `DerivedSubject` without importing
 * `@matchline/tag-anatomy` a second time, and so "no anatomy taught" and "the
 * anatomy did not match this tag" stay two different values rather than one
 * `null` that hides the difference.
 */
export function anatomyResultOf(
  anatomy: TagAnatomyConfig | undefined,
  canonicalTag: string,
): AnatomyResult | null {
  if (anatomy === undefined || canonicalTag === '') {
    return null;
  }
  return applyAnatomy(anatomy, canonicalTag);
}
