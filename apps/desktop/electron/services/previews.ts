import type { AssetCatalog, FilterStageImpact, ModelAsset } from '@matchline/asset-catalog';
import type { SegmentName, SystemComponentConfig } from '@matchline/domain';
import { previewAnatomy, type AnatomyPreview } from '@matchline/tag-anatomy';
import {
  buildSystemCatalog,
  resolveSystems,
  type MelCatalogRow,
  type ResolverSubject,
  type SubjectResolution,
  type SystemClaim,
} from '@matchline/system-resolver';

import type {
  WireAnatomyExample,
  WireAnatomyPreview,
  WireAssetPreview,
  WireDraftProfile,
  WireFilterStage,
  WireResolvedSample,
  WireResolverPreview,
  WireRungUsage,
  WireSampleAsset,
  WireSourceImpact,
  WireSystemConflict,
  WireTagAnatomy,
} from '../../shared/schemas.js';

import { toSystemResolver, toTagAnatomy } from './draft-profile.js';

/**
 * Screens 3-5: engine results turned into something a commissioning engineer
 * can read without knowing the engine.
 *
 * Every number below comes straight out of an engine package — nothing is
 * recomputed here and nothing is rounded. What this module adds is naming: the
 * asset catalog's `FILTER_STAGES` become sentences about objects leaving,
 * anatomy miss reasons become the thing to go and fix, and a resolver rung
 * becomes "Tag segment «system»" instead of `{kind: 'tag-segment'}`.
 */

const SAMPLE_LIMIT = 8;

/* ----------------------------------------------- screen 3: asset definition */

/**
 * What each filter stage means, in the vocabulary of the screen that sets it.
 *
 * Keyed by `FilterStageName`; the asset catalog always reports every stage in
 * order, configured or not, so a zero row is meaningful ("this filter is doing
 * nothing") rather than missing.
 */
const STAGE_LABELS: Readonly<Record<string, string>> = {
  'source-model-files': 'Left out because their source model is not in your list',
  classes: 'Left out by your class include/exclude lists',
  'selection-sets': 'Left out because they are not in the selection sets you named',
  'tag-presence': 'Left out because they carry no equipment tag',
  'tag-patterns': 'Left out because their tag does not match your accepted patterns',
};

function sampleAssetOf(asset: ModelAsset): WireSampleAsset {
  return {
    assetId: asset.assetId,
    canonicalTag: asset.canonicalTag,
    description: asset.description ?? '',
    equipmentType: asset.equipmentType ?? '',
    building: asset.building ?? '',
    objectCount: asset.objectIds.length,
    status: asset.status,
    sourceId: asset.sourceId,
  };
}

/**
 * @param sourceLabels short display name per source id, for the per-source
 * breakdown. A source with no label prints as its own id.
 */
export function buildAssetPreview(
  catalog: AssetCatalog,
  sourceLabels: ReadonlyMap<string, string>,
): WireAssetPreview {
  const impact = catalog.impact;

  const stages: WireFilterStage[] = impact.candidatesAfterEachFilter.map(
    (stage: FilterStageImpact): WireFilterStage => ({
      stage: stage.stage,
      label: STAGE_LABELS[stage.stage] ?? stage.stage,
      inCount: stage.inCount,
      droppedCount: stage.droppedCount,
      outCount: stage.inCount - stage.droppedCount,
    }),
  );

  // `impact.bySource` is keyed by source id ascending by construction, so the
  // rows print in the same order every time without a second sort.
  const bySource: WireSourceImpact[] = [];
  for (const [sourceId, source] of impact.bySource) {
    bySource.push({
      sourceId,
      label: sourceLabels.get(sourceId) ?? sourceId,
      totalObjects: source.totalObjects,
      collapsedCount: source.collapsedCount,
      finalAssetCount: source.finalAssetCount,
      untaggedDroppedCount: source.untaggedDroppedCount,
    });
  }

  return {
    state: 'ready',
    totalObjects: impact.totalObjects,
    stages,
    collapsedCount: impact.collapsedCount,
    finalAssetCount: impact.finalAssetCount,
    duplicateTagCount: impact.duplicateTagCount,
    untaggedDroppedCount: impact.untaggedDroppedCount,
    samples: catalog.assets.slice(0, SAMPLE_LIMIT).map(sampleAssetOf),
    bySource,
  };
}

/* --------------------------------------------------- screen 4: tag anatomy */

/** Every non-blank canonical tag the current filters produced, in catalog order. */
export function catalogTags(catalog: AssetCatalog): readonly string[] {
  return catalog.assets
    .map((asset: ModelAsset): string => asset.canonicalTag)
    .filter((tag: string): boolean => tag !== '');
}

