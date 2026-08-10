import {
  SOURCE_ASSIGNMENT_FIELDS,
  type ModelObjectKey,
  type ModelSourceRef,
  type SourceAssignments,
} from '@matchline/domain';

/**
 * Two registered sources that share a raw file name (hard gate 4).
 *
 * Type-checked rather than asserted: the point of `sourceId` is that a project
 * can hold both of these at once, and a shape that made `rawFileName` the
 * identity would not compile this.
 */
export const DRAGON_SOURCES: ReadonlyArray<ModelSourceRef> = [
  {
    sourceId: 'dragon-area-mech',
    displayName: 'Dragon Area (Mechanical)',
    rawFileName: 'Dragon-Area.nwd',
    rawSha256: 'a'.repeat(64),
    cacheSha256: 'b'.repeat(64),
  },
  {
    sourceId: 'dragon-area-ctrl',
    displayName: 'Dragon Area (Controls)',
    rawFileName: 'Dragon-Area.nwd',
    rawSha256: 'c'.repeat(64),
    cacheSha256: 'd'.repeat(64),
  },
];

/** One object in each of those sources, with the same ordinal in both. */
export const DRAGON_OBJECT_KEYS: ReadonlyArray<ModelObjectKey> = [
  { sourceId: 'dragon-area-mech', objectId: 4 },
  { sourceId: 'dragon-area-ctrl', objectId: 4 },
];

/**
 * Source ids that would collide under a naive `sourceId + objectId` join, and
 * the reason {@link modelObjectKeyToString} escapes rather than concatenates.
 */
export const COLLIDING_SOURCE_IDS: ReadonlyArray<string> = [
  'a/1',
  'a%2F1',
  'a',
  'a%',
  'rev#b',
  '',
];

/** A source-level assignment of every standard field, plus a site-defined one. */
export const DRAGON_ASSIGNMENTS: SourceAssignments = {
  building: 'D1',
  nativeDiscipline: 'Mechanical',
  custom: new Map([
    ['contractor', 'Wyvern Mechanical'],
    ['package', 'P-104'],
  ]),
};

/** An assignment that states nothing: absent is not a default value. */
export const EMPTY_ASSIGNMENTS: SourceAssignments = {};

/** The standard fields, as a runtime array the `.mjs` test can walk. */
export const ASSIGNMENT_FIELDS: ReadonlyArray<string> = [...SOURCE_ASSIGNMENT_FIELDS];
