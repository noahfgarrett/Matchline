/**
 * Explicit, auditable system-value transforms (PRODUCT.md §5.5).
 *
 * A site may write `001` in tags, `1` in Excel and `UPN-001` in a model field.
 * Reconciling those is a profile statement, never an engine guess, and the
 * trail of what happened is kept on the claim so a padded leading zero is
 * reviewable rather than invisible.
 *
 * Normalization applies to keys only. Descriptions are display text; padding
 * or upper-casing them would corrupt a human-readable string to no benefit.
 */
import { assertNever, type NormalizationStep } from '@matchline/domain';

import type { TransformRecord } from './types.js';

export interface NormalizedValue {
  /** The value exactly as the source wrote it. */
  readonly raw: string;
  /** The value after every configured step ran, in order. */
  readonly value: string;
  /** One record per configured step, no-ops included. */
  readonly transforms: ReadonlyArray<TransformRecord>;
}

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
      // A zero-length fill would loop forever inside padStart's own contract;
      // treat it as "the profile asked for nothing" rather than throwing.
      return step.fill.length === 0 ? value : value.padStart(step.length, step.fill);
    case 'alias':
      return value === step.from ? step.to : value;
    default:
      return assertNever(step, 'unhandled NormalizationStep');
  }
}

/**
 * Runs every step in order and records each one.
 *
 * No-op steps are recorded too: "the profile ran `stripPrefix UPN-` and it did
 * not apply" is a different, and more useful, statement than silence.
 */
export function normalizeSystemValue(
  raw: string,
  steps: ReadonlyArray<NormalizationStep>,
): NormalizedValue {
  const transforms: TransformRecord[] = [];
  let value = raw;
  for (const step of steps) {
    const next = applyStep(value, step);
    transforms.push({ step, from: value, to: next });
    value = next;
  }
  return { raw, value, transforms };
}
