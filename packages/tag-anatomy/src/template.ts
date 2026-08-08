/**
 * Family-key templates: `{system}-{token:1}-{token:2}` and friends.
 *
 * The placeholder pattern below is a fixed literal applied to profile text. No
 * regular expression is ever built from what a profile says.
 */
import type { SegmentName } from '@matchline/domain';

import { SEGMENT_NAMES } from './tokens.js';

/** A `{...}` run with no nested brace. Stray braces stay literal. */
const PLACEHOLDER = /\{([^{}]*)\}/g;

/** A decimal index with no sign, no padding and no whitespace. */
const INDEX = /^(0|[1-9][0-9]*)$/;

const TOKEN_PREFIX = 'token:';
const TOKEN_RANGE_PREFIX = 'tokens:';

export type TemplateOutcome =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly detail: string };

/** What a template is allowed to refer to. */
export interface TemplateContext {
  readonly segments: Readonly<Partial<Record<SegmentName, string>>>;
  readonly tokens: readonly string[];
  /** Separator `{tokens:N-M}` rejoins with. */
  readonly join: string;
}

function isSegmentName(value: string): value is SegmentName {
  return (SEGMENT_NAMES as ReadonlyArray<string>).includes(value);
}

function parseIndex(text: string): number | null {
  return INDEX.test(text) ? Number(text) : null;
}

function resolvePlaceholder(body: string, context: TemplateContext): TemplateOutcome {
  if (isSegmentName(body)) {
    const value = context.segments[body];
    return value === undefined
      ? { ok: false, detail: `{${body}} needs the ${body} segment, which this anatomy does not extract` }
      : { ok: true, value };
  }

  if (body.startsWith(TOKEN_PREFIX)) {
    const index = parseIndex(body.slice(TOKEN_PREFIX.length));
    if (index === null) {
      return { ok: false, detail: `{${body}} is not a token index` };
    }
    const token = context.tokens[index];
    return token === undefined
      ? {
          ok: false,
          detail: `{${body}} needs token ${index} (the tag has ${context.tokens.length} token(s))`,
        }
      : { ok: true, value: token };
  }

  if (body.startsWith(TOKEN_RANGE_PREFIX)) {
    const [fromText, toText, ...rest] = body.slice(TOKEN_RANGE_PREFIX.length).split('-');
    if (fromText === undefined || toText === undefined || rest.length > 0) {
      return { ok: false, detail: `{${body}} is not an N-M token range` };
    }
    const from = parseIndex(fromText);
    const to = parseIndex(toText);
    if (from === null || to === null || to < from) {
      return { ok: false, detail: `{${body}} is not an N-M token range` };
    }
    if (to >= context.tokens.length) {
      return {
        ok: false,
        detail: `{${body}} runs past the end (the tag has ${context.tokens.length} token(s))`,
      };
    }
    return { ok: true, value: context.tokens.slice(from, to + 1).join(context.join) };
  }

  return { ok: false, detail: `{${body}} is not a placeholder this engine knows` };
}

/**
 * Expands every placeholder, or fails naming the first one it could not fill.
 *
 * Half-expanded templates are never returned: a family key with a literal
 * `{system}` in it would silently become a real grouping key.
 */
export function expandTemplate(template: string, context: TemplateContext): TemplateOutcome {
  let expanded = '';
  let cursor = 0;
  for (const match of template.matchAll(PLACEHOLDER)) {
    const start = match.index;
    if (start === undefined) {
      continue;
    }
    expanded += template.slice(cursor, start);
    const resolved = resolvePlaceholder(match[1] ?? '', context);
    if (!resolved.ok) {
      return resolved;
    }
    expanded += resolved.value;
    cursor = start + match[0].length;
  }
  return { ok: true, value: expanded + template.slice(cursor) };
}
