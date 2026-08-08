/**
 * Tag anatomy configuration: how a site's equipment tags decompose.
 *
 * Types only. The tokenizer, the extractors and the whole-set preview live in
 * `@matchline/tag-anatomy`; the shapes live here so the Site Profile can carry
 * them without depending on the engine package.
 *
 * Anatomy is taught, never guessed (PRODUCT.md §5.4). Nothing here is a
 * regular expression: extractors address structure -- token positions, letter
 * runs, digit runs -- so a profile can never smuggle a pattern into the engine.
 */

/**
 * How one named segment is cut out of a tokenized tag.
 *
 * Token indices are 0-based, counted after `ignoredSuffixes` stripping and
 * after empty tokens are dropped.
 */
export type SegmentExtractor =
  /** The leading run of letters in token N. `MAH001` -> `MAH`. */
  | { readonly kind: 'alphaPrefix'; readonly token: number }
  /** The trailing run of digits in token N. `MAH001` -> `001`. */
  | { readonly kind: 'digitSuffix'; readonly token: number }
  /** All of token N. */
  | { readonly kind: 'token'; readonly token: number }
  /** Tokens `from`..`to`, both ends included, rejoined. */
  | { readonly kind: 'tokenRange'; readonly from: number; readonly to: number }
  /** Characters `[from, to)` of token N -- a 0-based slice, `to` exclusive. */
  | { readonly kind: 'charRange'; readonly token: number; readonly from: number; readonly to: number };

/**
 * The segments Matchline knows how to consume.
 *
 * `role` feeds equipment classification, `system` feeds the System Resolver,
 * and `unit`/`instance` feed the tag-family hierarchy rung (PRODUCT.md §11.2).
 */
export type SegmentName = 'role' | 'system' | 'unit' | 'instance';

/**
 * One site's tag anatomy.
 *
 * `MAH001-10-01` with separators `['-']`, `role: alphaPrefix token 0`,
 * `system: digitSuffix token 0` and `familyKeyTemplate '{system}-{token:1}-{token:2}'`
 * yields role `MAH`, system `001`, family key `001-10-01`.
 */
export interface TagAnatomyConfig {
  /** Split points, matched longest-first. Multi-character separators allowed. */
  readonly separators: ReadonlyArray<string>;
  /** Removed before tokenizing; longest match wins, comparison is case-sensitive. */
  readonly ignoredSuffixes?: ReadonlyArray<string>;
  /** Only the segments named here are extracted, and all of them must hit. */
  readonly segments: Readonly<Partial<Record<SegmentName, SegmentExtractor>>>;
  /** Placeholders: `{role}`, `{system}`, `{unit}`, `{instance}`, `{token:N}`, `{tokens:N-M}`. */
  readonly familyKeyTemplate?: string;
  /** Same placeholder vocabulary as `familyKeyTemplate`. */
  readonly localFamilyTemplate?: string;
}