/** What to do about a miss, rather than what the engine called it. */
function explainMiss(reason: string, detail: string): string {
  switch (reason) {
    case 'empty-tag':
      return 'This asset has no tag, so there is nothing to split.';
    case 'no-tokens':
      return 'Splitting this tag on your separators left nothing behind. Check the separator list.';
    case 'extractor-miss':
      return `Nothing matched for "${detail}". Check that segment's token position against the examples above.`;
    default:
      return detail;
  }
}

function exampleOf(
  tag: string,
  segments: Readonly<Partial<Record<SegmentName, string>>>,
  normalizedTag: string,
  familyKey: string | undefined,
  localFamily: string | undefined,
  configured: readonly SegmentName[],
): WireAnatomyExample {
  return {
    tag,
    normalizedTag,
    segments: configured.map((segment: SegmentName) => ({
      segment,
      value: segments[segment] ?? null,
    })),
    familyKey: familyKey ?? '',
    localFamily: localFamily ?? '',
  };
}

export function buildAnatomyPreview(
  wire: WireTagAnatomy,
  catalog: AssetCatalog,
): WireAnatomyPreview {
  const config = toTagAnatomy(wire);
  if (config === null) {
    return { state: 'blocked', reason: 'Add at least one segment to preview it.' };
  }

  const tags = catalogTags(catalog);
  const preview: AnatomyPreview = previewAnatomy(config, tags);
  const configured = wire.segments.map((row): SegmentName => row.segment);

  const examples = preview.examples.map((entry): WireAnatomyExample =>
    exampleOf(
      entry.tag,
      entry.result.segments,
      entry.result.normalizedTag,
      entry.result.familyKey,
      entry.result.localFamily,
      configured,
    ),
  );

  return {
    state: 'ready',
    total: preview.total,
    matchedCount: preview.matchedCount,
    coverage: preview.coverage,
    segmentStats: preview.segmentStats.map((stat) => ({
      segment: stat.segment,
      distinctValueCount: stat.distinctValueCount,
    })),
    examples,
    misses: preview.misses.map((miss) => ({
      tag: miss.tag,
      reason: miss.reason,
      detail: miss.detail,
      explanation: explainMiss(miss.reason, miss.detail),
    })),
    // The first matching tag is what every extractor row is demonstrated on, so
    // the row the user is editing always shows a result rather than a promise.
    sample: examples[0] ?? null,
  };
}

/* ----------------------------------------------- screen 5: System Resolver */

