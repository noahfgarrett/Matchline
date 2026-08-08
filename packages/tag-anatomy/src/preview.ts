/**
 * Whole-set preview: what an anatomy does to every tag a site actually has.
 *
 * The setup wizard has to show coverage before a profile is published
 * (PRODUCT.md §7, screen 4), and "it worked on the three tags I typed" is not
 * evidence. Deterministic: examples are first-seen in input order, never
 * sampled.
 */
import type { SegmentName, TagAnatomyConfig } from '@matchline/domain';

import { applyAnatomy, type AnatomyMatch, type AnatomyMissReason } from './anatomy.js';
import { SEGMENT_NAMES } from './tokens.js';

/** How many examples of each outcome a preview carries. */
export const PREVIEW_EXAMPLE_LIMIT = 8;

export interface AnatomySegmentStat {
  readonly segment: SegmentName;
  /** Distinct values the segment produced across every matched tag. */
  readonly distinctValueCount: number;
}

export interface AnatomyPreviewExample {
  readonly tag: string;
  readonly result: AnatomyMatch;
}

export interface AnatomyPreviewMiss {
  readonly tag: string;
  readonly reason: AnatomyMissReason;
  readonly detail: string;
}

export interface AnatomyPreview {
  /** Tags handed in, duplicates included. */
  readonly total: number;
  readonly matchedCount: number;
  /** `matchedCount / total`, or 0 for an empty set. */
  readonly coverage: number;
  /** One entry per configured segment, in `SEGMENT_NAMES` order. */
  readonly segmentStats: ReadonlyArray<AnatomySegmentStat>;
  /** First distinct matching tags, capped at `PREVIEW_EXAMPLE_LIMIT`. */
  readonly examples: ReadonlyArray<AnatomyPreviewExample>;
  /** First distinct failing tags, capped at `PREVIEW_EXAMPLE_LIMIT`. */
  readonly misses: ReadonlyArray<AnatomyPreviewMiss>;
}

/**
 * Runs `applyAnatomy` over every tag and summarizes.
 *
 * Examples are deduplicated by tag so that a set with 4,000 copies of one tag
 * does not fill the preview with the same line eight times; the counts above
 * them still cover every tag handed in.
 */
export function previewAnatomy(
  config: TagAnatomyConfig,
  tags: ReadonlyArray<string>,
): AnatomyPreview {
  const configured = SEGMENT_NAMES.filter((name) => config.segments[name] !== undefined);
  const distinctBySegment = new Map<SegmentName, Set<string>>(
    configured.map((name) => [name, new Set<string>()]),
  );

  const examples: AnatomyPreviewExample[] = [];
  const misses: AnatomyPreviewMiss[] = [];
  const exampleTags = new Set<string>();
  const missTags = new Set<string>();
  let matchedCount = 0;

  for (const tag of tags) {
    const result = applyAnatomy(config, tag);
    if (!result.matched) {
      if (!missTags.has(tag)) {
        missTags.add(tag);
        if (misses.length < PREVIEW_EXAMPLE_LIMIT) {
          misses.push({ tag, reason: result.reason, detail: result.detail });
        }
      }
      continue;
    }

    matchedCount += 1;
    for (const name of configured) {
      const value = result.segments[name];
      if (value !== undefined) {
        distinctBySegment.get(name)?.add(value);
      }
    }
    if (!exampleTags.has(tag)) {
      exampleTags.add(tag);
      if (examples.length < PREVIEW_EXAMPLE_LIMIT) {
        examples.push({ tag, result });
      }
    }
  }

  return {
    total: tags.length,
    matchedCount,
    coverage: tags.length === 0 ? 0 : matchedCount / tags.length,
    segmentStats: configured.map((segment) => ({
      segment,
      distinctValueCount: distinctBySegment.get(segment)?.size ?? 0,
    })),
    examples,
    misses,
  };
}
