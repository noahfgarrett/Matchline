import type { AssetCatalog, ModelAsset } from '@matchline/asset-catalog';
import type { SegmentName, TagAnatomyConfig } from '@matchline/domain';
import { applyAnatomy, type AnatomyResult } from '@matchline/tag-anatomy';
import { expandComposite, type MelCatalogRow, type ResolverSubject } from '@matchline/system-resolver';

import type {
  WireAttributeResolver,
  WireDerivedAttribute,
  WireDerivedPreview,
  WireDerivedRungUsage,
  WireDerivedSample,
} from '../../shared/schemas.js';

/**
 * Screen 6's derived-attribute manager: what one definition would resolve to,
 * over the assets this project actually has (P0-7).
 *
 * ## Why the evaluation is here and not called
 *
 * `@matchline/compiler` owns the real evaluator (`derivedAttributesFor`) and
 * runs it inside `compileProject`. It is not on the package's public surface —
 * the compiler exports one entry point plus the validation and the attribute
 * keys — so a preview that wanted to call it would have to widen an engine
 * package's exports from a UI milestone. This module walks the same chain
 * instead, and the rules it walks by are the engine's, restated once here:
 *
 * 1. **First rung wins.** The chain is ordered; the first rung yielding a
 *    non-blank value supplies the answer and the rest are not consulted.
 * 2. **Missing stays missing.** A chain nothing answered leaves the attribute
 *    off the asset. There is no default value, ever — a fallback that reached a
 *    boundary would let two assets nobody located compare equal (ENGINE.md
 *    binding rule 4).
 * 3. **Blank is not a value.** A rung that yields whitespace has said nothing.
 *
 * Where a rung's semantics live in a published function, that function is
 * called rather than copied: `composite` is `expandComposite` from
 * `@matchline/system-resolver` — the same one the compiler uses, so a site that
 * taught Matchline `{segment:role}` for its systems meets exactly one spelling —
 * and `tag-segment` reads `applyAnatomy`'s own result.
 *
 * This is a preview and says so: it reports coverage, which rung answered and
 * eight examples. It never writes, and the compile remains the only thing whose
 * numbers are the answer. `derived-preview.test.mjs` pins the three rules above
 * against the compiler's own behaviour on the Dragon fixture, which is what
 * stops the restatement drifting.
 */

/** Everything one asset's chain may consult. Assembled once per asset. */
export interface DerivedPreviewSubject {
  readonly asset: ModelAsset;
  readonly subject: ResolverSubject;
  /** What the System Resolver settled on, or `null` when it resolved nothing. */
  readonly system: {
    readonly systemKey: string;
    readonly systemDescription: string;
    readonly systemLabel: string;
  } | null;
  /** `applyAnatomy` for this asset's tag, or `null` when no anatomy is taught. */
  readonly anatomy: AnatomyResult | null;
}

const SAMPLE_LIMIT = 8;

