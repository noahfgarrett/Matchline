/**
 * Column readers that turn SQLite's loose value type into the exact types
 * `schema.ts` declares, and fail loudly rather than silently coercing.
 *
 * Everything here is internal: a `CacheValidationError` with reason
 * `malformed-row` means the cache does not hold what the DDL promises.
 */
import { CacheValidationError } from './errors.js';

/** Any value SQLite can return for a column. Mirrors `node:sqlite`. */
export type SqlValue = string | number | bigint | Uint8Array | null;

/** One result row, keyed by column name. */
export type SqlRow = Record<string, SqlValue>;

function malformed(table: string, column: string, detail: string): CacheValidationError {
  return new CacheValidationError({ kind: 'malformed-row', table, column, detail });
}

function describeValue(value: SqlValue | undefined): string {
  if (value === undefined) {
    return 'absent';
  }
  if (value === null) {
    return 'null';
  }
  if (value instanceof Uint8Array) {
    return `blob(${value.length} bytes)`;
  }
  return `${typeof value} ${String(value)}`;
}

function present(row: SqlRow, table: string, column: string): SqlValue {
  const value = row[column];
  if (value === undefined) {
    throw malformed(table, column, 'column absent from result row');
  }
  return value;
}

function toInteger(value: SqlValue, table: string, column: string): number {
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw malformed(table, column, `expected an integer, got ${describeValue(value)}`);
    }
    return value;
  }
  if (typeof value === 'bigint') {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      throw malformed(table, column, `integer ${value.toString()} exceeds safe range`);
    }
    return Number(value);
  }
  throw malformed(table, column, `expected an integer, got ${describeValue(value)}`);
}

/** A NOT NULL integer column. */
export function requireInteger(row: SqlRow, table: string, column: string): number {
  const value = present(row, table, column);
  if (value === null) {
    throw malformed(table, column, 'expected an integer, got null');
  }
  return toInteger(value, table, column);
}

/** A nullable integer column, typically a foreign key. */
export function optionalInteger(row: SqlRow, table: string, column: string): number | null {
  const value = present(row, table, column);
  return value === null ? null : toInteger(value, table, column);
}

/** A NOT NULL text column. */
export function requireText(row: SqlRow, table: string, column: string): string {
  const value = present(row, table, column);
  if (typeof value !== 'string') {
    throw malformed(table, column, `expected text, got ${describeValue(value)}`);
  }
  return value;
}

/** A nullable text column. */
export function optionalText(row: SqlRow, table: string, column: string): string | null {
  const value = present(row, table, column);
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw malformed(table, column, `expected text, got ${describeValue(value)}`);
  }
  return value;
}

/** A nullable REAL column. Integers stored in a REAL column are accepted. */
export function optionalReal(row: SqlRow, table: string, column: string): number | null {
  const value = present(row, table, column);
  if (value === null) {
    return null;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw malformed(table, column, `expected a finite number, got ${describeValue(value)}`);
    }
    return value;
  }
  if (typeof value === 'bigint') {
    return toInteger(value, table, column);
  }
  throw malformed(table, column, `expected a number, got ${describeValue(value)}`);
}
