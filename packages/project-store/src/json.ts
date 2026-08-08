/**
 * Canonical JSON: one value, one string, every time.
 *
 * Profiles, learned rule sets, compile stats and snapshots are stored as text,
 * and two runs of the same compile must produce byte-identical rows -- that is
 * what makes "did anything actually change?" answerable by comparing hashes
 * rather than by diffing structures. `JSON.stringify` does not promise key
 * order across values built in different orders, so this does:
 *
 * - object keys are emitted in ascending UTF-16 code-unit order;
 * - properties whose value is `undefined` are dropped, as `JSON.stringify` does;
 * - anything JSON cannot represent is refused rather than quietly mangled.
 *
 * That last rule is why `Map` is rejected instead of serializing as `{}`: a
 * `ResolvedSnapshot` holds its nodes in a Map, and a silent `{}` would store an
 * empty tree that looks perfectly valid. Callers convert first --
 * `serializeSnapshot` exists for exactly that.
 */
import { ProjectStoreError } from './errors.js';

/** True for plain objects -- object literals and `Object.create(null)`. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function refuse(path: string, detail: string): never {
  throw new ProjectStoreError({ kind: 'not-json-serializable', path, detail });
}

function describe(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  if (typeof value === 'object') {
    const name: unknown = value.constructor?.name;
    return typeof name === 'string' ? `a ${name} instance` : 'a non-plain object';
  }
  return `a ${typeof value}`;
}

function write(value: unknown, path: string, out: string[]): void {
  if (value === null) {
    out.push('null');
    return;
  }
  if (typeof value === 'string') {
    out.push(JSON.stringify(value));
    return;
  }
  if (typeof value === 'boolean') {
    out.push(value ? 'true' : 'false');
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      refuse(path, `${String(value)} has no JSON representation`);
    }
    out.push(JSON.stringify(value));
    return;
  }
  if (typeof value !== 'object') {
    // bigint, undefined, function, symbol.
    refuse(path, `${typeof value} has no JSON representation`);
  }

  if (Array.isArray(value)) {
    out.push('[');
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) {
        out.push(',');
      }
      const item: unknown = value[index];
      // JSON arrays have no holes: `undefined` becomes `null`, as JSON.stringify does.
      if (item === undefined) {
        out.push('null');
      } else {
        write(item, `${path}[${index}]`, out);
      }
    }
    out.push(']');
    return;
  }

  if (!isRecord(value)) {
    refuse(path, `${describe(value)} is not a plain JSON object`);
  }

  const keys = Object.keys(value).sort();
  out.push('{');
  let written = 0;
  for (const key of keys) {
    const entry: unknown = value[key];
    if (entry === undefined) {
      continue;
    }
    if (written > 0) {
      out.push(',');
    }
    out.push(JSON.stringify(key), ':');
    write(entry, `${path}.${key}`, out);
    written += 1;
  }
  out.push('}');
}

/**
 * Serializes `value` with sorted keys.
 *
 * @throws ProjectStoreError `not-json-serializable` when the value holds
 * anything JSON cannot represent: a Map, a Set, a class instance, a function,
 * a bigint, `NaN`, or `Infinity`.
 */
export function canonicalJson(value: unknown, path = '$'): string {
  const out: string[] = [];
  write(value, path, out);
  return out.join('');
}

/**
 * Parses text this package stored.
 *
 * @throws ProjectStoreError `malformed-json` when the column does not hold
 * JSON, which means the file was edited by something that is not Matchline.
 */
export function parseStoredJson(text: string, table: string): unknown {
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw new ProjectStoreError({
      kind: 'malformed-json',
      table,
      detail: cause instanceof Error ? cause.message : String(cause),
    });
  }
}
