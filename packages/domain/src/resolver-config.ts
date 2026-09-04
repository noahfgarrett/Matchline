/**
 * System Resolver configuration (PRODUCT.md §5).
 *
 * Types only; the chain evaluator lives in `@matchline/system-resolver`.
 *
 * System identifiers are strings, always. A site can write `001` in tags, `1`
 * in Excel and `UPN-001` in a model field, and the profile has to say out loud
 * which transform reconciles them -- leading-zero conversion never happens
 * silently (PRODUCT.md §5.5).
 */
import type { SegmentName } from './anatomy.js';
import type { PropertyRef } from './profile.js';

/** One explicit, auditable transform applied to a resolved system value. */
export type NormalizationStep =
  | { readonly kind: 'trim' }
  | { readonly kind: 'uppercase' }
  /** Removes `prefix` when the value starts with it; otherwise a no-op. */
  | { readonly kind: 'stripPrefix'; readonly prefix: string }
  /** Left-pads to `length` with `fill`. `1` -> `001`, stated rather than assumed. */
  | { readonly kind: 'padStart'; readonly length: number; readonly fill: string }
  /** Rewrites one exact value to another. The site's own synonym list. */
  | { readonly kind: 'alias'; readonly from: string; readonly to: string }
  /**
   * NFKC, zero-width strip, dash-family fold, NBSP, whitespace around hyphens.
   *
   * The one step that is about characters nobody typed on purpose rather than
   * about what a site calls things. See {@link unicodeFold}, which both
   * `@matchline/identity` and `@matchline/system-resolver` run for it.
   */
  | { readonly kind: 'unicodeFold' };

/**
 * One rung of a resolution chain (PRODUCT.md §5.2).
 *
 * Every rung produces an `AttributeClaim` whether or not it wins, so a losing
 * rung stays visible in review.
 */
export type SystemComponentConfig =
  /** An extracted object, ancestor or source-model property. */
  | { readonly kind: 'model-field'; readonly property: PropertyRef }
  /** A segment the site taught in its tag anatomy. */
  | { readonly kind: 'tag-segment'; readonly segment: SegmentName }
  /** A join into an imported MEL. */
  | {
      readonly kind: 'mel-lookup';
      readonly joinBy: 'equipmentTag' | 'systemKey';
      readonly returnField: 'systemKey' | 'systemDescription';
    }
  /** A spreadsheet or model-export column the user labelled "System". */
  | { readonly kind: 'direct-column'; readonly property: PropertyRef }
  /** `{Area}-{SystemCode}` style assembly from other components. */
  | { readonly kind: 'composite'; readonly template: string }
  /** Assigned by a person; never inferred. */
  | { readonly kind: 'manual' };

/**
 * How this site resolves system identity.
 *
 * The chains are ordered: the first rung that yields a value supplies the
 * resolved answer, and every rung's claim is kept. When rungs disagree, the
 * default is a review item, not a silent majority vote (PRODUCT.md §5.6).
 */
export interface SystemResolverConfig {
  readonly keyChain: ReadonlyArray<SystemComponentConfig>;
  readonly descriptionChain: ReadonlyArray<SystemComponentConfig>;
  /** Applied to resolved key and description alike, in order. */
  readonly normalization: ReadonlyArray<NormalizationStep>;
  /** `review` raises a System Conflict; `precedence` lets chain order decide. */
  readonly conflictPolicy: 'review' | 'precedence';
  /** Defaults to `"{System Key} {System Description}"` behavior when absent. */
  readonly labelTemplate?: string;
}
