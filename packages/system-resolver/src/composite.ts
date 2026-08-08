/**
 * `{Area}-{SystemCode}` style assembly (PRODUCT.md §5.2 component 5).
 *
 * Two placeholder vocabularies, both explicit about where the value comes
 * from, because a bare `{Name}` would be ambiguous the moment two Navisworks
 * categories both carry a `Name`:
 *
 * - `{segment:role}` -- a segment the site taught in its tag anatomy
 * - `{prop:Item.UPN}` -- category `Item`, property `UPN`
 *
 * The category/name split is at the FIRST `.`, so a property name may contain
 * dots (`Item.Revit.Type`= category `Item`, name `Revit.Type`) but a category
 * may not.
 *
 * A composite yields only when every placeholder fills. Half an identifier is
 * worse than none.
 */
import type { EvidenceTier, SegmentName } from '@matchline/domain';
import type { AnatomyResult } from '@matchline/tag-anatomy';

import { COMPONENT_EVIDENCE_TIER, lowestTier } from './tiers.js';
import type { ResolverSubject, SkipReason } from './types.js';

const SEGMENT_NAMES: ReadonlyArray<SegmentName> = ['role', 'system', 'unit', 'instance'];

export interface CompositeFilled {
  readonly ok: true;
  readonly value: string;
  /** Lowest tier among the placeholders that filled it. */
  readonly evidenceTier: EvidenceTier;
  /** Placeholder bodies in template order, for provenance. */
  readonly inputs: ReadonlyArray<string>;
}

export interface CompositeUnfilled {
  readonly ok: false;
  readonly reason: SkipReason;
  readonly detail: string;
}

export type CompositeResult = CompositeFilled | CompositeUnfilled;

function isSegmentName(candidate: string): candidate is SegmentName {
  return (SEGMENT_NAMES as ReadonlyArray<string>).includes(candidate);
}

interface Placeholder {
  readonly body: string;
  readonly start: number;
  readonly end: number;
}

/** Finds `{...}` runs. An unclosed `{` is left as literal text. */
function findPlaceholders(template: string): ReadonlyArray<Placeholder> {
  const found: Placeholder[] = [];
  let cursor = 0;
  for (;;) {
    const open = template.indexOf('{', cursor);
    if (open === -1) {
      return found;
    }
    const close = template.indexOf('}', open + 1);
    if (close === -1) {
      return found;
    }
    found.push({ body: template.slice(open + 1, close), start: open, end: close + 1 });
    cursor = close + 1;
  }
}

/**
 * Expands one composite template against a subject.
 *
 * A template with no placeholders is refused rather than yielding its literal
 * text: a profile constant may not drive a structural decision, and system
 * identity is structural (ENGINE.md semantics rule 4).
 */
export function expandComposite(
  template: string,
  subject: ResolverSubject,
  anatomy: AnatomyResult | null,
): CompositeResult {
  const placeholders = findPlaceholders(template);
  if (placeholders.length === 0) {
    return {
      ok: false,
      reason: 'not-configured',
      detail: `composite template "${template}" has no placeholders; a profile literal may not decide system identity`,
    };
  }

  const tiers: EvidenceTier[] = [];
  const inputs: string[] = [];
  let out = '';
  let cursor = 0;

  for (const placeholder of placeholders) {
    out += template.slice(cursor, placeholder.start);
    cursor = placeholder.end;
    inputs.push(placeholder.body);

    const separator = placeholder.body.indexOf(':');
    if (separator === -1) {
      return {
        ok: false,
        reason: 'placeholder-unfilled',
        detail: `placeholder "{${placeholder.body}}" names neither segment: nor prop:`,
      };
    }
    const kind = placeholder.body.slice(0, separator);
    const address = placeholder.body.slice(separator + 1);

    if (kind === 'segment') {
      if (!isSegmentName(address)) {
        return {
          ok: false,
          reason: 'placeholder-unfilled',
          detail: `placeholder "{${placeholder.body}}" names no known segment`,
        };
      }
      if (anatomy === null) {
        return {
          ok: false,
          reason: 'not-configured',
          detail: `placeholder "{${placeholder.body}}" needs a tag anatomy and none is configured`,
        };
      }
      if (!anatomy.matched) {
        return {
          ok: false,
          reason: 'no-value',
          detail: `placeholder "{${placeholder.body}}": ${anatomy.detail}`,
        };
      }
      const segment = anatomy.segments[address]?.trim() ?? '';
      if (segment.length === 0) {
        return {
          ok: false,
          reason: 'no-value',
          detail: `placeholder "{${placeholder.body}}" is not extracted by this anatomy`,
        };
      }
      out += segment;
      tiers.push(COMPONENT_EVIDENCE_TIER['tag-segment']);
      continue;
    }

    if (kind === 'prop') {
      const dot = address.indexOf('.');
      if (dot === -1) {
        return {
          ok: false,
          reason: 'placeholder-unfilled',
          detail: `placeholder "{${placeholder.body}}" needs Category.Name`,
        };
      }
      const category = address.slice(0, dot);
      const name = address.slice(dot + 1);
      const value = subject.properties.get(category)?.get(name)?.trim() ?? '';
      if (value.length === 0) {
        return {
          ok: false,
          reason: 'no-value',
          detail: `placeholder "{${placeholder.body}}" found no value on ${subject.assetId}`,
        };
      }
      out += value;
      tiers.push(COMPONENT_EVIDENCE_TIER['model-field']);
      continue;
    }

    return {
      ok: false,
      reason: 'placeholder-unfilled',
      detail: `placeholder "{${placeholder.body}}" names neither segment: nor prop:`,
    };
  }

  out += template.slice(cursor);
  const value = out.trim();
  if (value.length === 0) {
    return {
      ok: false,
      reason: 'blank-value',
      detail: `composite template "${template}" expanded to blank`,
    };
  }

  return { ok: true, value, evidenceTier: lowestTier(tiers), inputs };
}