/** Trimmed, or `null` when the rung said nothing. A blank is not a value. */
function meaningful(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** One rung named the way the editor names it. Main owns the wording. */
export function describeResolver(resolver: WireAttributeResolver): string {
  switch (resolver.kind) {
    case 'model-property': {
      if (resolver.chain.length === 0) {
        return 'Model property (none chosen)';
      }
      const first = resolver.chain[0];
      const rest = resolver.chain.length - 1;
      return (
        `Model property "${first?.category ?? ''} > ${first?.name ?? ''}"` +
        (rest === 0 ? '' : ` and ${String(rest)} more`)
      );
    }
    case 'tag-segment':
      return `Tag segment "${resolver.segment}"`;
    case 'source-assignment':
      return `Source assignment "${resolver.key}"`;
    case 'system-field':
      return `System ${
        resolver.field === 'systemKey'
          ? 'key'
          : resolver.field === 'systemLabel'
            ? 'label'
            : 'description'
      }`;
    case 'composite':
      return `Composite "${resolver.template}"`;
    case 'mel-lookup':
      return `MEL lookup by equipment tag → ${resolver.returnField}`;
    case 'manual':
      return `Assigned by hand (${String(resolver.assignments.length)} rows)`;
    default: {
      const exhaustive: never = resolver;
      throw new Error(`Unhandled resolver: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Runs one rung against one asset.
 *
 * Each branch reads what it addresses and nothing else; no rung consults the
 * chain around it, which is what keeps chain order the whole of the precedence
 * story.
 */
function evaluateRung(
  resolver: WireAttributeResolver,
  context: DerivedPreviewSubject,
  melByTag: ReadonlyMap<string, readonly MelCatalogRow[]>,
): string | null {
  const { asset, subject } = context;

  switch (resolver.kind) {
    case 'model-property': {
      // The rung is itself an ordered chain of addresses: first non-blank wins,
      // exactly as a mapped field's chain does (P0-8).
      for (const property of resolver.chain) {
        const value = meaningful(subject.properties.get(property.category)?.get(property.name));
        if (value !== null) {
          return value;
        }
      }
      return null;
    }

    case 'tag-segment': {
      const anatomy = context.anatomy;
      if (anatomy === null || !anatomy.matched) {
        return null;
      }
      return meaningful(anatomy.segments[resolver.segment as SegmentName]);
    }

    case 'source-assignment':
      return meaningful(asset.assignedAttributes.get(resolver.key));

    case 'system-field': {
      const system = context.system;
      if (system === null) {
        return null;
      }
      return meaningful(system[resolver.field]);
    }

    case 'composite': {
      const expanded = expandComposite(resolver.template, subject, context.anatomy);
      return expanded.ok ? meaningful(expanded.value) : null;
    }

    case 'mel-lookup': {
      if (asset.canonicalTag === '') {
        return null;
      }
      // First row that both matches the tag and actually states the field —
      // the same rule the system resolver's tag join follows.
      for (const row of melByTag.get(asset.canonicalTag) ?? []) {
        const value = meaningful(
          (row as unknown as Record<string, string | undefined>)[resolver.returnField],
        );
        if (value !== null) {
          return value;
        }
      }
      return null;
    }

    case 'manual': {
      const assigned = resolver.assignments.find((entry) => entry.assetId === asset.assetId);
      return meaningful(assigned?.value);
    }

    default: {
      const exhaustive: never = resolver;
      throw new Error(`Unhandled resolver: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * The MEL indexed the one way a derived rung joins into it: by equipment tag.
 *
 * Built once per preview rather than per asset, because a 40,000-asset project
 * with a 6,000-row MEL would otherwise be a quarter of a billion comparisons on
 * a screen that recomputes as somebody types.
 */
export function indexMelByTag(
  rows: readonly MelCatalogRow[],
): ReadonlyMap<string, readonly MelCatalogRow[]> {
  const byTag = new Map<string, MelCatalogRow[]>();
  for (const row of rows) {
    const tag = row.equipmentTag?.trim() ?? '';
    if (tag === '') {
      continue;
    }
    const bucket = byTag.get(tag) ?? [];
    bucket.push(row);
    byTag.set(tag, bucket);
  }
  return byTag;
}

/**
 * Builds one `DerivedPreviewSubject` per catalog asset.
 *
 * `anatomy` is run here rather than inside the chain so a 40,000-asset project
 * parses each tag once instead of once per rung, and so "no anatomy taught" and
 * "the anatomy did not match this tag" stay two different values.
 */
export function derivedSubjectsFor(
  catalog: AssetCatalog,
  subjects: readonly ResolverSubject[],
  anatomy: TagAnatomyConfig | null,
  systems: ReadonlyMap<
    string,
    { readonly systemKey: string; readonly systemDescription: string; readonly systemLabel: string }
  >,
): readonly DerivedPreviewSubject[] {
  const subjectById = new Map(subjects.map((subject) => [subject.assetId, subject] as const));
  const built: DerivedPreviewSubject[] = [];

  for (const asset of catalog.assets) {
    const subject = subjectById.get(asset.assetId);
    if (subject === undefined) {
      continue;
    }
    built.push({
      asset,
      subject,
      system: systems.get(asset.assetId) ?? null,
      anatomy:
        anatomy === null || asset.canonicalTag === ''
          ? null
          : applyAnatomy(anatomy, asset.canonicalTag),
    });
  }
  return built;
}

/**
 * What one definition resolves to across the universe.
 *
 * A definition whose chain is empty is `blocked` rather than a zero-coverage
 * `ready`: it is not a field that answers for nobody, it is a field nobody has
 * finished describing, and the two need different sentences on the screen.
 */
export function buildDerivedPreview(
  definition: WireDerivedAttribute,
  contexts: readonly DerivedPreviewSubject[],
  melByTag: ReadonlyMap<string, readonly MelCatalogRow[]>,
): WireDerivedPreview {
  if (definition.resolverChain.length === 0) {
    return {
      state: 'blocked',
      reason: 'Add at least one source below to see what this attribute resolves to.',
    };
  }

  const won = definition.resolverChain.map((): number => 0);
  const claimed = definition.resolverChain.map((): number => 0);
  const samples: WireDerivedSample[] = [];
  const unresolvedExamples: string[] = [];
  const distinct = new Set<string>();
  let resolvedCount = 0;

  for (const context of contexts) {
    let winner: { readonly value: string; readonly rungIndex: number } | null = null;

    for (const [rungIndex, resolver] of definition.resolverChain.entries()) {
      const value = evaluateRung(resolver, context, melByTag);
      if (value === null) {
        continue;
      }
      // Every rung that COULD answer is counted, winner or not: a rung that
      // never wins but always disagrees is the thing worth finding before this
      // attribute ends up on a boundary level.
      claimed[rungIndex] = (claimed[rungIndex] ?? 0) + 1;
      if (winner === null) {
        winner = { value, rungIndex };
      }
    }

    if (winner === null) {
      if (unresolvedExamples.length < SAMPLE_LIMIT) {
        unresolvedExamples.push(
          context.asset.canonicalTag === '' ? context.asset.assetId : context.asset.canonicalTag,
        );
      }
      continue;
    }

    resolvedCount += 1;
    won[winner.rungIndex] = (won[winner.rungIndex] ?? 0) + 1;
    distinct.add(winner.value);

    if (samples.length < SAMPLE_LIMIT) {
      const resolver = definition.resolverChain[winner.rungIndex];
      samples.push({
        assetId: context.asset.assetId,
        canonicalTag: context.asset.canonicalTag,
        value: winner.value,
        from: resolver === undefined ? 'Unknown source' : describeResolver(resolver),
      });
    }
  }

  const rungUsage: WireDerivedRungUsage[] = definition.resolverChain.map(
    (resolver, rungIndex): WireDerivedRungUsage => ({
      rungIndex,
      kind: resolver.kind,
      label: describeResolver(resolver),
      wonCount: won[rungIndex] ?? 0,
      claimCount: claimed[rungIndex] ?? 0,
    }),
  );

  return {
    state: 'ready',
    assetCount: contexts.length,
    resolvedCount,
    coverage: contexts.length === 0 ? 0 : resolvedCount / contexts.length,
    distinctValueCount: distinct.size,
    rungUsage,
    samples,
    unresolvedExamples,
  };
}
