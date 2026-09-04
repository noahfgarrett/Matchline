/**
 * Explicit tag transforms for the normalized tier.
 *
 * Same step vocabulary and same semantics as the System Resolver's value
 * normalization (PRODUCT.md §5.5) -- deliberately re-stated here rather than
 * imported, because identity is a lower layer than system resolution and must
 * not depend on it. Both are a handful of lines over the same explicit union;
 * neither is allowed to invent a transform the profile did not name.
 *
 * The one exception is `unicodeFold`, which is imported from
 * `@matchline/domain` by both. It is not a statement about what a site calls
 * things -- it is what an en dash and a hyphen have in common -- and two
 * hand-written copies of that would eventually disagree about one code point,
 * which is a tag that matches in one stage and not in the other.
 */
import { assertNever, unicodeFold, type NormalizationStep } from '@matchline/domain';

function applyStep(value: string, step: NormalizationStep): string {
  switch (step.kind) {
    case 'trim':
      return value.trim();
    case 'uppercase':
      return value.toUpperCase();
    case 'stripPrefix':
      return step.prefix.length > 0 && value.startsWith(step.prefix)
        ? value.slice(step.prefix.length)
        : value;
    case 'padStart':
      // A zero-length fill cannot pad; treat it as "the profile asked for
      // nothing" rather than throwing inside padStart's own contract.
      return step.fill.length === 0 ? value : value.padStart(step.length, step.fill);
    case 'alias':
      return value === step.from ? step.to : value;
    case 'unicodeFold':
      // The one step whose implementation is shared rather than restated: a
      // tag that folds one way for identity and another way for the resolver
      // is a tag that joins in one stage and not in the other.
      return unicodeFold(value);
    default:
      return assertNever(step, 'unhandled NormalizationStep');
  }
}

/** Runs every step in order. No steps means the tag is returned untouched. */
export function normalizeTag(tag: string, steps: ReadonlyArray<NormalizationStep>): string {
  let value = tag;
  for (const step of steps) {
    value = applyStep(value, step);
  }
  return value;
}
