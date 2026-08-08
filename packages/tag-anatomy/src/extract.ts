/**
 * Segment extraction: one `SegmentExtractor` against one tokenized tag.
 *
 * A miss carries the reason a person needs to fix their profile, not just a
 * `false` -- the setup wizard shows this text next to the failing tag.
 */
import { assertNever, type SegmentExtractor } from '@matchline/domain';

import { alphaPrefixOf, digitSuffixOf } from './tokens.js';

/** Success carries the extracted text; failure carries why it failed. */
export type ExtractOutcome =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly detail: string };

function missingToken(index: number, tokens: readonly string[]): ExtractOutcome {
  return {
    ok: false,
    detail: `token ${index} does not exist (the tag has ${tokens.length} token(s))`,
  };
}

/**
 * Runs one extractor.
 *
 * `join` is only consulted by `tokenRange`; it is the separator the tokens are
 * rebuilt with, since tokenizing threw the original away.
 */
export function extractSegment(
  extractor: SegmentExtractor,
  tokens: readonly string[],
  join: string,
): ExtractOutcome {
  switch (extractor.kind) {
    case 'alphaPrefix': {
      const token = tokens[extractor.token];
      if (token === undefined) {
        return missingToken(extractor.token, tokens);
      }
      const value = alphaPrefixOf(token);
      return value.length === 0
        ? { ok: false, detail: `token ${extractor.token} "${token}" has no leading letters` }
        : { ok: true, value };
    }
    case 'digitSuffix': {
      const token = tokens[extractor.token];
      if (token === undefined) {
        return missingToken(extractor.token, tokens);
      }
      const value = digitSuffixOf(token);
      return value.length === 0
        ? { ok: false, detail: `token ${extractor.token} "${token}" has no trailing digits` }
        : { ok: true, value };
    }
    case 'token': {
      const token = tokens[extractor.token];
      return token === undefined
        ? missingToken(extractor.token, tokens)
        : { ok: true, value: token };
    }
    case 'tokenRange': {
      // Both ends included: `{tokens:1-2}` reads as "tokens 1 and 2".
      if (extractor.from < 0 || extractor.to < extractor.from) {
        return {
          ok: false,
          detail: `token range ${extractor.from}-${extractor.to} is not a range`,
        };
      }
      if (extractor.to >= tokens.length) {
        return {
          ok: false,
          detail:
            `token range ${extractor.from}-${extractor.to} runs past the end ` +
            `(the tag has ${tokens.length} token(s))`,
        };
      }
      return { ok: true, value: tokens.slice(extractor.from, extractor.to + 1).join(join) };
    }
    case 'charRange': {
      const token = tokens[extractor.token];
      if (token === undefined) {
        return missingToken(extractor.token, tokens);
      }
      // A 0-based slice: `from` included, `to` excluded.
      if (extractor.from < 0 || extractor.to <= extractor.from) {
        return {
          ok: false,
          detail: `character range [${extractor.from}, ${extractor.to}) is empty`,
        };
      }
      if (extractor.to > token.length) {
        return {
          ok: false,
          detail:
            `character range [${extractor.from}, ${extractor.to}) runs past token ` +
            `${extractor.token} "${token}"`,
        };
      }
      return { ok: true, value: token.slice(extractor.from, extractor.to) };
    }
  }
  return assertNever(extractor, 'unhandled SegmentExtractor');
}
