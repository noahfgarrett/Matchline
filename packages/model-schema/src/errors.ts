/**
 * Every way a cache can be rejected, as data rather than as a message string.
 *
 * Callers switch on `reason.kind`; the human-readable message is derived from
 * the reason so the two can never drift apart. A cache is refused outright
 * rather than read partially: a cache that fails any of these checks was
 * written by a worker we do not understand, or was truncated, and guessing
 * would put wrong numbers in front of an engineer.
 */
export type CacheValidationReason =
  | { readonly kind: 'cannot-open'; readonly path: string; readonly detail: string }
  | { readonly kind: 'missing-table'; readonly table: string }
  | { readonly kind: 'missing-meta-key'; readonly key: string }
  | {
      readonly kind: 'unsupported-schema-version';
      readonly found: string;
      readonly supported: string;
    }
  | { readonly kind: 'malformed-meta-value'; readonly key: string; readonly value: string }
  | { readonly kind: 'object-count-mismatch'; readonly declared: number; readonly actual: number }
  | {
      readonly kind: 'malformed-row';
      readonly table: string;
      readonly column: string;
      readonly detail: string;
    };

/** Thrown by `openExtractionCache` and by row readers that meet impossible data. */
export class CacheValidationError extends Error {
  readonly reason: CacheValidationReason;

  constructor(reason: CacheValidationReason) {
    super(describeCacheValidationReason(reason));
    this.name = 'CacheValidationError';
    this.reason = reason;
  }
}

/** The message shown for a reason. Exhaustive: a new reason will not compile. */
export function describeCacheValidationReason(reason: CacheValidationReason): string {
  switch (reason.kind) {
    case 'cannot-open':
      return `cannot open extraction cache at ${reason.path}: ${reason.detail}`;
    case 'missing-table':
      return `extraction cache is missing required table '${reason.table}'`;
    case 'missing-meta-key':
      return `extraction cache is missing required meta key '${reason.key}'`;
    case 'unsupported-schema-version':
      return `extraction cache schema_version '${reason.found}' is not supported (this reader supports '${reason.supported}')`;
    case 'malformed-meta-value':
      return `extraction cache meta key '${reason.key}' has malformed value '${reason.value}'`;
    case 'object-count-mismatch':
      return `extraction cache is incomplete: meta.object_count is ${reason.declared} but the objects table holds ${reason.actual} rows`;
    case 'malformed-row':
      return `extraction cache table '${reason.table}' column '${reason.column}' is malformed: ${reason.detail}`;
    default: {
      const exhaustive: never = reason;
      throw new Error(`unhandled CacheValidationReason: ${JSON.stringify(exhaustive)}`);
    }
  }
}