/** One chain rung, named the way the screen names it. */
export function describeComponent(component: SystemComponentConfig): string {
  switch (component.kind) {
    case 'model-field':
      return `Model property "${component.property.category} > ${component.property.name}"`;
    case 'tag-segment':
      return `Tag segment "${component.segment}"`;
    case 'mel-lookup':
      return `MEL lookup: ${
        component.joinBy === 'equipmentTag' ? 'equipment tag' : 'system key'
      } → ${component.returnField === 'systemKey' ? 'system key' : 'description'}`;
    case 'direct-column':
      return `Imported column "${component.property.category} > ${component.property.name}"`;
    case 'composite':
      return `Composite "${component.template}"`;
    case 'manual':
      return 'Manual assignment';
    default: {
      const exhaustive: never = component;
      throw new Error(`Unhandled component: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Mutable tally for one rung, before it becomes a wire row. */
interface RungTally {
  wonCount: number;
  claimCount: number;
  skippedCount: number;
}

function tallyKey(chain: 'keyChain' | 'descriptionChain', rungIndex: number): string {
  return `${chain}:${String(rungIndex)}`;
}

export function buildResolverPreview(
  draft: WireDraftProfile,
  subjects: readonly ResolverSubject[],
  catalog: AssetCatalog,
  melRows: readonly MelCatalogRow[],
): WireResolverPreview {
  const config = toSystemResolver(draft.systemResolver);
  if (config === null) {
    return { state: 'blocked', reason: 'Add at least one System Key source to preview it.' };
  }

  const anatomy = toTagAnatomy(draft.tagAnatomy);
  const systemCatalog = buildSystemCatalog(melRows);

  const result = resolveSystems(subjects, config, {
    ...(anatomy === null ? {} : { anatomy }),
    catalog: systemCatalog.catalog,
    melRows,
  });

  const tagOf = new Map<string, string>(
    catalog.assets.map((asset: ModelAsset): readonly [string, string] => [
      asset.assetId,
      asset.canonicalTag,
    ]),
  );
  // Which file a sampled subject came out of. A resolver preview over a
  // universe has to be able to say "this key came from the controls model",
  // and an asset id only names a source when its tag is duplicated.
  const sourceOf = new Map<string, string>(
    catalog.assets.map((asset: ModelAsset): readonly [string, string] => [
      asset.assetId,
      asset.sourceId,
    ]),
  );

  const tallies = new Map<string, RungTally>();
  const bump = (
    chain: 'keyChain' | 'descriptionChain',
    rungIndex: number,
    field: keyof RungTally,
  ): void => {
    const key = tallyKey(chain, rungIndex);
    const tally = tallies.get(key) ?? { wonCount: 0, claimCount: 0, skippedCount: 0 };
    tally[field] += 1;
    tallies.set(key, tally);
  };

  const samples: WireResolvedSample[] = [];
  const conflicts: WireSystemConflict[] = [];
  const unresolvedExamples: string[] = [];
  const distinctKeys = new Set<string>();
  let resolvedCount = 0;
  let describedCount = 0;

  for (const subject of subjects) {
    const resolution: SubjectResolution | undefined = result.bySubject.get(subject.assetId);
    if (resolution === undefined) {
      continue;
    }

    for (const claim of resolution.claims) {
      bump(claim.chain, claim.rungIndex, 'claimCount');
    }
    for (const skipped of resolution.skippedRungs) {
      bump(skipped.chain, skipped.rungIndex, 'skippedCount');
    }
    if (resolution.keyClaim !== null) {
      bump('keyChain', resolution.keyClaim.rungIndex, 'wonCount');
    }
    if (resolution.descriptionClaim !== null) {
      bump('descriptionChain', resolution.descriptionClaim.rungIndex, 'wonCount');
    }

    const canonicalTag = tagOf.get(subject.assetId) ?? subject.canonicalTag;

    if (resolution.resolution === null) {
      if (unresolvedExamples.length < SAMPLE_LIMIT) {
        unresolvedExamples.push(canonicalTag === '' ? subject.assetId : canonicalTag);
      }
      continue;
    }

    resolvedCount += 1;
    distinctKeys.add(resolution.resolution.systemKey);
    if (resolution.resolution.systemDescription !== undefined) {
      describedCount += 1;
    }

    if (resolution.agreement === 'conflict' && conflicts.length < SAMPLE_LIMIT) {
      conflicts.push({
        assetId: subject.assetId,
        canonicalTag,
        claims: resolution.claims
          .filter((claim: SystemClaim): boolean => claim.chain === 'keyChain')
          .map((claim: SystemClaim) => ({
            value: claim.proposedValue,
            source: describeComponent(config.keyChain[claim.rungIndex] ?? { kind: 'manual' }),
          })),
      });
    }

    if (samples.length < SAMPLE_LIMIT) {
      const keyClaim = resolution.keyClaim;
      samples.push({
        assetId: subject.assetId,
        // Unreachable: every subject was built from a catalog asset above.
        sourceId: sourceOf.get(subject.assetId) ?? subject.assetId,
        canonicalTag,
        systemKey: resolution.resolution.systemKey,
        systemDescription: resolution.resolution.systemDescription ?? '',
        systemLabel: resolution.resolution.systemLabel,
        keySource:
          keyClaim === null
            ? 'No source'
            : describeComponent(config.keyChain[keyClaim.rungIndex] ?? { kind: 'manual' }),
        conflictStatus: resolution.resolution.systemConflictStatus,
      });
    }
  }

  const rungUsage: WireRungUsage[] = [
    ...config.keyChain.map((component, rungIndex) =>
      usageRow('keyChain', rungIndex, component, tallies),
    ),
    ...config.descriptionChain.map((component, rungIndex) =>
      usageRow('descriptionChain', rungIndex, component, tallies),
    ),
  ];

  return {
    state: 'ready',
    subjectCount: subjects.length,
    resolvedCount,
    coverage: subjects.length === 0 ? 0 : resolvedCount / subjects.length,
    describedCount,
    conflictCount: result.reviewItems.filter(
      (item): boolean => item.kind === 'system-conflict',
    ).length,
    distinctSystemCount: distinctKeys.size,
    melRowCount: melRows.length,
    rungUsage,
    samples,
    conflicts,
    unresolvedExamples,
  };
}

function usageRow(
  chain: 'keyChain' | 'descriptionChain',
  rungIndex: number,
  component: SystemComponentConfig,
  tallies: ReadonlyMap<string, RungTally>,
): WireRungUsage {
  const tally = tallies.get(tallyKey(chain, rungIndex)) ?? {
    wonCount: 0,
    claimCount: 0,
    skippedCount: 0,
  };
  return {
    chain,
    rungIndex,
    kind: component.kind,
    label: describeComponent(component),
    wonCount: tally.wonCount,
    claimCount: tally.claimCount,
    skippedCount: tally.skippedCount,
  };
}
