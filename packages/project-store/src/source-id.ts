/**
 * Source identity: the readable, stable id a `sources` row is keyed by (v4).
 *
 * A project registers many files, and two of them may honestly share a basename
 * -- four consultants each ship `Level 1.nwc` (PRODUCT.md P0-1, hard gate 4).
 * So the row key is a `source_id` the caller supplies, and this is how a caller
 * gets one.
 *
 * Two properties matter more than beauty:
 *
 * - **Deterministic.** No `Date.now()`, no counter, no randomness. The same
 *   file registered against the same project twice derives the same id, which
 *   is what lets a project file be diffed and a compile be replayed.
 * - **Readable.** `model:mechanical-a.nwd` says what it is in a review item, a
 *   log line and a provenance record. A UUID would say nothing, and every
 *   duplicate-tag report in the engine names sources by id.
 *
 * The id is *derived from* the role and the file name, but it is not a key on
 * them: once a row exists its id never changes, whatever the file is renamed
 * to. That is the difference between an identity and an index.
 */
import { SOURCE_ROLES, type SourceRole } from './schema.js';
import { requireFilledArgument, requireMemberArgument } from './validate.js';

/** Characters an id keeps as-is. Everything else becomes a separator. */
const KEPT = /[^a-z0-9._]+/g;

/** Runs of separators, and separators at either end, are noise. */
const RUNS = /-{2,}/g;
const EDGES = /^[-.]+|[-.]+$/g;

/** What a file name reduces to when nothing readable survives normalization. */
const UNREADABLE = 'source';

/**
 * Lowercases a file name and reduces it to `[a-z0-9._-]`.
 *
 * Case is folded because Windows treats `Level 1.nwc` and `level 1.nwc` as one
 * file, and a project written on Windows is opened on macOS. Dots and
 * underscores survive so an extension stays legible; everything else -- spaces,
 * slashes, accents, CJK -- becomes a hyphen.
 */
function slugify(rawFileName: string): string {
  const slug = rawFileName
    .trim()
    .toLowerCase()
    .replace(KEPT, '-')
    .replace(RUNS, '-')
    .replace(EDGES, '');
  return slug === '' ? UNREADABLE : slug;
}

/**
 * Derives a source id that no existing source is using.
 *
 * The first source of a name gets `role:file-name`; a second gets `-2`, a third
 * `-3`. The suffix is what makes duplicate basenames a supported case rather
 * than a collision: both rows exist, both keep their own hash, and neither
 * overwrites the other.
 *
 * `existingIds` is every id already registered -- `listSources()` mapped to
 * `sourceId` -- not just the ones sharing this name. Ids are unique across the
 * whole table, so a suffix that dodges only same-name rows would still collide.
 *
 * @throws ProjectStoreError `invalid-argument` for an unknown role or a blank
 * file name.
 */
export function deriveSourceId(
  role: SourceRole,
  rawFileName: string,
  existingIds: Iterable<string>,
): string {
  const checkedRole = requireMemberArgument(role, SOURCE_ROLES, 'role');
  const checkedName = requireFilledArgument(rawFileName, 'rawFileName');

  const taken = new Set(existingIds);
  const base = `${checkedRole}:${slugify(checkedName)}`;
  if (!taken.has(base)) {
    return base;
  }
  // Bounded by the number of rows: every attempt below the answer is an id
  // that is genuinely taken, so this terminates at `taken.size + 2` at worst.
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${String(suffix)}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}
