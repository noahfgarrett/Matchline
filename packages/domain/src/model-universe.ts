/**
 * The multi-model universe (RELEASE-1.0-PLAN P0-1).
 *
 * A project reads many model sources, not one extraction cache, so every model
 * identity is scoped by the source it came from: object ids are per-cache
 * extraction ordinals, source-model names are per-cache rows, and selection-set
 * names repeat across files. A bare `number` addresses nothing once a second
 * source exists.
 *
 * `ModelObjectKey` is that scoped address, and it is a STRUCTURED value: pass
 * the pair. The string form below exists for the two places a structure cannot
 * go -- a `Map` key and a serialized document -- and nowhere else. Ad-hoc
 * concatenation is exactly what P0-1 forbids.
 */

/**
 * One object in one model source.
 *
 * `objectId` is that source's extraction ordinal (`objects.id` in the cache),
 * which is only meaningful together with `sourceId`.
 */
export interface ModelObjectKey {
  /** Project-assigned, stable for the life of the source. Never a file name. */
  readonly sourceId: string;
  /** Extraction ordinal within that source's cache. */
  readonly objectId: number;
}

/**
 * The characters that would otherwise make the string form ambiguous, escaped
 * `%` first so the escape is injective: without that, `a/b` and `a%2Fb` would
 * both encode to `a%2Fb` and two sources would share one key.
 */
const SOURCE_ID_ESCAPES: ReadonlyArray<readonly [string, string]> = [
  ['%', '%25'],
  ['/', '%2F'],
  ['#', '%23'],
];

/** The inverse table, keyed by the two hex digits of an escape. */
const SOURCE_ID_UNESCAPES: ReadonlyMap<string, string> = new Map([
  ['25', '%'],
  ['2F', '/'],
  ['23', '#'],
]);

const SOURCE_ID_ESCAPE_PATTERN = /%(25|2F|23)/g;

/**
 * A source id with `%`, `/` and `#` percent-escaped.
 *
 * Published because an id that embeds a source (an `assetId`, say) needs the
 * same escape to stay injective, and two spellings of one rule is how they
 * drift apart.
 */
export function escapeSourceId(sourceId: string): string {
  let escaped = sourceId;
  for (const [raw, code] of SOURCE_ID_ESCAPES) {
    escaped = escaped.replaceAll(raw, code);
  }
  return escaped;
}

/** The inverse of {@link escapeSourceId}, in one left-to-right pass. */
export function unescapeSourceId(escaped: string): string {
  return escaped.replace(
    SOURCE_ID_ESCAPE_PATTERN,
    (match: string, code: string): string => SOURCE_ID_UNESCAPES.get(code) ?? match,
  );
}

/**
 * The string form of a key: `<escaped source id>/<object id>`.
 *
 * Injective, so two distinct keys never produce one string. For `Map` keys and
 * serialization only -- a function that takes a model object should take the
 * `ModelObjectKey` itself, not this.
 *
 * `objectId` is expected to be a non-negative safe integer, which every cache
 * ordinal is; anything else produces a string {@link parseModelObjectKey}
 * refuses, rather than a key that silently reads back as something else.
 */
export function modelObjectKeyToString(key: ModelObjectKey): string {
  return `${escapeSourceId(key.sourceId)}/${key.objectId}`;
}

/**
 * Reads a key back, or `null` when the text is not one this module wrote.
 *
 * Canonical form only: a text whose re-encoding differs is refused rather than
 * accepted loosely, so `parse` is a true inverse and two texts can never name
 * one key.
 */
export function parseModelObjectKey(text: string): ModelObjectKey | null {
  // An escaped source id contains no `/`, so the last one is the separator.
  const separator = text.lastIndexOf('/');
  if (separator === -1) {
    return null;
  }
  const rawObjectId = text.slice(separator + 1);
  if (!/^(0|[1-9][0-9]*)$/.test(rawObjectId)) {
    return null;
  }
  const objectId = Number(rawObjectId);
  if (!Number.isSafeInteger(objectId)) {
    return null;
  }
  const key: ModelObjectKey = {
    sourceId: unescapeSourceId(text.slice(0, separator)),
    objectId,
  };
  return modelObjectKeyToString(key) === text ? key : null;
}

/**
 * One registered model source, as the project store records it.
 *
 * `rawFileName` is what the file called itself and is NOT an identity: two
 * consultants really do both ship `Level 1.nwc`, and hard gate 4 says both
 * coexist. `sourceId` is the identity; the hashes are what says whether a
 * source changed (raw) and whether its cache is the one that raw file produced
 * (cache). No absolute path: a portable project cannot carry one.
 */
export interface ModelSourceRef {
  readonly sourceId: string;
  /** What a person calls this source in the UI. */
  readonly displayName: string;
  /** The basename of the file that was extracted. Never unique. */
  readonly rawFileName: string;
  readonly rawSha256: string;
  readonly cacheSha256: string;
}

/**
 * What a site asserts about a whole source rather than about one object
 * (P0-8).
 *
 * These are the weakest rung that still states a fact: an object property that
 * answers the same field always wins, because the model saying so beats the
 * project saying so about the model. A missing assignment stays missing --
 * nothing here is a default value.
 */
export interface SourceAssignments {
  readonly building?: string;
  readonly nativeDiscipline?: string;
  /**
   * Site-defined fields, by attribute key. Carried through verbatim; this
   * package assigns them no meaning.
   */
  readonly custom?: ReadonlyMap<string, string>;
}

/** The standard fields an assignment can fill, for callers that walk them. */
export const SOURCE_ASSIGNMENT_FIELDS = ['building', 'nativeDiscipline'] as const;

export type SourceAssignmentField = (typeof SOURCE_ASSIGNMENT_FIELDS)[number];

/**
 * Compile-time completeness guard. Adding a standard field to
 * `SourceAssignments` without listing it above resolves this to `false` and the
 * assignment below stops compiling.
 */
type EverySourceAssignmentFieldListed =
  Exclude<Exclude<keyof SourceAssignments, 'custom'>, SourceAssignmentField> extends never
    ? true
    : false;

const SOURCE_ASSIGNMENT_FIELDS_ARE_COMPLETE: EverySourceAssignmentFieldListed = true;
void SOURCE_ASSIGNMENT_FIELDS_ARE_COMPLETE;
