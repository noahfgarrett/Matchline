/**
 * Guards shared by everything that reads untyped data back into typed shapes.
 *
 * Two audiences, two error kinds. Arguments a caller passed in are refused with
 * `invalid-argument`; values parsed out of a stored JSON column are refused with
 * whichever kind the calling validator supplies (`invalid-profile`,
 * `invalid-snapshot`, `invalid-override`). The guards themselves are shared, so
 * "is this a non-empty string" means the same thing everywhere.
 *
 * `@matchline/domain` publishes types, not schemas, and this package takes no
 * non-workspace dependency -- so validation is hand-written rather than Zod.
 * The desktop app's IPC layer keeps its own Zod schemas (APP.md); this is the
 * storage boundary's own check, and the two are meant to overlap.
 */
import { ProjectStoreError } from './errors.js';
import { isRecord } from './json.js';

/** Rejects a field of a parsed structure. Supplied by the calling validator. */
export type Fail = (field: string, detail: string) => never;

function describe(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'an array';
  }
  return `a ${typeof value}`;
}

/** The value must be a plain object. */
export function requireRecordAt(
  value: unknown,
  field: string,
  fail: Fail,
): Record<string, unknown> {
  if (!isRecord(value)) {
    return fail(field, `expected an object, got ${describe(value)}`);
  }
  return value;
}

/** The value must be a string, empty or not. */
export function requireStringAt(value: unknown, field: string, fail: Fail): string {
  if (typeof value !== 'string') {
    return fail(field, `expected a string, got ${describe(value)}`);
  }
  return value;
}

/** The value must be a string with at least one non-space character. */
export function requireFilledStringAt(value: unknown, field: string, fail: Fail): string {
  const text = requireStringAt(value, field, fail);
  if (text.trim() === '') {
    return fail(field, 'expected a non-empty string');
  }
  return text;
}

/** The value must be absent, or a string. `null` is not "absent". */
export function optionalStringAt(value: unknown, field: string, fail: Fail): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return requireStringAt(value, field, fail);
}

/** The value must be a boolean. */
export function requireBooleanAt(value: unknown, field: string, fail: Fail): boolean {
  if (typeof value !== 'boolean') {
    return fail(field, `expected a boolean, got ${describe(value)}`);
  }
  return value;
}

/** The value must be a finite number. */
export function requireNumberAt(value: unknown, field: string, fail: Fail): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fail(field, `expected a finite number, got ${describe(value)}`);
  }
  return value;
}

/** The value must be an integer this runtime can hold exactly. */
export function requireIntegerAt(value: unknown, field: string, fail: Fail): number {
  const parsed = requireNumberAt(value, field, fail);
  if (!Number.isSafeInteger(parsed)) {
    return fail(field, `expected a safe integer, got ${String(parsed)}`);
  }
  return parsed;
}

/** The value must be an array. Element types are the caller's business. */
export function requireArrayAt(value: unknown, field: string, fail: Fail): readonly unknown[] {
  if (!Array.isArray(value)) {
    return fail(field, `expected an array, got ${describe(value)}`);
  }
  return value;
}

/** The value must be an array of strings. */
export function requireStringArrayAt(
  value: unknown,
  field: string,
  fail: Fail,
): readonly string[] {
  return requireArrayAt(value, field, fail).map((item, index) =>
    requireStringAt(item, `${field}[${index}]`, fail),
  );
}

/** The value must be one of `allowed`. */
export function requireMemberAt<T extends string>(
  value: unknown,
  allowed: ReadonlyArray<T>,
  field: string,
  fail: Fail,
): T {
  const text = requireStringAt(value, field, fail);
  const match = allowed.find((candidate) => candidate === text);
  if (match === undefined) {
    return fail(field, `'${text}' is not one of ${allowed.join(', ')}`);
  }
  return match;
}

/** Rejects a caller's argument. */
export function invalidArgument(parameter: string, detail: string): never {
  throw new ProjectStoreError({ kind: 'invalid-argument', parameter, detail });
}

/** An argument that must be a string with at least one non-space character. */
export function requireFilledArgument(value: string, parameter: string): string {
  if (value.trim() === '') {
    invalidArgument(parameter, 'expected a non-empty string');
  }
  return value;
}

/**
 * An argument that must be one of `allowed`.
 *
 * TypeScript already narrows these at compile time; the runtime check is for
 * values that crossed an IPC boundary, where the type is a promise rather than
 * a guarantee.
 */
export function requireMemberArgument<T extends string>(
  value: string,
  allowed: ReadonlyArray<T>,
  parameter: string,
): T {
  const match = allowed.find((candidate) => candidate === value);
  if (match === undefined) {
    invalidArgument(parameter, `'${value}' is not one of ${allowed.join(', ')}`);
  }
  return match;
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * An argument that must be an ISO 8601 timestamp with an explicit zone.
 *
 * Timestamps in a project file are compared as text (`ORDER BY added_at`) and
 * shown to people in other time zones, so a bare local-time string is refused
 * rather than silently reinterpreted.
 */
export function requireTimestampArgument(value: string, parameter: string): string {
  if (!ISO_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    invalidArgument(parameter, `'${value}' is not an ISO 8601 timestamp with a zone`);
  }
  return value;
}

const SHA256 = /^[0-9a-f]{64}$/;

/** An argument that must be a lowercase hex SHA-256 digest. */
export function requireSha256Argument(value: string, parameter: string): string {
  if (!SHA256.test(value)) {
    invalidArgument(parameter, `'${value}' is not a lowercase hex sha256 digest`);
  }
  return value;
}

/** An argument that must be a non-negative safe integer. */
export function requireCountArgument(value: number, parameter: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    invalidArgument(parameter, `expected a non-negative integer, got ${String(value)}`);
  }
  return value;
}
